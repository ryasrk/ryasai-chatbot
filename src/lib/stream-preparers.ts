import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getPromptSettings } from '@/lib/prompt-settings'
import { requireOrgContext } from '@/lib/prisma-tenant'
import { SQL_REPAIR_ATTEMPTS, SQL_MAX_LIMIT } from '@/lib/constants'
import {
  generateRestCall,
  streamAnswer,
  streamChat,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { RAG_ANSWER_TOP_K, settleRetrieval, type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import { matchEndpoint } from '@/lib/rest-api-connectors'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import type { Citation } from '@/lib/types'
import {
  buildChartDataFromRows,
  buildDocumentCitation,
  summarize,
  extractTableName,
  jsonRowsToChart,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
import { executeRestRequest } from '@/lib/tool-branches'
import { buildSourceGuidance } from '@/lib/source-guidance'
import { judgeSqlAnswerability, type RelevanceJudge } from '@/lib/sql-answerability'
import { runSqlPipeline, buildCrossSourceNote } from '@/lib/pipelines/sql-pipeline'
import { chatOnce } from '@/lib/llm-client'
import { getRoleLlmConfig } from '@/lib/llm-config'

const log = scopedLogger('stream-preparers')

// ---------------------------------------------------------------------------
// Streaming branch preparers — one per RouteDecision.
// Called by runStreamingChatCompletion in tool-router.ts.
// Each returns a StreamingCompletionResult with an AsyncGenerator stream.
// ----------------------------------------------------------------------------

export async function prepareContextualChatStream(args: {
  question: string
  context: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context: args.context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
  })
  return {
    toolRuns: [{
      type: 'CHAT',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(args.context),
    }],
    citations: [],
    chartData: null,
    stream,
  }
}

export async function prepareChatStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  // `usage` arrives only after the stream ends, so it is captured here and read by the
  // route once the stream drains. Exposed as a getter, never a value: object spread
  // evaluates getters, and a snapshot taken at return time is always undefined.
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamChat(args.question, args.memoryContext, args.systemPromptPrefix, args.chatHistory, (u) => {
    usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens }
  })
  return {
    toolRuns: [{
      type: 'CHAT',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
    }],
    citations: [],
    chartData: null,
    stream,
    get usage() { return usage },
  }
}

