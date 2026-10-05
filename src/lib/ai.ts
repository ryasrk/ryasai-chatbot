/**
 * AI Client — routes completions to a configured OpenAI/Anthropic-compatible
 * endpoint (set via /api/llm-config). Fail-closed: throws when no LLM is
 * configured. Mirrors spec §7 (`app/ai/agent.py`) — temperature=0 for
 * deterministic Text-to-SQL.
 *
 * Responsibilities:
 *   - routeQuery(): decide whether a user question needs SQL, RAG, or chit-chat.
 *   - generateSql(): Text-to-SQL given a reflected schema + question.
 *   - generateAnswer(): final NL answer from SQL rows / RAG context.
 *   - streamAnswer(): token-by-token streaming for the HTTP SSE pipeline.
 */
import { routingMemoryBlock } from '@/lib/memory-routing'
import { defaultSqlRulesPrompt } from '@/lib/prompt-settings'
import type { LlmUsage } from '@/lib/llm-client'
import { identifierQuotingRule } from '@/lib/db-provider-presets'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { db } from '@/lib/db'
import { wrapUntrusted, DATA_BOUNDARY_RULE } from '@/lib/evidence-boundary'
import {
  assertSystemPromptUnderCeiling,
  assertSystemMessagesUnderCeiling,
  orgSystemPrefixMessage,
} from '@/lib/system-message-ceiling'
import { isProfileCurrent } from '@/lib/profile-version'
import { chatOnce, chatStream, historyToMessages, type ChatMessage } from '@/lib/ai-chat'
export { DATABASE_PROFILE_VERSION, isProfileCurrent } from '@/lib/profile-version'
export { HISTORY_MAX_TURNS, HISTORY_TURN_MAX_CHARS, historyToMessages } from '@/lib/ai-chat'
export { REST_ROUTER_SYSTEM_PROMPT, generateRestCall, parseRestCallJson } from '@/lib/ai-rest'
export type { RestEndpointOption, RestCallPlan } from '@/lib/ai-rest'
export { generateSchemaDescriptions, generateDatabaseProfile } from '@/lib/ai-schema'
export type { TableSummaryInput } from '@/lib/ai-schema'

export type RouteDecision = 'SQL' | 'RAG' | 'REST' | 'CHAT' | 'CONTEXTUAL_CHAT' | 'PLUGIN'

/**
 * The router's system message. 1936 characters today — under the ~2000-character ceiling, but with
 * only ~64 characters of headroom, which is why it is measured by `assertSystemPromptUnderCeiling`
 * rather than trusted to stay small. Named (rather than inline) so the guard can see it: this
 * prompt is another candidate for the same silent discard that already cost this repo the intent
 * prompt and the Text-to-SQL rules, and a guard cannot measure an expression it cannot name.
 */
export const ROUTER_SYSTEM_PROMPT =
  'You are an enterprise AI router. Determine the handling ROUTE for the user message. ' +
  'Answer ONLY with one word: SQL, RAG, REST, CHAT, or CONTEXTUAL_CHAT.\n' +
  '- SQL: questions about structured data in connected databases — any question asking for ' +
  'counts, totals, lists, or data from database tables. If the question asks "how many", ' +
  '"berapa", "count", "total", "list", "show me", and databases are available, route to SQL.\n' +
  '- RAG: questions about policies, SOPs, documents, procedures, guidelines, regulations, or non-structural text.\n' +
  '- REST: questions that need to call whitelisted REST API endpoints on external systems.\n' +
  '- CHAT: greetings, small talk, or general questions that do not need internal data.\n' +
  '- CONTEXTUAL_CHAT: the user refers to a previous conversation OR provides new information/facts.\n' +
  '  Examples of CONTEXTUAL_CHAT:\n' +
  '  - "mention your answer again" → CONTEXTUAL_CHAT (not SQL)\n' +
  '  - "what product did I ask about earlier?" → CONTEXTUAL_CHAT (not SQL)\n' +
  '  - "how much does it cost?" (without mentioning a product) → CONTEXTUAL_CHAT (not SQL, because "it" = the cost of the product discussed earlier)\n' +
  '  - "the best-selling product is SKU-902 with 5800 units" → CONTEXTUAL_CHAT (not SQL, because the user is stating a fact, not asking)\n' +
  '  - "I want to say that..." → CONTEXTUAL_CHAT\n' +
  '  Examples of SQL/RAG (not CONTEXTUAL_CHAT):\n' +
  '  - "what is the stock of SKU-902?" → SQL (specific product mentioned + asking for data)\n' +
  '  - "what is the stock opname procedure?" → RAG (asking about a document)\n' +
  '  IMPORTANT RULE: if the message does NOT end with a question mark AND contains the words "is/that is/namely", it is likely a statement → CONTEXTUAL_CHAT.\n' +
  '  IMPORTANT: When databases are available and the question asks about data (counts, lists, ' +
  'totals, or mentions any table/entity name), prefer SQL over CHAT. Do NOT route to CHAT ' +
  'just because the question does not mention "sales" or "customers" — any structured data ' +
  'question goes to SQL.'

