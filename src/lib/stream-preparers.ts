import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getPromptSettings, resolveSqlRulesPrompt } from '@/lib/prompt-settings'
import { getOrgContext, requireOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import { SQL_REPAIR_ATTEMPTS, SQL_MAX_LIMIT , SQL_REPAIR_MIN_REMAINING_MS, SQL_REPAIR_TOTAL_BUDGET_MS } from '@/lib/constants'
import {
  generateRestCall,
  generateSql,
  streamAnswer,
  streamChat,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { RAG_ANSWER_TOP_K, settleRetrieval, type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { resolveIntegrationForQuestion, tokenize } from '@/lib/smart-router'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import { matchEndpoint } from '@/lib/rest-api-connectors'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import type { Citation } from '@/lib/types'
import {
  withSqlConcurrency,
  buildChartDataFromRows,
  buildDocumentCitation,
  summarize,
  safeParseColumns,
  safeParseSampleRow,
  extractTableName,
  jsonRowsToChart,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
import { executeRestRequest } from '@/lib/tool-branches'
import { buildSourceGuidance } from '@/lib/source-guidance'
import { judgeSqlAnswerability, type RelevanceJudge } from '@/lib/sql-answerability'
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
  /*
   * The scope filter, applied to ALL FIVE lookups in this branch.
   *
   * `null` means unrestricted — what every key created before this axis resolves to — so it is spread in
   * CONDITIONALLY rather than sent as `in: []`, which would match nothing and lock out every existing key.
   */
  const scopeIds = args.integrationIds && args.integrationIds.length > 0 ? args.integrationIds : null
  const inScope = scopeIds ? { id: { in: scopeIds } } : {}

  let integration = args.integrationId
    ? await db.integration.findFirst({
        where: { id: args.integrationId, status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : null

  // ponytail: this used to be an inline ~45-line keyword scorer ending in
  // `bestMatch ?? allIntegrations[0]` — a SECOND implementation that drifted from
  // the non-streaming path's `orderBy: { createdAt: 'asc' }` and from the
  // router's ambiguity-aware picker. The same question could therefore resolve to
  // a different database depending on transport, and when nothing matched both
  // fallbacks silently took the OLDEST source instead of refusing. Now delegated
  // to resolveIntegrationForQuestion so there is exactly one implementation.
  if (!integration) {
    /*
     * SCOPED, and this one changes BEHAVIOUR rather than only safety.
     *
     * `available` decides whether the single-source fast path or the "ambiguous — ask which" path is taken. An
     * unscoped count let a key restricted to ONE database count every database in the org, so it was asked to
     * disambiguate between sources it may not read: the operator would be shown a list of names the key cannot
     * access, and the single-source fast path it legitimately qualified for never ran.
     */
    const available = await db.integration.count({ where: { status: 'active', ...inScope } })
    if (available > 1) {
      const choice = await resolveIntegrationForQuestion(tokenize(args.question), args.question, 'refuse', args.integrationIds)
      if (!choice) {
        // Refuse to guess in a streaming turn too, and name the candidates.
        const names = await db.integration.findMany({
          where: { status: 'active', ...inScope },
          orderBy: { name: 'asc' },
          select: { name: true },
        })
        return prepareChatStreamWithNote(args, ambiguousStreamNote(names.map((n) => n.name)), started)
      }
      integration = await db.integration.findFirst({
        where: { id: choice.integrationId, status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    } else {
      integration = await db.integration.findFirst({
        where: { status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    }
  }

  if (!integration || integration.schemas.length === 0) {
    return prepareChatStream(args)
  }

  const schemaDescription = describeSchema(
    integration.schemas.map((schema) => ({
      tableName: schema.tableName,
      columns: safeParseColumns(schema.columns),
      rowCount: schema.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(schema.sampleRow),
      description: schema.description,
    })),
  )
  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  /*
   * The org's editable Text-to-SQL rules.
   *
   * This path previously read NO prompt settings at all, so an admin editing them would see the
   * change apply to scheduled runs and /api/v1 (which use runSqlBranch) while the interactive chat
   * — the place they were testing — kept the old behaviour. Resolved once per request, not per
   * repair attempt.
   */
  const sqlRules = resolveSqlRulesPrompt((await getPromptSettings(db)).sqlRulesPrompt)
  // ponytail: SQL error-correction loop, streaming twin of runSqlBranch's.
  // A failed execution feeds the DB error back to generateSql for a corrected
  // retry instead of ending the turn with a canned apology.
  let lastSqlError = ''
  const attemptedSql: string[] = []
  let executed: Awaited<ReturnType<typeof connector.executeQuery>> | null = null
  let finalSql = ''
  /** The SQL generator's stated scope, forwarded to the answer so it can name the population it measured. */
  let sqlExplanation = ''

  for (let attempt = 0; attempt <= SQL_REPAIR_ATTEMPTS; attempt++) {
    /*
     * TIME BUDGET BEFORE EVERY RETRY — the streaming twin of tool-branches' check, with the same rule:
     * attempt 0 always runs, and a retry only starts when one attempt's worst case still fits. The loop
     * previously counted attempts and never the clock, so a retry could begin with the route's deadline
     * already spent. Both transports must carry the check or the one that does not becomes the slow path
     * that re-introduces the defect — the transport-drift class this repo has recorded three times.
     */
    if (attempt > 0 && Date.now() - started + SQL_REPAIR_MIN_REMAINING_MS() > SQL_REPAIR_TOTAL_BUDGET_MS()) {
      log.warn('sql repair loop: not enough budget left for another attempt', {
        elapsedMs: Date.now() - started,
        budgetMs: SQL_REPAIR_TOTAL_BUDGET_MS(),
        attemptsDone: attempt,
      })
      break
    }
    const feedback = attempt > 0
      ? `The previous SQL was:\n${attemptedSql[attemptedSql.length - 1]}\nIt failed with error:\n${lastSqlError}`
      : undefined
    // ponytail: generateSql MUST be inside a try. It was not, and only the SQL
    // EXECUTION was guarded, so an LLM failure (provider down, dead BYOK key,
    // timeout — all of which throw) escaped prepareSqlStream entirely. The
    // caller has already promised the client an SSE stream by that point, so the
    // turn died with the connection open and ZERO frames sent: the UI showed
    // nothing at all, not even an error. Found by stream-preparers.test.ts,
    // which is the first test ever to exercise this path.
    let candidate: Awaited<ReturnType<typeof generateSql>>
    try {
      candidate = await generateSql({
        question: args.question,
        schemaDescription,
        provider: integration.provider,
        memoryContext: args.memoryContext,
        systemPromptPrefix: args.systemPromptPrefix,
        businessContext: integration.businessContext,
        repairFeedback: feedback,
        sqlRules,
      })
    } catch (e) {
      // A transient provider blip must not end the turn; the repair loop retries.
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(`<generation failed: ${lastSqlError}>`)
      continue
    }
    /*
     * The generator's own EXPLANATION, kept because rule 17 puts the measured population there.
     *
     * MEASURED IN UAT: `/send` — the path the chat UI uses — streams through HERE, not through `tool-branches.ts`. A
     * fix applied only to the non-streaming branch therefore changed nothing a user could see, which a probe
     * confirmed: the branch's log line never fired while the chat kept answering normally. Only `candidate.sql` was
     * used here; `explanation` was dropped, so the answer generator never learned which rows the SQL had counted.
     */
    sqlExplanation = typeof candidate.explanation === 'string' ? candidate.explanation.trim() : ''
    const guard = validateAndSanitizeLlmSql(candidate.sql)
    if (!guard.ok) {
      lastSqlError = guard.reason ?? 'SQL rejected by guardrail'
      attemptedSql.push(candidate.sql)
      continue // guardrail rejection is retryable
    }
    const sanitizedSql = guard.sanitized
    try {
      // ponytail: retry on transient connection errors (ECONNRESET is common
      // with remote PRINASA DB under load — a single retry recovers most cases).
      let result: Awaited<ReturnType<typeof connector.executeQuery>>
      try {
        result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sanitizedSql))
      } catch (e) {
        if (/ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(e instanceof Error ? e.message : String(e))) {
          await new Promise((r) => setTimeout(r, 1000))
          result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sanitizedSql))
        } else {
          throw e
        }
      }
      executed = result
      finalSql = sanitizedSql
      break
    } catch (e) {
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(sanitizedSql)
    }
  }

  if (!executed) {
    const errMsg = lastSqlError
    return {
      toolRuns: [{
        type: 'SQL',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: '',
        errorMessage: errMsg.slice(0, 500),
      }],
      citations: [],
      chartData: null,
      stream: streamAnswer({
        question: args.question,
        context: `SQL execution error after ${SQL_REPAIR_ATTEMPTS + 1} attempts: ${errMsg}`,
        source: 'SQL',
        systemPromptPrefix: args.systemPromptPrefix,
        memoryContext: args.memoryContext,
        chatHistory: args.chatHistory,
      }),
    }
  }

  const result = executed

  /*
   * SECOND CHANCE FOR THE DOCUMENTS — only when the database provably did not answer.
   *
   * The router chose this source from the question's wording, and where a database and a document set both cover a
   * topic that choice is wrong for a small, predictable class of questions: ones phrased like a data query whose
   * answer is a POLICY figure ("berapa jam pelatihan per tahun …"). MEASURED: 5.7% of document questions in an eval
   * reached this branch, almost all of them from two phrasings, and each ended as "cannot be computed" or a
   * confident wrong number. The verdict is read off the ROWS (empty, all-NULL, or the generator's improvised "I
   * cannot answer" placeholder), never off the answer's wording, and a relevance judge is only consulted on rows that
   * look populated.
   *
   * Never a REPLACEMENT: when the rows answer, this does nothing, and the extra retrieval is only attempted when
   * documents exist and the user did not pin this database. If the documents have nothing either, the database's own
   * "no data" answer is what the user gets, exactly as before.
   */
  if (!args.userPinnedIntegration) {
    const fallback = await tryDocumentsAfterSqlMiss(args, result.rows, started)
    if (fallback) return fallback
  }

  /*
   * The measured population travels WITH the rows, inside the untrusted wrapper (it is model-generated text ABOUT the
   * data, so it must not acquire system authority). Without it the answer cannot say which rows it counted — which is
   * the entire point of rule 17, and the reason two questions in one UAT session reported Rp 1.240.000 and Rp 1.620.000
   * for the same customer without either answer mentioning a filter.
   */
  const context =
    (sqlExplanation ? `QUERY SCOPE (what the SQL measured): ${sqlExplanation}\n\n` : '') +
    wrapUntrusted('CONTEXT (DATABASE ROWS):', JSON.stringify(result.rows, null, 2))
  const chartData = buildChartDataFromRows(result.rows)
  /*
   * The same two-rule note as the non-streaming twin (see `crossSourceNote` in tool-branches.ts for the measurement
   * and both rules). Kept as a deliberate duplicate: the two transports have drifted on shared wording before, and a
   * shared helper would hide that this path was MISSING the note entirely rather than wording it differently.
   */
  const otherSources = (args.integrationNames ?? []).filter((n) => n !== integration.name)
  const crossSourceNote =
    otherSources.length > 0
      ? `Other connected data sources in this workspace: ${otherSources.join(', ')}. ` +
        `This answer uses ${integration.name} ONLY. Two rules follow, and BOTH apply:\n` +
        `1. If the question asks you to compare or combine this result with something those sources would hold, say ` +
        `plainly that THIS ANSWER COVERS ONLY ${integration.name} and name what was not included. Never present a ` +
        `figure from this source as if it described another one.\n` +
        `2. If the question asks about "all", "every", "the system", "the workspace", or the TOTAL amount of data, ` +
        `then this source CANNOT answer it alone: state that the figure covers only ${integration.name}, name the ` +
        `other sources (${otherSources.join(', ')}) that were NOT included, and offer to run it per source. Never ` +
        `present a count from ${integration.name} as the count for the workspace.\n\n`
      : ''
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'SQL',
    systemPromptPrefix: crossSourceNote + (args.systemPromptPrefix ?? ''),
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
