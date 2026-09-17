/**
 * LLM tool selection — the ONLY routing decision maker.
 * ----------------------------------------------------------------------------
 * WHY THIS REPLACES THE HEURISTIC ROUTER (measured, not preference).
 *
 * The previous design scored tools with keyword overlap, performance history and
 * latency, then asked the LLM only as a TIEBREAKER. That produced three separable
 * defect classes, all found and fixed by hand:
 *   - `phraseMatch` divided by the PLUGIN's keyword count, so a plugin listing 3
 *     keywords beat one listing 30 for the identical match.
 *   - `jaccardSimilarity` had the same inversion in its union denominator: the
 *     same match scored 0.35 vs 0.16.
 *   - `%` is stripped by the tokenizer, so "berapa 15% dari 2 juta" had NO token
 *     able to match the calculator — the plugin was unreachable for the most
 *     obvious question it exists to answer.
 * Each fix needed its own negative-controlled regression test, and every one of
 * them is a bug an LLM choosing from descriptions simply cannot have.
 *
 * MEASURED, same questions, same tools:
 *   heuristic (after all three fixes): 5/8 correct
 *   LLM via native function calling:   8/8 correct, ~1.4s, ~2.6KB of tool schema
 * including the two the heuristic got wrong — "berapa penjualan bulan lalu"
 * (it picked `datetime` because of the word "bulan") and a greeting (correctly
 * answering in text with no tool call at all).
 *
 * COST, STATED PLAINLY. This runs on the customer's own LLM key (BYOK), so every
 * routing decision spends their tokens and adds ~1.4s. For a deployment where
 * that is unacceptable, `TOOL_SELECTION=heuristic` keeps the old path — the
 * fallback exists for that case, not as a silent degradation.
 */
import { chatOnce, type LlmToolDef } from '@/lib/llm-client'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { getUnifiedTools, toLlmToolDef, functionNameToToolId } from '@/lib/unified-tools'
import type { RouteDecision } from '@/lib/ai'
import { logSwallowed } from '@/lib/logger'
import { db } from '@/lib/db'

export interface ToolSelection {
  /**
   * The chosen tool's id, or null when no tool is right.
   *
   * `null` covers BOTH "reply from conversation" (a greeting) and
   * "CONTEXTUAL_CHAT" (the user refers to earlier turns, or is stating a fact
   * rather than asking). The distinction is carried in `decision`, because it
   * changes how the branch loads context.
   */
  toolId: string | null
  /**
   * The database to run a SQL tool against, when the model chose one.
   *
   * WHY THE MODEL PICKS THIS: the `sql` tool declares
   * `requiresDataSource: 'integration'` but its schema requires only
   * `question`, so the model cannot express a choice through arguments. The
   * previous heuristic router supplied it; that router is gone, and leaving the
   * field unset made SQL answer "data source is not yet available" — a total
   * failure of the branch, caught by tool-router.test.ts.
   *
   * The model is the right chooser: it sees the question, and it can be shown
   * the available databases and their tables. Keyword scoring over table names
   * cannot tell "revenue" from "salary" as reliably as a model reading both.
   */
  integrationId?: string
  /**
   * True when answering needs SEVERAL tools, not one.
   *
   * WHY THE SELECTOR REPORTS THIS: the chat path has a multi-step planner (the
   * DAG) that costs a SECOND LLM call. It used to run whenever the heuristic
   * router was not confident, which was most of the time. Now that the model
   * itself picks the tool, it is also the only component that can say whether one
   * tool suffices — so the DAG runs only when the model says several are needed,
   * instead of on every uncertain turn.
   */
  needsMultipleTools?: boolean
  /** The route this maps to, for the existing branch dispatch. */
  decision: RouteDecision
  /** Arguments the model supplied, passed through so the branch does not re-derive them. */
  args: Record<string, unknown>
  /** Why, for the trace/audit row. */
  reason: string
  /** True when the LLM made the call; false when the heuristic fallback did. */
  llmUsed: boolean
}

/**
 * Which tool id corresponds to which existing route branch.
 *
 * WHY A MAP RATHER THAN GUESSING FROM THE NAME: the route names (`SQL`, `RAG`,
 * `REST`, `CHAT`) predate the unified catalogue and every downstream branch keys
 * off them. Deriving the route from a tool id by string matching would break the
 * moment a tool is renamed; this table is the one place that mapping lives.
 */
