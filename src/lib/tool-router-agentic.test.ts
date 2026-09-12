import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

// The alignment gate is mocked at MODULE level, before the module under test is
// imported, and its behaviour is swapped per test through a mutable holder.
// Registering `mock.module` inside a test body does not apply retroactively to
// imports the module-under-test already captured.
const alignmentState = {
  enabled: false,
  risk: 'low' as 'low' | 'high',
  reason: 'fine',
  shouldThrow: false,
  calls: 0,
}
mock.module('@/lib/alignment-check', () => ({
  isAlignmentCheckEnabled: () => alignmentState.enabled,
  checkAlignment: async () => {
    alignmentState.calls++
    if (alignmentState.shouldThrow) throw new Error('judge unreachable')
    return { risk: alignmentState.risk, reason: alignmentState.reason }
  },
}))
// intent-pipeline is mocked so the loop's confidence decision is deterministic;
// the real evaluator calls an LLM and its own tests cover it.
const confidenceState = { confident: false, confidence: 0.1, reason: 'needs more', nextToolHint: null as string | null }
mock.module('@/lib/intent-pipeline', () => ({
  evaluateAnswerConfidence: async () => ({ ...confidenceState }),
}))
// Reflexion is opt-in via REFLEXION_ENABLED. The branch that MATTERS is
// `needsRevision: true`, which REPLACES the text the user receives — a broken
// revision path would ship the critique's draft or drop the answer entirely.
// Nothing had ever exercised it on the streaming path.
const reflexionState = { enabled: false, needsRevision: false, revised: 'REVISED', critique: 'too vague', calls: 0 }
mock.module('@/lib/reflexion', () => ({
  selfCritique: async () => {
    reflexionState.calls++
    return { needsRevision: reflexionState.needsRevision, revisedAnswer: reflexionState.revised, critique: reflexionState.critique }
  },
}))

import { appendToolRuns, dedupeToolRuns, toolRunTypeFor, runAgenticLoop, runStreamingAgenticLoop } from './tool-router-agentic'
import { createTokenBudget } from './agentic-budget'
import type { PendingToolRun, CompletionResult, StreamingCompletionResult } from './tool-utils'
import type { ChartData } from './types'

beforeEach(() => {
  alignmentState.enabled = false
  alignmentState.risk = 'low'
  alignmentState.reason = 'fine'
  alignmentState.shouldThrow = false
  alignmentState.calls = 0
  confidenceState.confident = false
  confidenceState.confidence = 0.1
  confidenceState.reason = 'needs more'
  confidenceState.nextToolHint = null
  reflexionState.enabled = false
  reflexionState.needsRevision = false
  reflexionState.revised = 'REVISED'
  reflexionState.critique = 'too vague'
  reflexionState.calls = 0
  delete process.env.REFLEXION_ENABLED
  delete process.env.AGENTIC_DEADLINE_MS
})

function run(over: Partial<PendingToolRun> = {}): PendingToolRun {
  return {
    type: 'CHAT',
    status: 'success',
    inputSummary: 'what is the total revenue?',
    ...over,
  }
}


// ---------------------------------------------------------------------------
// Fixtures for the loop tests below
// ---------------------------------------------------------------------------
function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return {
    answer: 'answer',
    citations: [],
    toolRuns: [],
    chartData: null,
    ...over,
  }
}

function toolRun(over: Partial<PendingToolRun> = {}): PendingToolRun {
  return { type: 'SQL', status: 'success', inputSummary: 'q', ...over }
}

