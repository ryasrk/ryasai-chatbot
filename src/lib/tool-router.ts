import { db } from '@/lib/db'
import { narrowDocumentScope, resolveUserRole } from '@/lib/access-scope'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { pickBestIntegration, pickBestIntegrationByKeywords, tokenize } from '@/lib/smart-router'
import { cancelSpeculativeRetrieval, startSpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { selectToolWithLlm } from '@/lib/tool-selector'
import { analyzeIntent, rewriteQuery } from '@/lib/intent-pipeline'
import { getPromptSettings } from '@/lib/prompt-settings'
import { recallContext, rememberChatTurn } from '@/lib/cognee'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

export {
  withSqlConcurrency, buildChartDataFromRows, buildDocumentCitation,
  sanitizeSqlError, summarize, stripSessionWrapper,
  type PendingToolRun, type CompletionResult, type ChatHistoryEntry, type StreamingCompletionResult,
} from '@/lib/tool-utils'
export { parseRestCallJson } from '@/lib/ai'

import {
  stripSessionWrapper,
  type CompletionResult, type ChatHistoryEntry, type StreamingCompletionResult,
} from '@/lib/tool-utils'
import {
  runChatBranch, runContextualChatBranch, runRagBranch, runSqlBranch, runRestBranch, runPluginBranch,
} from '@/lib/tool-branches'
import {
  prepareChatStream, prepareContextualChatStream, prepareRagStream, prepareSqlStream, prepareRestStream, preparePluginStream,
} from '@/lib/stream-preparers'
import { runMultiStepDag, runAgenticLoop, runStreamingAgenticLoop } from '@/lib/tool-router-agentic'
import { withUsageTracking } from '@/lib/llm-client'

export function chooseAvailableDecision(
  decision: RouteDecision,
  available: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean },
): RouteDecision {
  if (decision === 'CONTEXTUAL_CHAT') return 'CONTEXTUAL_CHAT'
  if (decision === 'PLUGIN') return 'PLUGIN'
  if (decision === 'SQL' && !available.hasIntegrations) return 'CHAT'
  if (decision === 'RAG' && !available.hasDocuments) return 'CHAT'
  if (decision === 'REST' && !available.hasRestApis) return 'CHAT'
  return decision
}

export async function runNonStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  signal?: AbortSignal
  /**
   * Restrict retrieval to these documents. `null`/absent = every document.
   *
   * Declared on BOTH public signatures and copied into `branchArgs` by spread, so every branch that
   * reads documents receives it — including a branch added later, which cannot silently miss it by
   * forgetting a field. Returning to the caller is what makes the API-key scope reach retrieval.
   */
  documentIds?: string[] | null
  /**
   * The API-key scope's allowed integrations, or `null` for every source.
   *
   * Companion to `documentIds` on the same axis. Without it the SQL branch auto-selected from EVERY active
   * integration, so a key restricted to one database could be routed to another by keyword scoring — the
   * "computed and dropped" shape `effectiveScope.integrationIds` had.
   */
  integrationIds?: string[] | null
}): Promise<CompletionResult> {
  return withUsageTracking(async () =>
    _runNonStreamingChatCompletion({ ...args, documentIds: await documentScopeForUser(args.userId, args.documentIds) }),
  )
}

/**
 * The document scope narrowed to what the caller's ROLE may read (`Document.allowedRoles`, access-scope.ts).
 *
 * Applied at the two public entry points so every branch below — RAG, the SQL→documents fallback, speculative
 * retrieval, the agentic loop and the graph recall — receives the already-narrowed `documentIds` they all honour.
 * Admin (and therefore API-key and scheduled turns, which run as the org admin under the key's own scope) is
 * unchanged.
 */
async function documentScopeForUser(userId: string, requested: string[] | null | undefined): Promise<string[] | null> {
  return narrowDocumentScope(await resolveUserRole(userId), requested)
}