export interface RoutingContext {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
  hasRestApis?: boolean
  memoryContext?: string
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * The caller's allowed sources, for the SOURCE LIST this function puts in the router prompt.
   *
   * MEASURED DEFECT this exists for: `routeQuery` queried documents, tables and REST paths with NO scope at all —
   * `db.document.findMany({ where: { status: 'ready', isEnabled: true } })` and its two siblings — and then
   * interpolated the results into the prompt as `Documents: …`, `Database tables: …`,
   * `Table descriptions: …` and `REST APIs: …`.
   *
   * The CALLER was already scoped: `loadDbData` in `tool-router.ts` builds `intScope`/`docScope` deliberately, and
   * says so in a comment. So the same org could be told about every table and document in the install while the
   * branch that would read them refused — the key could not USE them but was told they exist, including their names
   * and per-table DESCRIPTIONS. Naming is the leak: a table description is business content, and a document name is
   * often the most sensitive string in the deployment ("Resignation-2026-Q3.xlsx").
   *
   * `null`/absent keeps the previous behaviour (unrestricted), matching `loadDbData`'s own contract: an empty `in: []`
   * would match nothing and lock out every key created before these axes existed.
   */
  integrationIds?: string[] | null
  documentIds?: string[] | null
  /**
   * The source the USER pinned for this turn, when the composer's picker was used.
   *
   * MEASURED GAP: the picker tells the user "other sources are excluded for this turn", but the id never reached the
   * router — `routeQuery` was called without it, so the LLM chose a route from the full source list. A user who
   * pinned a database could still get a RAG answer. The pin only ever bound AFTER the route was decided (as
   * `resolvedIntegrationId`, used only when the route is SQL), which is not what the UI promises.
   */
  pinnedSourceName?: string
}

/**
 * LLM router. Decides which pipeline to run.
 * Uses deterministic prompting (temp=0) per spec §7.
 */
/**
 * Is a plugin match strong enough to override the route the classifier chose?
 *
 * The promotion below used to fire on ANY match above a score threshold, and the score is
 * normalised by the plugin's own vocabulary — so ONE common word in a long question could win.
 * MEASURED on this deployment, with the `datetime` plugin (it declares the bare keyword "tahun"):
 *
 *     "Tampilkan pesanan per jam."          -> Current Date & Time  (0.415)  [database question]
 *     "Penjualan bulan lalu berapa?"        -> Current Date & Time  (0.233)  [database question]
 *     "Berapa total pendapatan tahun 2024?" -> Current Date & Time  (0.175)  [database question]
 *
 * 5 of 6 database questions that merely contained a time word were promoted off SQL.
 *
 * The rule: the match must be more than one incidental token, OR that one token must be most of
 * the question. "jam berapa sekarang?" still promotes (the shared word IS the question);
 * "Tampilkan pesanan per jam." does not (the question is about orders, and "jam" is a qualifier).
 */
export function pluginMatchDominatesQuestion(question: string, matchedTokens: string[]): boolean {
  const contentTokens = tokenizeForPluginGate(question)
  if (matchedTokens.length === 0) return false
  // Two or more of the question's own words hitting the plugin is unambiguous.
  if (matchedTokens.length >= 2) return true
  // ONE matched word is ambiguous, so it must not be a mere QUALIFIER inside a longer question.
  // The distinguishing signal is where the word sits: "Tampilkan pesanan per jam" appends a time
  // word to a request about ORDERS (a trailing modifier), while "what time is it in Jakarta" and
  // "hitung 15% dari 2 juta" LEAD with the plugin's own verb/noun — the match is the predicate.
  //
  // A ratio threshold was tried first and was arbitrary: it needed 0.5, which blocked "what time
  // is it in Jakarta?" (1 of 3 content words, 0.33) while still being tuned per-case. Position is
  // the property the two groups actually differ on, so it is what the gate tests.
  const firstContent = contentTokens[0]
  if (firstContent && matchedTokens.includes(firstContent)) return true
  // A question short enough that one shared word is most of it (e.g. "jam berapa sekarang").
  return contentTokens.length <= 3 && matchedTokens.length / contentTokens.length >= 0.34
}

/**
 * Conservative tokenizer for the gate above: lowercase word characters only, with common
 * Indonesian and English question/filler words removed so they cannot inflate or deflate the
 * ratio. Deliberately NOT the scoring tokenizer — this decides whether one word IS the subject.
 */