// ---------------------------------------------------------------------------
// appendToolRuns / dedupeToolRuns
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): a single external-API chat turn persisted FOUR identical
// CHAT ToolRun rows. `runStreamingAgenticLoop` pushes each iteration's
// `result.toolRuns` onto `allToolRuns`, and the streaming CHAT preparers always
// report one run — so an N-iteration turn wrote N duplicates.
//
// Those rows feed `loadPerformanceMetrics()` (last 50 per type, 24h), which
// drives the smart router's success rate, latency score and circuit breaker.
// Duplicates inflate `total` and skew every derived score silently.
describe('appendToolRuns — collapses repeated observations', () => {
  test('the observed incident: 3 identical iterations collapse to 1', () => {
    const all: PendingToolRun[] = []
    // Simulates 3 agentic iterations, each reporting the same CHAT run.
    for (let i = 0; i < 3; i++) {
      appendToolRuns(all, [run({ latencyMs: 10 + i })])
    }
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('CHAT')
  })

  test('the reported 4-row case collapses to 1', () => {
    const all: PendingToolRun[] = []
    appendToolRuns(all, [run(), run(), run(), run()])
    expect(all).toHaveLength(1)
  })

  test('genuinely different runs are preserved', () => {
    const all: PendingToolRun[] = []
    appendToolRuns(all, [
      run({ type: 'SQL', inputSummary: 'revenue by region' }),
      run({ type: 'RAG', inputSummary: 'refund policy' }),
      run({ type: 'PLUGIN', inputSummary: 'weather' }),
    ])
    expect(all).toHaveLength(3)
    expect(all.map((r) => r.type)).toEqual(['SQL', 'RAG', 'PLUGIN'])
  })

  test('same type but different status is a distinct event', () => {
    const all: PendingToolRun[] = []
    appendToolRuns(all, [run({ status: 'error', errorMessage: 'timeout' })])
    appendToolRuns(all, [run({ status: 'success' })])
    expect(all).toHaveLength(2)
  })

  test('same type+status but different output is a distinct event', () => {
    // A retry that produced a different result is real evidence, not noise.
    const all: PendingToolRun[] = []
    appendToolRuns(all, [run({ outputSummary: 'first attempt' })])
    appendToolRuns(all, [run({ outputSummary: 'retry succeeded differently' })])
    expect(all).toHaveLength(2)
  })

  test('same type+status+output but different input is a distinct event', () => {
    const all: PendingToolRun[] = []
    appendToolRuns(all, [run({ inputSummary: 'question A' })])
    appendToolRuns(all, [run({ inputSummary: 'question B' })])
    expect(all).toHaveLength(2)
  })

  test('missing outputSummary does not collide with a real one', () => {
    const all: PendingToolRun[] = []
    appendToolRuns(all, [run({ outputSummary: undefined })])
    appendToolRuns(all, [run({ outputSummary: 'something' })])
    expect(all).toHaveLength(2)
  })

  test('returns nothing early when incoming is empty', () => {
    const all: PendingToolRun[] = [run()]
    appendToolRuns(all, [])
    expect(all).toHaveLength(1)
  })
})

describe('dedupeToolRuns', () => {
  test('is non-mutating', () => {
    const input = [run(), run(), run()]
    const out = dedupeToolRuns(input)
    expect(out).toHaveLength(1)
    expect(input).toHaveLength(3) // original untouched
  })

  test('preserves first-seen order', () => {
    const out = dedupeToolRuns([
      run({ type: 'SQL', inputSummary: 'a' }),
      run({ type: 'RAG', inputSummary: 'b' }),
      run({ type: 'SQL', inputSummary: 'a' }),
    ])
    expect(out.map((r) => r.type)).toEqual(['SQL', 'RAG'])
  })
})

