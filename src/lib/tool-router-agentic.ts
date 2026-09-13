import type { Citation, ChartData } from '@/lib/types'
import type { PendingToolRun, CompletionResult, ChatHistoryEntry, StreamingCompletionResult } from '@/lib/tool-utils'
import { isAlignmentCheckEnabled } from '@/lib/alignment-check'
import { evaluateAnswerConfidence } from '@/lib/intent-pipeline'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { summarize } from '@/lib/tool-utils'
import { createTokenBudget, type TokenBudget } from '@/lib/agentic-budget'
import { getLastLlmUsage } from '@/lib/llm-client'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

const MAX_AGENTIC_ITERATIONS = 3

/**
 * Per-round deadline budget, read LAZILY.
 *
 * It used to be a module-level const, which made the deadline untestable: the
 * value is captured at import time, and bun hoists imports above a test file's
 * top-level statements, so a test could not set the env before the read. Read at
 * call time, the deadline is also honest about what the operator set — with the
 * constant, changing AGENTIC_DEADLINE_MS had no effect until the process restarted.
 * A non-positive value is honoured (deadline already past), which is what the
 * termination tests use.
 */
function agenticDeadlineMs(): number {
  const raw = Number(process.env.AGENTIC_DEADLINE_MS ?? 90_000)
  return Number.isFinite(raw) ? raw : 90_000
}

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

/**
 * Map a planner/tool-registry tool id to a persisted `ToolRun.type` value.
 *
 * FIX (2026-09): the old inline expression cast `r.tool.toUpperCase()` straight
 * to `PendingToolRun['type']`, so tool ids that had no constant-case equivalent
 * — `db_query`/`web_fetch`/`chat` — were written to the DB as `SQL`/`WEB_FETCH`/
 * `CHAT`. Only `RAG | SQL | REST_API | CHAT | PLUGIN` are valid (see
 * `tool-utils.ts` and the `ToolRun.type` column comment); anything else is
 * invisible to `loadPerformanceMetrics()`, which filters by those exact strings
 * when computing success rate, latency and the circuit breaker.
 */
export function toolRunTypeFor(tool: string): PendingToolRun['type'] {
  if (tool.startsWith('plugin:') || tool.startsWith('mcp:')) return 'PLUGIN'
  const up = tool.toUpperCase()
  if (up === 'SQL' || up === 'DB_QUERY' || up === 'DATABASE') return 'SQL'
  if (up === 'RAG' || up === 'KNOWLEDGE' || up === 'DOCUMENTS') return 'RAG'
  if (up === 'REST' || up === 'REST_API' || up === 'API') return 'REST_API'
  if (up === 'CHAT' || up === 'ANSWER' || up === 'WEB_FETCH' || up === 'WEB_SEARCH') return 'CHAT'
  // ponytail: unknown tool → CHAT rather than an invalid literal. An invalid
  // type is silently dropped by every metrics query, which is worse than
  // slightly mislabelling an exotic tool.
  return 'CHAT'
}

/**
 * Append `incoming` tool runs to `target`, collapsing repeats.
 *
 * INCIDENT (2026-09): `runStreamingAgenticLoop` pushes each iteration's
 * `result.toolRuns` onto `allToolRuns`, and a streaming round always reports at
 * least one run (the CHAT preparers emit one unconditionally). A single chat
 * turn that looped twice therefore persisted FOUR identical CHAT rows.
 *
 * Those rows are not cosmetic: `loadPerformanceMetrics()` reads the last 50
 * ToolRuns per type (`take: 50`, 24h window) to compute `successRate`,
 * `avgLatencyMs`, `total` and `recentFailRate` (the smart router's circuit
 * breaker). Duplicates inflate `total` and skew every derived score, so the
 * router's tool selection silently degrades.
 *
 * Two runs collapse only when they are genuinely the same observation —
 * same type, status, input and output summary. A retry that produced a
 * different summary is a real, distinct event and is preserved.
 */