export function tokenizeForPluginGate(question: string): string[] {
  // Only true function words — pronouns, prepositions, articles, and the generic verb "is/are".
  // Deliberately NOT words like "berapa", "tampilkan" or "what": those carry the question's INTENT,
  // and stripping them made a legitimately time-focused question ("what time is it in Jakarta?")
  // look like one incidental word. Removing intent words overshot the correction.
  const STOP = new Set([
    'yang','dan','atau','untuk','dari','di','ke','pada','dengan','itu','ini','ada','nya','lah',
    'saya','kamu','kita','mereka','dia',
    'the','a','an','of','to','in','on','at','for','and','or','is','are','was','were','it','this',
    'that','there','here','my','your','our',
  ])
  return question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

/**
 * Memory context belongs in a USER message, and this is not a style preference.
 *
 * MEASURED twice, on the customer's provider: a SYSTEM message above ~2000 characters is
 * DISCARDED rather than truncated — reported `prompt_tokens` at 1800 chars is 411, at 2100+ it is
 * 44 (the user message alone), reproducible 3/3 with realistic content. The same text in a user
 * message has no ceiling: 12000 characters reports 1558 tokens and its instruction is still obeyed.
 *
 * Recall from prior conversations routinely exceeds 2000 characters, so every one of these was
 * being dropped on the floor while still costing the latency of the call that produced it.
 *
 * It is ALSO the safer role. This text is derived from earlier user turns, so it is untrusted
 * input; a system message carries the highest authority, and wrapping it in the evidence fence
 * would not change that. As a user message it is data the model reads, not a directive it obeys.
 */
function pushMemoryContext(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  memoryContext: string | undefined | null,
): void {
  if (!memoryContext) return
  messages.push({ role: 'user', content: wrapUntrusted('Memory context from prior interactions:', memoryContext) })
}

export async function routeQuery(ctx: RoutingContext): Promise<{
  decision: RouteDecision
  reason: string
}> {
  const hasHistory = ctx.chatHistory && ctx.chatHistory.length > 0
  const historyText = hasHistory
    ? ctx.chatHistory!.slice(-8)
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
        .join('\n')
    : ''

  // The scope is spread CONDITIONALLY, exactly as `loadDbData` does and for the same reason: an empty `in: []`
  // matches nothing, which would lock out every key created before these axes existed.
  const intScope = ctx.integrationIds && ctx.integrationIds.length > 0 ? { id: { in: ctx.integrationIds } } : {}
  const docScope = ctx.documentIds && ctx.documentIds.length > 0 ? { id: { in: ctx.documentIds } } : {}
  const [tableSchemas, documents, restEndpoints] = await Promise.all([
    db.integrationSchema.findMany({
      where: { integration: { status: 'active', ...intScope } },
      select: { tableName: true, description: true, integration: { select: { name: true } } },
    }),
    db.document.findMany({
      where: { status: 'ready', isEnabled: true, ...docScope },
      select: { name: true, category: true },
    }),
    // A REST endpoint has no scope axis of its own; it belongs to the org, and the key's tool allowlist is what
    // bounds it (see `allowedTools`). Scoping it to integrations would hide endpoints that are not integration-backed.
    db.restApiEndpoint.findMany({ where: { isEnabled: true }, select: { path: true, description: true } }),
  ])
  const tableNames = tableSchemas.map((t) => t.tableName)
  const tableDescriptions = tableSchemas
    .filter((t) => t.description)
    .map((t) => `${t.integration.name}.${t.tableName}: ${t.description}`)
  const docNames = documents.map((d) => (d.category ? `${d.name} [${d.category}]` : d.name))
  const apiPaths = restEndpoints.map((e) => e.path)

  // Built once, before the prompt, rather than inline at the interpolation below: it both
  // filters the raw recall (run ids, timestamps, latencies, tool bookkeeping) and frames
  // what remains as background from PAST turns rather than material for this one.
  const routingBlock = routingMemoryBlock(ctx.memoryContext)

  // The router prompt sits closest to the ceiling of any system message left in this file, and a
  // discarded router prompt does not look like a delivery failure: the model returns prose, the
  // caller below reads no known keyword and routes to CHAT, and every question silently stops
  // reaching SQL/RAG. Warn once per label rather than per request.
  assertSystemPromptUnderCeiling(ROUTER_SYSTEM_PROMPT, 'routeQuery')

  const decisionRaw = await chatOnce(
    [
      { role: 'system', content: ROUTER_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Question: "${ctx.question}"\n` +
          `Context: database integrations available=${ctx.hasIntegrations}, knowledge base documents available=${ctx.hasDocuments}, REST APIs available=${ctx.hasRestApis ?? false}.\n` +
          (tableNames.length > 0 ? `Database tables: ${tableNames.slice(0, 30).join(', ')}\n` : '') +
          (tableDescriptions.length > 0 ? `Table descriptions:\n${tableDescriptions.slice(0, 30).join('\n')}\n` : '') +
          /*
           * THE PIN, stated before the lists so it frames them. The picker promises the user that other sources
           * are excluded for this turn, but the id never reached this function — so the router chose from the full
           * list and a pinned-database question could still be answered from documents. MEASURED gap.
           *
           * Phrased as "prefer", not "you must": a pin that cannot answer is better redirected than answered
           * wrongly, and `applyToolGating` still refuses a route whose source is absent.
           */
          (ctx.pinnedSourceName
            ? `THE USER EXPLICITLY CHOSE THIS SOURCE FOR THIS QUESTION: "${ctx.pinnedSourceName}". ` +
              'Prefer the route that reads it. Route to SQL when it is a database, to RAG when it is a document set.\n'
            : '') +
          (docNames.length > 0 ? `Documents: ${docNames.slice(0, 30).join(', ')}\n` : '') +
          (apiPaths.length > 0 ? `REST APIs: ${apiPaths.slice(0, 20).join(', ')}\n` : '') +
          // FRAMED, for the same reason as tool-selector.ts: this is a ROUTING prompt, and a
          // block of remembered conversation read as material for THIS question makes the
          // router answer instead of fetching. See memory-routing.ts for the measured
          // mechanism.
          (routingBlock ? `${routingBlock}\n` : '') +
          (hasHistory ? `Prior conversation history:\n${historyText}\n` : '') +
          `Answer only SQL / RAG / REST / CHAT / CONTEXTUAL_CHAT.`,
      },
    ],
    { purpose: 'router' },
  )
  const raw = decisionRaw.toUpperCase().trim()
  const decision: RouteDecision = raw.includes('CONTEXTUAL')
    ? 'CONTEXTUAL_CHAT'
    : raw.startsWith('SQL')
      ? 'SQL'
      : raw.startsWith('RAG')
        ? 'RAG'
        : raw.startsWith('REST')
          ? 'REST'
          : 'CHAT'
  // ponytail: lightweight plugin check — keyword match only, no LLM call.
  // If a relevant plugin exists, route to PLUGIN so tool-router executes it.
  // Filter by chatEnabled — this runs in the chat path (routeQuery is called
  // from resolveRouting in tool-router.ts, which is the chat completion flow).
  //
  // MEASURED, and it was hijacking real database questions: the `datetime` plugin declares
  // "tahun" (year) among its keywords, so ANY question containing a time word matched it and got
  // promoted off the route the classifier had chosen. Against this deployment:
  //
  //     "Tampilkan pesanan per jam."            -> Current Date & Time  (0.415)
  //     "Penjualan bulan lalu berapa?"          -> Current Date & Time  (0.233)
  //     "Berapa total pendapatan tahun 2024?"   -> Current Date & Time  (0.175)
  //     ... 5 of 6 database questions containing a time word
  //
  // The promotion is only safe when the plugin is what the question is ABOUT. A single incidental
  // word inside a longer question is not that, so the evidence now has to be more than one shared
  // token: two of the query's content tokens, or one that IS the whole question's content. A
  // question that genuinely asks the time ("jam berapa sekarang?") still qualifies, because there
  // the shared token dominates the query rather than hiding in it.
  if (decision === 'CHAT') {
    const relevant = await selectRelevantPlugins({ query: ctx.question, topK: 1, minScore: 0.05, context: 'chat' })
    if (relevant.length > 0 && pluginMatchDominatesQuestion(ctx.question, relevant[0].matchedTokens ?? [])) {
      return { decision: 'PLUGIN', reason: `Plugin ${relevant[0].name} is relevant (score ${relevant[0].score.toFixed(2)})` }
    }
  }
  return { decision, reason: `Router LLM selected ${decision}` }
}

/**
 * Text-to-SQL generator (spec §3 + §7).
 * Returns raw SQL — caller MUST run it through guardrails.validateAndSanitizeLlmSql.
 */
export async function generateSql(args: {
  question: string
  schemaDescription: string
  provider: string
  dialectHint?: string
  memoryContext?: string
  systemPromptPrefix?: string
  /** Rich business context: domain overview, glossary, relationships, query hints */
  businessContext?: string | null
  /** Repair feedback from a failed execution — fed back for a corrected retry. */
  repairFeedback?: string
  /**
   * Free-text columns of the target database, used only when the business context
   * is stale. Naming the actual columns is what stops a filter being invented on
   * one of them; a generic warning is not enough.
   */
  textColumns?: string[]
  /**
   * The org's editable Text-to-SQL rules. Resolved by the CALLER via
   * `resolveSqlRulesPrompt(settings.sqlRulesPrompt)` so this function stays free of DB access and the
   * fallback lives in exactly one place.
   *
   * Omitted → the built-in default, so existing call sites keep their behaviour unchanged and an org
   * that never opens the editor behaves exactly as before the field existed.
   */
  sqlRules?: string
}): Promise<{ sql: string; explanation: string }> {
  const sqlSystemPrompt =
    `You are an expert ${args.provider} Text-to-SQL specialist. ` +
    'Your task: convert a natural language question into ONE valid & efficient SELECT query, ' +
    'following the RULES given in the next message. '
  // Guarded rather than assumed: this is the prompt that measured 3033 characters before the RULES
  // moved to a user message, which is why the split is visible here at all. The variable closes
  // over a provider name, so it is measured at runtime rather than trusted on inspection.
  assertSystemPromptUnderCeiling(sqlSystemPrompt, 'generateSql')
  const raw = await chatOnce(
    [
      { role: 'system', content: sqlSystemPrompt },
      {
        // The RULES live in a USER message, not the system message.
        //
        // MEASURED: the customer's provider DISCARDS a system message above ~2000 characters
        // rather than truncating it — reported `prompt_tokens` for an identical request at 1800
        // chars is 411, at 2100+ it is 44 (the user message alone), reproducible 3/3. This prompt
        // was 3033 characters, so the Text-to-SQL RULES — including rules 13-16 that encode real
        // fixed bugs — never reached the model on any request. User messages have NO such ceiling:
        // 12000 characters reports 1558 tokens and the instruction is still obeyed.
        role: 'user',
        content:
                    // RULES come from the org's editable settings, falling back to the built-in
                    // default. `resolveSqlRulesPrompt` treats whitespace-only text as empty so a
                    // stray newline can never replace the rules with nothing.
                    args.sqlRules ?? defaultSqlRulesPrompt(),
      },
      {
        role: 'user',
        content:
          `Dialect: ${args.provider}\n` +
          `${identifierQuotingRule(args.provider)}\n` +
          (args.businessContext
            ? `\n## BUSINESS CONTEXT\n${args.businessContext}\n`
            // A profile from an OLDER prompt has no query-hints section, and that is
            // the harmful state: MEASURED, such a profile made the model fabricate a
            // filter on a free-text label in 10 of 10 runs, against 0 of 10 with a
            // current one. Regeneration happens on Test Connection, but an install
            // that has not re-tested keeps the old profile, so the fallback guidance
            // is added here rather than relying on regeneration having happened.
            + (isProfileCurrent(args.businessContext)
              ? ''
              : '\n(No query hints are available for this database. If the question uses a '
                + 'qualifier such as "active", "pending" or "unpaid" and no column clearly '
                + 'holds that state, do NOT filter on an unrelated column — answer for all '
                + 'rows instead.'
                // Naming the columns is the part that works. MEASURED against a table
                // whose only text columns were nama/kota/tipe_pelanggan, the generic
                // warning alone still allowed `WHERE tipe_pelanggan ILIKE \'%aktif%\'`
                // in 1 of 40 runs; naming all three removed it (0 of 40).
                + (args.textColumns && args.textColumns.length > 0
                  ? ` Free-text columns in this schema — ${args.textColumns.join(', ')} — are '
                    + 'descriptive labels, NOT status columns; never filter on them for a '
                    + 'status qualifier.`
                  : '')
                + ')\n')
            : '') +
          `\nDatabase schema:\n${args.schemaDescription}\n\n` +
          (args.systemPromptPrefix ? `Context: ${args.systemPromptPrefix}\n\n` : '') +
          (args.repairFeedback ? `PREVIOUS ATTEMPT FAILED — fix it. ${args.repairFeedback}\n\n` : '') +
          `User question: ${args.question}\n\n` +
          (args.memoryContext ? `Memory: a similar query previously succeeded with:\n${args.memoryContext}\n\n` : '') +
          `Provide JSON {"sql": "...", "explanation": "..."}.`,
      },
    ],
    { purpose: 'sql' },
  )
  return parseSqlJson(raw)
}