export async function prepareRagStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
  /** Retrieval scope from the caller's API key and request. `null`/absent = every document. */
  documentIds?: string[] | null
  /** Retrieval the router started alongside intent analysis; reused only when it was started for exactly this request. */
  speculativeRetrieval?: SpeculativeRetrieval | null
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  let retrieval: Awaited<ReturnType<typeof retrieveWithReflection>>
  try {
    const request = { query: args.question, topK: RAG_ANSWER_TOP_K, documentIds: args.documentIds }
    retrieval = await settleRetrieval(args.speculativeRetrieval, request, () => retrieveWithReflection(request))
  } catch (e) {
    /*
     * Same recording as the non-streaming twin: the fallback is correct, but it must not be SILENT. The
     * tool run carries `DEGRADED from RAG` with the failure reason, so the audit trail distinguishes
     * "answered from chat because retrieval failed" from an ordinary chat turn — the verified weakness
     * was precisely that the two looked identical.
     */
    log.warn('RAG retrieval failed; answering from chat', {
      error: e instanceof Error ? e.message : String(e),
    })
    const degraded = await prepareChatStream({ ...args })
    return {
      ...degraded,
      toolRuns: degraded.toolRuns.map((run) =>
        run.type === 'CHAT' && run.status === 'success'
          ? { ...run, outputSummary: summarize(`DEGRADED from RAG: ${e instanceof Error ? e.message : String(e)}`) }
          : run,
      ),
    }
  }
  const topChunks = retrieval.chunks
  // An empty corpus is NOT degraded (see the twin's comment): retrieval ran and found nothing.
  if (topChunks.length === 0 && !retrieval.graphContext) return prepareChatStream(args)

  const chunkContext = topChunks
    .map((item) => `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`)
    .join('\n\n---\n\n')

  // Same framing as the non-streaming RAG branch — untrusted document text must
  // be marked as data on BOTH transports, or the two drift (this class of
  // transport drift has now bitten three times in this codebase).
  const context = retrieval.graphContext
    ? `${wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)}\n\n${wrapUntrusted('CONTEXT (KNOWLEDGE GRAPH):', retrieval.graphContext)}`
    : wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)

  /*
   * THIS IS THE BRANCH THE WEB CHAT USES, so anything the non-streaming twin does
   * to the context must be done here too — and it was not. `runRagBranch` gained
   * the reflection note and the source-guidance injection in the UAT round-2 fix,
   * but `prepareRagStream` kept sending the bare evidence: the fix was live only
   * on the transport nothing calls (`/api/documents/search` and the agentic
   * loop), while the answer the customer actually read was produced here.
   * MEASURED: asked to refund a complaining customer, the UI answered "there is
   * no refund procedure in the available sources" while chunk #2 of
   * `02-sop-layanan-pelanggan.md` contained that procedure verbatim.
   * Both blocks below are intentional duplicates of src/lib/tool-branches.ts —
   * see the comment there for why the note is worded the way it is.
   */
  const reflectionNote = !retrieval.reflection.sufficient && retrieval.retrievalPasses >= 2
    ? `\n\n[Note: The retrieved evidence may not fully address the question. Answer based only on the evidence above.` +
      ` If the answer is not in the evidence, say that YOUR SEARCH did not find it — phrase it as "saya tidak` +
      ` menemukan ini dalam dokumen yang terambil" — and do NOT claim the document or policy does not exist,` +
      ` because the search may simply have missed it. Never state that a procedure or figure is absent from the` +
      ` documents; state only what you did not find.]`
    : ''

  // Per-document contextPrompts + the org ragContextPrompt, in retrieval order.
  // Empty prompts inject nothing (buildSourceGuidance returns '').
  const distinctDocIds: string[] = []
  for (const c of topChunks) {
    if (c.documentId && !distinctDocIds.includes(c.documentId)) distinctDocIds.push(c.documentId)
  }
  let sourceGuidance = ''
  if (distinctDocIds.length > 0) {
    const docs = await db.document.findMany({
      where: { id: { in: distinctDocIds } },
      select: { id: true, name: true, contextPrompt: true },
    })
    const byId = new Map(docs.map((d) => [d.id, d]))
    const docPrompts = distinctDocIds
      .map((id) => byId.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .filter((d) => d.contextPrompt && d.contextPrompt.trim())
      .map((d) => ({ name: d.name, content: d.contextPrompt! }))
    const orgPrompt = (await getPromptSettings(db)).ragContextPrompt
    sourceGuidance = buildSourceGuidance(docPrompts, { budget: 2000, orgPrompt })
  }
  const contextWithGuidance = sourceGuidance ? `${sourceGuidance}\n\n${context}` : context

  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context: contextWithGuidance + reflectionNote,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
  })

  const citations = topChunks.map((item) =>
    buildDocumentCitation({
      documentName: item.documentName,
      chunkIndex: item.chunkIndex,
      // The chunk's OWN text: `content` leads with the document summary, which would be every citation's snippet.
      content: item.ownContent ?? item.content,
      score: item.score,
      // Carried, not re-derived: `retrieveWithReflection` re-stamped this list after the merge, and the
      // answer path concatenates several tool runs' citations, so the array index is not the rank.
      rank: item.rank,
    }),
  )

  await db.auditLog.create({
    data: {
      organizationId: requireOrgContext(),
      userId: null,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: JSON.stringify({
        query: args.question,
        returned: topChunks.length,
        candidatesScanned: retrieval.candidatesScanned,
        queryTokens: retrieval.queryTokens,
        topScore: topChunks[0]?.score ?? 0,
      }),
    },
  })

  return {
    toolRuns: [{
      type: 'RAG',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(context),
    }],
    citations,
    chartData: null,
    stream,
    get usage() { return usage },
    citationTrail: retrieval.citationTrail,
  }
}

/**
 * Message shown when we refuse to guess the data source in a streaming turn.
 * Kept next to the non-streaming twin (ambiguousDataSourceResult in tool-utils)
 * so the two wordings stay recognisably the same behaviour to the user.
 */
function ambiguousStreamNote(names: string[]): string {
  const list = names.slice(0, 10)
  const more = names.length > list.length ? ` (and ${names.length - list.length} more)` : ''
  return (
    `I could not tell which data source this question refers to, and I do not want to guess ` +
    `and answer from the wrong database. Available sources${more}: ${list.join(', ')}. ` +
    `Please name the source you mean — for example "in ${list[0] ?? 'the sales database'}, ...".`
  )
}