export function appendToolRuns(target: PendingToolRun[], incoming: PendingToolRun[]): void {
  const seen = new Set(
    target.map((t) => `${t.type}|${t.status}|${t.inputSummary}|${t.outputSummary ?? ''}`),
  )
  for (const run of incoming) {
    const key = `${run.type}|${run.status}|${run.inputSummary}|${run.outputSummary ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    target.push(run)
  }
}

/** Non-mutating form of {@link appendToolRuns} — same collapse rule. */
export function dedupeToolRuns(runs: PendingToolRun[]): PendingToolRun[] {
  const out: PendingToolRun[] = []
  appendToolRuns(out, runs)
  return out
}

interface AgenticIterationResult {
  answer: string
  citations: Citation[]
  chartData: ChartData | null
  toolRuns: PendingToolRun[]
  iterations: number
  confidenceHistory: { confident: boolean; confidence: number; reason: string }[]
  /**
   * Turn-total token usage. Optional so existing callers and tests are unaffected, but it is now POPULATED on
   * every return of `runAgenticLoop`: the loop read `result.usage` into the budget and then dropped it, so the
   * field was never set on any agentic path even though both builders of the same shape do set it.
   */
  usage?: { promptTokens: number; completionTokens: number }
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
        type: toolRunTypeFor(r.tool),
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


/**
 * Alignment gate shared by the substantial-evidence path of BOTH loops.
 *
 * INCIDENT (2026-09 audit): the streaming loop checked alignment *inside* its
 * substantial-evidence branch, but the non-streaming loop `return`ed from that
 * same branch ~10 lines BEFORE reaching its own check. The identical query
 * therefore passed the guardrail over SSE and bypassed it over HTTP, and
 * docs/threat-model.md claimed both paths were covered.
 *
 * Keeping one function and calling it from both return sites is the fix; a
 * second inline copy is how the two paths diverged to begin with.
 * Returns the note to append when the answer is flagged, or null when clear.
 */
async function alignmentNoteFor(answer: string, question: string): Promise<string | null> {
  if (!isAlignmentCheckEnabled()) return null
  try {
    const { checkAlignment } = await import('@/lib/alignment-check')
    const alignment = await checkAlignment(answer, question)
    if (alignment.risk !== 'high') return null
    return `[Note: answer flagged by alignment check — ${alignment.reason}]`
  } catch (e) {
    // Fail OPEN but loudly: a judging outage must not block every answer. The
    // gate is advisory (it annotates rather than blocks), so this matches the
    // existing behaviour; it is logged so it cannot vanish silently.
    log.warn('alignment check failed', { error: e instanceof Error ? e.message : String(e) })
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
  // The loop read `result.usage` into the token BUDGET and then discarded it, so no agentic turn ever reported
  // tokens. Accumulated across iterations and attached by `withUsage` at EVERY return, one closure instead of ten
  // hand-edits that the next change would half-miss.
  let loopPromptTokens = 0
  let loopCompletionTokens = 0
  const withUsage = <T extends Record<string, unknown>>(out: T) => ({
    ...out,
    ...(loopPromptTokens || loopCompletionTokens
      ? { usage: { promptTokens: loopPromptTokens, completionTokens: loopCompletionTokens } }
      : {}),
  })
  const confidenceHistory: { confident: boolean; confidence: number; reason: string }[] = []
  const budget = args.budget ?? createTokenBudget()
  const deadline = Date.now() + agenticDeadlineMs()

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    if (Date.now() > deadline) {
      log.info('Agentic loop stopped — deadline exceeded', { iterations: iteration })
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'deadline exceeded' })
      return withUsage({ answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: iteration, confidenceHistory })
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
        return withUsage({ answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
      }
      throw e
    }

    if (result.usage) {
      budget.track(result.usage)
      loopPromptTokens += result.usage.promptTokens
      loopCompletionTokens += result.usage.completionTokens
    }
    if (budget.isExhausted()) {
      log.info('Agentic loop stopped — token budget exhausted', { iteration: iteration + 1, total: budget.total() })
      confidenceHistory.push({ confident: false, confidence: 0, reason: 'token budget exhausted' })
      return withUsage({ answer: `${result.answer}\n\n[Note: token budget exhausted — answer may be incomplete.]`, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
    }

    appendToolRuns(allToolRuns, result.toolRuns)
    if (result.citations) allCitations.push(...result.citations)

    if (result.toolRuns.length === 0) {
      return withUsage({ answer: result.answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
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
      // Must run BEFORE returning: this path short-circuits, so the older
      // alignment check further down never executed for confident answers.
      const note = await alignmentNoteFor(answer, args.question)
      if (note) {
        log.info('Agentic loop flagged by alignment check (heuristic path)', { iteration: iteration + 1 })
        confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${note}` })
        return withUsage({ answer: `${answer}\n\n${note}`, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
      }
      return withUsage({ answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
    }

    const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
    confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })

    if (confidence.confident) {
      if (isAlignmentCheckEnabled()) {
        const { checkAlignment } = await import('@/lib/alignment-check')
        const alignment = await checkAlignment(answer, args.question)
        if (alignment.risk === 'high') {
          log.info('Agentic loop stopped — alignment check high risk', { iteration: iteration + 1, reason: alignment.reason })
          confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${alignment.reason}` })
          return withUsage({ answer: `${answer}\n\n[Note: answer flagged by alignment check — ${alignment.reason}]`, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
        }
      }
      return withUsage({ answer, citations: allCitations, chartData: result.chartData, toolRuns: allToolRuns, iterations: iteration + 1, confidenceHistory })
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
      return withUsage({ answer: accumulatedEvidence ? `Based on gathered evidence:\n\n${accumulatedEvidence.slice(0, 2000)}` : 'The request timed out before a complete answer could be generated.', citations: allCitations, chartData: null, toolRuns: allToolRuns, iterations: MAX_AGENTIC_ITERATIONS, confidenceHistory })
    }
    throw e
  }

  return withUsage({ answer: finalResult.answer, citations: [...allCitations, ...finalResult.citations], chartData: finalResult.chartData, toolRuns: dedupeToolRuns([...allToolRuns, ...finalResult.toolRuns]), iterations: MAX_AGENTIC_ITERATIONS, confidenceHistory })
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

  // TOKEN USAGE WAS DROPPED ON THIS PATH. Each iteration read `getLastLlmUsage()` into the token BUDGET and then
  // discarded it; `output.usage` was never assigned, so an SSE chat turn reported NO token counts while the
  // non-streaming builders do populate the same field. Accumulated because one turn makes several LLM calls.
  let streamPromptTokens = 0
  let streamCompletionTokens = 0
  const budget = args.budget ?? createTokenBudget()
  const deadline = Date.now() + agenticDeadlineMs()

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

      // Accumulate usage IMMEDIATELY after the round returns, in ONE place. It was previously read only at the
      // two points where the loop continues, so any early RETURN (the substantial-evidence heuristic, the
      // alignment gate, the high-confidence stop) discarded that round's tokens entirely. One site also means a
      // new exit added later cannot forget it.
      const roundUsage = getLastLlmUsage()
      if (roundUsage) {
        budget.track(roundUsage)
        streamPromptTokens += roundUsage.promptTokens
        streamCompletionTokens += roundUsage.completionTokens
      }

      appendToolRuns(allToolRuns, result.toolRuns)
      if (result.citations) allCitations.push(...result.citations)

      // No tools ran — stream the answer directly and finish.
      if (result.toolRuns.length === 0) {
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail
        for await (const chunk of result.stream) {
          yield chunk
        }
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
        continue
      }

      if (hasSubstantialData && !hasError) {
        confidenceHistory.push({ confident: true, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)' })
        log.info('Streaming agentic loop confident (heuristic)', { iteration: iteration + 1 })
        args.onConfidence?.({ iteration: iteration + 1, confidence: 0.85, reason: 'substantial evidence gathered (heuristic)', confident: true })
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail

        // Same helper as the non-streaming path — one implementation, so the two
        // loops cannot disagree about when the gate runs or what it returns.
        const note = await alignmentNoteFor(answerText, args.question)
        if (note) {
          log.info('Streaming agentic loop flagged by alignment check', { iteration: iteration + 1 })
          confidenceHistory.push({ confident: false, confidence: 0, reason: `alignment: ${note}` })
          yield `\n\n${note}`
        }
        return
      }

      const confidence = await evaluateAnswerConfidence({ question: args.question, evidence: accumulatedEvidence })
      confidenceHistory.push({ confident: confidence.confident, confidence: confidence.confidence, reason: confidence.reason })
      args.onConfidence?.({ iteration: iteration + 1, confidence: confidence.confidence, reason: confidence.reason, confident: confidence.confident })

      if (confidence.confident) {
        output.chartData = result.chartData
        output.citationTrail = result.citationTrail

        if (isAlignmentCheckEnabled()) {
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
    appendToolRuns(allToolRuns, finalResult.toolRuns)
    if (finalResult.citations) allCitations.push(...finalResult.citations)
    output.chartData = finalResult.chartData
    output.citationTrail = finalResult.citationTrail
    for await (const chunk of finalResult.stream) {
      yield chunk
    }
    // The max-iterations SYNTHESIS call is a real LLM call too, so its tokens belong in the turn total.
    const finalUsage = getLastLlmUsage()
    if (finalUsage) {
      budget.track(finalUsage)
      streamPromptTokens += finalUsage.promptTokens
      streamCompletionTokens += finalUsage.completionTokens
    }
    if (budget.isExhausted()) {
      yield '\n\n[Note: token budget exhausted — answer may be incomplete.]'
    }
  }

  // ponytail: output is mutated inside combinedStream() to set chartData/
  // citationTrail from whichever iteration produces the final answer. The
  // arrays (allToolRuns/allCitations) are also mutated during generation.
  // Callers must consume the stream before reading these fields.
  // `usage` is a DEFERRED GETTER, not a spread. The accumulator is filled DURING stream consumption (each round
  // reports its tokens after its call), so a spread here would always read 0/0 and silently omit the field --
  // measured: the first version of this fix did exactly that. A getter is evaluated when the caller reads it,
  // which is necessarily after the stream is drained.
  const output: StreamingCompletionResult = {
    stream: combinedStream(),
    toolRuns: allToolRuns,
    citations: allCitations,
    chartData: null,
    citationTrail: undefined,
    get usage() {
      return streamPromptTokens || streamCompletionTokens
        ? { promptTokens: streamPromptTokens, completionTokens: streamCompletionTokens }
        : undefined
    },
  }
  return output
}