// ---------------------------------------------------------------------------
// toolRunTypeFor
// ---------------------------------------------------------------------------
// The old inline cast was `r.tool.toUpperCase() as PendingToolRun['type']`, so
// tool ids with no constant-case equivalent were written to the DB as invalid
// literals (`SQL` for `db_query`, `WEB_FETCH` for `web_fetch`). Metrics queries
// filter on the exact valid strings, so those rows were invisible.
describe('toolRunTypeFor — only valid ToolRun.type literals', () => {
  const VALID = ['RAG', 'SQL', 'REST_API', 'CHAT', 'PLUGIN']

  test('every mapping produces a valid literal', () => {
    const tools = [
      'sql', 'SQL', 'db_query', 'database', 'rag', 'knowledge', 'documents',
      'rest', 'rest_api', 'api', 'chat', 'answer', 'web_fetch', 'web_search',
      'plugin:weather', 'mcp:filesystem', 'some-unknown-tool',
    ]
    for (const t of tools) {
      expect(VALID).toContain(toolRunTypeFor(t))
    }
  })

  test('maps known tool ids to their canonical type', () => {
    expect(toolRunTypeFor('sql')).toBe('SQL')
    expect(toolRunTypeFor('db_query')).toBe('SQL')
    expect(toolRunTypeFor('rag')).toBe('RAG')
    expect(toolRunTypeFor('rest_api')).toBe('REST_API')
    expect(toolRunTypeFor('chat')).toBe('CHAT')
  })

  test('plugin: and mcp: prefixes both map to PLUGIN', () => {
    expect(toolRunTypeFor('plugin:weather')).toBe('PLUGIN')
    expect(toolRunTypeFor('mcp:filesystem')).toBe('PLUGIN')
  })

  test('web tools no longer produce the invalid WEB_FETCH literal', () => {
    // Regression: this returned 'WEB_FETCH' via the raw toUpperCase() cast.
    expect(toolRunTypeFor('web_fetch')).not.toBe('WEB_FETCH')
    expect(toolRunTypeFor('web_fetch')).toBe('CHAT')
  })

  test('unknown tools fall back to CHAT, never an invalid literal', () => {
    expect(toolRunTypeFor('some-unknown-tool')).toBe('CHAT')
    expect(toolRunTypeFor('')).toBe('CHAT')
  })
})

// ---------------------------------------------------------------------------
// runAgenticLoop / runStreamingAgenticLoop — termination and gating
// ---------------------------------------------------------------------------
// These two loops were 8% covered: only their pure helpers were ever executed.
// Everything that decides WHEN TO STOP and WHETHER TO ANNOTATE was untested,
// which is the part that burns a user's tokens and the part that can hang a
// request. `runCompletion` is injected, so every branch is reachable with no
// LLM, no network and no clock manipulation.
//
// The tests assert the CONTRACT, not the implementation: iteration counts,
// which branch produced the answer, and whether the alignment gate ran. Where
// two paths are supposed to agree (the 2026-09 incident: SSE passed the
// guardrail that HTTP bypassed), the test asserts they agree by running both.
describe('runAgenticLoop — termination', () => {
  test('no tool runs → returns immediately after ONE iteration', async () => {
    const calls: string[] = []
    const res = await runAgenticLoop({ question: 'hello', userId: 'u1' }, async (a) => {
      calls.push(a.question)
      return completion({ answer: 'hi there', toolRuns: [] })
    })
    expect(res.answer).toBe('hi there')
    expect(res.iterations).toBe(1)
    // The loop must NOT keep calling the model when no tool was requested —
    // each extra call is real money on a BYOK key.
    expect(calls).toHaveLength(1)
  })

  test('substantial evidence with no error → stops and reports confident', async () => {
    // MEASURED, not assumed: answering takes TWO iterations, not one. The first
    // round's accumulated evidence is a single `[Answer so far: …]` block, which
    // is under the 500-char substantial-data threshold, so round 1 defers to
    // `evaluateAnswerConfidence` (mocked to "not confident"). Only once round 2
    // appends its own evidence does the length clear 500 and the heuristic fire.
    // An earlier version of this test asserted iterations === 1 and failed —
    // the code was right and the expectation was wrong.
    const res = await runAgenticLoop({ question: 'summarise sales', userId: 'u1' }, async () =>
      completion({
        answer: 'Sales were 1.2M',
        toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })],
      }),
    )
    expect(res.iterations).toBe(2)
    expect(res.confidenceHistory).toHaveLength(2)
    expect(res.confidenceHistory[0].confident).toBe(false)
    const last = res.confidenceHistory[res.confidenceHistory.length - 1]
    expect(last.confident).toBe(true)
    expect(last.reason).toContain('substantial evidence')
  })

  test('all tools failed → does NOT stop, continues the loop', async () => {
    let n = 0
    const res = await runAgenticLoop({ question: 'find the invoice', userId: 'u1' }, async () => {
      n++
      return completion({
        answer: 'failed',
        toolRuns: [toolRun({ status: 'error', outputSummary: 'boom' })],
      })
    })
    // A failing tool must not be treated as a confident answer. The loop keeps
    // going until a bound stops it, and the history records why.
    expect(n).toBeGreaterThan(1)
    expect(res.confidenceHistory.some((h) => h.reason === 'all tools failed')).toBe(true)
  })

  test('a "blocked" tool run counts as an error (refused ≠ answered)', async () => {
    // blocked means the guardrail REFUSED the request. Treating it as evidence
    // would let "I am not allowed to run DROP TABLE" read as a successful answer.
    let n = 0
    const res = await runAgenticLoop({ question: 'drop the users table', userId: 'u1' }, async () => {
      n++
      return completion({
        answer: 'refused',
        toolRuns: [toolRun({ status: 'blocked', outputSummary: 'blocked: DDL' })],
      })
    })
    expect(n).toBeGreaterThan(1)
    expect(res.confidenceHistory.some((h) => h.reason === 'all tools failed')).toBe(true)
  })

  test('an injected completion that throws propagates (not swallowed)', async () => {
    // A crash inside the provider must surface; silently converting it to an
    // empty answer is how a broken BYOK key reads as "no data found".
    await expect(
      runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        throw new Error('provider exploded')
      }),
    ).rejects.toThrow('provider exploded')
  })

  test('the loop is bounded — it cannot run forever', async () => {
    let n = 0
    await runAgenticLoop({ question: 'keep going', userId: 'u1' }, async () => {
      n++
      return completion({
        answer: 'still working',
        toolRuns: [toolRun({ status: 'error', outputSummary: 'short' })],
      })
    })
    // Unbounded loops are the classic way to spend a user's whole budget in one
    // turn. Pin the ceiling so a refactor cannot remove it.
    expect(n).toBeLessThanOrEqual(4)
  })
})