/** Stream a plain note (no SQL) as the assistant's answer. */
function prepareChatStreamWithNote(
  args: { question: string; systemPromptPrefix?: string; memoryContext?: string; chatHistory?: ChatHistoryEntry[] },
  note: string,
  started: number,
): StreamingCompletionResult {
  const stream = (async function* () { yield note })()
  return {
    toolRuns: [{
      type: 'SQL',
      status: 'blocked',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      errorMessage: 'Ambiguous data source — refusing to guess.',
    }],
    citations: [],
    chartData: null,
    stream,
  }
}

export async function prepareSqlStream(args: {
  question: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
  /**
   * The API-key document scope, declared here because the router passes `branchArgs` by SPREAD — the value
   * already arrived at runtime, and without this declaration it was discarded at the type boundary.
   *
   * Exactly the shape this review kept finding: `...args` carrying a field the callee's type never named, so
   * the argument is dropped silently and nothing reports it.
   */
  documentIds?: string[] | null
  /**
   * The API-key scope's allowed integrations, or `null` for every source.
   *
   * The streaming sibling of `runSqlBranch`'s parameter. Both transports auto-select an integration when the
   * question does not name one, so both must be filtered — and this path has FIVE such lookups, which is why
   * the axis could not be corrected in one place.
   */
  integrationIds?: string[] | null
  /**
   * The user explicitly pinned a database for this turn. A pin is a request to answer from THAT source, so the
   * documents fallback is not attempted: silently answering from a different source than the one the user chose
   * would contradict the control they used. Absent/false means the database was the ROUTER's choice, which is the
   * only case the fallback exists for.
   */
  userPinnedIntegration?: boolean
  /** Injected for tests; production uses the model-backed judge below. */
  relevanceJudge?: RelevanceJudge
  /**
   * The org's OTHER active data sources, so the answer can say which source it used.
   *
   * The non-streaming twin has carried this as `crossSourceNote` for a while; THIS transport never did, and this is
   * the transport the web chat uses. MEASURED consequence with three databases connected: "Berapa banyak data yang
   * tersimpan di sistem?" was answered "total 45 baris data ... di empat tabel utama" from ONE database (citation:
   * `ZZ Sales.pelanggan`) while the three hold 104 rows across 12 tables — a confident strict subset presented as the
   * whole, with nothing in the answer saying the other sources were not consulted. Declared, not inferred: the router
   * passes `branchArgs` by SPREAD, so a field the callee's type never names is dropped silently (the shape this file
   * has already been bitten by on this exact axis).
   */
  integrationNames?: string[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const outcome = await runSqlPipeline(args)

  // Refuse to guess in a streaming turn too, and name the candidates.
  if (outcome.kind === 'ambiguous') return prepareChatStreamWithNote(args, ambiguousStreamNote(outcome.candidates), started)
  if (outcome.kind === 'unavailable') return prepareChatStream(args)
  if (outcome.kind === 'rate_limited') {
    return {
      toolRuns: [{
        type: 'SQL',
        status: 'blocked',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: '',
        errorMessage: 'SQL rate limit exceeded.',
      }],
      citations: [],
      chartData: null,
      integrationId: outcome.integration.id,
      stream: singleChunkStream('Rate limit exceeded for SQL queries. Please try again in a minute.'),
    }
  }
  if (outcome.kind === 'failed') {
    return {
      toolRuns: [{
        type: 'SQL',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: '',
        errorMessage: outcome.lastError.slice(0, 500),
      }],
      citations: [],
      chartData: null,
      stream: streamAnswer({
        question: args.question,
        context: `SQL execution error after ${SQL_REPAIR_ATTEMPTS + 1} attempts: ${outcome.lastError}`,
        source: 'SQL',
        systemPromptPrefix: outcome.systemPromptPrefix,
        memoryContext: args.memoryContext,
        chatHistory: args.chatHistory,
      }),
    }
  }

  const { integration, result, finalSql, sqlExplanation } = outcome

  /*
   * SECOND CHANCE FOR THE DOCUMENTS — only when the database provably did not answer.
   *
   * Where a database and a document set both cover a topic, the router is wrong for a small, predictable class of
   * questions phrased like a data query whose answer is a POLICY figure. MEASURED: 5.7% of document questions in an
   * eval reached this branch. The verdict is read off the ROWS, never off the answer's wording, and when the rows
   * answer this does nothing. A pinned database is never second-guessed.
   */
  if (!args.userPinnedIntegration) {
    const fallback = await tryDocumentsAfterSqlMiss(args, result.rows, started)
    if (fallback) return fallback
  }

  // The measured population travels WITH the rows, inside the untrusted wrapper (rule 17).
  const context =
    (sqlExplanation ? `QUERY SCOPE (what the SQL measured): ${sqlExplanation}\n\n` : '') +
    wrapUntrusted('CONTEXT (DATABASE ROWS):', JSON.stringify(result.rows, null, 2))
  const chartData = buildChartDataFromRows(result.rows)
  const crossSourceNote = buildCrossSourceNote(integration.name, args.integrationNames)
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'SQL',
    systemPromptPrefix: crossSourceNote + (outcome.systemPromptPrefix ?? ''),
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    rowCount: result.rowCount,
    truncated: result.rowCount >= SQL_MAX_LIMIT,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
  })

  const citations: Citation[] = [
    {
      type: 'DATABASE',
      source: `${integration.name}.${extractTableName(finalSql)}`,
      query_used: finalSql,
    },
  ]

  return {
    toolRuns: [{
      type: 'SQL',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(finalSql),
    }],
    citations,
    chartData,
    integrationId: integration.id,
    stream,
    get usage() { return usage },
  }
}

