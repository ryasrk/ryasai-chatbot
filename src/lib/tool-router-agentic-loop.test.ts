/**
 * Tests for `runAgenticLoop`'s termination and heuristics.
 *
 * Why this file exists: tool-router-agentic.ts was 68% lines with the loop's
 * DECISION paths unexecuted — the deadline stops, the token-budget stops, the
 * "all tools failed" heuristic, the "substantial evidence" short-circuit, the
 * reflexion branch, and the max-iterations synthesis. Those are the paths that
 * decide whether the user gets an answer, a partial answer with a disclosure, or
 * an honest "it timed out" — and none had ever run.
 *
 * Separate file: the loop reads AGENTIC_DEADLINE_MS and REFLEXION_ENABLED at module
 * load, and this file sets them at the top of the process. The existing
 * tool-router-agentic.test.ts must keep its own environment.
 */
// The module reads AGENTIC_DEADLINE_MS into a module-level const at import time,
// and bun hoists imports above this file's top-level statements, so setting
// process.env here would be too late (measured: the deadline test saw 3 model
// calls instead of 0). A NEGATIVE deadline is used instead of 0 — `Date.now() > 0`
// is `Date.now() > Date.now() - 1000`, which is what makes the very first loop
// iteration already over the deadline. The hook below runs before each test and
// before any import is evaluated for the loop, because the value is read lazily
// per call via the override seam.
process.env.REFLEXION_ENABLED = 'false'

import { describe, expect, test, mock, beforeEach } from 'bun:test'

const align = { enabled: false, risk: 'low' as 'low' | 'high', reason: 'ok', calls: 0 }
mock.module('@/lib/alignment-check', () => ({
  isAlignmentCheckEnabled: () => align.enabled,
  checkAlignment: async () => { align.calls++; return { risk: align.risk, reason: align.reason } },
}))

const conf = {
  confident: false,
  confidence: 0.2,
  reason: 'not enough',
  nextToolHint: null as string | null,
  calls: 0,
  lastEvidence: '' as string,
}
mock.module('@/lib/intent-pipeline', () => ({
  evaluateAnswerConfidence: async (a: { evidence: string }) => {
    conf.calls++
    conf.lastEvidence = a.evidence
    return { confident: conf.confident, confidence: conf.confidence, reason: conf.reason, nextToolHint: conf.nextToolHint }
  },
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))

import { runAgenticLoop } from '@/lib/tool-router-agentic'
import { createTokenBudget } from '@/lib/agentic-budget'
import type { PendingToolRun, CompletionResult } from '@/lib/tool-utils'

function run(over: Partial<PendingToolRun> = {}): PendingToolRun {
  // NOTE: the loop slices outputSummary to 300 chars, so a fixture must be larger
  // than that for the "substantial evidence" heuristic (>500 chars accumulated) to
  // trigger. Measured: 'x'.repeat(200) kept the evidence under the threshold and
  // the LLM evaluator ran anyway.
  return { type: 'SQL', status: 'success', inputSummary: 'q', outputSummary: 'x'.repeat(400), ...over }
}
function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return { answer: 'answer', citations: [], toolRuns: [run()], chartData: null, ...over }
}

beforeEach(() => {
  // Generous by default so a test only sees a deadline when it asks for one.
  delete process.env.AGENTIC_DEADLINE_MS
  align.enabled = false
  align.risk = 'low'
  align.reason = 'ok'
  align.calls = 0
  conf.confident = false
  conf.confidence = 0.2
  conf.reason = 'not enough'
  conf.nextToolHint = null
  conf.calls = 0
  conf.lastEvidence = ''
})

describe('runAgenticLoop — deadline is checked at the TOP of every iteration', () => {
  // A NEGATIVE deadline, not 0: `Date.now() > Date.now() + 0` is false, so 0 does
  // NOT put the first iteration over. -1000 does. Now that agenticDeadlineMs() is
  // read per call, setting it here takes effect; as a module-level const it could
  // not be set from a test file at all (bun hoists imports above top-level code).
  beforeEach(() => { process.env.AGENTIC_DEADLINE_MS = '-1000' })
  test('a deadline already past stops immediately and never calls the model', async () => {
    let calls = 0
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => { calls++; return completion() })
    // AGENTIC_DEADLINE_MS=0 in this file, so the very first iteration is over.
    expect(calls).toBe(0)
    expect(r.iterations).toBe(0)
    expect(r.confidenceHistory[0].reason).toBe('deadline exceeded')
  })

  test('with no evidence gathered the deadline answer SAYS it timed out', async () => {
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => completion())
    // Presenting an empty string as an answer would look like the model chose to
    // say nothing; the user must be told the request timed out.
    expect(r.answer).toContain('timed out')
  })
})