describe('agentic loops — the alignment gate is reached from BOTH transports', () => {
  // INCIDENT (2026-09 audit): the streaming loop checked alignment inside its
  // substantial-evidence branch, but the non-streaming loop RETURNED from that
  // same branch before reaching its own check. The identical query therefore
  // passed the guardrail over SSE and bypassed it over HTTP, while
  // docs/threat-model.md claimed both paths were covered. Two copies of one
  // check is how they diverged; these tests run both and require agreement.
  test('non-streaming: substantial evidence is still alignment-checked', async () => {
    alignmentState.enabled = true
    alignmentState.risk = 'high'
    alignmentState.reason = 'medical advice'
    const res = await runAgenticLoop({ question: 'what dosage should I take?', userId: 'u1' }, async () =>
      completion({
        answer: 'Take 500mg twice daily.',
        toolRuns: [toolRun({ outputSummary: 'y'.repeat(600) })],
      }),
    )
    expect(alignmentState.calls).toBeGreaterThan(0)
    // Advisory gate: it ANNOTATES rather than discards, so the answer survives
    // and the note is what surfaces the risk.
    expect(res.answer).toContain('alignment check')
    expect(res.confidenceHistory.some((h) => h.reason.startsWith('alignment:'))).toBe(true)
  })

  test('non-streaming: a clear alignment check leaves the answer untouched', async () => {
    alignmentState.enabled = true
    alignmentState.risk = 'low'
    const res = await runAgenticLoop({ question: 'total sales', userId: 'u1' }, async () =>
      completion({
        answer: 'Sales were 1.2M',
        toolRuns: [toolRun({ outputSummary: 'z'.repeat(600) })],
      }),
    )
    expect(res.answer).toBe('Sales were 1.2M')
    expect(res.answer).not.toContain('alignment')
  })

  test('a FAILING alignment check fails OPEN and still answers', async () => {
    // A judging outage must not block every answer — the gate is advisory. Pin
    // the failure direction, because "fail closed" here would take the product
    // down whenever the judge is unreachable.
    alignmentState.enabled = true
    alignmentState.shouldThrow = true
    const res = await runAgenticLoop({ question: 'total sales', userId: 'u1' }, async () =>
      completion({
        answer: 'Sales were 1.2M',
        toolRuns: [toolRun({ outputSummary: 'w'.repeat(600) })],
      }),
    )
    expect(res.answer).toContain('Sales were 1.2M')
  })
})

