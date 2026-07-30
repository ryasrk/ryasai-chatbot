import type { Citation, ChartData } from '@/lib/types'
import type { PendingToolRun, CompletionResult, ChatHistoryEntry, StreamingCompletionResult } from '@/lib/tool-utils'
import { evaluateAnswerConfidence } from '@/lib/intent-pipeline'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { summarize } from '@/lib/tool-utils'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

const MAX_AGENTIC_ITERATIONS = 3

interface AgenticIterationResult {
  answer: string
  citations: Citation[]
  chartData: ChartData | null
  toolRuns: PendingToolRun[]
  iterations: number
  confidenceHistory: { confident: boolean; confidence: number; reason: string }[]
}

export async function runMultiStepDag(args: {
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

    return { answer, citations: [], chartData: null, toolRuns }
  } catch (e) {
    log.warn('multi-step DAG failed, falling back to single-tool', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export async function runAgenticLoop(
  args: {
    question: string
    userId: string
    sessionId?: string
    integrationId?: string
    chatHistory?: ChatHistoryEntry[]
  },
  runCompletion: (a: { question: string; userId: string; sessionId?: string; integrationId?: string; chatHistory?: ChatHistoryEntry[] }) => Promise<CompletionResult>,
): Promise<AgenticIterationResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    const result = await runCompletion({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
    })

    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    if (result.toolRuns.length === 0) {
      return { answer: result.answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${result.answer.slice(0, 1000)}]`

    const totalEvidenceLength = accumulatedEvidence.length
    const hasError = result.toolRuns.some((tr) => tr.status === 'error' || tr.status === 'blocked')
    const hasSubstantialData = totalEvidenceLength > 500

    if (hasError && result.toolRuns.every((tr) => tr.status === 'error' || tr.status === 'blocked')) {
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'all tools failed' })
      log.info('Agentic loop continuing (heuristic: all tools failed)', { iteration: iteration + 1 })
      continue
    }

    if (hasSubstantialData && !hasError) {
      confidenceHistory.push({ confident: true, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)' })
      log.info('Agentic loop confident (heuristic: substantial evidence)', { iteration: iteration + 1, evidenceLength: totalEvidenceLength })
      return { answer: result.answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
    confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })

    if (confidence.confident) {
      return { answer: result.answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    const toolHint = confidence.nextToolHint && confidence.nextToolHint !== 'CHAT'
      ? `\n[Hint: the previous tool call was insufficient. Try ${confidence.nextToolHint} instead.]`
      : ''
    accumulatedEvidence += toolHint
    log.info('Agentic loop continuing', { iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, nextToolHint: confidence.nextToolHint })
  }

  log.info('Agentic loop max iterations reached', { iterations: MAX_AGENTIC_ITERATIONS })
  const finalResult = await runCompletion({
    question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
    userId: args.userId,
    sessionId: args.sessionId,
    chatHistory: args.chatHistory,
  })

  return { answer: finalResult.answer, citations: [...allCitations, ...finalResult.citations], chartData: finalResult.chartData, toolRuns: [...allToolRuns, ...finalResult.toolRuns], iterations: MAX_AGENTIC_ITERATIONS, confidenceHistory }
}

export async function runStreamingAgenticLoop(
  args: {
    question: string
    userId: string
    integrationId?: string
    sessionId?: string
    chatHistory?: ChatHistoryEntry[]
  },
  runStreaming: (a: { question: string; userId: string; sessionId?: string; integrationId?: string; chatHistory?: ChatHistoryEntry[] }) => Promise<StreamingCompletionResult>,
): Promise<StreamingCompletionResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    const result = await runStreaming({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
    })

    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    if (result.toolRuns.length === 0) {
      return { stream: result.stream, toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData }
    }

    let answerText = ''
    for await (const chunk of result.stream) {
      answerText += chunk
    }

    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${answerText.slice(0, 1000)}]`

    const hasError = result.toolRuns.some((tr) => tr.status === 'error' || tr.status === 'blocked')
    const hasSubstantialData = accumulatedEvidence.length > 500

    if (hasError && result.toolRuns.every((tr) => tr.status === 'error' || tr.status === 'blocked')) {
      log.info('Streaming agentic loop continuing (all tools failed)', { iteration: iteration + 1 })
      continue
    }

    if (hasSubstantialData && !hasError) {
      log.info('Streaming agentic loop confident (heuristic)', { iteration: iteration + 1 })
      async function* answerStream() { yield answerText }
      return { stream: answerStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData }
    }

    const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })

    if (confidence.confident) {
      async function* answerStream() { yield answerText }
      return { stream: answerStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData }
    }

    log.info('Streaming agentic loop continuing', { iteration: iteration + 1, confidence: confidence.confidence, nextToolHint: confidence.nextToolHint })
  }

  const finalResult = await runStreaming({
    question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
    userId: args.userId,
    sessionId: args.sessionId,
    chatHistory: args.chatHistory,
  })

  return { stream: finalResult.stream, toolRuns: [...allToolRuns, ...finalResult.toolRuns], citations: [...allCitations, ...finalResult.citations], chartData: finalResult.chartData }
}