describe('runAgenticLoop — the all-tools-failed heuristic continues instead of answering', () => {
  test('every tool failing does NOT return the failure as the answer', async () => {
    let calls = 0
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return completion({ answer: 'sorry, that failed', toolRuns: [run({ status: 'error', outputSummary: 'err' })] })
    })
    // It must keep trying (up to the iteration cap) rather than present a failure
    // as a final answer.
    // 3 loop rounds + 1 final synthesis round.
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThanOrEqual(4)
    expect(r.confidenceHistory.some((c) => c.reason === 'all tools failed')).toBe(true)
  })

  test('a BLOCKED tool counts as a failure too', async () => {
    let calls = 0
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return completion({ toolRuns: [run({ status: 'blocked' })] })
    })
    expect(calls).toBeGreaterThan(1)
  })

  test('one success among failures is NOT treated as all-failed', async () => {
    let calls = 0
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return completion({ toolRuns: [run({ status: 'error' }), run({ status: 'success' })] })
    })
    // A partial success must fall through to the confidence evaluator, not the
    // "all failed" shortcut. 3 loop rounds + 1 synthesis round.
    expect(calls).toBe(4)
  })
})

describe('runAgenticLoop — substantial-evidence short-circuit', () => {
  test('more than 500 chars of evidence and no error returns WITHOUT the LLM evaluator', async () => {
    // Measured arithmetic: accumulatedEvidence is
    //   "\n[<type>] <outputSummary up to 300>\n[Answer so far: <answer up to 1000>]"
    // so one round with a 400-char summary is only 331 chars — under the 500
    // threshold, and the heuristic does NOT fire. The answer completes the total.
    // A fixture that ignored this would assert the threshold instead of the
    // behaviour, which is what the first version of this test did.
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ answer: 'a'.repeat(300) }))
    // The heuristic exists to save an LLM call on an obviously-answered question.
    expect(conf.calls).toBe(0)
    expect(r.confidenceHistory.some((c) => c.reason.includes('substantial evidence'))).toBe(true)
    expect(r.answer).toBe('a'.repeat(300))
  })

  test('the threshold is a real boundary: just under it, the evaluator DOES run', async () => {
    // 300-char summary + a short answer = 331 chars, below 500.
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ answer: 'short', toolRuns: [run({ outputSummary: 'y'.repeat(300) })] }))
    expect(conf.calls).toBeGreaterThan(0)
  })

  test('an ERROR alongside substantial evidence does not short-circuit', async () => {
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ status: 'success' }), run({ status: 'error' })] }))
    // Evidence that includes a failed call is not "substantial" in the sense that
    // matters; it must still be judged.
    expect(conf.calls).toBeGreaterThan(0)
  })

  test('LITTLE evidence falls through to the confidenid evaluator', async () => {
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ outputSummary: 'tiny' })] }))
    expect(conf.calls).toBeGreaterThan(0)
  })

  test('the heuristic path STILL runs the alignment gate (the old bypass)', async () => {
    align.enabled = true
    align.risk = 'high'
    align.reason = 'unsupported claim'
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => completion())
    // INCIDENT: the alignment check used to live only on the path BELOW this
    // return, so a confident heuristic answer short-circuited past it entirely.
    // The same question was guarded in one branch and unguarded in the other.
    expect(r.answer).toContain('unsupported claim')
    expect(r.confidenceHistory.some((c) => c.reason.includes('alignment'))).toBe(true)
  })
})