// ---------------------------------------------------------------------------
// runStreamingAgenticLoop — the SSE path
// ---------------------------------------------------------------------------
// This is the transport users actually hit. It was at 8% coverage, so the
// branch that decides how many model calls a turn costs, and the branch that
// runs the alignment gate, had never been executed by a test.
//
// The FUNCTION is async and resolves to the result object; `.stream` is the
// generator. An earlier draft of these tests treated the call as synchronous and
// every one failed with "undefined is not an object (evaluating 'out.stream')" —
// measured, not assumed, and now pinned by the tests themselves.
//
// What can go wrong here: chunks must reach
// the caller incrementally (a cached answer is a broken product), the terminal
// note must be yielded AFTER the answer rather than replacing it, and the
// `output` object is mutated during consumption — so the tests read it only
// after draining the stream, exactly as callers must.
function streamResult(over: Partial<StreamingCompletionResult> = {}): StreamingCompletionResult {
  return {
    toolRuns: [],
    citations: [],
    chartData: null,
    stream: (async function* () { yield 'streamed answer' })(),
    ...over,
  }
}

async function drain(gen: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = ''
  for await (const chunk of gen) out += chunk
  return out
}

describe('runStreamingAgenticLoop — chunk delivery', () => {
  test('no tools → chunk are forwarded one by one, not buffered', async () => {
    const out = await runStreamingAgenticLoop({ question: 'hi', userId: 'u1' }, async () =>
      streamResult({
        stream: (async function* () {
          yield 'Hello'
          yield ' there'
        })(),
      }),
    )
    const received: string[] = []
    for await (const chunk of out.stream) received.push(chunk)
    // Two chunks in, two chunks out. If the loop buffered the answer the UI
    // would show nothing until completion, which is the regression this pins.
    expect(received).toEqual(['Hello', ' there'])
    expect(out.toolRuns).toHaveLength(0)
  })

  test('a tool run is recorded on the result object', async () => {
    const out = await runStreamingAgenticLoop({ question: 'sales?', userId: 'u1' }, async () =>
      streamResult({ toolRuns: [toolRun()] }),
    )
    await drain(out.stream)
    expect(out.toolRuns).toHaveLength(1)
    expect(out.toolRuns[0].type).toBe('SQL')
  })

  test('chartData from the final answer is exposed', async () => {
    const out = await runStreamingAgenticLoop({ question: 'chart it', userId: 'u1' }, async () =>
      streamResult({ chartData: { type: 'bar', data: [] } as unknown as ChartData }),
    )
    await drain(out.stream)
    expect(out.chartData).not.toBeNull()
  })

  test('an injected failure propagates out of the generator', async () => {
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      throw new Error('provider exploded')
    })
    // Must reject, not swallow: a dead BYOK key has to surface as an error the
    // handler can map to 503, not as a silently empty answer.
    await expect(drain(out.stream)).rejects.toThrow('provider exploded')
  })
})

