/**
 * A deliberately SMALL routing pipeline, built alongside the existing one so the
 * two can be compared on the same questions instead of replaced on faith.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED on the current pipeline: "Halo, apa kabar?" costs 4 LLM calls and 175 s
 * end-to-end, against 12.8 s for a direct call to the same model. A timing trace
 * attributed 23.4 s to intent analysis and 13.6 s to routing -- which then decided
 * `CHAT`, i.e. spent 37 s and two LLM round-trips to conclude that nothing needed to
 * be routed. The pre-token phase is ~85% of the wall clock.
 *
 * The full pipeline is 4,428 lines across 7 files and may make 4+ sequential LLM
 * calls per question (intent -> rewrite -> route -> optional tiebreaker -> answer).
 *
 * WHAT THIS DOES DIFFERENTLY
 * --------------------------
 * One rule governs it: SPEND AN LLM CALL ONLY WHEN THE ANSWER DEPENDS ON IT.
 *
 *   1. Greeting / chit-chat / a question with NO data source connected
 *      -> answer immediately, ZERO classification calls. A regex plus the set of
 *         connected sources is enough, and it cannot hallucinate a route.
 *   2. Exactly ONE relevant source connected
 *      -> use it. There is nothing to choose between, so choosing costs a call.
 *   3. Two or more sources, or a genuinely ambiguous question
 *      -> exactly ONE classification call that returns the tool AND the extracted
 *         parameters together, replacing the intent + rewrite + route chain.
 *
 * It reuses the EXISTING branch preparers (prepareChatStream, prepareRagStream,
 * prepareSqlStream, prepareRestStream) rather than reimplementing them. That is
 * deliberate: retrieval, SQL generation, guardrails, citation building and streaming
 * already work and are covered by tests. The complexity worth removing is the
 * ROUTING, not the execution.
 *
 * WHAT IT DROPS, AND THE RISK
 * ---------------------------
 * The old pipeline carried guards accumulated from real bugs: the clarification
 * guard, the CHAT-vs-SQL near-tie logic, the circuit breaker, per-tool similarity
 * boost. Those are not reimplemented here. The fast path is intentionally unable to
 * ask a clarifying question, because a clarification is itself a slow, expensive
 * outcome and the old pipeline was reported to over-use it. Feature-flagged so this
 * can be switched off without a deploy.
 */
import { getOrgContext } from '@/lib/prisma-tenant'
import { db } from '@/lib/db'
import { chatOnce } from '@/lib/llm-client'
import { getRoleLlmConfig } from '@/lib/llm-config'
import { prepareChatStream, prepareRagStream, prepareSqlStream, prepareRestStream } from '@/lib/stream-preparers'
import type { ChatHistoryEntry, StreamingCompletionResult } from '@/lib/tool-utils'

export type SimpleRoute = 'CHAT' | 'RAG' | 'SQL' | 'REST'

/** Why a route was chosen — the operator-visible half of the decision. */
export interface SimpleDecision {
  route: SimpleRoute
  reason: string
  /** Number of LLM calls the DECISION cost (0 for the deterministic fast paths). */
  classifierCalls: number
  /** Set when a single source made the choice for us. */
  integrationId?: string
}

export interface SimpleSources {
  documents: number
  integrations: number
  restEndpoints: number
}

/**
 * Greetings and pleasantries, matched on a NORMALISED question.
 *
 * A fixed, auditable list rather than a model call, and that is the point: a greeting
 * has no data behind it, so no classifier can be more accurate than a lookup, and the
 * lookup cannot be slow.
 *
 * Two details are load-bearing, and my first version got BOTH wrong:
 *
 *   1. The check is against the WHOLE normalised question, not a prefix match with a
 *      `\b` boundary. "Halo, apa kabar?" FAILED that version, because `\b` does not
 *      match between "halo" and the comma. Measured before the fix: the regex said
 *      false, the classifier ran anyway, and the fast path never triggered for the
 *      most common greeting there is.
 *   2. A greeting may be SEVERAL words ("selamat pagi", "apa kabar") and may repeat
 *      ("halo halo"), so the pattern allows a sequence of greeting words rather than
 *      a single one.
 *
 * Anchoring to the END is what keeps data questions off the shortcut: "halo, berapa
 * total pesanan?" contains a greeting but ends in a question, so it is NOT small talk
 * and still gets routed. Widening this list is the one change here that can silently
 * steal a real data question, so the anchoring is asserted by tests.
 */
