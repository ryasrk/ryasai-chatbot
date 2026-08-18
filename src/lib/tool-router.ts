import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { smartRoute, pickBestIntegration, pickBestIntegrationByKeywords, tokenize } from '@/lib/smart-router'
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
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  signal?: AbortSignal
}): Promise<CompletionResult> {
  return withUsageTracking(() => _runNonStreamingChatCompletion(args))
}

async function _runNonStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
  signal?: AbortSignal
}): Promise<CompletionResult> {
  if (args.allowMultiStepDag && args.chatHistory && args.chatHistory.length > 0) {
    const result = await runAgenticLoop({
      question: args.question, userId: args.userId, sessionId: args.sessionId,
      integrationId: args.integrationId, chatHistory: args.chatHistory,
      skipClarification: args.skipClarification, systemPromptPrefix: args.systemPromptPrefix,
    }, runNonStreamingChatCompletion)
    return { answer: result.answer, citations: result.citations, chartData: result.chartData, toolRuns: result.toolRuns }
  }

  if (args.allowMultiStepDag) {
    // ponytail: pre-route to check if this is a clear single-tool question.
    // When the smart router confidently picks SQL or RAG, skip the LLM
    // planner (which would overthink simple data questions and route to
    // CHAT, causing the "asks for clarification instead of querying" bug).
    // The planner is only valuable for genuine multi-step questions that
    // need data from multiple tools (e.g. "compare revenue with the policy
    // doc for Q3").
    const [docCount, intCount, , , , restEndpoints, promptSettings] = await loadDbData()
    const restCount = restEndpoints.length
    const quickRoute = await smartRoute({
      question: args.question,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restCount > 0,
      preferredIntegrationId: args.integrationId,
    })
    const clearSingleTool =
      (quickRoute.decision === 'SQL' || quickRoute.decision === 'RAG' || quickRoute.decision === 'REST') &&
      quickRoute.scores[0] && quickRoute.scores[0].finalScore > 0.5 &&
      (!quickRoute.scores[1] || quickRoute.scores[0].finalScore - quickRoute.scores[1].finalScore > 0.05)

    if (!clearSingleTool) {
      const dagResult = await runMultiStepDag(args)
      if (dagResult) return dagResult
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
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  args.signal?.throwIfAborted()

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docRows.map((d) => formatDocForIntent(d)),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
    restEndpointSummaries: restEndpoints.map((e) => `${e.method} ${e.path}: ${e.description ?? ''}`).filter((s) => !s.endsWith(': ')),
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    return { answer: intent.clarificationQuestion, citations: [], chartData: null, toolRuns: [] }
  }

  if (!intent.needsRetrieval) {
    return runChatBranch({ ...args, question: effectiveQuestion, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  args.signal?.throwIfAborted()

  const { decision, resolvedIntegrationId } = await resolveRouting(args, effectiveQuestion, dbData, memoryContext)

  let effectiveDecision = chooseAvailableDecision(decision, {
    hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0,
  })
  if (effectiveDecision === 'SQL' && !promptSettings.tools.sql) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'RAG' && !promptSettings.tools.rag) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'REST' && !promptSettings.tools.restApi) effectiveDecision = 'CHAT'

  const contextualContext = await loadContextualContext(effectiveDecision, args.sessionId)
  const mergedPrefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
  const branchArgs = { ...args, question: effectiveQuestion, integrationId: resolvedIntegrationId, systemPromptPrefix: mergedPrefix, memoryContext, chatHistory: args.chatHistory ?? [] }

  let result: CompletionResult
  if (effectiveDecision === 'SQL') result = await runSqlBranch(branchArgs)
  else if (effectiveDecision === 'RAG') result = await runRagBranch(branchArgs)
  else if (effectiveDecision === 'REST') result = await runRestBranch(branchArgs)
  else if (effectiveDecision === 'PLUGIN') result = await runPluginBranch(branchArgs)
  else if (effectiveDecision === 'CONTEXTUAL_CHAT' && contextualContext) result = await runContextualChatBranch({ ...branchArgs, context: contextualContext })
  else result = await runChatBranch(branchArgs)

  await rememberChatTurn({ sessionId: args.sessionId, userMessage: args.question, aiMessage: result.answer, toolRuns: result.toolRuns.map((t) => ({ type: t.type, status: t.status, latencyMs: t.latencyMs ?? 0 })) })
  return result
}

export async function runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
}): Promise<StreamingCompletionResult> {
  return withUsageTracking(() => _runStreamingChatCompletion(args))
}