function parseSqlJson(raw: string): { sql: string; explanation: string } {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    const obj = JSON.parse(cleaned)
    return { sql: String(obj.sql ?? '').trim(), explanation: String(obj.explanation ?? '').trim() }
  } catch (e) {
    console.warn('[ai] SQL JSON parse failed, using raw text:', e instanceof Error ? e.message : String(e))
    return { sql: cleaned, explanation: 'Query generated by LLM.' }
  }
}

/**
 * Generate the final natural-language answer from SQL rows / RAG context.
 * Used by both the HTTP fallback and the WebSocket streaming service.
 */
export async function generateAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'
  provider?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatMessage[]
  /** SQL/REST row count — enables honest empty-result and truncation reporting. */
  rowCount?: number
  /** True when the result was cut off by the LIMIT clamp (resultLimit reached). */
  truncated?: boolean
}): Promise<string> {
  const sourceLabel = answerContextLabel(args.source)
  const messages: ChatMessage[] = []
  // ponytail: empty results and LIMIT truncation used to reach the synthesis
  // prompt as bare "[]" / 100 rows with no framing — the model either invented
  // an explanation or presented a truncated set as complete. Surface both
  // facts explicitly so it can be honest without hallucinating.
  const emptyNote =
    args.rowCount === 0
      ? `The query executed successfully but returned 0 rows. State plainly that no matching data was found for this question. Do NOT invent rows, do NOT fabricate an explanation for why it is empty — if the reason is not evident from the data, say the filter may be too narrow and suggest what the user could relax (date range, status filter, entity name). `
      : ''
  const truncatedNote =
    args.truncated
      ? `The result was TRUNCATED to the first ${args.rowCount} rows by the system row limit. Tell the user explicitly (e.g. "showing the first ${args.rowCount} matching rows") — never present a truncated set as the complete answer, and offer to narrow the question for a complete view. `
      : ''
  // Built BEFORE the prefix is pushed, because the prefix's ROLE now depends on how much system
  // budget this fixed block needs. See `orgSystemPrefixMessage`: an org prefix that does not fit
  // alongside it is delivered as a USER message rather than pushing the assistant instructions
  // over the provider's ceiling, where the provider drops the whole system message.
  const systemContent =
    `You are ryasai, an enterprise AI assistant. ` +
    `Answer the user's question based on the CONTEXT provided. ` +
    /*
     * THE DATA/INSTRUCTION BOUNDARY, stated ONCE here instead of inside every context block. MEASURED: the
     * per-block copy cost ~260 characters and appeared for EVERY block — documents, knowledge graph, database rows —
     * so an ordinary RAG answer paid it twice, and it grew with the number of blocks. The fences still travel with
     * each block (see `wrapUntrusted`); only the instruction is hoisted, so it cannot be repeated or drift.
     */
    DATA_BOUNDARY_RULE + ' ' +
    `If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ` +
    `Do not say data is unavailable if it appears in the context or history. ` +
    emptyNote +
    truncatedNote +
    `If the CONTEXT marks a step FAILED, report that failure and its reason. ` +
    `Never invent data, and never substitute manual setup instructions for the user to run by hand. ` +
    `Never invent a REASON for a failure: do not claim a network problem, a blocked host, a timeout or a permission error unless the CONTEXT states it, and never tell the user to change firewall or security settings to fix something that was never attempted. If you could not answer, say what YOU did not find. If the question asks you to COMPARE two things and the CONTEXT covers only one, give that one and state plainly that the other was not available in this result — never relabel one source's rows as another's.` +
    `Format numbers for readability. ` +
    /*
     * THE SOURCE LINE MOVED OUT OF THE ANSWER TEXT.
     *
     * This used to instruct "Mention the data source naturally at the end of the answer", so every reply ended with a
     * sentence like "Sumber: kebijakan.txt (HR), bagian kebijakan lembur." — text the user has to read past, and which
     * the UI already renders as structured metadata under the answer (the collapsible Sources row, built from the
     * citation objects rather than from prose). MEASURED: the model paraphrased the file name AND the section, so the
     * sentence also varied between replies for identical citations.
     *
     * What is NOT removed is grounding: the answer must still be based on the context, and must still say when the
     * context did not contain the answer. Only the human-readable attribution moved to the metadata surface.
     */
    `Do NOT write a source, citation or file-name line at the end of the answer: the interface shows the sources as ` +
    `metadata, so repeating them in prose is redundant. Answer in your own sentences and stop.`
  assertSystemPromptUnderCeiling(systemContent, 'generateAnswer')
  if (args.systemPromptPrefix) {
    messages.push(orgSystemPrefixMessage(args.systemPromptPrefix, 'generateAnswer', systemContent))
  }
  if (args.memoryContext) {
    pushMemoryContext(messages, args.memoryContext)
  }
  if (args.chatHistory && args.chatHistory.length > 0) {
    messages.push(...historyToMessages(args.chatHistory))
  }
  messages.push({ role: 'system', content: systemContent })
  messages.push({
    role: 'user',
    content:
      `Question: ${args.question}\n\n` +
      `CONTEXT (${sourceLabel}):\n${args.context}\n\n` +
      `Answer:`,
  })
  assertSystemMessagesUnderCeiling(messages, 'generateAnswer')
  return chatOnce(messages, { purpose: 'synthesis' })
}