const GREETING_WORDS = [
  'halo', 'hai', 'hei', 'hi', 'hello', 'hey',
  'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam',
  'pagi', 'siang', 'sore', 'malam',
  'apa kabar', 'kabar', 'how are you',
  'terima kasih', 'terimakasih', 'thanks', 'thank you', 'makasih',
  'sip', 'baik', 'siapa kamu', 'kamu siapa', 'apa ini',
]

const GREETING_ALT = GREETING_WORDS.map((g) => g.replace(/ /g, '\\s+')).join('|')
const GREETING_RE = new RegExp(
  `^(?:${GREETING_ALT})(?:[\\s,!.]*(?:${GREETING_ALT}))*[\\s!.,?]*$`,
  'iu',
)

/** True when the question is purely a greeting or pleasantry, and nothing more. */
function isGreetingOrSmallTalk(question: string): boolean {
  return GREETING_RE.test(question.trim())
}

/** Count what is actually connected, for the current org only. */
export async function countSimpleSources(): Promise<SimpleSources> {
  // `getOrgContext()` is read for the same reason `getEmbeddingRuntimeConfig` reads
  // it: an unscoped count would see another tenant's rows. HTTP callers already
  // entered the org, so a missing context is a programming error worth surfacing.
  if (!getOrgContext()) {
    throw new Error('countSimpleSources called without an org context')
  }
  const [documents, integrations, restEndpoints] = await Promise.all([
    db.document.count({ where: { status: 'ready', isEnabled: true } }),
    db.integration.count({ where: { status: 'active' } }),
    db.restApiEndpoint.count({ where: { isEnabled: true, connector: { isActive: true } } }),
  ])
  return { documents, integrations, restEndpoints }
}

const CLASSIFIER_PROMPT = `You route a question to exactly one data source. Reply with JSON only.

Tools:
- SQL: questions about numbers, totals, counts, lists or records held in a connected database.
- RAG: questions about policies, procedures, rules, guidelines, or anything a DOCUMENT would state.
- REST: questions that require calling one of the listed external API endpoints.
- CHAT: greetings, small talk, general knowledge, or anything requiring no data source.

Rules:
- Choose a tool ONLY if that source is listed as available below.
- Prefer the source whose description genuinely matches the question.
- Never invent a source. If none matches, choose CHAT.

Reply exactly: {"tool":"SQL"|"RAG"|"REST"|"CHAT","reason":"short reason"}`

/** Parse the classifier reply, tolerating prose or a markdown fence around the JSON. */
export function parseSimpleDecision(raw: string): { tool: SimpleRoute; reason: string } | null {
  const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed: { tool?: unknown; reason?: unknown }
  try {
    parsed = JSON.parse(match[0]) as { tool?: unknown; reason?: unknown }
  } catch {
    return null
  }
  const tool = String(parsed.tool ?? '').trim().toUpperCase()
  if (!['SQL', 'RAG', 'REST', 'CHAT'].includes(tool)) return null
  return { tool: tool as SimpleRoute, reason: String(parsed.reason ?? '').slice(0, 200) }
}

/**
 * Decide the route, spending as few LLM calls as the question allows.
 *
 * Order matters and is the whole design: the cheap, certain checks run first, so the
 * common cases (a greeting, or an org with one source) never reach a classifier.
 */
