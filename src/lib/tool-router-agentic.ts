import type { Citation, ChartData } from '@/lib/types'
import type { PendingToolRun, CompletionResult, ChatHistoryEntry, StreamingCompletionResult } from '@/lib/tool-utils'
import { evaluateAnswerConfidence } from '@/lib/intent-pipeline'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { summarize } from '@/lib/tool-utils'
import { createTokenBudget, type TokenBudget } from '@/lib/agentic-budget'
import { getLastLlmUsage } from '@/lib/llm-client'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

const MAX_AGENTIC_ITERATIONS = 3
const AGENTIC_DEADLINE_MS = Number(process.env.AGENTIC_DEADLINE_MS ?? 90_000)

// ponytail: deadline is enforced per round (see withAgenticDeadline) so a hung
// tool (plugin up to 120s, dead MCP 30s, REST timeout) can't push a single
// round past the remaining deadline budget. The losing work keeps running in
// the background — Node can't abort a promise it doesn't hold a signal for.
class AgenticDeadlineError extends Error {
  constructor() {
    super('agentic deadline exceeded')
    this.name = 'AgenticDeadlineError'
  }
}

async function withAgenticDeadline<T>(deadline: number, fn: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new AgenticDeadlineError()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgenticDeadlineError()), remaining)
    fn().then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

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
      // runMultiStepDag uses 'chat' context — admin tools are never offered here.
      isAdmin: false,
    })

    const answer = await synthesizeAnswer({
      question: args.question,
      stepResults: results,
      plan,
    })

    // ponytail: MCP steps are persisted as ToolRun rows at invocation time in
    // the planner (executeStep), so filter them out here to avoid duplicates.
    const toolRuns: PendingToolRun[] = results
      .filter((r) => !r.tool.startsWith('mcp:'))
      .map((r) => ({
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

    let result: CompletionResult
    try {
      result = await withAgenticDeadline(deadline, () => runCompletion({
        question: contextualQuestion,
        userId: args.userId,
        sessionId: args.sessionId,
        integrationId: args.integrationId,
        chatHistory: args.chatHistory,
        skipClarification: args.skipClarification,
        systemPromptPrefix: args.systemPromptPrefix,
      }))
    } catch (e) {
      if (e instanceof AgenticDeadlineError) {
        log.info('Agentic loop stopped — deadline exceeded mid-round', { iteration: iteration + 1 })
        confidenceHistory.push({ confident: false, confidence: 0, reason: 'deadline exceeded' })
        return { answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory }
      }
      throw e
    }

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
  let finalResult: CompletionResult
  try {
    finalResult = await withAgenticDeadline(deadline, () => runCompletion({
      question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
      userId: args.userId,
      sessionId: args.sessionId,
      chatHistory: args.chatHistory,
      skipClarification: args.skipClarification,
      systemPromptPrefix: args.systemPromptPrefix,
    }))
  } catch (e) {
    if (e instanceof AgenticDeadlineError) {
      log.info('Agentic loop stopped — deadline exceeded during synthesis', { iterations: MAX_AGENTIC_ITERATIONS })
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'deadline exceeded' })
      return { answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: MAX_AGENTIC_ITERATIONS, confidenceHistory }
    }
    throw e
  }

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
    budget?: TokenBudget
    onConfidence?: (info: { iteration: number; confidence: number; reason: string; confident: boolean }) => void
  },
  runStreaming: (a: { question: string; userId: string; sessionId?: string; integrationId?: string; chatHistory?: ChatHistoryEntry[]; skipClarification?: boolean; systemPromptPrefix?: string }) => Promise<StreamingCompletionResult>,
): Promise<StreamingCompletionResult> {
  const allToolRuns: PendingToolRun[] = []
  const allCitations: Citation[] = []
  let accumulatedEvidence = ''
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []
  const budget = args.budget ?? createTokenBudget()
  const deadline = Date.now() + AGENTIC_DEADLINE_MS

  async function* combinedStream(): AsyncGenerator<string, void, unknown> {
    for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
      if (Date.now() > deadline) {
        log.info('Streaming agentic loop stopped — deadline exceeded', { iterations: iteration })
        yield 'The request timed out before a complete answer could be generated.'
        return
      }

      const contextualQuestion = accumulatedEvidence
        ? `${args.question}\n\n[Context from prior tool calls: ${accumulatedEvidence.slice(0, 1000)}]`
        : args.question

      let result: StreamingCompletionResult
      try {
        result = await withAgenticDeadline(deadline, () => runStreaming({
          question: contextualQuestion,
          userId: args.userId,
          sessionId: args.sessionId,
          integrationId: args.integrationId,
          chatHistory: args.chatHistory,
          skipClarification: args.skipClarification,
          systemPromptPrefix: args.systemPromptPrefix,
        }))
      } catch (e) {
        if (e instanceof AgenticDeadlineError) {
          log.info('Streaming agentic loop stopped — deadline exceeded mid-round', { iteration: iteration + 1 })
          yield accumulatedEvidence
            ? '\n\n[Note: deadline exceeded — the answer may be incomplete.]'
            : 'The request timed out before a complete answer could be generated.'
          return
        }
        throw e
      }

      allToolRuns.push(...result.toolRuns)
      if (result.citations) allCitations.push(...result.citations)

      // No tools ran — stream the answer directly and finish.
      if (result.toolRuns.length === 0) {
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail
        for await (const chunk of result.stream) {
          yield chunk
        }
        const usage = getLastLlmUsage()
        if (usage) budget.track(usage)
        if (budget.isExhausted()) {
          log.info('Streaming agentic loop stopped — token budget exhausted', { iteration: iteration + 1, total: budget.total() })
          yield '\n\n[Note: token budget exhausted — answer may be incomplete.]'
        }
        return
      }

      // Tools ran — stream the answer live while accumulating for confidence
      // evaluation. Reflexion (opt-in) needs the full text before revising, so
      // when enabled we buffer and yield the revised answer in one chunk.
      let answerText = ''
      if (process.env.REFLEXION_ENABLED === 'true') {
        for await (const chunk of result.stream) {
          answerText += chunk
        }
        const { selfCritique } = await import('@/lib/reflexion')
        const critique = await selfCritique(args.question, answerText, accumulatedEvidence + `\n${answerText}`)
        if (critique.needsRevision) {
          answerText = critique.revisedAnswer
          log.info('Streaming reflexion revised answer', { iteration: iteration + 1, critique: critique.critique.slice(0, 100) })
        }
        yield answerText
      } else {
        for await (const chunk of result.stream) {
          answerText += chunk
          yield chunk
        }
      }

      // Token budget — mirror runAgenticLoop: track this round's usage and stop
      // starting further tool iterations once exhausted.
      const usage = getLastLlmUsage()
      if (usage) budget.track(usage)
      if (budget.isExhausted()) {
        log.info('Streaming agentic loop stopped — token budget exhausted', { iteration: iteration + 1, total: budget.total() })
        confidenceHistory.push({ confident: false, confidence: 0, reason: 'token budget exhausted' })
        yield '\n\n[Note: token budget exhausted — answer may be incomplete.]'
        return
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
        yield '\n\n_Continuing analysis..._\n\n'
        continue
      }

      if (hasSubstantialData && !hasError) {
        confidenceHistory.push({ confident: true, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)' })
        log.info('Streaming agentic loop confident (heuristic)', { iteration: iteration + 1 })
        args.onConfidence?.({ iteration: iteration + 1, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)', confident: true })
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail

        if (process.env.ALIGNMENT_CHECK === 'true' || process.env.ALIGNMENT_CHECK_URL) {
          const { checkAlignment } = await import('@/lib/alignment-check')
          const alignment = await checkAlignment(answerText, args.question)
          if (alignment.risk === 'high') {
            log.info('Streaming agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
            confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
            yield `\n\n[Note: answer flagged by alignment check — ${alignment.reason}]`
          }
        }
        return
      }

      const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
      confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })
      args.onConfidence?.({ iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, confident: confidence.confident })

      if (confidence.confident) {
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail

        if (process.env.ALIGNMENT_CHECK === 'true' || process.env.ALIGNMENT_CHECK_URL) {
          const { checkAlignment } = await import('@/lib/alignment-check')
          const alignment = await checkAlignment(answerText, args.question)
          if (alignment.risk === 'high') {
            log.info('Streaming agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
            confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
            yield `\n\n[Note: answer flagged by alignment check — ${alignment.reason}]`
          }
        }
        return
      }

      const toolHint = confidence.nextToolHint && confidence.nextToolHint !== 'CHAT'
        ? `\n[Hint: the previous tool call was insufficient. Try ${confidence.nextToolHint} instead.]`
        : ''
      accumulatedEvidence += toolHint
      log.info('Streaming agentic loop continuing', { iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, nextToolHint: confidence.nextToolHint })
      yield '\n\n_Continuing analysis..._\n\n'
    }

    // Max iterations reached without a confident answer — final synthesis.
    log.info('Streaming agentic loop max iterations reached', { iterations: MAX_AGENTIC_ITERATIONS })
    let finalResult: StreamingCompletionResult
    try {
      finalResult = await withAgenticDeadline(deadline, () => runStreaming({
        question: `${args.question}\n\n[All gathered evidence: ${accumulatedEvidence.slice(0, 2000)}]\n\nBased on all the evidence above, answer the original question.`,
        userId: args.userId,
        sessionId: args.sessionId,
        chatHistory: args.chatHistory,
        skipClarification: args.skipClarification,
        systemPromptPrefix: args.systemPromptPrefix,
      }))
    } catch (e) {
      if (e instanceof AgenticDeadlineError) {
        log.info('Streaming agentic loop stopped — deadline exceeded during synthesis', { iterations: MAX_AGENTIC_ITERATIONS })
        yield accumulatedEvidence
          ? '\n\n[Note: deadline exceeded — the answer may be incomplete.]'
          : 'The request timed out before a complete answer could be generated.'
        return
      }
      throw e
    }
    allToolRuns.push(...finalResult.toolRuns)
    if (finalResult.citations) allCitations.push(...finalResult.citations)
    output.chartData = finalResult.chartData
    output.citationTrail = finalResult.citationTrail
    for await (const chunk of finalResult.stream) {
      yield chunk
    }
    const finalUsage = getLastLlmUsage()
    if (finalUsage) budget.track(finalUsage)
    if (budget.isExhausted()) {
      yield '\n\n[Note: token budget exhausted — answer may be incomplete.]'
    }
  }

  // ponytail: output is mutated inside combinedStream() to set chartData/
  // citationTrail from whichever iteration produces the final answer. The
  // arrays (allToolRuns/allCitations) are also mutated during generation.
  // Callers must consume the stream before reading these fields.
  const output: StreamingCompletionResult = {
    stream: combinedStream(),
    toolRuns: allToolRuns,
    citations: allCitations,
    chartData: null,
    citationTrail: undefined,
  }
  return output
}
