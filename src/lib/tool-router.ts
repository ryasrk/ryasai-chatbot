import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { smartRoute, pickBestIntegration, tokenize } from '@/lib/smart-router'
import { analyzeIntent, rewriteQuery, evaluateAnswerConfidence } from '@/lib/intent-pipeline'
import { getPromptSettings } from '@/lib/prompt-settings'
import { recallContext, rememberChatTurn } from '@/lib/cognee'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import type { Citation, ChartData } from '@/lib/types'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

// Re-export types + utilities for backward compatibility (consumers import from tool-router)
export {
  withSqlConcurrency,
  buildChartDataFromRows,
  buildDocumentCitation,
  sanitizeSqlError,
  summarize,
  type PendingToolRun,
  type CompletionResult,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
export { parseRestCallJson } from '@/lib/ai'

import {
  summarize,
  type PendingToolRun,
  type CompletionResult,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
import {
  runChatBranch,
  runContextualChatBranch,
  runRagBranch,
  runSqlBranch,
  runRestBranch,
  runPluginBranch,
} from '@/lib/tool-branches'
import {
  prepareChatStream,
  prepareContextualChatStream,
  prepareRagStream,
  prepareSqlStream,
  prepareRestStream,
  preparePluginStream,
} from '@/lib/stream-preparers'

// ---------------------------------------------------------------------------
// Decision helper — maps a routing decision to an available data source.
// ---------------------------------------------------------------------------

export function chooseAvailableDecision(
  decision: RouteDecision,
  available: {
    hasIntegrations: boolean
    hasDocuments: boolean
    hasRestApis: boolean
  },
): RouteDecision {
  if (decision === 'CONTEXTUAL_CHAT') return 'CONTEXTUAL_CHAT'
  if (decision === 'PLUGIN') return 'PLUGIN'
  if (decision === 'SQL' && !available.hasIntegrations) return 'CHAT'
  if (decision === 'RAG' && !available.hasDocuments) return 'CHAT'
  if (decision === 'REST' && !available.hasRestApis) return 'CHAT'
  return decision
}

// ---------------------------------------------------------------------------
// Non-streaming entry point — the main single-tool dispatcher.
// Routes a question to one of: SQL, RAG, REST, CHAT, PLUGIN, CONTEXTUAL_CHAT.
// ---------------------------------------------------------------------------

export async function runNonStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
}): Promise<CompletionResult> {
  // ── Agentic loop (opt-in) ────────────────────────────────────────────
  // When allowMultiStepDag is enabled AND this is a multi-turn conversation,
  // wrap the single-tool execution in a confidence-based loop — the LLM
  // continues calling tools until it has enough evidence to answer. Max 3
  // iterations. Single-turn questions fall through to the planner DAG below.
  if (args.allowMultiStepDag && args.chatHistory && args.chatHistory.length > 0) {
    const result = await runAgenticLoop({
      question: args.question,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
    })
    return {
      answer: result.answer,
      citations: result.citations,
      chartData: result.chartData,
      toolRuns: result.toolRuns,
    }
  }
  // ── End Agentic loop ─────────────────────────────────────────────────

  // ponytail: multi-step DAG path — when flag is set, use planner instead of single-tool router.
  // Ceiling: planner makes 1+ LLM calls (plan + execute + synthesize), higher latency than single-tool.
  // Use for complex questions that need multiple tools (e.g. "Q1 sales AND the SOP for that product").
  if (args.allowMultiStepDag) {
    const dagResult = await runMultiStepDag(args)
    if (dagResult) return dagResult
    // Fall through to single-tool if planner fails (graceful degradation)
  }

  // ── Intent Pipeline (parallelized) ───────────────────────────────────
  const hasHistory = args.chatHistory && args.chatHistory.length > 0

  const [
    effectiveQuestion,
    dbData,
    memoryContext,
  ] = await Promise.all([
    hasHistory
      ? rewriteQuery({ question: args.question, chatHistory: args.chatHistory! })
      : Promise.resolve(args.question),
    Promise.all([
      db.document.count({ where: { status: 'ready', isEnabled: true } }),
      db.integration.count({ where: { status: 'active' } }),
      db.document.findMany({ where: { status: 'ready', isEnabled: true }, select: { name: true, category: true }, take: 20 }),
      db.integration.findMany({ where: { status: 'active' }, select: { name: true }, take: 20 }),
      db.integrationSchema.findMany({
        where: { integration: { status: 'active' }, description: { not: null } },
        select: { tableName: true, description: true, integration: { select: { name: true } } },
        take: 40,
      }),
      db.restApiEndpoint.count({ where: { isEnabled: true, connector: { isActive: true } } }),
      getPromptSettings(db),
    ]),
    recallContext({ query: args.question, sessionId: args.sessionId }),
  ])

  if (hasHistory) {
    log.debug('Query rewritten', { original: args.question.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }

  const [docCount, intCount, docNames, intNames, schemaRows, restEndpointCount, promptSettings] = dbData
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  const intent = await analyzeIntent({
    question: hasHistory ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0,
    hasIntegrations: intCount > 0,
    documentNames: docNames.map((d) => d.category ? `${d.name} [${d.category}]` : d.name),
    integrationNames: intNames.map((i) => i.name),
    schemaSummaries,
  })

  if (intent.needsClarification && intent.clarificationQuestion) {
    return {
      answer: intent.clarificationQuestion,
      citations: [],
      chartData: null,
      toolRuns: [],
    }
  }

  if (!intent.needsRetrieval) {
    return runChatBranch({
      ...args,
      question: effectiveQuestion,
      memoryContext,
      chatHistory: args.chatHistory ?? [],
    })
  }
  // ── End Intent Pipeline ──────────────────────────────────────────────

  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId

  if (hasHistory) {
    const routed = await routeQuery({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
    })
    decision = routed.decision
  } else {
    const routed = await smartRoute({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      preferredIntegrationId: args.integrationId,
    })
    decision = routed.decision
    resolvedIntegrationId = routed.integrationId ?? args.integrationId
    // ponytail: when routing is ambiguous (multiple integrations match equally),
    // ask the user to clarify instead of guessing.
    if (routed.ambiguousIntegrations && routed.ambiguousIntegrations.length > 1) {
      const names = routed.ambiguousIntegrations.map((a) => a.integrationName)
      const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n')
      return {
        answer: `I found multiple databases that could answer this question. Which one do you mean?\n\n${list}\n\nPlease specify the database name or select it from the dropdown.`,
        citations: [],
        chartData: null,
        toolRuns: [],
      }
    }
  }

  decision = chooseAvailableDecision(decision, {
    hasIntegrations: intCount > 0,
    hasDocuments: docCount > 0,
    hasRestApis: restEndpointCount > 0,
  })
  if (decision === 'SQL' && !promptSettings.tools.sql) decision = 'CHAT'
  if (decision === 'RAG' && !promptSettings.tools.rag) decision = 'CHAT'
  if (decision === 'REST' && !promptSettings.tools.restApi) decision = 'CHAT'

  // ponytail: when multi-turn LLM router picks SQL but no integration was explicitly
  // selected, use schema-aware integration selection (same as smartRoute does for
  // first-turn). Without this, runSqlBranch falls back to "first by createdAt" which
  // always picks the same integration regardless of which DB the question targets.
  if (decision === 'SQL' && !resolvedIntegrationId) {
    const tokens = tokenize(effectiveQuestion)
    resolvedIntegrationId = await pickBestIntegration(tokens) ?? undefined
  }

  const historyMsgs: ChatHistoryEntry[] = args.chatHistory ?? []

  // For CONTEXTUAL_CHAT: load recent tool run outputs so the LLM has prior data context
  let contextualContext = ''
  if (decision === 'CONTEXTUAL_CHAT' && args.sessionId) {
    const recentToolRuns = await db.toolRun.findMany({
      where: {
        chatMessage: { sessionId: args.sessionId },
        status: 'success',
        outputSummary: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { type: true, inputSummary: true, outputSummary: true },
    })
    if (recentToolRuns.length > 0) {
      contextualContext = recentToolRuns
        .map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`)
        .join('\n\n---\n\n')
    }
  }

  const branchArgs = {
    ...args,
    question: effectiveQuestion,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: promptSettings.systemPrompt || undefined,
    memoryContext,
    chatHistory: historyMsgs,
  }

  let result: CompletionResult
  if (decision === 'SQL') result = await runSqlBranch(branchArgs)
  else if (decision === 'RAG') result = await runRagBranch(branchArgs)
  else if (decision === 'REST') result = await runRestBranch(branchArgs)
  else if (decision === 'PLUGIN') result = await runPluginBranch(branchArgs)
  else if (decision === 'CONTEXTUAL_CHAT' && contextualContext) {
    result = await runContextualChatBranch({ ...branchArgs, context: contextualContext })
  } else {
    result = await runChatBranch(branchArgs)
  }

  await rememberChatTurn({
    sessionId: args.sessionId,
    userMessage: args.question,
    aiMessage: result.answer,
    toolRuns: result.toolRuns.map((t) => ({ type: t.type, status: t.status, latencyMs: t.latencyMs ?? 0 })),
  })

  return result
}

// ---------------------------------------------------------------------------
// Multi-step DAG — plan → execute → synthesize.
// ponytail: returns null when planner fails or produces a single-step CHAT
// plan (fall back to single-tool router).
// ---------------------------------------------------------------------------

async function runMultiStepDag(args: {
  question: string
  userId: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult | null> {
  try {
    const availableTools = await getAvailableTools(args.question, 'chat')
    if (availableTools.length === 0) return null

    const plan = await planQuery({
      question: args.question,
      availableTools,
      sessionId: args.sessionId,
      chatHistory: args.chatHistory,
    })

    // Single-step CHAT plan = no benefit over single-tool router, skip
    if (plan.steps.length === 1 && plan.steps[0].tool === 'chat' && !plan.needsSynthesis) {
      return null
    }

    const results: PlanStepResult[] = await executePlan({
      plan,
      userId: args.userId,
      sessionId: args.sessionId,
    })

    const answer = await synthesizeAnswer({
      question: args.question,
      stepResults: results,
      plan,
    })

    const toolRuns: PendingToolRun[] = results.map((r) => ({
      type: r.tool.startsWith('plugin:') ? 'PLUGIN' : r.tool.startsWith('mcp:') ? 'PLUGIN' : (r.tool.toUpperCase() as PendingToolRun['type']),
      status: r.ok ? 'success' : 'error',
      latencyMs: r.latencyMs,
      inputSummary: summarize(args.question),
      outputSummary: summarize(r.output),
      errorMessage: r.error,
    }))

    return {
      answer,
      citations: [],
      chartData: null,
      toolRuns,
    }
  } catch (e) {
    log.warn('multi-step DAG failed, falling back to single-tool', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

// ---------------------------------------------------------------------------
// Agentic tool loop — continues calling tools until the LLM is confident
// enough to answer. Max 3 iterations to prevent infinite loops.
// ----------------------------------------------------------------------------

const MAX_AGENTIC_ITERATIONS = 3

interface AgenticIterationResult {
  answer: string
  citations: Citation[]
  chartData: ChartData | null
  toolRuns: PendingToolRun[]
  iterations: number
  confidenceHistory: { confident: boolean; confidence: number; reason: string }[]
}

async function runAgenticLoop(args: {
  question: string
  userId: string
  sessionId?: string
  integrationId?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<AgenticIterationResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    // Run one tool execution with accumulated context in the question.
    // allowMultiStepDag is intentionally NOT passed — prevents infinite recursion.
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    const result = await runNonStreamingChatCompletion({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
    })

    // Collect tool outputs
    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    // If no tools were called (clarification), return immediately
    if (result.toolRuns.length === 0) {
      return {
        answer: result.answer,
        citations: allCitations,
        chartData: result.chartData,
        toolRuns: allToolRuns,
        iterations: iteration + 1,
        confidenceHistory,
      }
    }

    // Accumulate evidence — include both the tool output summary AND the answer text.
    // ponytail: outputSummary for SQL stores the SQL query, not the results. The
    // actual evidence is in the answer. Including the answer gives the confidence
    // evaluator something meaningful to evaluate.
    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${result.answer.slice(0, 1000)}]`

    // ponytail: skip expensive LLM confidence check when the result is heuristically obvious.
    // Only call the LLM for genuinely ambiguous cases (moderate evidence, unclear if sufficient).
    const totalEvidenceLength = accumulatedEvidence.length
    const hasError = result.toolRuns.some((tr) => tr.status === 'error' || tr.status === 'blocked')
    const hasSubstantialData = totalEvidenceLength > 500

    if (hasError && result.toolRuns.every((tr) => tr.status === 'error' || tr.status === 'blocked')) {
      confidenceHistory.push({
        confident: false,
        confidence: 0,
        reason: 'all tools failed',
      })
      log.info('Agentic loop continuing (heuristic: all tools failed)', {
        iteration: iteration + 1,
      })
      continue
    }

    if (hasSubstantialData && !hasError) {
      confidenceHistory.push({
        confident: true,
        confidence: 0.85,
        reason: 'substantial evidence gathered (heuristic)',
      })
      log.info('Agentic loop confident (heuristic: substantial evidence)', {
        iteration: iteration + 1,
        evidenceLength: totalEvidenceLength,
      })
      return {
        answer: result.answer,
        citations: allCitations,
        chartData: result.chartData,
        toolRuns: allToolRuns,
        iterations: iteration + 1,
        confidenceHistory,
      }
    }

    // Evaluate confidence
    const confidence = await evaluateAnswerConfidence({
      question: args.question,
      evidence: accumulatedEvidence,
    })
    confidenceHistory.push({
      confident: confidence.confident,
      confidence: confidence.confidence,
      reason: confidence.reason,
    })

    if (confidence.confident) {
      // Confident enough — return the answer
      return {
        answer: result.answer,
        citations: allCitations,
        chartData: result.chartData,
        toolRuns: allToolRuns,
        iterations: iteration + 1,
        confidenceHistory,
      }
    }

    // Not confident — continue to next iteration.
    // ponytail: cross-source fallback — when the confidence evaluator suggests
    // a different tool type (e.g. "tried SQL, suggest RAG"), inject the hint
    // into the next iteration's question so the router picks the right tool.
    const toolHint = confidence.nextToolHint && confidence.nextToolHint !== 'CHAT'
      ? `\n[Hint: the previous tool call was insufficient. Try ${confidence.nextToolHint} instead.]`
      : ''
    accumulatedEvidence += toolHint
    log.info('Agentic loop continuing', {
      iteration: iteration + 1,
      confidence: confidence.confidence,
      reason: confidence.reason,
      nextToolHint: confidence.nextToolHint,
    })
  }

  // Max iterations reached — return the last answer
  log.info('Agentic loop max iterations reached', { iterations: MAX_AGENTIC_ITERATIONS })
  const finalResult = await runNonStreamingChatCompletion({
    question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
    userId: args.userId,
    sessionId: args.sessionId,
    chatHistory: args.chatHistory,
  })

  return {
    answer: finalResult.answer,
    citations: [...allCitations, ...finalResult.citations],
    chartData: finalResult.chartData,
    toolRuns: [...allToolRuns, ...finalResult.toolRuns],
    iterations: MAX_AGENTIC_ITERATIONS,
    confidenceHistory,
  }
}

// ---------------------------------------------------------------------------
// Streaming agentic loop — same confidence-based loop as runAgenticLoop but
// streams status updates + the final answer. Used by the UI chat (send/route).
// ----------------------------------------------------------------------------

async function runStreamingAgenticLoop(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    // Run the streaming pipeline (NOT agentic — prevents recursion)
    const result = await runStreamingChatCompletion({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
    })

    // Collect tool runs + citations
    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    // If no tools were called (clarification/CHAT), stream the answer directly
    if (result.toolRuns.length === 0) {
      return {
        stream: result.stream,
        toolRuns: allToolRuns,
        citations: allCitations,
        chartData: result.chartData,
      }
    }

    // Consume the stream to get the full answer + accumulate evidence
    // We need to buffer the answer because we might need to do more iterations
    let answerText = ''
    for await (const chunk of result.stream) {
      answerText += chunk
    }

    // Accumulate evidence — include tool output + the answer text (see non-streaming loop for rationale)
    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${answerText.slice(0, 1000)}]`

    // Heuristic confidence check (same as non-streaming loop)
    const hasError = result.toolRuns.some((tr) => tr.status === 'error' || tr.status === 'blocked')
    const hasSubstantialData = accumulatedEvidence.length > 500

    if (hasError && result.toolRuns.every((tr) => tr.status === 'error' || tr.status === 'blocked')) {
      log.info('Streaming agentic loop continuing (all tools failed)', { iteration: iteration + 1 })
      continue
    }

    if (hasSubstantialData && !hasError) {
      log.info('Streaming agentic loop confident (heuristic)', { iteration: iteration + 1 })
      async function* answerStream() { yield answerText }
      return {
        stream: answerStream(),
        toolRuns: allToolRuns,
        citations: allCitations,
        chartData: result.chartData,
      }
    }

    // LLM confidence evaluation for ambiguous cases
    const confidence = await evaluateAnswerConfidence({
      question: args.question,
      evidence: accumulatedEvidence,
    })

    if (confidence.confident) {
      async function* answerStream() { yield answerText }
      return {
        stream: answerStream(),
        toolRuns: allToolRuns,
        citations: allCitations,
        chartData: result.chartData,
      }
    }

    // Cross-source fallback: if confidence evaluator suggests a different tool,
    // the next iteration will naturally route to it via the intent pipeline.
    log.info('Streaming agentic loop continuing', {
      iteration: iteration + 1,
      confidence: confidence.confidence,
      nextToolHint: confidence.nextToolHint,
    })
  }

  // Max iterations — do a final synthesis stream with all evidence
  const finalResult = await runStreamingChatCompletion({
    question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
    userId: args.userId,
    sessionId: args.sessionId,
    chatHistory: args.chatHistory,
  })

  return {
    stream: finalResult.stream,
    toolRuns: [...allToolRuns, ...finalResult.toolRuns],
    citations: [...allCitations, ...finalResult.citations],
    chartData: finalResult.chartData,
  }
}

// ---------------------------------------------------------------------------
// Streaming entry point — the main streaming dispatcher.
// Same routing logic as runNonStreamingChatCompletion but delegates to
// prepare*Stream functions that return AsyncGenerator streams.
// ---------------------------------------------------------------------------

export async function runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
}): Promise<StreamingCompletionResult> {
  // ponytail: streaming agentic loop — when enabled, run the confidence loop
  // but stream status updates + final answer. Yields "Searching...", "Querying..."
  // between iterations so the user sees progress instead of waiting blind.
  if (args.allowMultiStepDag && args.chatHistory && args.chatHistory.length > 0) {
    return runStreamingAgenticLoop(args)
  }
  // ── Intent Pipeline (streaming, parallelized) ───────────────────────
  const hasHistory = args.chatHistory && args.chatHistory.length > 0

  const [
    effectiveQuestion,
    dbData,
    memoryContext,
  ] = await Promise.all([
    hasHistory
      ? rewriteQuery({ question: args.question, chatHistory: args.chatHistory! })
      : Promise.resolve(args.question),
    Promise.all([
      db.document.count({ where: { status: 'ready', isEnabled: true } }),
      db.integration.count({ where: { status: 'active' } }),
      db.document.findMany({ where: { status: 'ready', isEnabled: true }, select: { name: true, category: true }, take: 20 }),
      db.integration.findMany({ where: { status: 'active' }, select: { name: true }, take: 20 }),
      db.integrationSchema.findMany({
        where: { integration: { status: 'active' }, description: { not: null } },
        select: { tableName: true, description: true, integration: { select: { name: true } } },
        take: 40,
      }),
      db.restApiEndpoint.count({ where: { isEnabled: true, connector: { isActive: true } } }),
      getPromptSettings(db),
    ]),
    recallContext({ query: args.question, sessionId: args.sessionId }),
  ])

  if (hasHistory) {
    log.debug('Query rewritten (stream)', { original: args.question.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }

  const [docCount, intCount, docNames, intNames, schemaRows, restEndpointCount, promptSettings] = dbData
  const schemaSummaries = schemaRows.map((s) => `${s.integration.name}.${s.tableName}: ${s.description}`)

  const intent = await analyzeIntent({
    question: hasHistory ? effectiveQuestion : args.question,
    chatHistory: args.chatHistory,
    hasDocuments: docCount > 0,
    hasIntegrations: intCount > 0,
    documentNames: docNames.map((d) => d.category ? `${d.name} [${d.category}]` : d.name),
    integrationNames: intNames.map((i) => i.name),
    schemaSummaries,
  })

  if (intent.needsClarification && intent.clarificationQuestion) {
    async function* clarifyStream() { yield intent.clarificationQuestion! }
    return {
      stream: clarifyStream(),
      toolRuns: [],
      citations: [],
      chartData: null,
    }
  }

  if (!intent.needsRetrieval) {
    return prepareChatStream({
      question: effectiveQuestion,
      systemPromptPrefix: undefined,
      memoryContext,
      chatHistory: args.chatHistory ?? [],
    })
  }
  // ── End Intent Pipeline ─────────────────────────────────────────────

  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId

  if (hasHistory) {
    const routed = await routeQuery({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
    })
    decision = routed.decision
  } else {
    const routed = await smartRoute({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      preferredIntegrationId: args.integrationId,
    })
    decision = routed.decision
    resolvedIntegrationId = routed.integrationId ?? args.integrationId
    // ponytail: ambiguous integration — return clarification stream
    if (routed.ambiguousIntegrations && routed.ambiguousIntegrations.length > 1) {
      const names = routed.ambiguousIntegrations.map((a) => a.integrationName)
      const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n')
      const clarification = `I found multiple databases that could answer this question. Which one do you mean?\n\n${list}\n\nPlease specify the database name or select it from the dropdown.`
      async function* clarifyStream() { yield clarification }
      return {
        stream: clarifyStream(),
        toolRuns: [],
        citations: [],
        chartData: null,
      }
    }
  }

  decision = chooseAvailableDecision(decision, {
    hasIntegrations: intCount > 0,
    hasDocuments: docCount > 0,
    hasRestApis: restEndpointCount > 0,
  })
  if (decision === 'SQL' && !promptSettings.tools.sql) decision = 'CHAT'
  if (decision === 'RAG' && !promptSettings.tools.rag) decision = 'CHAT'
  if (decision === 'REST' && !promptSettings.tools.restApi) decision = 'CHAT'

  // ponytail: when multi-turn LLM router picks SQL but no integration was explicitly
  // selected, use schema-aware integration selection (same as smartRoute does for
  // first-turn). Without this, runSqlBranch falls back to "first by createdAt" which
  // always picks the same integration regardless of which DB the question targets.
  if (decision === 'SQL' && !resolvedIntegrationId) {
    const tokens = tokenize(effectiveQuestion)
    resolvedIntegrationId = await pickBestIntegration(tokens) ?? undefined
  }

  // For CONTEXTUAL_CHAT: load recent tool run outputs so the LLM has prior data context
  let contextualContext = ''
  if (decision === 'CONTEXTUAL_CHAT' && args.sessionId) {
    const recentToolRuns = await db.toolRun.findMany({
      where: {
        chatMessage: { sessionId: args.sessionId },
        status: 'success',
        outputSummary: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { type: true, inputSummary: true, outputSummary: true },
    })
    if (recentToolRuns.length > 0) {
      contextualContext = recentToolRuns
        .map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`)
        .join('\n\n---\n\n')
    }
  }

  const branchArgs = {
    ...args,
    question: effectiveQuestion,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: promptSettings.systemPrompt || undefined,
    memoryContext,
    chatHistory: args.chatHistory ?? [],
  }

  if (decision === 'SQL') return await prepareSqlStream(branchArgs)
  if (decision === 'RAG') return await prepareRagStream(branchArgs)
  if (decision === 'REST') return await prepareRestStream(branchArgs)
  if (decision === 'PLUGIN') return await preparePluginStream(branchArgs)
  if (decision === 'CONTEXTUAL_CHAT' && contextualContext) {
    return await prepareContextualChatStream({ ...branchArgs, context: contextualContext })
  }
  return await prepareChatStream(branchArgs)
}