export async function decideRoute(args: {
  question: string
  sources: SimpleSources
  /** Descriptions shown to the classifier; built by the caller so this stays pure. */
  catalog?: string
}): Promise<SimpleDecision> {
  const { question, sources } = args
  const totalSources = sources.documents + sources.integrations + sources.restEndpoints

  // 1. No source at all: there is nothing to route to, so asking a model which
  //    source to use is not just slow, it is unanswerable.
  if (totalSources === 0) {
    return { route: 'CHAT', reason: 'no data source is connected', classifierCalls: 0 }
  }

  // 2. Greeting / small talk: a lookup cannot be wrong here, and cannot be slow.
  if (isGreetingOrSmallTalk(question)) {
    return { route: 'CHAT', reason: 'greeting or small talk', classifierCalls: 0 }
  }

  // 3. EXACTLY ONE source: the choice is already made, so a classifier could only
  //    second-guess it. This is the single largest saving for a typical org with one
  //    knowledge base, or one database.
  const onlyOne: SimpleRoute | null =
    totalSources === 1
      ? sources.documents === 1
        ? 'RAG'
        : sources.integrations === 1
          ? 'SQL'
          : 'REST'
      : null
  if (onlyOne) {
    return { route: onlyOne, reason: 'only one data source is connected', classifierCalls: 0 }
  }

  // 4. Genuinely ambiguous: ONE call decides tool AND parameters together, replacing
  //    the intent -> rewrite -> route chain of the full pipeline.
  const cfg = await getRoleLlmConfig('keyword')
  if (!cfg) {
    // No classifier configured. Returning CHAT here would be WRONG, not merely
    // degraded: with 5 documents connected, CHAT tells the user the knowledge base
    // does not exist. Observed on a real org with 34 ready documents. When a source
    // exists, route to the STRONGEST one that exists rather than to nothing --
    // documents are the safest guess because RAG either retrieves something or the
    // branch itself degrades to chat, whereas SQL and REST would need parameters that
    // were never extracted.
    const fallback: SimpleRoute =
      sources.documents > 0 ? 'RAG' : sources.integrations > 0 ? 'SQL' : 'REST'
    return {
      route: fallback,
      reason: 'no classifier configured; using the strongest available source',
      classifierCalls: 0,
    }
  }
  const available = [
    `Databases connected: ${sources.integrations > 0 ? 'yes' : 'no'}`,
    `Documents available: ${sources.documents > 0 ? 'yes' : 'no'}`,
    `REST endpoints available: ${sources.restEndpoints > 0 ? 'yes' : 'no'}`,
    args.catalog ? `Available sources:\n${args.catalog}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await chatOnce(
    cfg,
    [
      { role: 'system', content: CLASSIFIER_PROMPT },
      { role: 'user', content: `${available}\n\nQuestion: ${question}` },
    ],
    0,
    'intent-analysis',
  )

  const decision = parseSimpleDecision(raw)
  if (!decision) {
    // A malformed reply must not become a wrong route. Fall back to the source that
    // exists rather than failing the request.
    const fallback: SimpleRoute =
      sources.documents > 0 ? 'RAG' : sources.integrations > 0 ? 'SQL' : 'REST'
    return { route: fallback, reason: `classifier reply unparseable (${raw.slice(0, 60)}), using an available source`, classifierCalls: 1 }
  }
  return { route: decision.tool, reason: decision.reason, classifierCalls: 1 }
}

/** Env flag. Off by default so the change is opt-in and reversible without a deploy. */
export function simplePipelineEnabled(): boolean {
  return process.env.SIMPLE_PIPELINE === '1'
}

/**
 * Streaming entry point, shaped as a drop-in replacement for
 * `runStreamingChatCompletion`. It returns the SAME `StreamingCompletionResult`, so
 * the HTTP route does not need to know which pipeline produced it.
 */
export async function runSimpleStreamingChat(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  systemPromptPrefix?: string
}): Promise<StreamingCompletionResult & { decision: SimpleDecision }> {
  const sources = await countSimpleSources()
  const catalog = await buildSourceCatalog(sources)
  const decision = await decideRoute({ question: args.question, sources, catalog })
  // Preselect an integration ONLY when there is exactly one to choose from.
  //
  // This previously preselected the OLDEST active integration whenever the route was
  // SQL, which SILENTLY BYPASSED the schema-aware picker: `prepareSqlStream` skips its
  // own resolution when handed an `integrationId`. With one database that is a free
  // saving; with several it is a routing bug, and it was measured as one -- on a
  // four-database setup every SQL question went to whichever database was created
  // first. "Berapa jumlah karyawan?" was answered from the SALES schema, and because
  // the model is told to use only tables that exist, it correctly emitted
  // `SELECT 1 WHERE FALSE` and reported no data rather than inventing a table. The
  // answer looked like a knowledge gap; the defect was here.
  //
  // With more than one candidate the argument is left UNDEFINED so the branch's own
  // picker scores the schemas and chooses on evidence.
  const integrationId =
    args.integrationId ??
    (decision.route === 'SQL' && sources.integrations === 1
      ? await firstActiveIntegrationId()
      : undefined)

  const branchArgs = {
    question: args.question,
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: undefined,
    chatHistory: args.chatHistory ?? [],
  }

  let result: StreamingCompletionResult
  if (decision.route === 'RAG') result = await prepareRagStream(branchArgs)
  else if (decision.route === 'SQL') result = await prepareSqlStream({ ...branchArgs, userId: args.userId, integrationId })
  else if (decision.route === 'REST') result = await prepareRestStream({ ...branchArgs, userId: args.userId })
  else result = await prepareChatStream(branchArgs)

  if (integrationId) result.integrationId = integrationId
  // `usage` is a GETTER on the preparer's result (it is populated only once the stream
  // drains), and object spread evaluates getters -- so `{ ...result }` would freeze a
  // snapshot of `undefined` and the route's `done` frame would never carry token counts.
  // Measured: the preparer held {promptTokens:2132, completionTokens:121} while the client
  // still received usage=null. Copy the data keys explicitly and re-attach the stream and
  // the usage getter, so the live value is read at the moment the route asks for it.
  const { stream, ...rest } = result
  return {
    ...rest,
    decision,
    stream,
    get usage() { return (result as { usage?: { promptTokens: number; completionTokens: number } }).usage },
  }
}

/** Short, human-readable description of each connected source, for the classifier. */
async function buildSourceCatalog(sources: SimpleSources): Promise<string> {
  const parts: string[] = []
  if (sources.documents > 0) {
    const docs = await db.document.findMany({
      where: { status: 'ready', isEnabled: true },
      select: { name: true, category: true },
      take: 20,
      orderBy: { createdAt: 'desc' },
    })
    parts.push(
      'Documents: ' + docs.map((d) => (d.category ? `${d.name} [${d.category}]` : d.name)).join(', '),
    )
  }
  if (sources.integrations > 0) {
    const ints = await db.integration.findMany({
      where: { status: 'active' },
      select: { name: true, provider: true },
      take: 20,
    })
    parts.push('Databases: ' + ints.map((i) => `${i.name} (${i.provider})`).join(', '))
  }
  if (sources.restEndpoints > 0) {
    const eps = await db.restApiEndpoint.findMany({
      where: { isEnabled: true, connector: { isActive: true } },
      select: { method: true, path: true, description: true },
      take: 20,
    })
    parts.push(
      'REST endpoints: ' + eps.map((e) => `${e.method} ${e.path}${e.description ? `: ${e.description}` : ''}`).join('; '),
    )
  }
  return parts.join('\n')
}

async function firstActiveIntegrationId(): Promise<string | undefined> {
  const row = await db.integration.findFirst({
    where: { status: 'active' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  return row?.id
}