async function _runNonStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  signal?: AbortSignal
  documentIds?: string[] | null
  /**
   * The API-key scope's allowed integrations, or `null` for every source.
   *
   * Companion to `documentIds` on the same axis. Without it the SQL branch auto-selected from EVERY active
   * integration, so a key restricted to one database could be routed to another by keyword scoring — the
   * "computed and dropped" shape `effectiveScope.integrationIds` had.
   */
  integrationIds?: string[] | null
}): Promise<CompletionResult> {
  /**
   * Remember the turn, then return the answer — ONE exit point for the memory write.
   *
   * WHY THIS WRAPPER EXISTS. The write used to sit AFTER the branch dispatch, so every earlier
   * `return` skipped it. MEASURED on the production install: a chat through
   * `/api/v1/chat/completions` produced NO `remember` request at all, and a recall 180s later found
   * nothing — because a CHAT turn returns at the `!intent.needsRetrieval` line BELOW the write, and a
   * multi-step turn returns from the DAG. Memory looked wired and stored nothing for the two most
   * common kinds of turn.
   *
   * `void` keeps the answer off the write's critical path — a write measures 5.6-9.7s, and 85s on a
   * fresh dataset, and awaiting it once hung a request past its 90s timeout. `rememberChatTurn` logs
   * its own failures, so a memory problem stays visible without reaching the caller.
   */
  const remember = (answer: CompletionResult): CompletionResult => {
    void rememberChatTurn({
      sessionId: args.sessionId,
      userMessage: args.question,
      aiMessage: answer.answer,
      toolRuns: answer.toolRuns.map((t) => ({ type: t.type, status: t.status, latencyMs: t.latencyMs ?? 0 })),
    })
    return answer
  }

  if (args.allowMultiStepDag && args.chatHistory && args.chatHistory.length > 0) {
    const result = await runAgenticLoop({
      question: args.question, userId: args.userId, sessionId: args.sessionId,
      integrationId: args.integrationId, chatHistory: args.chatHistory,
      skipClarification: args.skipClarification, systemPromptPrefix: args.systemPromptPrefix,
      // FORWARDED, and this line is load-bearing. The streaming sibling below spreads `...args` and so
      // carried it by accident; this one builds an explicit object, and the omission made an API key's
      // document scope fail OPEN from the second turn of a session onward — `undefined` means "every
      // document" to retrieval, and the route always sets `allowMultiStepDag: true`.
      documentIds: args.documentIds,
    }, runNonStreamingChatCompletion)
    return remember({ answer: result.answer, citations: result.citations, chartData: result.chartData, toolRuns: result.toolRuns })
  }

  if (args.allowMultiStepDag) {
    // ponytail: pre-route to check if this is a clear single-tool question.
    // When the smart router confidently picks SQL or RAG, skip the LLM
    // planner (which would overthink simple data questions and route to
    // CHAT, causing the "asks for clarification instead of querying" bug).
    // The planner is only valuable for genuine multi-step questions that
    // need data from multiple tools (e.g. "compare revenue with the policy
    // doc for Q3").
    // The DAG costs a SECOND LLM call (planQueryWithTools), so it must run only
    // when it can add something. It used to run whenever the heuristic router
    // was not confident, which was most turns. The model now picks the tool
    // itself, so it is also the only component that can say whether ONE tool
    // suffices: the DAG runs only when the model reports that several are
    // needed. MEASURED cost of getting this wrong: two planner calls per turn on
    // a BYOK key, where the customer pays for both.
    const [, intCountForPrompt] = await loadDbData(args)
    const quickPick = await selectToolWithLlm({
      question: args.question, context: 'chat', isAdmin: false,
      memoryContext: undefined, chatHistory: args.chatHistory,
      needsDatabaseListing: intCountForPrompt > 0,
    })
    const needsMultiple = quickPick?.needsMultipleTools === true
    // A FAILED selector (null) also enters the DAG: with no routing decision at
    // all, the planner is the only remaining way to answer, and skipping it
    // would turn a provider blip into an empty reply.
    const cannotRoute = quickPick === null

    if (needsMultiple || cannotRoute) {
      const dagResult = await runMultiStepDag(args)
      if (dagResult) return remember(dagResult)
    }
  }

  // ponytail: cooperative abort — check between pipeline stages so an external
  // timeout/cancel stops the chain at the next boundary. The per-branch LLM
  // fetches have their own 30s AbortSignal.timeout, so at most one in-flight
  // call keeps burning after we bail. Perfect cancel wiring would need an
  // AbortSignal plumbed into every branch executor; ceiling noted.
  args.signal?.throwIfAborted()

  const [effectiveQuestion, dbData, memoryContext] = await loadIntentPipeline(args)
  const [docCount, intCount, docRows, intNames, schemaRows, restEndpoints, promptSettings] = dbData
  const restEndpointCount = restEndpoints.length
  const schemaSummaries = formatSchemasForIntent(schemaRows)

  args.signal?.throwIfAborted()

  // Started BEFORE intent analysis so the two LLM calls overlap; see `startSpeculativeRouting`.
  const speculativeRouting = startSpeculativeRouting(args, effectiveQuestion, dbData, memoryContext)
  // Retrieval joins them: it reads the question and the document scope, not the routing verdict. See speculative-retrieval.ts.
  const speculativeRetrieval = startSpeculativeRetrieval({
    question: effectiveQuestion,
    documentIds: args.documentIds,
    documentCount: docCount,
    ragToolEnabled: promptSettings.tools.rag,
    pinnedIntegration: Boolean(args.integrationId),
  })

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docRows.map((d) => formatDocForIntent(d)),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
    restEndpointSummaries: restEndpoints.map((e) => `${e.method} ${e.path}: ${e.description ?? ''}`).filter((s) => !s.endsWith(': ')),
    // Passed so the intent fallbacks agree with applyToolGating: a REST-only org HAS
    // a data source, and treating it as "nothing to retrieve" skipped the whole
    // retrieval path. There are exactly TWO call sites of analyzeIntent in this file
    // (streaming and non-streaming) and BOTH must pass it -- a single-site edit would
    // leave one path silently broken.
    hasRestApis: restEndpointCount > 0,
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    cancelSpeculativeRetrieval(speculativeRetrieval)
    // Remembered like any other turn: the user SEES this question, so a session that omitted it would
    // leave a gap in the conversation memory — a later "what were we discussing?" would miss the very
    // turn where the assistant asked what they meant.
    return remember({ answer: intent.clarificationQuestion, citations: [], chartData: null, toolRuns: [] })
  }

  if (!intent.needsRetrieval) {
    cancelSpeculativeRetrieval(speculativeRetrieval)
    // THE PATH THAT MADE MEMORY LOOK BROKEN. A plain conversation turn returns here, above the branch
    // dispatch where the write used to live — so the most common kind of turn never reached memory.
    return remember(await runChatBranch({ ...args, question: effectiveQuestion, memoryContext, chatHistory: args.chatHistory ?? [] }))
  }

  args.signal?.throwIfAborted()

  const { decision, resolvedIntegrationId, extraToolIds = [] } = await settleRouting(speculativeRouting, () => resolveRouting(args, effectiveQuestion, dbData, memoryContext))

  const effectiveDecision = applyToolGating(
    decision,
    { hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0 },
    promptSettings.tools,
  )
  // Only a RAG verdict uses the retrieval. (This transport has no multi-source DAG branch, so `extraToolIds` never
  // diverts a RAG verdict away from it.)
  if (effectiveDecision !== 'RAG') cancelSpeculativeRetrieval(speculativeRetrieval)

  const contextualContext = await loadContextualContext(effectiveDecision, args.sessionId)
  const mergedPrefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
  const branchArgs = {
    ...args,
    question: effectiveQuestion,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: mergedPrefix,
    memoryContext,
    chatHistory: args.chatHistory ?? [],
    // The names `loadDbData` already loaded, so the SQL answer can state which OTHER sources it did not include.
    // MEASURED IN UAT: without this, a comparison question was answered from one database and the other source's
    // rows were relabelled as its own.
    integrationNames: intNames.map((i) => i.name),
    speculativeRetrieval,
  }

  let result: CompletionResult
  if (effectiveDecision === 'SQL') result = await runSqlBranch(branchArgs)
  else if (effectiveDecision === 'RAG') result = await runRagBranch(branchArgs)
  else if (effectiveDecision === 'REST') result = await runRestBranch(branchArgs)
  else if (effectiveDecision === 'PLUGIN') result = await runPluginBranch(branchArgs)
  else if (effectiveDecision === 'CONTEXTUAL_CHAT' && contextualContext) result = await runContextualChatBranch({ ...branchArgs, context: contextualContext })
  else result = await runChatBranch(branchArgs)

  // Same wrapper as every other exit above — the fire-and-forget reasoning lives on `remember`, and
  // keeping one exit path means a future branch cannot be added with the write forgotten again.
  return remember(result)
}