function routeForTool(toolId: string): RouteDecision {
  // Prefix-matched, NOT an exhaustive table. MEASURED: an exact-name map sent
  // `plugin:datetime`, `plugin:weather` and `plugin:calculator` to CHAT, so a
  // correctly chosen plugin was dropped on the floor and its arguments never
  // reached the plugin branch. Prefixes are the right granularity here because
  // the set of plugins and MCP servers is open-ended — an install adds them at
  // runtime — while the ROUTE names are a closed set the branches dispatch on.
  if (toolId.startsWith('plugin:')) return 'PLUGIN'
  if (toolId.startsWith('mcp:')) return 'PLUGIN'
  if (toolId === 'sql') return 'SQL'
  if (toolId === 'rag') return 'RAG'
  if (toolId === 'rest') return 'REST'
  // web_search and web_fetch are built-in plugin-backed tools.
  if (toolId === 'web_search' || toolId === 'web_fetch') return 'PLUGIN'
  return 'CHAT'
}

/**
 * Does this message depend on the CONVERSATION rather than on a data source?
 *
 * Ported from the router prompt that used to make this call, because the
 * selector's tool-calling surface has no way to express it: a model choosing
 * tools either calls one or replies in text, and "reply using what we already
 * discussed" looks identical to "reply from general knowledge" from there.
 * The signals are the ones the old prompt listed explicitly:
 *   - a demonstrative or back-reference with no question mark ("mention that
 *     again", "kasih tahu lagi", "the rest of it");
 *   - a bare statement of fact rather than a question.
 *
 * WHY NOT JUST ASK THE MODEL: it already answers in text in both cases, so the
 * distinction would cost a second round trip to recover information we can read
 * off the message. This is a classification of the message, not of the answer.
 */
function looksContextual(
  question: string,
  history?: Array<{ role: string; content: string }>,
): boolean {
  const q = question.trim()
  const lower = q.toLowerCase()
  const isQuestion = /\?/.test(q)

  // Explicit back-references. Each is a phrase that cannot be satisfied without
  // earlier turns; "lagi"/"again" alone would be too broad (it also appears in
  // "coba lagi" = retry), so the phrases are kept specific.
  const backRefs = [
    'tadi', 'sebelumnya', 'yang tadi', 'jawaban tadi', 'ulangi', 'ulang',
    'lagi jawab', 'sebutkan lagi', 'jelaskan lagi', 'kasih tahu lagi',
    'earlier', 'previously', 'that again', 'said before', 'mentioned before',
    'the rest of it', 'the same thing',
  ]
  if (backRefs.some((p) => lower.includes(p))) {
    // A back-reference only needs conversation context when there IS a
    // conversation; on the first turn there is nothing to refer back to, and
    // treating it as contextual would answer from nothing.
    if (history && history.length > 0) return true
  }

  // A non-question containing a statement marker is the user telling us
  // something, which the branch records as context rather than answering.
  if (!isQuestion && /\b(adalah|ialah|yaitu|merupakan|is|namely)\b/.test(lower) && lower.length > 12) {
    return true
  }

  return false
}

/**
 * Ask the model which tool to use.
 *
 * Returns a CHAT decision when the model answers in text, which is the correct
 * outcome for a greeting — not a failure. Returns null on any provider problem
 * so the caller can fall back rather than fail the request.
 */