async function _runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
  skipClarification?: boolean
  systemPromptPrefix?: string
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
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docRows.map((d) => formatDocForIntent(d)),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
    restEndpointSummaries: restEndpoints.map((e) => `${e.method} ${e.path}: ${e.description ?? ''}`).filter((s) => !s.endsWith(': ')),
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    async function* clarifyStream() { yield intent.clarificationQuestion! }
    return { stream: clarifyStream(), toolRuns: [], citations: [], chartData: null }
  }

  if (!intent.needsRetrieval) {
    return prepareChatStream({ question: effectiveQuestion, systemPromptPrefix: args.systemPromptPrefix, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  const { decision, resolvedIntegrationId } = await resolveRouting(args, effectiveQuestion, dbData, memoryContext)

  let effectiveDecision = chooseAvailableDecision(decision, {
    hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0,
  })
  if (effectiveDecision === 'SQL' && !promptSettings.tools.sql) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'RAG' && !promptSettings.tools.rag) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'REST' && !promptSettings.tools.restApi) effectiveDecision = 'CHAT'

  // DEBUG: trace routing decisions

  const contextualContext = await loadContextualContext(effectiveDecision, args.sessionId)
  const mergedPrefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
  const branchArgs = { ...args, question: effectiveQuestion, integrationId: resolvedIntegrationId, systemPromptPrefix: mergedPrefix, memoryContext, chatHistory: args.chatHistory ?? [] }

  if (effectiveDecision === 'SQL') {
    return await prepareSqlStream(branchArgs)
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
    loadDbData(),
    recallContext({ query: cleanQuestion, sessionId: args.sessionId }).catch(() => ''),
  ])
  if (hasHistory) {
    log.debug('Query rewritten', { original: cleanQuestion.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }
  return [effectiveQuestion, dbData, memoryContext]
}

async function loadDbData() {
  const queries = Promise.all([
    db.document.count({ where: { status: 'ready', isEnabled: true } }),
    db.integration.count({ where: { status: 'active' } }),
    // ponytail: description included — the LLM first-scan (source-init) writes
    // it when the uploader doesn't. "invoice_sop_2024.pdf — Refund policy for
    // enterprise customers…" routes RAG questions far better than a file name.
    db.document.findMany({
      where: { status: 'ready', isEnabled: true },
      select: { name: true, category: true, description: true },
      take: 20,
    }),
    db.integration.findMany({ where: { status: 'active' }, select: { name: true }, take: 20 }),
    db.integrationSchema.findMany({ where: { integration: { status: 'active' }, description: { not: null } }, select: { tableName: true, description: true, integration: { select: { name: true } } }, take: 40 }),
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

type DbData = Awaited<ReturnType<typeof loadDbData>>

/**
 * Render a document row for the intent prompt: name [category] — description.
 * The description comes from the uploader or the LLM first-scan (source-init);
 * it is what lets the router tell "annual leave SOP" from "Q3 invoice export".
 */
function formatDocForIntent(d: { name: string; category: string | null; description: string | null }): string {
  const label = d.category ? `${d.name} [${d.category}]` : d.name
  return d.description ? `${label} — ${d.description}` : label
}

async function resolveRouting(
  args: { question: string; integrationId?: string; chatHistory?: ChatHistoryEntry[] },
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ decision: RouteDecision; resolvedIntegrationId: string | undefined }> {
  const [docCount, intCount, , , , restEndpoints] = dbData
  const restEndpointCount = restEndpoints.length
  const hasHistory = args.chatHistory && args.chatHistory.length > 0
  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId

  if (hasHistory) {
    const routed = await routeQuery({ question: effectiveQuestion, hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0, memoryContext, chatHistory: args.chatHistory })
    decision = routed.decision
  } else {
    const routed = await smartRoute({ question: effectiveQuestion, hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0, memoryContext, preferredIntegrationId: args.integrationId })
    decision = routed.decision
    resolvedIntegrationId = routed.integrationId ?? args.integrationId
    // ponytail: when multiple integrations look plausible, pick the best-scoring
    // one rather than blocking with a clarification question. The user can
    // always narrow via the integration dropdown, but blocking on every
    // question with 2+ DBs was the #1 complaint ("chatbot asks which database
    // endlessly"). If ambiguity is genuine (no schema keyword overlap), the
    // score will be 0 and pickBestIntegration below will try semantic match.
    if (!resolvedIntegrationId && routed.ambiguousIntegrations && routed.ambiguousIntegrations.length > 0) {
      resolvedIntegrationId = routed.ambiguousIntegrations
        .sort((a, b) => b.score - a.score)[0]?.integrationId
    }
  }

  if (decision === 'SQL' && !resolvedIntegrationId) {
    // ponytail: last-resort integration selection. pickBestIntegration uses
    // embedding API which can be slow/unavailable. Try keyword matching first
    // (fast, no API call), then fall back to pickBestIntegration.
    const tokens = tokenize(effectiveQuestion)
    const kwId = await pickBestIntegrationByKeywords(tokens)
    if (kwId) {
      resolvedIntegrationId = kwId
    } else {
      resolvedIntegrationId = await pickBestIntegration(tokens) ?? undefined
    }
  }

  return { decision, resolvedIntegrationId }
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