async function* singleChunkStream(text: string): AsyncGenerator<string, void, unknown> {
  yield text
}

/**
 * The model-backed relevance judge. Same contract as the one measured in the eval: it must say "answers" only when
 * the rows hold the specific value asked for. Returns `true` (keep the rows) whenever it cannot decide, because a
 * judge outage must never turn a working database answer into a fallback.
 */
const defaultRelevanceJudge: RelevanceJudge = async (question, rows) => {
  const cfg = await getRoleLlmConfig('query')
  if (!cfg) return true
  const raw = String(await chatOnce(cfg, [
    {
      role: 'system',
      content:
        'You judge whether a database result can answer a question. Reply ONLY with JSON {"answers": true|false}. ' +
        '"answers" is true ONLY when the rows contain the specific value the question asks for. It is false when the ' +
        'rows are unrelated records, a placeholder, NULL, or a message saying the data is unavailable.',
    },
    { role: 'user', content: `Question: ${question}\nRows (${rows.length}): ${JSON.stringify(rows.slice(0, 5)).slice(0, 600)}` },
  ], 0, 'sql-answerability'))
  if (/"answers"\s*:\s*false/i.test(raw)) return false
  return true
}

/**
 * Try the document corpus when the SQL result did not answer. Returns `null` — meaning "keep the database answer" —
 * unless the rows are provably unhelpful AND the documents actually produced evidence. The documents' own result is
 * returned as-is, so it carries its citations, reflection note and source guidance exactly like a routed RAG turn.
 */
async function tryDocumentsAfterSqlMiss(
  args: {
    question: string
    systemPromptPrefix?: string
    memoryContext?: string
    chatHistory?: ChatHistoryEntry[]
    documentIds?: string[] | null
    relevanceJudge?: RelevanceJudge
  },
  rows: ReadonlyArray<Record<string, unknown>>,
  started: number,
): Promise<StreamingCompletionResult | null> {
  const verdict = await judgeSqlAnswerability({
    question: args.question,
    rows,
    judge: args.relevanceJudge ?? defaultRelevanceJudge,
  })
  if (verdict.answers) return null

  const docScope = args.documentIds && args.documentIds.length > 0 ? { id: { in: args.documentIds } } : {}
  const documents = await db.document.count({ where: { status: 'ready', isEnabled: true, ...docScope } })
  if (documents === 0) return null

  const viaDocuments = await prepareRagStream({
    question: args.question,
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    documentIds: args.documentIds,
  })
  // `prepareRagStream` degrades to plain CHAT when retrieval found nothing, and that carries no citations. Taking it
  // would trade a real "the database has no data" answer for a general-knowledge reply, so it is not accepted.
  if (viaDocuments.citations.length === 0) return null

  return {
    ...viaDocuments,
    // Both attempts are recorded, so the audit trail shows that the database was tried and why it was not used.
    toolRuns: [
      {
        type: 'SQL',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: `not used: ${verdict.reason}`,
      },
      ...viaDocuments.toolRuns,
    ],
  }
}