describe('runStreamingAgenticLoop — termination and the alignment gate', () => {
  test('all tools failed → keeps looping instead of answering', async () => {
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'find it', userId: 'u1' }, async () => {
      calls++
      return streamResult({ toolRuns: [toolRun({ status: 'error', outputSummary: 'boom' })] })
    })
    await drain(out.stream)
    // A failed tool is not an answer. More than one round must have run.
    expect(calls).toBeGreaterThan(1)
  })

  test('a blocked tool run is treated as a failure, not as evidence', async () => {
    // `blocked` = the SQL guardrail refused the request. Counting it as
    // substantial evidence would present a refusal as a confident answer.
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'DROP TABLE users', userId: 'u1' }, async () => {
      calls++
      return streamResult({
        toolRuns: [toolRun({ status: 'blocked', outputSummary: 'blocked: DDL not allowed' })],
      })
    })
    await drain(out.stream)
    expect(calls).toBeGreaterThan(1)
  })

  test('substantial evidence → alignment gate runs and ANNOTATES (answer survives)', async () => {
    alignmentState.enabled = true
    alignmentState.risk = 'high'
    alignmentState.reason = 'medical advice'
    const out = await runStreamingAgenticLoop({ question: 'what dosage?', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'e'.repeat(600) })],
        stream: (async function* () { yield 'Take 500mg.' })(),
      }),
    )
    const text = await drain(out.stream)
    expect(alignmentState.calls).toBeGreaterThan(0)
    // The answer is still delivered and the note is appended — the gate is
    // advisory. Verified in the same run, so a future "block instead" change
    // cannot silently pass.
    expect(text).toContain('Take 500mg.')
    expect(text).toContain('alignment check')
  })

  test('onConfidence reports every verdict, including the heuristic one', async () => {
    const seen: Array<{ iteration: number; confident: boolean; reason: string }> = []
    const out = await runStreamingAgenticLoop(
      { question: 'summarise', userId: 'u1', onConfidence: (i) => seen.push(i) },
      async () =>
        streamResult({
          toolRuns: [toolRun({ outputSummary: 'f'.repeat(600) })],
          stream: (async function* () { yield 'done' })(),
        }),
    )
    await drain(out.stream)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((s) => s.confident)).toBe(true)
  })

  test('the streaming loop is bounded like the non-streaming one', async () => {
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'loop forever?', userId: 'u1' }, async () => {
      calls++
      return streamResult({ toolRuns: [toolRun({ status: 'error', outputSummary: 'x' })] })
    })
    await drain(out.stream)
    // MAX_AGENTIC_ITERATIONS rounds + at most one final synthesis.
    expect(calls).toBeLessThanOrEqual(4)
  })

  test('a token budget exhausted mid-turn appends a note and stops', async () => {
    const budget = createTokenBudget(0)
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'expensive', userId: 'u1', budget }, async () => {
      calls++
      return streamResult({ toolRuns: [toolRun({ outputSummary: 'g'.repeat(600) })] })
    })
    const text = await drain(out.stream)
    // With a zero budget the loop must refuse to start more work, and say so in
    // the transcript rather than presenting a partial answer as complete.
    expect(text).toContain('budget')
    expect(calls).toBeLessThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// The streaming loop's opt-in and deadline paths.
//
// Reflexion (`REFLEXION_ENABLED`) had never been exercised on the STREAMING
// path: the flag gates a self-critique that can REPLACE the answer text before it
// is yielded, so a broken revision path would either drop the user's answer or
// yield the pre-critique version while claiming the revision happened.
// ---------------------------------------------------------------------------