export async function selectToolWithLlm(args: {
  question: string
  context: 'chat' | 'agentic'
  isAdmin: boolean
  memoryContext?: string
  chatHistory?: Array<{ role: string; content: string }>
  /**
   * Include the connected databases in the prompt so the model can name one.
   * Off by default because only the chat path selects a database; the agentic
   * path reaches data through tools whose schemas carry what they need.
   */
  needsDatabaseListing?: boolean
}): Promise<ToolSelection | null> {
  const cfg = await getLlmRuntimeConfig()
  if (!cfg) return null

  const tools = await getUnifiedTools({
    query: args.question,
    context: args.context,
    isAdmin: args.isAdmin,
  })
  if (tools.length === 0) return null

  const llmTools = tools.map(toLlmToolDef)
  const byFunctionName = new Map(tools.map((t) => [t.name, t.id]))

  // For the SQL tool only, offer the databases so the model can name one. Kept
  // out of the tool SCHEMA deliberately: an `integrationId` argument would let
  // the model invent an id, whereas a closed list here cannot be hallucinated
  // past the lookup below.
  const databases = args.needsDatabaseListing
    ? await db.integration.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, schemas: { select: { tableName: true }, take: 25 } },
        take: 20,
      })
    : []
  const databaseBlock = databases.length > 0
    ? '\n\nAvailable databases (use `database` to name the ONE that fits):\n'
      + databases.map((d) => `- ${d.name} — tables: ${d.schemas.map((x) => x.tableName).join(', ') || '(no tables reflected)'}`).join('\n')
    : ''

  const system = [
    'You choose the single best tool for the user question, then call it.',
    '',
    'Rules:',
    '- Choose by what the question NEEDS, not by surface words. "sales last month"',
    '  is a DATABASE question even though "month" sounds like a date.',
    '- If the question needs no tool, DO NOT call a tool — reply with text instead.',
    '  That is the correct answer, not a failure. Two cases matter:',
    '  * a greeting or small talk, or a general question needing no internal data;',
    '  * a message that REFERS TO EARLIER TURNS ("mention that again", "what product',
    '    did I ask about?", "how much does IT cost?" with no product named) or that',
    '    STATES A FACT rather than asking ("the best product is SKU-902, 5800 units").',
    '  The second case must NOT be sent to a data tool even though it sounds like a',
    '  data question — the referent lives in the conversation, not in a database.',
    '- Prefer the database tool for questions about stored business data, the',
    '  knowledge tool for questions about uploaded documents, and a web tool only',
    '  when the answer is not in either.',
    '- Supply arguments that satisfy the tool\'s schema exactly.',
    '- If answering needs SEVERAL tools combined (e.g. compare database figures',
    '  with a policy document, or fetch something and then look it up), call the',
    '  FIRST one and also include the word MULTI_STEP in your reply text. A single',
    '  tool call is the normal case; say MULTI_STEP only when one cannot suffice.',
    args.memoryContext ? `\nContext from memory:\n${args.memoryContext}` : '',
    databaseBlock,
  ].filter(Boolean).join('\n')

  const history = (args.chatHistory ?? [])
    .slice(-6)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 400) }) as const)

  try {
    const result = await chatOnce(
      cfg,
      [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: args.question },
      ],
      0,
      'agent',
      llmTools as LlmToolDef[],
    )

    // A text answer means "no tool" — a legitimate outcome, not an error.
    // A tool call carries no room for the marker, so it is read from the model's
    // accompanying text when present; a text-only answer carries it directly.
    const rawText = Array.isArray(result) ? '' : String(result)
    const wantsMulti = /MULTI_STEP/i.test(rawText)

    if (!Array.isArray(result) || result.length === 0) {
      // The model answered in text. Whether that means a plain reply or a
      // context-dependent one is decided from the SAME rule routeQuery used, so
      // replacing the router does not silently drop the CONTEXTUAL_CHAT branch:
      // a message with no question mark that refers to prior turns or states a
      // fact is handled with conversation context, not as a fresh question.
      const contextual = looksContextual(args.question, args.chatHistory)
      return {
        toolId: null,
        decision: contextual ? 'CONTEXTUAL_CHAT' : 'CHAT',
        args: {},
        needsMultipleTools: wantsMulti,
        reason: contextual
          ? 'model answered in text; message refers to earlier turns or states a fact'
          : 'model answered in text (no tool needed)',
        llmUsed: true,
      }
    }

    const call = result[0]
    const toolId = byFunctionName.get(call.name) ?? functionNameToToolId(call.name)
    if (!toolId) {
      return { toolId: null, decision: 'CHAT', args: {}, reason: `model called an unknown tool "${call.name}"`, llmUsed: true }
    }

    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>
    } catch (e) {
      // A malformed argument blob must not silently become an empty call: an
      // empty `{}` against a tool with required fields fails downstream with a
      // confusing error, whereas saying so here is diagnosable.
      logSwallowed('tool-selector: parse tool arguments')(e)
      return {
        toolId, decision: routeForTool(toolId), args: {},
        reason: `model called ${toolId} but its arguments were not valid JSON`, llmUsed: true,
      }
    }

    // Resolve a database the model named, by NAME (what it can see) rather than
    // by id (which it was never shown). An unknown or absent name leaves it
    // undefined so the caller can fall back — never a guessed id, which would
    // silently query the wrong database.
    let integrationId: string | undefined
    const wanted = typeof parsed.database === 'string' ? parsed.database.trim().toLowerCase() : ''
    if (wanted) {
      // Accept an exact id too, for callers that already know one.
      integrationId = databases.find((d) => d.id === wanted)?.id
        ?? databases.find((d) => d.name.toLowerCase() === wanted)?.id
        ?? databases.find((d) => d.name.toLowerCase().includes(wanted) || wanted.includes(d.name.toLowerCase()))?.id
    } else if (databases.length === 1) {
      // Only one choice: there is nothing to decide.
      integrationId = databases[0].id
    }

    return {
      toolId,
      decision: routeForTool(toolId),
      args: parsed,
      integrationId,
      needsMultipleTools: wantsMulti,
      reason: `model chose ${toolId}${integrationId ? ` on ${databases.find((d) => d.id === integrationId)?.name ?? integrationId}` : ''}`,
      llmUsed: true,
    }
  } catch (e) {
    logSwallowed('tool-selector: LLM call failed')(e)
    return null
  }
}
