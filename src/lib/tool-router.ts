import { narrowDocumentScope, resolveUserRole } from '@/lib/access-scope'
import { cancelSpeculativeRetrieval, startSpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { selectToolWithLlm } from '@/lib/tool-selector'
import { analyzeIntent } from '@/lib/intent-pipeline'
import { rememberChatTurn } from '@/lib/cognee'

export {
  withSqlConcurrency, buildChartDataFromRows, buildDocumentCitation,
  sanitizeSqlError, summarize, stripSessionWrapper,
  type PendingToolRun, type CompletionResult, type ChatHistoryEntry, type StreamingCompletionResult,
} from '@/lib/tool-utils'
export { parseRestCallJson } from '@/lib/ai'

import {
  type CompletionResult,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
import {
  runChatBranch, runContextualChatBranch, runRagBranch, runSqlBranch, runRestBranch, runPluginBranch,
} from '@/lib/tool-branches'
import {
  prepareChatStream, prepareContextualChatStream, prepareRagStream, prepareSqlStream, prepareRestStream, preparePluginStream,
} from '@/lib/stream-preparers'
import { runMultiStepDag, runAgenticLoop, runStreamingAgenticLoop } from '@/lib/tool-router-agentic'
import { withUsageTracking } from '@/lib/llm-client'
import {
  formatSchemasForIntent, formatDocForIntent, loadIntentPipeline, loadDbData, applyToolGating, startSpeculativeRouting,
  settleRouting, resolveRouting, loadContextualContext, resolvePlannedTool, documentsHoldTheAnswer, type RequestedTool, type PlannedTool,
} from '@/lib/tool-router-routing'
export { chooseAvailableDecision, formatSchemaForIntent, formatSchemasForIntent, formatDocForIntent } from '@/lib/tool-router-routing'

/** A planned step needs retrieval by definition, and its question came from the model, not the user, so nothing to clarify. */
const PLANNED_STEP_INTENT = { needsClarification: false, clarificationQuestion: undefined, needsRetrieval: true } as const

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
  /**
   * This call is one round of the agentic loop. The round may run several tool calls as one plan, but never starts
   * another loop (`allowMultiStepDag` with history would). See `runAgenticLoop`.
   */
  agenticRound?: boolean
  /**
   * The tool a plan step already chose (and, for SQL, the database it named). The step runs it: no intent analysis and
   * no second selector call, which a compound question used to pay again for every step. See `resolvePlannedTool`.
   */
  plannedTool?: PlannedTool
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
  /**
   * This call is one round of the agentic loop. The round may run several tool calls as one plan, but never starts
   * another loop (`allowMultiStepDag` with history would). See `runAgenticLoop`.
   */
  agenticRound?: boolean
  /**
   * The tool a plan step already chose (and, for SQL, the database it named). The step runs it: no intent analysis and
   * no second selector call, which a compound question used to pay again for every step. See `resolvePlannedTool`.
   */
  plannedTool?: PlannedTool
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
      integrationIds: args.integrationIds,
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
    const quickCalls: RequestedTool[] | undefined = quickPick?.toolId && quickPick.extraTools?.length
      ? [{ toolId: quickPick.toolId, args: quickPick.args }, ...quickPick.extraTools]
      : undefined
    const needsMultiple = quickPick?.needsMultipleTools === true || quickCalls !== undefined
    // A FAILED selector (null) also enters the DAG: with no routing decision at
    // all, the planner is the only remaining way to answer, and skipping it
    // would turn a provider blip into an empty reply.
    const cannotRoute = quickPick === null

    if (needsMultiple || cannotRoute) {
      const dagResult = await runMultiStepDag({ ...args, requestedTools: quickCalls })
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

  // A plan step whose tool is already chosen skips the selector and intent analysis; null means route as usual.
  const planned = args.plannedTool ? await resolvePlannedTool(args.plannedTool, args.integrationIds) : null

  // Started BEFORE intent analysis so the two LLM calls overlap; see `startSpeculativeRouting`.
  const speculativeRouting = planned ? null : startSpeculativeRouting(args, effectiveQuestion, dbData, memoryContext)
  // Retrieval joins them: it reads the question and the document scope, not the routing verdict. See speculative-retrieval.ts.
  const speculativeRetrieval = planned && planned.decision !== 'RAG' ? null : startSpeculativeRetrieval({
    question: effectiveQuestion,
    documentIds: args.documentIds,
    documentCount: docCount,
    ragToolEnabled: promptSettings.tools.rag,
    pinnedIntegration: Boolean(args.integrationId),
  })

  const intent = planned ? PLANNED_STEP_INTENT : await analyzeIntent({
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
    return remember({ answer: intent.clarificationQuestion, citations: [], chartData: null, toolRuns: [], needsUserInput: true })
  }

  if (!intent.needsRetrieval) {
    // The intent model cannot see what the documents hold; one lexical probe can (kb-probe.ts).
    if (await documentsHoldTheAnswer({ question: effectiveQuestion, documentCount: docCount, ragToolEnabled: promptSettings.tools.rag, documentIds: args.documentIds })) {
      const prefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
      return remember(await runRagBranch({ ...args, question: effectiveQuestion, systemPromptPrefix: prefix, memoryContext, chatHistory: args.chatHistory ?? [], speculativeRetrieval, chatIfUnsupported: true }))
    }
    cancelSpeculativeRetrieval(speculativeRetrieval)
    // THE PATH THAT MADE MEMORY LOOK BROKEN. A plain conversation turn returns here, above the branch
    // dispatch where the write used to live — so the most common kind of turn never reached memory.
    return remember(await runChatBranch({ ...args, question: effectiveQuestion, memoryContext, chatHistory: args.chatHistory ?? [] }))
  }

  args.signal?.throwIfAborted()

  const routed: Awaited<ReturnType<typeof resolveRouting>> = planned
    ?? await settleRouting(speculativeRouting, () => resolveRouting(args, effectiveQuestion, dbData, memoryContext))
  const { decision, resolvedIntegrationId, extraToolIds = [], requestedTools } = routed

  // Same hand-off as the streaming path: the model asked for several tools, so its calls run as one plan.
  if (extraToolIds.length > 0 && (args.allowMultiStepDag || args.agenticRound)) {
    const dag = await runMultiStepDag({
      question: effectiveQuestion, userId: args.userId, sessionId: args.sessionId,
      chatHistory: args.chatHistory, documentIds: args.documentIds, integrationIds: args.integrationIds, requestedTools,
    })
    if (dag) return remember(dag)
  }
  const unanswered = unansweredPartsNote(requestedTools)

  const effectiveDecision = applyToolGating(
    decision,
    { hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0 },
    promptSettings.tools,
  )
  // A chat verdict on a question the documents hold is answered from them (kb-probe.ts), with the chat fallback armed.
  const probedToDocuments = effectiveDecision === 'CHAT'
    && await documentsHoldTheAnswer({ question: effectiveQuestion, documentCount: docCount, ragToolEnabled: promptSettings.tools.rag, documentIds: args.documentIds })
  // Only a RAG verdict uses the retrieval. (This transport has no multi-source DAG branch, so `extraToolIds` never
  // diverts a RAG verdict away from it.)
  if (effectiveDecision !== 'RAG' && !probedToDocuments) cancelSpeculativeRetrieval(speculativeRetrieval)

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
  else if (probedToDocuments) result = await runRagBranch({ ...branchArgs, chatIfUnsupported: true })
  else result = await runChatBranch(branchArgs)
  if (unanswered) result = { ...result, answer: `${result.answer}\n\n${unanswered}` }

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
  /**
   * This call is one round of the agentic loop. The round may run several tool calls as one plan, but never starts
   * another loop (`allowMultiStepDag` with history would). See `runAgenticLoop`.
   */
  agenticRound?: boolean
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
  /**
   * This call is one round of the agentic loop. The round may run several tool calls as one plan, but never starts
   * another loop (`allowMultiStepDag` with history would). See `runAgenticLoop`.
   */
  agenticRound?: boolean
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
    // Same probe as the non-streaming transport; see `documentsHoldTheAnswer`.
    if (await documentsHoldTheAnswer({ question: effectiveQuestion, documentCount: docCount, ragToolEnabled: promptSettings.tools.rag, documentIds: args.documentIds })) {
      const prefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
      return prepareRagStream({ question: effectiveQuestion, systemPromptPrefix: prefix, memoryContext, chatHistory: args.chatHistory ?? [], documentIds: args.documentIds, speculativeRetrieval, chatIfUnsupported: true })
    }
    cancelSpeculativeRetrieval(speculativeRetrieval)
    return prepareChatStream({ question: effectiveQuestion, systemPromptPrefix: args.systemPromptPrefix, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  const { decision, resolvedIntegrationId, extraToolIds = [], requestedTools } = await settleRouting(speculativeRouting, () => resolveRouting(args, effectiveQuestion, dbData, memoryContext))

  const effectiveDecision = applyToolGating(
    decision,
    { hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0 },
    promptSettings.tools,
  )
  // Only a RAG verdict uses the retrieval — unless the multi-source DAG will run, which plans and retrieves for itself.
  // The DAG condition must mirror the branch below EXACTLY (`extraToolIds.length > 0 && args.allowMultiStepDag`): cancelling
  // for `extraToolIds` alone would abort a retrieval the single-source RAG branch still needs, and a cancelled result
  // re-throws into that branch's degrade-to-chat handling — a silent quality loss with no error to find.
  const dagWillRun = extraToolIds.length > 0 && Boolean(args.allowMultiStepDag || args.agenticRound)
  const probedToDocuments = !dagWillRun && effectiveDecision === 'CHAT'
    && await documentsHoldTheAnswer({ question: effectiveQuestion, documentCount: docCount, ragToolEnabled: promptSettings.tools.rag, documentIds: args.documentIds })
  if ((effectiveDecision !== 'RAG' && !probedToDocuments) || dagWillRun) cancelSpeculativeRetrieval(speculativeRetrieval)

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
  if (dagWillRun) {
    const dag = await runMultiStepDag({
      question: effectiveQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      chatHistory: args.chatHistory,
      documentIds: args.documentIds,
      integrationIds: args.integrationIds,
      requestedTools,
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

  let prepared: StreamingCompletionResult
  if (effectiveDecision === 'SQL') {
    // `args.integrationId` is what the USER pinned; `resolvedIntegrationId` may be the router's own choice. Only a
    // user's pin forbids the documents fallback — the router's choice is exactly what the fallback second-guesses.
    prepared = await prepareSqlStream({ ...branchArgs, userPinnedIntegration: Boolean(args.integrationId) })
  } else if (effectiveDecision === 'RAG') prepared = await prepareRagStream(branchArgs)
  else if (effectiveDecision === 'REST') prepared = await prepareRestStream(branchArgs)
  else if (effectiveDecision === 'PLUGIN') prepared = await preparePluginStream(branchArgs)
  else if (effectiveDecision === 'CONTEXTUAL_CHAT' && contextualContext) prepared = await prepareContextualChatStream({ ...branchArgs, context: contextualContext })
  else if (probedToDocuments) prepared = await prepareRagStream({ ...branchArgs, chatIfUnsupported: true })
  else prepared = await prepareChatStream(branchArgs)

  // Reached with several requested tools only when the multi-step path did not answer.
  const unanswered = unansweredPartsNote(requestedTools)
  return unanswered ? { ...prepared, stream: withTrailer(prepared.stream, unanswered) } : prepared
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

/**
 * Names the parts of a compound question that the single-source answer did not cover.
 *
 * Reached when the model asked for several tools and the multi-step path did not run (caller opted out, or it
 * failed). The first tool still answers; without this the other parts vanish from a reply that looks complete.
 */
export function unansweredPartsNote(requested: RequestedTool[] | undefined): string {
  const rest = (requested ?? []).slice(1)
  if (rest.length === 0) return ''
  const lines = rest.map((t) => {
    const asked = String(t.args.question ?? t.args.query ?? '').trim()
    return `- ${asked || t.toolId}`
  })
  return `**Not answered:** this question had several parts and only the first was answered. Ask these separately:\n${lines.join('\n')}`
}

async function* withTrailer(stream: AsyncGenerator<string, void, unknown>, trailer: string): AsyncGenerator<string, void, unknown> {
  yield* stream
  yield `\n\n${trailer}`
}

async function* singleShotStream(answer: string): AsyncGenerator<string, void, unknown> {
  yield answer
}