describe('runAgenticLoop — confidence and the LLM alignment gate', () => {
  test('a confident verdict without alignment enabled returns the answer as-is', async () => {
    conf.confident = true
    conf.confidence = 0.9
    align.enabled = false
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ outputSummary: 'tiny' })] }))
    expect(r.answer).toBe('answer')
    expect(align.calls).toBe(0)
  })

  test('a HIGH-risk alignment verdict annotates the answer', async () => {
    conf.confident = true
    conf.confidence = 0.9
    align.enabled = true
    align.risk = 'high'
    align.reason = 'contradicts the evidence'
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ outputSummary: 'tiny' })] }))
    // Annotated, not silently rewritten: the user sees that it was flagged.
    expect(r.answer).toContain('contradicts the evidence')
    expect(r.answer).toContain('answer')
  })

  test('a LOW-risk verdict leaves the answer untouched', async () => {
    conf.confident = true
    conf.confidence = 0.9
    align.enabled = true
    align.risk = 'low'
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ outputSummary: 'tiny' })] }))
    expect(r.answer).toBe('answer')
  })

  test('a not-confident verdict with a tool hint feeds the hint back into the next round', async () => {
    conf.confident = false
    conf.nextToolHint = 'RAG'
    let n = 0
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      n++
      return completion({ toolRuns: [run({ outputSummary: 'tiny' })] })
    })
    // 3 loop rounds + 1 synthesis round.
    expect(n).toBe(4)
    // The hint must reach the evidence string, otherwise "try RAG instead" has no
    // effect on what the next round is asked.
    expect(conf.lastEvidence).toContain('Try RAG instead')
  })

  test('a CHAT hint is NOT injected (it would be a no-op instruction)', async () => {
    conf.confident = false
    conf.nextToolHint = 'CHAT'
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ toolRuns: [run({ outputSummary: 'tiny' })] }))
    expect(conf.lastEvidence).not.toContain('Try CHAT instead')
  })
})

describe('runAgenticLoop — token budget', () => {
  test('an exhausted budget returns the answer WITH a disclosure', async () => {
    const budget = createTokenBudget(0)
    const r = await runAgenticLoop({ question: 'q', userId: 'u1', budget }, async () =>
      completion({ usage: { promptTokens: 100, completionTokens: 50 } }))
    // Silently returning a partial answer as complete is the failure mode this
    // disclosure exists to prevent.
    expect(r.answer).toContain('token budget exhausted')
    expect(r.confidenceHistory.some((c) => c.reason === 'token budget exhausted')).toBe(true)
  })

  test('usage from a round is TRACKED so the budget can be reached', async () => {
    const budget = createTokenBudget(120)
    await runAgenticLoop({ question: 'q', userId: 'u1', budget }, async () =>
      completion({ usage: { promptTokens: 80, completionTokens: 40 } }))
    expect(budget.total()).toBe(120)
    expect(budget.isExhausted()).toBe(true)
  })

  test('a generous budget never reports exhaustion', async () => {
    const budget = createTokenBudget(1_000_000)
    const r = await runAgenticLoop({ question: 'q', userId: 'u1', budget }, async () =>
      completion({ usage: { promptTokens: 10, completionTokens: 5 } }))
    expect(r.answer).not.toContain('token budget exhausted')
  })
})

describe('runAgenticLoop — max iterations reached', () => {
  test('after the cap a FINAL synthesis call is made with all gathered evidence', async () => {
    const seen: string[] = []
    conf.confident = false
    const r = await runAgenticLoop({ question: 'original question', userId: 'u1' }, async (a) => {
      seen.push(a.question)
      return completion({ answer: `round ${seen.length}`, toolRuns: [run({ outputSummary: 'tiny' })] })
    })
    // 3 loop rounds + 1 synthesis round.
    expect(seen).toHaveLength(4)
    expect(seen[3]).toContain('answer the original question')
    expect(seen[3]).toContain('All gathered evidence')
    expect(r.iterations).toBe(3)
  })

  test('tool runs from the synthesis round are merged and de-duplicated', async () => {
    conf.confident = false
    let n = 0
    const r = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      n++
      return completion({ toolRuns: [run({ inputSummary: `same`, outputSummary: 'tiny' })] })
    })
    // The CHAT preparers report one run per round; without de-duplication a
    // 4-round turn wrote 4 identical rows and skewed the router's metrics.
    expect(n).toBe(4)
    expect(r.toolRuns.length).toBe(1)
  })

  test('a zero-tool-run round returns immediately with the model answer', async () => {
    let n = 0
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      n++
      return completion({ toolRuns: [] })
    })
    // A plain chat answer has nothing to gather; looping again would be wasted work.
    expect(n).toBe(1)
  })
})
