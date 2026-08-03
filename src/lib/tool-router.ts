import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { smartRoute, pickBestIntegration, tokenize } from '@/lib/smart-router'
import { analyzeIntent, rewriteQuery } from '@/lib/intent-pipeline'
import { getPromptSettings } from '@/lib/prompt-settings'
import { recallContext, rememberChatTurn } from '@/lib/cognee'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

export {
  withSqlConcurrency, buildChartDataFromRows, buildDocumentCitation,
  sanitizeSqlError, summarize,
  type PendingToolRun, type CompletionResult, type ChatHistoryEntry, type StreamingCompletionResult,
} from '@/lib/tool-utils'
export { parseRestCallJson } from '@/lib/ai'

import {
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
    const dagResult = await runMultiStepDag(args)
    if (dagResult) return dagResult
  }

  // ponytail: cooperative abort — check between pipeline stages so an external
  // timeout/cancel stops the chain at the next boundary. The per-branch LLM
  // fetches have their own 30s AbortSignal.timeout, so at most one in-flight
  // call keeps burning after we bail. Perfect cancel wiring would need an
  // AbortSignal plumbed into every branch executor; ceiling noted.
  args.signal?.throwIfAborted()

  const [effectiveQuestion, dbData, memoryContext] = await loadIntentPipeline(args)
  const [docCount, intCount, docNames, intNames, schemaRows, restEndpointCount, promptSettings] = dbData
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  args.signal?.throwIfAborted()

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docNames.map((d) => d.category ? `${d.name} [${d.category}]` : d.name),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    return { answer: intent.clarificationQuestion, citations: [], chartData: null, toolRuns: [] }
  }

  if (!intent.needsRetrieval) {
    return runChatBranch({ ...args, question: effectiveQuestion, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  args.signal?.throwIfAborted()

  const { decision, resolvedIntegrationId, clarification } = await resolveRouting(args, effectiveQuestion, dbData, memoryContext)
  if (clarification && !args.skipClarification) {
    return { answer: clarification, citations: [], chartData: null, toolRuns: [] }
  }

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
  const [docCount, intCount, docNames, intNames, schemaRows, restEndpointCount, promptSettings] = dbData
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  const intent = await analyzeIntent({
    question: args.chatHistory && args.chatHistory.length > 0 ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0, hasIntegrations: intCount > 0,
    documentNames: docNames.map((d) => d.category ? `${d.name} [${d.category}]` : d.name),
    integrationNames: intNames.map((i) => i.name), schemaSummaries,
  })

  if (intent.needsClarification && intent.clarificationQuestion && !args.skipClarification) {
    async function* clarifyStream() { yield intent.clarificationQuestion! }
    return { stream: clarifyStream(), toolRuns: [], citations: [], chartData: null }
  }

  if (!intent.needsRetrieval) {
    return prepareChatStream({ question: effectiveQuestion, systemPromptPrefix: args.systemPromptPrefix, memoryContext, chatHistory: args.chatHistory ?? [] })
  }

  const { decision, resolvedIntegrationId, clarification } = await resolveRouting(args, effectiveQuestion, dbData, memoryContext)
  if (clarification && !args.skipClarification) {
    const text = clarification
    async function* clarifyStream() { yield text }
    return { stream: clarifyStream(), toolRuns: [], citations: [], chartData: null }
  }

  let effectiveDecision = chooseAvailableDecision(decision, {
    hasIntegrations: intCount > 0, hasDocuments: docCount > 0, hasRestApis: restEndpointCount > 0,
  })
  if (effectiveDecision === 'SQL' && !promptSettings.tools.sql) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'RAG' && !promptSettings.tools.rag) effectiveDecision = 'CHAT'
  if (effectiveDecision === 'REST' && !promptSettings.tools.restApi) effectiveDecision = 'CHAT'

  const contextualContext = await loadContextualContext(effectiveDecision, args.sessionId)
  const mergedPrefix = [args.systemPromptPrefix, promptSettings.systemPrompt].filter(Boolean).join('\n\n') || undefined
  const branchArgs = { ...args, question: effectiveQuestion, integrationId: resolvedIntegrationId, systemPromptPrefix: mergedPrefix, memoryContext, chatHistory: args.chatHistory ?? [] }

  if (effectiveDecision === 'SQL') return await prepareSqlStream(branchArgs)
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
  const [effectiveQuestion, dbData, memoryContext] = await Promise.all([
    hasHistory ? rewriteQuery({ question: args.question, chatHistory: args.chatHistory! }) : Promise.resolve(args.question),
    loadDbData(),
    recallContext({ query: args.question, sessionId: args.sessionId }).catch(() => ''),
  ])
  if (hasHistory) {
    log.debug('Query rewritten', { original: args.question.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }
  return [effectiveQuestion, dbData, memoryContext]
}

async function loadDbData() {
  const queries = Promise.all([
    db.document.count({ where: { status: 'ready', isEnabled: true } }),
    db.integration.count({ where: { status: 'active' } }),
    db.document.findMany({ where: { status: 'ready', isEnabled: true }, select: { name: true, category: true }, take: 20 }),
    db.integration.findMany({ where: { status: 'active' }, select: { name: true }, take: 20 }),
    db.integrationSchema.findMany({ where: { integration: { status: 'active' }, description: { not: null } }, select: { tableName: true, description: true, integration: { select: { name: true } } }, take: 40 }),
    db.restApiEndpoint.count({ where: { isEnabled: true, connector: { isActive: true } } }),
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

async function resolveRouting(
  args: { question: string; integrationId?: string; chatHistory?: ChatHistoryEntry[] },
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ decision: RouteDecision; clarification?: string; resolvedIntegrationId: string | undefined }> {
  const [docCount, intCount, , , , restEndpointCount] = dbData
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
    if (routed.ambiguousIntegrations && routed.ambiguousIntegrations.length > 1) {
      const names = routed.ambiguousIntegrations.map((a) => a.integrationName)
      const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n')
      return { decision: 'CHAT' as RouteDecision, clarification: `I found multiple databases that could answer this question. Which one do you mean?\n\n${list}\n\nPlease specify the database name or select it from the dropdown.`, resolvedIntegrationId }
    }
  }

  if (decision === 'SQL' && !resolvedIntegrationId) {
    const tokens = tokenize(effectiveQuestion)
    resolvedIntegrationId = await pickBestIntegration(tokens) ?? undefined
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