export function answerContextLabel(source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'): string {
  if (source === 'REST_API') return 'REST API'
  if (source === 'CHAT') return 'PRIOR CONTEXT'
  return source
}

/**
 * ponytail: rolling session summary — condenses messages that fell out of the
 * 10-message history window. Without it, anything older silently vanishes
 * from every prompt ("chatbot with amnesia" in long sessions). Called when
 * history exceeds the window; stored on ChatSession.summary.
 */
export async function generateSessionSummary(args: {
  previousSummary: string | null
  messages: ChatMessage[]
}): Promise<string> {
  const formatted = args.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1000)}`)
    .join('\n')
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Condense the conversation into a compact summary (max 200 words) that preserves: ' +
          'topics discussed, key facts/figures the user shared, entities mentioned by name, ' +
          'decisions or conclusions reached, and any open questions. ' +
          'If a previous summary exists, merge — keep older facts unless contradicted. ' +
          'Same language as the conversation. Output ONLY the summary text.',
      },
      {
        role: 'user',
        content:
          (args.previousSummary ? `Previous summary:\n${args.previousSummary}\n\n` : '') +
          `New messages to fold in:\n${formatted}`,
      },
    ],
    { purpose: 'summary' },
  )
  return raw.trim().slice(0, 2000)
}

/**
 * Session title from the first user message — 3-6 words, user's language.
 * ponytail: the old fallback (raw text.slice(0, 60)) produced titles like
 * "Berapa total pendapatan kami untuk kuartal..." — truncated mid-sentence.
 * Cheap single call; callers should treat failure as non-fatal and keep the
 * raw-text fallback.
 */
export async function generateSessionTitle(firstMessage: string): Promise<string> {
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Create a short chat-session title (3-6 words) summarizing the user message. ' +
          'Use the SAME language as the message. Title case. No quotes, no trailing punctuation, ' +
          'no prefix like "Session:". Output ONLY the title.',
      },
      { role: 'user', content: firstMessage.slice(0, 500) },
    ],
    { purpose: 'title' },
  )
  const title = raw.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 80)
  // A model that replies "A" or "OK" has not summarised anything, and returning that verbatim puts a
  // one-word non-title in the session list. The caller only recovers if this THROWS, so a short reply has
  // to be handled HERE. This guard was dropped by accident in a5d3d04 (a mutation-testing harness restored
  // ai.ts from a truncated backup) and the two tests below caught it -- keep them.
  return title.length >= 3 ? title : firstMessage.slice(0, 60)
}

// ---------------------------------------------------------------------------
// Schema description generation — LLM summarizes each table's purpose from
// its columns + 1 sample row. Called once at connection test time, cached in
// IntegrationSchema.description. Used as context for intent analysis + routing.
// ----------------------------------------------------------------------------

/** Pure non-streaming chat (no SQL/RAG) for external API and general questions. */
export async function generateChat(
  question: string,
  systemPromptPrefix?: string,
  memoryContext?: string,
  chatHistory?: ChatMessage[],
): Promise<string> {
  const messages: ChatMessage[] = []
  // Built first so the org prefix's ROLE can be decided against the system budget it must share
  // (see `orgSystemPrefixMessage`); the push ORDER below is unchanged.
  const systemContent =
    'You are ryasai, an enterprise AI assistant. ' +
    'You can help with: database queries (SQL), document search (RAG), REST API calls, and general chat. ' +
    'When the user refers to prior conversation or data, use the conversation history to answer without needing a new query. ' +
    'If the user provides new information, acknowledge and remember it. ' +
    'Do not say data is unavailable if it was discussed in prior conversation history.'
  assertSystemPromptUnderCeiling(systemContent, 'generateChat')
  if (systemPromptPrefix) {
    messages.push(orgSystemPrefixMessage(systemPromptPrefix, 'generateChat', systemContent))
  }
  if (memoryContext) {
    pushMemoryContext(messages, memoryContext)
  }
  messages.push({ role: 'system', content: systemContent })
  if (chatHistory && chatHistory.length > 0) {
    messages.push(...historyToMessages(chatHistory))
  }
  messages.push({ role: 'user', content: question })
  assertSystemMessagesUnderCeiling(messages, 'generateChat')
  return chatOnce(messages, { purpose: 'chat' })
}

/** Streaming answer — yields token chunks. */
export async function* streamAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'
  memoryContext?: string
  systemPromptPrefix?: string
  chatHistory?: ChatMessage[]
  /** SQL/REST row count — enables honest empty-result and truncation reporting. */
  rowCount?: number
  /** True when the result was cut off by the LIMIT clamp (resultLimit reached). */
  truncated?: boolean
  /** Receives token counts when the stream ends; see chatStream. */
  onUsage?: (usage: LlmUsage) => void
}): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = []
  // ponytail: keep in sync with generateAnswer's empty/truncation notes.
  const emptyNote =
    args.rowCount === 0
      ? `The query executed successfully but returned 0 rows. State plainly that no matching data was found for this question. Do NOT invent rows, do NOT fabricate an explanation for why it is empty — if the reason is not evident from the data, say the filter may be too narrow and suggest what the user could relax (date range, status filter, entity name). `
      : ''
  const truncatedNote =
    args.truncated
      ? `The result was TRUNCATED to the first ${args.rowCount} rows by the system row limit. Tell the user explicitly (e.g. "showing the first ${args.rowCount} matching rows") — never present a truncated set as the complete answer, and offer to narrow the question for a complete view. `
      : ''
  // Built before the prefix is pushed: the prefix is demoted to a USER message when it will not
  // fit the surviving system budget (see `orgSystemPrefixMessage`). The streaming path needs the
  // same bound as its non-streaming twin or the two would diverge on exactly the long prefix.
  const systemContent =
    'You are ryasai, an enterprise AI assistant. ' +
    'Answer the user\'s question based on the CONTEXT provided. ' +
    // Same rule as `generateAnswer` — both answer prompts must carry it, or the streaming and non-streaming
    // transports would differ on exactly the untrusted-content boundary (a documented drift class in this repo).
    DATA_BOUNDARY_RULE + ' ' +
    'If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ' +
    'Do not say data is unavailable if it appears in the context or history. ' +
    emptyNote +
    truncatedNote +
    'If the CONTEXT marks a step FAILED, report that failure and its reason. ' +
    'Never invent data, and never substitute manual setup instructions for the user to run by hand. ' +
    `Never invent a REASON for a failure: do not claim a network problem, a blocked host, a timeout or a permission error unless the CONTEXT states it, and never tell the user to change firewall or security settings to fix something that was never attempted. If you could not answer, say what YOU did not find. If the question asks you to COMPARE two things and the CONTEXT covers only one, give that one and state plainly that the other was not available in this result — never relabel one source's rows as another's.` +
    'Format numbers for readability. ' +
    /*
     * THE SAME RULE AS `generateAnswer`, and it has to live in BOTH prompts. MEASURED: the trailer "Sumber:
     * kebijakan.txt (HR), bagian kebijakan lembur." was still appearing on streamed answers after the instruction was
     * removed from `generateAnswer`, because this prompt never carried the rule while the ORG's own system prompt did
     * ("Cite sources when using retrieved knowledge. Cite sources …"). A per-source instruction can only be
     * overridden by a more specific one; saying nothing leaves the operator's wording in charge.
     */
    `Do NOT end the answer with a source, citation or file-name line: the interface shows the sources as ` +
    `metadata, so repeating them in prose is redundant. Answer in your own sentences and stop.`
  assertSystemPromptUnderCeiling(systemContent, 'streamAnswer')
  if (args.systemPromptPrefix) {
    messages.push(orgSystemPrefixMessage(args.systemPromptPrefix, 'streamAnswer', systemContent))
  }
  if (args.memoryContext) {
    pushMemoryContext(messages, args.memoryContext)
  }
  if (args.chatHistory && args.chatHistory.length > 0) {
    messages.push(...historyToMessages(args.chatHistory))
  }
  messages.push(
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: `Question: ${args.question}\n\nCONTEXT (${answerContextLabel(args.source)}):\n${args.context}\n\nAnswer:`,
    },
  )
  assertSystemMessagesUnderCeiling(messages, 'streamAnswer')
  yield* chatStream(messages, { purpose: 'synthesis', onUsage: args.onUsage })
}

export async function* streamChat(
  question: string,
  memoryContext?: string,
  systemPromptPrefix?: string,
  chatHistory?: ChatMessage[],
  /** Receives token counts when the stream ends; see chatStream. */
  onUsage?: (usage: LlmUsage) => void,
): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = []
  // Same system block as generateChat, and the same budget rule for the prefix: the streaming
  // twin must not diverge on exactly the long prefix this bound exists for.
  const systemContent =
    'You are ryasai, an enterprise AI assistant. ' +
    'You can help with: database queries (SQL), document search (RAG), REST API calls, and general chat. ' +
    'When the user refers to prior conversation or data, use the conversation history to answer without needing a new query. ' +
    'If the user provides new information, acknowledge and remember it. ' +
    'Do not say data is unavailable if it was discussed in prior conversation history.'
  assertSystemPromptUnderCeiling(systemContent, 'streamChat')
  if (systemPromptPrefix) {
    messages.push(orgSystemPrefixMessage(systemPromptPrefix, 'streamChat', systemContent))
  }
  if (memoryContext) {
    pushMemoryContext(messages, memoryContext)
  }
  if (chatHistory && chatHistory.length > 0) {
    messages.push(...historyToMessages(chatHistory))
  }
  messages.push(
    { role: 'system', content: systemContent },
    { role: 'user', content: question },
  )
  assertSystemMessagesUnderCeiling(messages, 'streamChat')
  yield* chatStream(messages, { purpose: 'chat', onUsage })
}
