import type { Citation, ChartData } from '@/lib/types'
import type { PendingToolRun, CompletionResult, ChatHistoryEntry, StreamingCompletionResult } from '@/lib/tool-utils'
import { evaluateAnswerConfidence } from '@/lib/intent-pipeline'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { summarize } from '@/lib/tool-utils'
import { createTokenBudget, type TokenBudget } from '@/lib/agentic-budget'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

const MAX_AGENTIC_ITERATIONS = 3
const AGENTIC_DEADLINE_MS = Number(process.env.AGENTIC_DEADLINE_MS ?? 90_000)

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
    budget?: TokenBudget
    skipClarification?: boolean
    systemPromptPrefix?: string
  },
  runCompletion: (a: { question: string; userId: string; sessionId?: string; integrationId?: string; chatHistory?: ChatHistoryEntry[]; skipClarification?: boolean; systemPromptPrefix?: string }) => Promise<CompletionResult>,
): Promise<AgenticIterationResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []
  const budget = args.budget ?? createTokenBudget()
  const deadline = Date.now() + AGENTIC_DEADLINE_MS

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    if (Date.now() > deadline) {
      log.info('Agentic loop stopped — deadline exceeded', { iterations: iteration })
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'deadline exceeded' })
      return { answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: iteration, confidenceHistory }
    }
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    const result = await runCompletion({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
      skipClarification: args.skipClarification,
      systemPromptPrefix: args.systemPromptPrefix,
    })

    if (result.usage) budget.track(result.usage)
    if (budget.isExhausted()) {
      log.info('Agentic loop stopped — token budget exhausted', { iteration: iteration + 1, total: budget.total() })
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'token budget exhausted' })
      return { answer: `${result.answer}\n\n[Note: token budget exhausted — answer may be incomplete.]`, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    if (result.toolRuns.length === 0) {
      return { answer: result.answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    // Reflexion: self-critique the answer before confidence eval (opt-in).
    let answer = result.answer
    if (process.env.REFLEXION_ENABLED === 'true') {
      const { selfCritique } = await import('@/lib/reflexion')
      const critique = await selfCritique(args.question, answer, accumulatedEvidence + `\n${result.answer}`)
      if (critique.needsRevision) {
        answer = critique.revisedAnswer
        log.info('Reflexion revised answer', { iteration: iteration + 1, critique: critique.critique.slice(0, 100) })
      }
    }

    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${answer.slice(0, 1000)}]`

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
      return { answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
    }

    const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
    confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })

    if (confidence.confident) {
      if (process.env.ALIGNMENT_CHECK === 'true' || process.env.ALIGNMENT_CHECK_URL) {
        const { checkAlignment } = await import('@/lib/alignment-check')
        const alignment = await checkAlignment(answer, args.question)
        if (alignment.risk === 'high') {
          log.info('Agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
          confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
          return { answer: `${answer}\n\n[Note: answer flagged by alignment check — ${alignment.reason}]`, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
        }
      }
      return { answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
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
    skipClarification: args.skipClarification,
    systemPromptPrefix: args.systemPromptPrefix,
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
    skipClarification?: boolean
    systemPromptPrefix?: string
    onConfidence?: (info: { iteration: number; confidence: number; reason: string; confident: boolean }) => void
  },
  runStreaming: (a: { question: string; userId: string; sessionId?: string; integrationId?: string; chatHistory?: ChatHistoryEntry[]; skipClarification?: boolean; systemPromptPrefix?: string }) => Promise<StreamingCompletionResult>,
): Promise<StreamingCompletionResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []
  const deadline = Date.now() + AGENTIC_DEADLINE_MS

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    if (Date.now() > deadline) {
      log.info('Streaming agentic loop stopped — deadline exceeded', { iterations: iteration })
      async function* timeoutStream() { yield 'The request timed out before a complete answer could be generated.' }
      return { stream: timeoutStream(), toolRuns: allToolRuns, citations: allCitations, chartData: null }
    }
    const contextualQuestion = accumulatedEvidence
      ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
      : args.question

    const result = await runStreaming({
      question: contextualQuestion,
      userId: args.userId,
      sessionId: args.sessionId,
      integrationId: args.integrationId,
      chatHistory: args.chatHistory,
      skipClarification: args.skipClarification,
      systemPromptPrefix: args.systemPromptPrefix,
    })

    allToolRuns.push(...result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    if (result.toolRuns.length === 0) {
      return { stream: result.stream, toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData, citationTrail: result.citationTrail }
    }

    let answerText = ''
    for await (const chunk of result.stream) {
      answerText += chunk
    }

    // Reflexion: self-critique the answer before confidence eval (opt-in).
    if (process.env.REFLEXION_ENABLED === 'true') {
      const { selfCritique } = await import('@/lib/reflexion')
      const critique = await selfCritique(args.question, answerText, accumulatedEvidence + `\n${answerText}`)
      if (critique.needsRevision) {
        answerText = critique.revisedAnswer
        log.info('Streaming reflexion revised answer', { iteration: iteration + 1, critique: critique.critique.slice(0, 100) })
      }
    }

    const toolEvidence = result.toolRuns
      .map((tr) => `[${tr.type}] ${tr.outputSummary?.slice(0, 300) ?? ''}`)
      .join('\n')
    accumulatedEvidence += `\n${toolEvidence}\n[Answer so far: ${answerText.slice(0, 1000)}]`

    const hasError = result.toolRuns.some((tr) => tr.status === 'error' || tr.status === 'blocked')
    const hasSubstantialData = accumulatedEvidence.length > 500

    if (hasError && result.toolRuns.every((tr) => tr.status === 'error' || tr.status === 'blocked')) {
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'all tools failed' })
      log.info('Streaming agentic loop continuing (all tools failed)', { iteration: iteration + 1 })
      continue
    }

    if (hasSubstantialData && !hasError) {
      confidenceHistory.push({ confident: true, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)' })
      log.info('Streaming agentic loop confident (heuristic)', { iteration: iteration + 1 })
      args.onConfidence?.({ iteration: iteration + 1, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)', confident: true })

      // Alignment check (opt-in)
      if (process.env.ALIGNMENT_CHECK === 'true' || process.env.ALIGNMENT_CHECK_URL) {
        const { checkAlignment } = await import('@/lib/alignment-check')
        const alignment = await checkAlignment(answerText, args.question)
        if (alignment.risk === 'high') {
          log.info('Streaming agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
          confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
          async function* alignedStream() { yield `${answerText}\n\n[Note: answer flagged by alignment check — ${alignment.reason}]` }
          return { stream: alignedStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData, citationTrail: result.citationTrail }
        }
      }

      async function* answerStream() { yield answerText }
      return { stream: answerStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData, citationTrail: result.citationTrail }
    }

    const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
    confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })
    args.onConfidence?.({ iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, confident: confidence.confident })

    if (confidence.confident) {
      if (process.env.ALIGNMENT_CHECK === 'true' || process.env.ALIGNMENT_CHECK_URL) {
        const { checkAlignment } = await import('@/lib/alignment-check')
        const alignment = await checkAlignment(answerText, args.question)
        if (alignment.risk === 'high') {
          log.info('Streaming agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
          confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
          async function* alignedStream() { yield `${answerText}\n\n[Note: answer flagged by alignment check — ${alignment.reason}]` }
          return { stream: alignedStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData, citationTrail: result.citationTrail }
        }
      }

      async function* answerStream() { yield answerText }
      return { stream: answerStream(), toolRuns: allToolRuns, citations: allCitations, chartData: result.chartData, citationTrail: result.citationTrail }
    }

    const toolHint = confidence.nextToolHint && confidence.nextToolHint !== 'CHAT'
      ? `\n[Hint: the previous tool call was insufficient. Try ${confidence.nextToolHint} instead.]`
      : ''
    accumulatedEvidence += toolHint
    log.info('Streaming agentic loop continuing', { iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, nextToolHint: confidence.nextToolHint })
  }

  const finalResult = await runStreaming({
    question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
    userId: args.userId,
    sessionId: args.sessionId,
    chatHistory: args.chatHistory,
    skipClarification: args.skipClarification,
    systemPromptPrefix: args.systemPromptPrefix,
  })

  return { stream: finalResult.stream, toolRuns: [...allToolRuns, ...finalResult.toolRuns], citations: [...allCitations, ...finalResult.citations], chartData: finalResult.chartData, citationTrail: finalResult.citationTrail }
}