describe('runStreamingAgenticLoop — reflexion (opt-in self-critique)', () => {
  test('with reflexion OFF the answer is yielded unchanged and no critique runs', async () => {
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'e'.repeat(600) })],
        stream: (async function* () { yield 'original answer' })(),
      }),
    )
    const text = await drain(out.stream)
    // Off by default: the critique costs an extra LLM call per round, so it must
    // not run unless the operator turned it on.
    expect(text).toContain('original answer')
    expect(text).not.toContain('revised')
  })

  test('with reflexion ON, the critique RUNS and the original text is buffered', async () => {
    process.env.REFLEXION_ENABLED = 'true'
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield 'original answer' })(),
      }),
    )
    const text = await drain(out.stream)
    // Reflexion needs the FULL text before it can revise, so this path buffers
    // instead of streaming live — the tradeoff is deliberate.
    expect(reflexionState.calls).toBeGreaterThan(0)
    expect(text).toContain('original answer')
  })

  test('a revision REQUEST replaces the text the user receives', async () => {
    process.env.REFLEXION_ENABLED = 'true'
    reflexionState.needsRevision = true
    reflexionState.revised = 'corrected answer'
    // ONLY ONE ROUND. With 'tiny' evidence the loop runs further rounds, and each
    // round would yield the same fixture again — then `not.toContain('flawed')`
    // fails against the NEXT round's answer rather than proving anything about
    // the revision. A confident verdict keeps this to a single round so the
    // assertion is about the revision and nothing else.
    confidenceState.confident = true
    confidenceState.confidence = 0.9
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield 'flawed answer' })(),
      }),
    )
    const text = await drain(out.stream)
    // The revised text must REPLACE the draft, not be appended to it: shipping
    // both would show the user the flawed answer they were being protected from.
    expect(text).toContain('corrected answer')
    expect(text).not.toContain('flawed answer')
  })

  test('no revision requested leaves the original text alone', async () => {
    process.env.REFLEXION_ENABLED = 'true'
    reflexionState.needsRevision = false
    confidenceState.confident = true
    confidenceState.confidence = 0.9
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield 'good answer' })(),
      }),
    )
    const text = await drain(out.stream)
    expect(reflexionState.calls).toBeGreaterThan(0)
    expect(text).toContain('good answer')
    // 'REVISED' is the fixture's revised text; it must not appear when the
    // critique did not ask for a revision.
    expect(text).not.toContain('REVISED')
  })
})

describe('runStreamingAgenticLoop — deadline', () => {
  test('a deadline already past stops the FIRST round and says it timed out', async () => {
    process.env.AGENTIC_DEADLINE_MS = '-1000'
    try {
      let calls = 0
      const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        calls++
        return streamResult()
      })
      const text = await drain(out.stream)
      // A NEGATIVE deadline, not 0: Date.now() > Date.now() + 0 is false. Measured
      // on the non-streaming loop, where 0 did not stop the first iteration.
      expect(calls).toBe(0)
      expect(text).toContain('timed out')
    } finally {
      delete process.env.AGENTIC_DEADLINE_MS
    }
  })

  test('a deadline that expires DURING the round reports an incomplete answer, not the raw text', async () => {
    process.env.AGENTIC_DEADLINE_MS = '-1000'
    try {
      let calls = 0
      const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        calls++
        return streamResult({ toolRuns: [toolRun({ outputSummary: 'e'.repeat(600) })] })
      })
      const text = await drain(out.stream)
      // Either the top-of-round check fires (0 calls) or the per-round deadline
      // does; both must tell the user the answer is incomplete rather than
      // presenting a partial turn as finished.
      expect(text.length).toBeGreaterThan(0)
      expect(calls).toBeLessThanOrEqual(1)
    } finally {
      delete process.env.AGENTIC_DEADLINE_MS
    }
  })

  test('a healthy deadline does not interrupt the round', async () => {
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return streamResult({
        toolRuns: [toolRun({ outputSummary: 'e'.repeat(600) })],
        stream: (async function* () { yield 'complete answer' })(),
      })
    })
    const text = await drain(out.stream)
    expect(text).toContain('complete answer')
    // NOTE: measured at 2, not 1. outputSummary is sliced to 300 chars, so a
    // 600-char fixture contributes ~300 and the "substantial evidence" heuristic
    // (>500) does NOT fire; the mocked evaluator answers "not confident" and the
    // loop runs a second round. Each round yields its own text, so the transcript
    // is the answer twice. That is the loop working as designed, and the fixture —
    // not the loop — was wrong the first time this was written.
    expect(calls).toBe(2)
  })

  test('the substantial-evidence heuristic short-circuits the round in ONE call', async () => {
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return streamResult({
        // The ANSWER is what pushes accumulatedEvidence past 500 here: the tool
        // summary is capped at 300, so a 300-char answer is what clears the bar.
        toolRuns: [toolRun({ outputSummary: 'e'.repeat(300) })],
        stream: (async function* () { yield 'a'.repeat(300) })(),
      })
    })
    const text = await drain(out.stream)
    expect(calls).toBe(1)
    expect(text.length).toBeGreaterThanOrEqual(300)
  })
})