export async function runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  /** See `runNonStreamingChatCompletion` — same contract, both transports. */
  documentIds?: string[] | null
  /**
   * The API-key scope's allowed integrations, or `null` for every source.
   *
   * Companion to `documentIds` on the same axis. Without it the SQL branch auto-selected from EVERY active
   * integration, so a key restricted to one database could be routed to another by keyword scoring — the
   * "computed and dropped" shape `effectiveScope.integrationIds` had.
   */
  integrationIds?: string[] | null
}): Promise<StreamingCompletionResult> {
  return withUsageTracking(async () =>
    _runStreamingChatCompletion({ ...args, documentIds: await documentScopeForUser(args.userId, args.documentIds) }),
  )
}

async function _runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  /** See `runNonStreamingChatCompletion` — same contract, both transports. */
  documentIds?: string[] | null
  /**
   * The API-key scope's allowed integrations, or `null` for every source.
   *
   * Companion to `documentIds` on the same axis. Without it the SQL branch auto-selected from EVERY active
   * integration, so a key restricted to one database could be routed to another by keyword scoring — the
   * "computed and dropped" shape `effectiveScope.integrationIds` had.
   */
  integrationIds?: string[] | null
}): Promise<StreamingCompletionResult> {
  if (args.allowMultiStepDag && args.chatHistory && args.chatHistory.length > 0) {
    return runStreamingAgenticLoop({
      ...args,
      skipClarification: args.skipClarification,
      systemPromptPrefix: args.systemPromptPrefix,
    }, runStreamingChatCompletion)
  }

  const [effectiveQuestion, dbData, memoryContext] = await loadIntentPipeline(args)
  const [docCount, intCount, docRows, intNames, schemaRows, restEndpoints, promptSettings] = dbData
  const restEndpointCount = restEndpoints.length
  const schemaSummaries = formatSchemasForIntent(schemaRows)

  // Same overlap as the non-streaming path; both sites must start it or the transports diverge.
  const speculativeRouting = startSpeculativeRouting(args, effectiveQuestion, dbData, memoryContext)
  const speculativeRetrieval = startSpeculativeRetrieval({
    question: effectiveQuestion,
    documentIds: args.documentIds,
    documentCount: docCount,
    ragToolEnabled: promptSettings.tools.rag,
    pinnedIntegration: Boolean(args.integrationId),
  })

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docRows.map((d) => formatDocForIntent(d)),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
    restEndpointSummaries: restEndpoints.map((e) => `${e.method} ${e.path}: ${e.description ?? ''}`).filter((s) => !s.endsWith(': ')),
    // Passed so the intent fallbacks agree with applyToolGating: a REST-only org HAS
    // a data source, and treating it as "nothing to retrieve" skipped the whole
    // retrieval path. There are exactly TWO call sites of analyzeIntent in this file
    // (streaming and non-streaming) and BOTH must pass it -- a single-site edit would
    // leave one path silently broken.
    hasRestApis: restEndpointCount > 0,
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    cancelSpeculativeRetrieval(speculativeRetrieval)
    async function* clarifyStream() { yield intent.clarificationQuestion! }
    return { stream: clarifyStream(), toolRuns: [], citations: [], chartData: null }
  }

  if (!intent.needsRetrieval) {
    cancelSpeculativeRetrieval(speculativeRetrieval)
    return prepareChatStream({ question: effectiveQuestion, systemPromptPrefix: args.systemPromptPrefix, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  const { decision, resolvedIntegrationId, extraToolIds = [] } = await settleRouting(speculativeRouting, () => resolveRouting(args, effectiveQuestion, dbData, memoryContext))

  const effectiveDecision = applyToolGating(
    decision,
    { hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0 },
    promptSettings.tools,
  )
  // Only a RAG verdict uses the retrieval — unless the multi-source DAG will run, which plans and retrieves for itself.
  // The DAG condition must mirror the branch below EXACTLY (`extraToolIds.length > 0 && args.allowMultiStepDag`): cancelling
  // for `extraToolIds` alone would abort a retrieval the single-source RAG branch still needs, and a cancelled result
  // re-throws into that branch's degrade-to-chat handling — a silent quality loss with no error to find.
  const dagWillRun = extraToolIds.length > 0 && Boolean(args.allowMultiStepDag)
  if (effectiveDecision !== 'RAG' || dagWillRun) cancelSpeculativeRetrieval(speculativeRetrieval)

  // DEBUG: trace routing decisions

  const contextualContext = await loadContextualContext(effectiveDecision, args.sessionId)
  const mergedPrefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
  const branchArgs = {
    ...args,
    question: effectiveQuestion,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: mergedPrefix,
    memoryContext,
    chatHistory: args.chatHistory ?? [],
    // The names `loadDbData` already loaded, so the SQL answer can state which OTHER sources it did not include.
    // MEASURED IN UAT: without this, a comparison question was answered from one database and the other source's
    // rows were relabelled as its own.
    integrationNames: intNames.map((i) => i.name),
    speculativeRetrieval,
  }

  /*
   * A COMPOUND QUESTION ASKED FOR MORE THAN ONE SOURCE — run them together.
   *
   * The model emitted several tool calls and `resolveRouting` used to act on the first only, so the other half of the
   * question was answered from whatever the first source happened to contain (or dropped). The multi-step planner is
   * the existing machinery for "several sources, one answer", and it is already reachable on this path when the model
   * reports MULTI_STEP in TEXT; this extends it to the case it could never see, where the request arrives as TOOL
   * CALLS. Guarded by `allowMultiStepDag` for the same reason the other DAG entry is: the planner costs an extra LLM
   * call, and callers that opted out of multi-step must not be charged for it.
   */
  if (extraToolIds.length > 0 && args.allowMultiStepDag) {
    const dag = await runMultiStepDag({
      question: effectiveQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      chatHistory: args.chatHistory,
      documentIds: args.documentIds,
    })
    // A planner that declines (single chat step, or any failure) leaves the single-source decision intact: the
    // first source still answers, which is exactly the behaviour before this change rather than a lost turn.
    if (dag) {
      return {
        toolRuns: dag.toolRuns,
        citations: dag.citations,
        chartData: dag.chartData,
        stream: singleShotStream(dag.answer),
      }
    }
  }

  if (effectiveDecision === 'SQL') {
    // `args.integrationId` is what the USER pinned; `resolvedIntegrationId` may be the router's own choice. Only a
    // user's pin forbids the documents fallback — the router's choice is exactly what the fallback second-guesses.
    return await prepareSqlStream({ ...branchArgs, userPinnedIntegration: Boolean(args.integrationId) })
  }
  if (effectiveDecision === 'RAG') return await prepareRagStream(branchArgs)
  if (effectiveDecision === 'REST') return await prepareRestStream(branchArgs)
  if (effectiveDecision === 'PLUGIN') return await preparePluginStream(branchArgs)
  if (effectiveDecision === 'CONTEXTUAL_CHAT' && contextualContext) return await prepareContextualChatStream({ ...branchArgs, context: contextualContext })
  return await prepareChatStream(branchArgs)
}

async function loadIntentPipeline(args: {
  question: string
  chatHistory?: ChatHistoryEntry[]
  sessionId?: string
  /**
   * Declared so the scope survives this boundary.
   *
   * Both call sites pass the full `args` object, so these values ALREADY arrived at runtime while this type named
   * neither — which is why `loadDbData(args)` below could not read them and the routing prompt was built from
   * every source in the org. Same "the spread carries it, the type discards it" shape that hid the streaming
   * `documentIds` gap.
   */
  integrationIds?: string[] | null
  documentIds?: string[] | null
}): Promise<[string, Awaited<ReturnType<typeof loadDbData>>, string]> {
  const hasHistory = args.chatHistory && args.chatHistory.length > 0
  // ponytail: recall + rewrite do semantic/string matching — the session
  // meta-wrapper ("[Session started: ...] [Current time: ...]") must not
  // leak into the recall query or the rewrite prompt.
  const cleanQuestion = stripSessionWrapper(args.question)
  const [effectiveQuestion, dbData, memoryContext] = await Promise.all([
    hasHistory
      ? rewriteQuery({ question: cleanQuestion, chatHistory: args.chatHistory! })
      : Promise.resolve(cleanQuestion),
    loadDbData(args),
    recallContext({ query: cleanQuestion, sessionId: args.sessionId }).catch(() => ''),
  ])
  if (hasHistory) {
    log.debug('Query rewritten', { original: cleanQuestion.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }
  return [effectiveQuestion, dbData, memoryContext]
}

/**
 * The DB context the ROUTER prompt is built from.
 *
 * `scope` is threaded in because these counts and name lists go INTO the routing prompt. Unscoped, the model was
 * told about databases the key may not read — so it could choose one and the branch would then refuse (a
 * confusing outcome for the caller), and the org's source NAMES and schema descriptions leaked to a key with no
 * access to them.
 */
async function loadDbData(scope?: { integrationIds?: string[] | null; documentIds?: string[] | null }) {
  // `null`/absent means unrestricted, so both filters are spread CONDITIONALLY. An empty `in: []` would match
  // nothing and lock out every key created before these axes existed.
  const intScope = scope?.integrationIds && scope.integrationIds.length > 0 ? { id: { in: scope.integrationIds } } : {}
  const docScope = scope?.documentIds && scope.documentIds.length > 0 ? { id: { in: scope.documentIds } } : {}
  const queries = Promise.all([
    db.document.count({ where: { status: 'ready', isEnabled: true, ...docScope } }),
    db.integration.count({ where: { status: 'active', ...intScope } }),
    // ponytail: description included — the LLM first-scan (source-init) writes
    // it when the uploader doesn't. "invoice_sop_2024.pdf — Refund policy for
    // enterprise customers…" routes RAG questions far better than a file name.
    db.document.findMany({
      where: { status: 'ready', isEnabled: true, ...docScope },
      select: { name: true, category: true, description: true },
      take: 20,
    }),
    db.integration.findMany({ where: { status: 'active', ...intScope }, select: { name: true }, take: 20 }),
    db.integrationSchema.findMany({ where: { integration: { status: 'active', ...intScope }, description: { not: null } }, select: { tableName: true, description: true, integration: { select: { name: true } } }, take: 40 }),
    // ponytail: endpoint descriptions too — same first-scan rationale; they
    // tell the router which REST source answers which question.
    db.restApiEndpoint.findMany({
      where: { isEnabled: true, connector: { isActive: true } },
      select: { path: true, description: true, method: true },
      take: 20,
    }),
    getPromptSettings(db),
  ])
  // ponytail: shared 15s ceiling across the whole pre-stream DB batch so a slow
  // DB can't pin a request; the outer handler surfaces a sanitized error.
  return withTimeout(queries, 15_000, 'Preflight DB load')
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Render one schema row for the intent prompt: "integration.table: description".
 *
 * Extracted because this string is built in BOTH the streaming and the
 * non-streaming path, and the two copies had the same unguarded dereference --
 * exactly the shape that let a one-site fix silently leave the other path wrong
 * elsewhere in this file.
 *
 * The guard is not hypothetical. `integration` is a to-one relation, so Prisma
 * types it as non-null and the query filters `integration: { status: 'active' }`
 * to keep it that way. But a raw SQL read, a relaxed filter, or a Prisma version
 * that returns a null to-one join would make `undefined.name` a raw TypeError
 * thrown out of the dispatcher BEFORE any LLM call, with no user-facing error.
 * Dropping the row costs one line of prompt context; crashing costs the request.
 * A row with no name is also worse than useless in the prompt: the model cannot
 * choose a source it cannot name.
 */
export function formatSchemaForIntent(s: {
  tableName: string
  description: string | null
  integration?: { name: string } | null
}): string | null {
  const name = s.integration?.name
  if (!name) return null
  return `${name}.${s.tableName}: ${s.description}`
}

/**
 * Apply formatSchemaForIntent to a batch, keeping order and dropping the rows it
 * declines to render. Returned as a helper so both call sites share one policy.
 */
export function formatSchemasForIntent(
  rows: Array<{ tableName: string; description: string | null; integration?: { name: string } | null }>,
): string[] {
  const out: string[] = []
  for (const row of rows) {
    const rendered = formatSchemaForIntent(row)
    if (rendered) out.push(rendered)
  }
  return out
}

type DbData = Awaited<ReturnType<typeof loadDbData>>

/**
 * What the router prompt is told when the user pinned the DOCUMENT corpus.
 *
 * A constant rather than an inline string because the prompt only needs a NAME, and the picker's own label carries a
 * live count ("Documents (12)") that would change the prompt text whenever a document was added — making two
 * identical questions produce different router prompts.
 */
const DOCUMENTS_PIN_LABEL = 'the document corpus (all knowledge base documents)'

/**
 * Render a document row for the intent prompt: name [category] — description.
 * The description comes from the uploader or the LLM first-scan (source-init);
 * it is what lets the router tell "annual leave SOP" from "Q3 invoice export".
 */
export function formatDocForIntent(d: { name: string; category: string | null; description: string | null }): string {
  const label = d.category ? `${d.name} [${d.category}]` : d.name
  return d.description ? `${label} — ${d.description}` : label
}

/**
 * Turn the router's preference into a decision this org can actually execute, and
 * fall back to CHAT when the tool it picked is disabled in prompt settings.
 *
 * This existed TWICE, verbatim, in the non-streaming and streaming paths. Two
 * copies of one policy means a fix applied to one path silently leaves the other
 * wrong — and the two paths are chosen by a flag the user controls, so the bug
 * would only show up for some users. Kept as one function so they cannot diverge.
 */
function applyToolGating(
  decision: RouteDecision,
  availability: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean },
  tools: { sql: boolean; rag: boolean; restApi: boolean },
): RouteDecision {
  let effective = chooseAvailableDecision(decision, availability)
  // A tool the operator switched OFF must not be reached by the router's
  // preference: picking SQL for an org with no SQL tool would fail the request.
  if (effective === 'SQL' && !tools.sql) effective = 'CHAT'
  if (effective === 'RAG' && !tools.rag) effective = 'CHAT'
  if (effective === 'REST' && !tools.restApi) effective = 'CHAT'
  return effective
}

/**
 * Start tool selection NOW, alongside intent analysis, instead of after it.
 *
 * `analyzeIntent` and `selectToolWithLlm` are two sequential LLM calls (~2 s each, MEASURED) that read the SAME inputs —
 * the question, the memory context and the source list — and neither consumes the other's output. Running them
 * back to back made the user wait for both. Started together, the wait is the slower one, and the DECISIONS are
 * identical because the inputs are.
 *
 * THE PRICE, STATED: a turn that intent analysis then routes to plain chat or a clarification question has spent one
 * selector call it did not need — on the customer's own key. That is why `SPECULATIVE_ROUTING=false` turns it off.
 *
 * Settled into a value instead of returned as a bare promise: if intent analysis decides the speculative result is
 * not needed, nobody awaits it, and a bare rejected promise nobody awaits is an unhandled rejection. The error is
 * re-thrown only by the caller that actually uses the result.
 */
/** Yield an already-complete answer as a one-chunk stream, for paths that synthesize before dispatching. */
async function* singleShotStream(answer: string): AsyncGenerator<string, void, unknown> {
  yield answer
}

function startSpeculativeRouting(
  args: Parameters<typeof resolveRouting>[0],
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ ok: true; value: Awaited<ReturnType<typeof resolveRouting>> } | { ok: false; error: unknown }> | null {
  if (process.env.SPECULATIVE_ROUTING === 'false') return null
  return resolveRouting(args, effectiveQuestion, dbData, memoryContext).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

async function settleRouting(
  speculative: ReturnType<typeof startSpeculativeRouting>,
  fallback: () => ReturnType<typeof resolveRouting>,
): ReturnType<typeof resolveRouting> {
  if (!speculative) return fallback()
  const settled = await speculative
  if (!settled.ok) throw settled.error
  return settled.value
}

async function resolveRouting(
  args: {
    question: string
    integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
    chatHistory?: ChatHistoryEntry[]
    /**
     * The key's allowed sources. This function DECIDES which database answers a SQL question, so an unscoped
     * selection here reaches the customer: the branch would run generated SQL against a source the key was never
     * granted. The two selectors below are the LAST resort when the model chose no integration, which is exactly
     * when a scoped key is most likely to be sent somewhere it may not read.
     */
    integrationIds?: string[] | null
    /**
     * The key's allowed documents. Needed HERE because this function builds the router prompt's source list, and
     * that list was previously unscoped — see the note on `RoutingContext.documentIds`.
     */
    documentIds?: string[] | null
  },
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ decision: RouteDecision; resolvedIntegrationId: string | undefined; extraToolIds?: string[] }> {
  const [docCount, intCount, , , , restEndpoints] = dbData
  const restEndpointCount = restEndpoints.length
  const hasHistory = args.chatHistory && args.chatHistory.length > 0
  // Required by the pin lookup below, and named for it: `core` guards that EVERY integration query in the chat path
  // carries a scope filter. Spread conditionally, exactly as `loadDbData` does — an empty `in: []` matches nothing
  // and would lock out every key created before this axis existed.
  const intScope = args.integrationIds && args.integrationIds.length > 0 ? { id: { in: args.integrationIds } } : {}
  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId
  // Arguments the SELECTOR supplied, so the branch does not re-derive them.
  let selectionArgs: Record<string, unknown> = {}
  let selectionReason = ''
  /**
   * The tools the model asked for BEYOND the first one on a compound question.
   *
   * MEASURED: 'berapa hari cuti tahunan karyawan tetap dan berapa gaji pokok direktur utama?' — the model emitted
   * `search_knowledge_base` AND `query_database` on 5 of 16 tries, and the selector acted on `result[0]` only, so one
   * half of the question was dropped without anything reporting it. The existing multi-tool trigger could not catch
   * this: it reads a "MULTI_STEP" marker out of the model's text, and a reply carrying tool calls has no text.
   */
  let extraToolIds: string[] = []

  // The LLM chooses the tool on BOTH paths (with and without history). History
  // previously routed through `routeQuery` while the first turn used the
  // heuristic scorer, so the SAME question could take different branches
  // depending on whether it was the opening message — a real source of
  // "sometimes it works" reports.
  const sel = await selectToolWithLlm({
    question: effectiveQuestion, context: 'chat', isAdmin: false,
    memoryContext, chatHistory: args.chatHistory,
    // Only meaningful when there IS a database to choose between.
    needsDatabaseListing: intCount > 0,
  })
  if (sel) {
    decision = sel.decision
    selectionArgs = sel.args
    selectionReason = sel.reason
    // Compound questions: the model can ask for SEVERAL sources in one reply. Recorded here and acted on by
    // `runStreamingChatCompletion`, because only that layer can route the follow-up turn.
    extraToolIds = sel.extraTools?.map((t) => t.toolId) ?? []
    // The model named the database it wants. Taking it here is what keeps SQL
    // working at all now that the heuristic router (which used to supply this)
    // is gone.
    if (sel.integrationId) resolvedIntegrationId = sel.integrationId
  } else {
    // No LLM (unconfigured, or the provider failed). `routeQuery` is the
    // documented fail-closed fallback; a hard failure here would take chat down
    // for a deployment whose only problem is a transient provider error.
    const routed = await routeQuery({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
      // The scope REACHES THE PROMPT here, not just the branch. MEASURED: this call omitted it, so `routeQuery`
      // listed every table, document and table-description in the install to a key that could not read them.
      // `loadDbData` above already scoped the counts; the prompt needed the same axes.
      integrationIds: args.integrationIds,
      documentIds: args.documentIds,
      /*
       * The user's PIN, so the router can honour the composer's promise ("other sources are excluded for this turn").
       *
       * MEASURED GAP: the pin used to bind only AFTER the route was chosen — as `resolvedIntegrationId`, which the SQL
       * branch reads — so a user who pinned a database could still be answered from documents, and the UI said
       * otherwise. The lookup is one scoped `findFirst` on an id the route already validated, and only when a pin
       * exists, so an auto-routed turn costs nothing.
       */
      // A DOCUMENT pin names the corpus, which has no single row to look up — so the directive is stated directly.
      // Without this the picker's "Documents" option would set no `integrationId` and change nothing at all, which is
      // the "accepted and not applied" shape this file has already been bitten by.
      pinnedSourceName: args.pinToDocuments
        ? DOCUMENTS_PIN_LABEL
        : args.integrationId
        ? ((
            await db.integration.findFirst({
              // BOTH axes, and this is not belt-and-braces: `core` guards that every integration query in the chat
              // path carries a scope filter, and the first version of this lookup omitted it. Without `...intScope`
              // a key restricted away from a database could still have it NAMED back through the pin — the same
              // "told about a source it cannot read" leak the scope work above exists to close. The pin comes from
              // the client, so it is also an input the caller controls.
              where: { id: args.integrationId, status: 'active', ...intScope },
              select: { name: true },
            })
          )?.name ?? undefined)
        : undefined,
    })
    decision = routed.decision
    selectionReason = `fallback router: ${routed.reason}`
  }

  // The SQL tool declares `requiresDataSource: 'integration'` and its schema
  // requires only `question`, so the MODEL cannot choose an integration — that
  // has always been the router's job. Replacing the heuristic router dropped
  // this assignment, and SQL then answered "data source is not yet available"
  // because `resolvedIntegrationId` was undefined. Caught by
  // tool-router.test.ts > "SQL branch: returns answer with query results".
  if (decision === 'SQL' && !resolvedIntegrationId) {
    // ponytail: last-resort integration selection. pickBestIntegration uses
    // embedding API which can be slow/unavailable. Try keyword matching first
    // (fast, no API call), then fall back to pickBestIntegration.
    const tokens = tokenize(effectiveQuestion)
    const kwId = await pickBestIntegrationByKeywords(tokens, args.integrationIds)
    if (kwId) {
      resolvedIntegrationId = kwId
    } else {
      resolvedIntegrationId = (await pickBestIntegration(tokens, undefined, args.integrationIds)) ?? undefined
    }
  }

  return { decision, resolvedIntegrationId, ...(extraToolIds.length > 0 ? { extraToolIds } : {}) }
}

async function loadContextualContext(decision: RouteDecision, sessionId?: string): Promise<string> {
  if (decision !== 'CONTEXTUAL_CHAT' || !sessionId) return ''
  const recentToolRuns = await db.toolRun.findMany({
    where: { chatMessage: { sessionId }, status: 'success', outputSummary: { not: '' } },
    orderBy: { createdAt: 'desc' }, take: 3,
    select: { type: true, inputSummary: true, outputSummary: true },
  })
  if (recentToolRuns.length === 0) return ''
  return recentToolRuns.map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`).join('\n\n---\n\n')
}