export async function prepareRestStream(args: {
  question: string
  userId: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const connectors = await db.restApiConnector.findMany({
    where: { isActive: true },
    include: {
      endpoints: {
        where: { isEnabled: true },
        orderBy: [{ method: 'asc' }, { path: 'asc' }],
        // The prompt caps how many endpoints it lists (see generateRestCall); more than this can never be
        // shown, so loading them is wasted work — and the payload grows with every enabled endpoint.
        take: 40,
      },
    },
  })
  const endpointOptions: RestEndpointOption[] = connectors.flatMap((c) =>
    c.endpoints.map((e) => ({
      id: e.id,
      connectorName: c.name,
      method: e.method,
      path: e.path,
      description: e.description,
      parameterSchema: e.parameterSchema,
      sampleResponse: e.sampleResponse,
    })),
  )

  if (endpointOptions.length === 0) return prepareChatStream(args)

  // ponytail: same leak prepareSqlStream had. `generateRestCall` is an LLM call
  // that throws on a dead provider/key/timeout, and it sat outside any try — so
  // a BYOK failure killed the turn after the SSE stream was already promised,
  // leaving the client with an open connection and no frames. The caller can
  // recover from this, so answer as CHAT instead.
  let plan: Awaited<ReturnType<typeof generateRestCall>>
  try {
    plan = await generateRestCall({
      question: args.question,
      endpoints: endpointOptions,
      memoryContext: args.memoryContext,
    })
  } catch {
    return prepareChatStream(args)
  }
  const selected = endpointOptions.find((e) => e.id === plan.endpointId)
  if (!selected) return prepareChatStream(args)

  const connector = connectors.find((c) =>
    c.endpoints.some((e) => e.id === selected.id),
  )
  if (!connector) return prepareChatStream(args)

  const endpoint = matchEndpoint(
    selected.method,
    selected.path,
    connector.endpoints.map((e) => ({ id: e.id, method: e.method, path: e.path, enabled: e.isEnabled })),
  )
  if (!endpoint) return prepareChatStream(args)

  const result = await executeRestRequest({
    connector,
    endpointId: endpoint.id,
    method: selected.method,
    path: selected.path,
    plan,
  })

  if (!result.ok) {
    return {
      toolRuns: [{
        type: 'REST_API',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: result.error,
        restApiEndpointId: endpoint.id,
      }],
      citations: [],
      chartData: null,
      stream: streamChat(
        `The REST API request failed: ${result.error}. ${args.question}`,
        args.memoryContext, args.systemPromptPrefix, args.chatHistory,
      ),
    }
  }

  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context: result.bodyText,
    source: 'REST_API',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
  })

  const citations: Citation[] = [
    {
      type: 'REST_API',
      source: `${connector.name} ${selected.method} ${selected.path}`,
      query_used: JSON.stringify({ query: plan.query, explanation: plan.explanation }),
    },
  ]

  return {
    toolRuns: [{
      type: 'REST_API',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.bodyText),
      restApiEndpointId: endpoint.id,
    }],
    citations,
    chartData: jsonRowsToChart(result.body),
    stream,
    get usage() { return usage },
  }
}

export async function preparePluginStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const relevant = await selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05, context: 'chat' })
  const chatRelevant = relevant.filter((p) => p.chatEnabled)
  if (chatRelevant.length === 0) return prepareChatStream(args)

  const plugin = await db.plugin.findFirst({ where: { toolId: chatRelevant[0].toolId, isEnabled: true } })
  if (!plugin) return prepareChatStream(args)

  const result = await executePlugin({
    plugin: { manifestJson: plugin.manifestJson, toolId: plugin.toolId },
    input: JSON.stringify({ question: args.question, query: args.question }),
  })

  if (!result.ok) {
    return {
      toolRuns: [{
        type: 'PLUGIN',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: result.error,
      }],
      citations: [],
      chartData: null,
      stream: streamChat(
        `Plugin ${plugin.name} failed: ${result.error}. ${args.question}`,
        args.memoryContext, args.systemPromptPrefix, args.chatHistory,
      ),
    }
  }

  // Plugin output is third-party and therefore untrusted too.
  const context = `${wrapUntrusted(`CONTEXT (PLUGIN ${plugin.name}):`, result.output)}\n\nUser question: ${args.question}`
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
  })

  return {
    toolRuns: [{
      type: 'PLUGIN',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.output),
    }],
    citations: [],
    chartData: null,
    stream,
    get usage() { return usage },
  }
}