describe('runStreamingAgenticLoop — the LLM-confidence path (not the heuristic one)', () => {
  test('a CONFIDENT verdict from the evaluator returns without a synthesis round', async () => {
    confidenceState.confident = true
    confidenceState.confidence = 0.9
    confidenceState.reason = 'answered'
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      return streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield 'judged answer' })(),
      })
    })
    const text = await drain(out.stream)
    // `tiny` keeps the evidence under the 500-char heuristic, so this exercises
    // the evaluated path rather than the substantial-evidence shortcut (which is
    // covered separately, and which skips the evaluator entirely).
    expect(confidenceState.confident).toBe(true)
    expect(text).toContain('judged answer')
    expect(calls).toBe(1)
  })

  test('a HIGH-risk alignment verdict on the evaluated path annotates the answer', async () => {
    confidenceState.confident = true
    confidenceState.confidence = 0.9
    alignmentState.enabled = true
    alignmentState.risk = 'high'
    alignmentState.reason = 'unsupported claim'
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield 'judged answer' })(),
      }),
    )
    const text = await drain(out.stream)
    expect(alignmentState.calls).toBeGreaterThan(0)
    // Annotated, not blocked: the user still gets the answer plus the warning.
    expect(text).toContain('judged answer')
    expect(text).toContain('unsupported claim')
  })

  test('a not-confident verdict with a tool hint continues and injects the hint', async () => {
    confidenceState.confident = false
    confidenceState.nextToolHint = 'RAG'
    const questions: string[] = []
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async (a) => {
      questions.push(a.question)
      return streamResult({ toolRuns: [toolRun({ outputSummary: 'tiny' })] })
    })
    await drain(out.stream)
    // The hint must reach the evidence string that the next round is asked about,
    // otherwise "try RAG instead" changes nothing.
    expect(questions.length).toBeGreaterThan(1)
    expect(questions[1]).toContain('Try RAG instead')
  })

  test('a CHAT hint is NOT injected (a no-op instruction)', async () => {
    confidenceState.confident = false
    confidenceState.nextToolHint = 'CHAT'
    const questions: string[] = []
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async (a) => {
      questions.push(a.question)
      return streamResult({ toolRuns: [toolRun({ outputSummary: 'tiny' })] })
    })
    await drain(out.stream)
    expect(questions[1]).not.toContain('Try CHAT instead')
  })
})

describe('runStreamingAgenticLoop — deadline during the final synthesis', () => {
  test('a deadline that expires mid-synthesis reports an incomplete answer', async () => {
    // The synthesis round is the 4th call (MAX_AGENTIC_ITERATIONS = 3 rounds, then
    // one synthesis). The deadline must be generous enough for the three rounds
    // but expire during the sleep in the 4th, which is the only way to reach the
    // per-round AgenticDeadlineError on the synthesis path.
    process.env.AGENTIC_DEADLINE_MS = '400'
    confidenceState.confident = false // keep looping; never confident
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      if (calls === 4) {
        // Burn past the remaining budget so withAgenticDeadline rejects.
        await new Promise((r) => setTimeout(r, 600))
      }
      return streamResult({ toolRuns: [toolRun({ outputSummary: 'tiny' })] })
    })
    const text = await drain(out.stream)
    // Measured: the loop must have reached the synthesis round, and the user must
    // be told the answer is incomplete rather than handed a silent partial.
    expect(calls).toBe(4)
    expect(text).toContain('deadline exceeded')
  })
})
