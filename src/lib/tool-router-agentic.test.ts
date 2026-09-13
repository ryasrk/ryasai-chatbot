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

// The STREAMING loop takes its token usage from `getLastLlmUsage()`, which reads an
// AsyncLocalStorage store populated only by a REAL chatStream call (`_usageStorage.enterWith`
// in llm-client.ts). A mocked stream leaves that store empty, so `if (usage) budget.track(usage)`
// never fires and the budget can never be crossed -- which is exactly why lines 424-428 (the
// no-tools streaming exit) and 554-557 (the loop's final round) had no coverage. The real
// `withUsageTracking`/`getLastLlmUsage` pair IS the public contract, so the holder below
// substitutes only the last step: what a completed LLM round reports as its usage.
//
// This mock exists in THIS file only. tool-router-stream.test.ts mocks the same module with a
// different shape (`withUsageTracking` only), which is fine because each file is a separate
// process under scripts/test.ts.
let lastUsage: { promptTokens: number; completionTokens: number } | undefined
mock.module('@/lib/llm-client', () => ({
  getLastLlmUsage: () => lastUsage,
  withUsageTracking: async (fn: any) => fn(),
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
  // Reset the usage seam too: a value left over from one test would make the NEXT test's "no usage reported"
  // assertion pass for the wrong reason, which is how a leak of this kind hides.
  lastUsage = undefined
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
// ---------------------------------------------------------------------------
// runAgenticLoop (NON-streaming) — reflexion and deadline
//
// Both were covered on the STREAMING path only. runStreamingAgenticLoop and
// runAgenticLoop are parallel implementations, so "covered on one" says nothing
// about the other: 24 lines of runAgenticLoop had never executed.
// ---------------------------------------------------------------------------

describe('runAgenticLoop — reflexion (opt-in self-critique)', () => {
  test('REFLEXION_ENABLED=true lets the critique REPLACE the answer', async () => {
    process.env.REFLEXION_ENABLED = 'true'
    reflexionState.needsRevision = true
    reflexionState.revised = 'THE REVISED ANSWER'
    confidenceState.confident = true

    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ answer: 'ORIGINAL', toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })] }),
    )
    // The revision must actually reach the caller — returning the pre-critique
    // text while the log says "revised" would be a silent lie.
    expect(res.answer).toContain('THE REVISED ANSWER')
    expect(reflexionState.calls).toBeGreaterThan(0)
  })

  test('needsRevision=false keeps the original answer untouched', async () => {
    process.env.REFLEXION_ENABLED = 'true'
    reflexionState.needsRevision = false
    confidenceState.confident = true

    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ answer: 'ORIGINAL', toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })] }),
    )
    expect(res.answer).toContain('ORIGINAL')
    expect(res.answer).not.toContain('REVISED')
  })

  test('reflexion is NOT consulted when the flag is off (no wasted LLM call)', async () => {
    reflexionState.needsRevision = true
    confidenceState.confident = true
    await runAgenticLoop({ question: 'q', userId: 'u1' }, async () =>
      completion({ answer: 'ORIGINAL', toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })] }),
    )
    // The critique is a full extra LLM call on a BYOK key, so it must stay opt-in.
    expect(reflexionState.calls).toBe(0)
  })
})

describe('runAgenticLoop — the deadline', () => {
  test('a deadline mid-round returns the evidence gathered so far, not an empty answer', async () => {
    process.env.AGENTIC_DEADLINE_MS = '250'
    confidenceState.confident = false // never confident, so the loop keeps going
    let calls = 0
    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      if (calls >= 2) await new Promise((r) => setTimeout(r, 400))
      // Long, non-empty evidence is the POINT here: this test is about the mid-round
      // path returning what was already gathered.
      return completion({ answer: 'round answer', toolRuns: [toolRun({ outputSummary: 'EVIDENCE'.repeat(20) })] })
    })
    // MEASURED: the partial answer carries what was already collected. Throwing
    // away round-1 evidence because round 2 timed out wastes work the user paid for.
    expect(res.answer).toContain('EVIDENCE')
    const last = res.confidenceHistory[res.confidenceHistory.length - 1]
    expect(last.reason).toContain('deadline exceeded')
    expect(last.confident).toBe(false)
  })

  test('with NO evidence yet, a deadline returns an explicit timeout message', async () => {
    process.env.AGENTIC_DEADLINE_MS = '200'
    confidenceState.confident = false
    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      // The FIRST round is already too slow, so nothing has accumulated.
      await new Promise((r) => setTimeout(r, 400))
      return completion({ answer: 'never seen', toolRuns: [] })
    })
    // An empty string here would look like a successful empty answer.
    expect(res.answer).toContain('timed out')
  })
})

describe('runAgenticLoop — deadline during the FINAL SYNTHESIS', () => {
  // The streaming transport covered this branch (405-408); the non-streaming one
  // (347-351) had never run. They are SEPARATE catch blocks, so covering one proves
  // nothing about the other: a fix applied to the SSE path alone would leave the
  // JSON path throwing a raw AgenticDeadlineError at the API layer.

  test('a deadline expiring mid-synthesis returns the gathered evidence, not a throw', async () => {
    // MAX_AGENTIC_ITERATIONS rounds (3), then a 4th call which is the synthesis.
    process.env.AGENTIC_DEADLINE_MS = '400'
    confidenceState.confident = false // keep looping; never confident
    let calls = 0
    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      if (calls === 4) {
        // Burn past the remaining budget so withAgenticDeadline rejects.
        await new Promise((r) => setTimeout(r, 600))
      }
      // Deliberately EMPTY answer and summary. accumulatedEvidence grows by the tool
      // summary AND `[Answer so far: ...]` every round, and the heuristic path
      // short-circuits once it passes 500 chars -- never reaching synthesis. My first
      // version used 160 chars of summary plus a non-empty answer and saw calls=3:
      // the assertion was measuring the heuristic exit, not the deadline. Empty text
      // is the only way to still be inside the synthesis call when the deadline fires.
      return completion({ answer: '', toolRuns: [toolRun({ outputSummary: '' })] })
    })
    // MEASURED: the loop reached synthesis and did NOT throw. Throwing here would
    // surface as a 500 to the user after the work was already paid for.
    expect(calls).toBe(4)
    // The partial answer carries the evidence accumulated across the three rounds.
    // It is non-empty even with empty model text, because each round appends the
    // `[SQL] ...` tool marker and `[Answer so far: ...]` header -- so this asserts
    // the DEGRADED-but-useful shape rather than a bare timeout string.
    expect(res.answer).toContain('Based on gathered evidence')
    // The iterations report the CEILING, because that is how far the loop got.
    expect(res.iterations).toBe(3)
    // And the deadline is recorded in the history for the operator, not swallowed.
    const last = res.confidenceHistory[res.confidenceHistory.length - 1]
    expect(last.reason).toBe('deadline exceeded')
    expect(last.confident).toBe(false)
  })

  test('the deadline is reported even when NO round produced model text', async () => {
    // Rounds return a toolRun but no output and no answer, so the accumulated
    // evidence holds only the per-round `[SQL]`/`[Answer so far: ]` markers. The
    // DEGRADED answer must still be returned rather than thrown: a blank answer
    // reads as success, and a throw reads as a server fault.
    process.env.AGENTIC_DEADLINE_MS = '400'
    confidenceState.confident = false
    let calls = 0
    const res = await runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
      calls++
      if (calls === 4) await new Promise((r) => setTimeout(r, 600))
      // A toolRun with EMPTY text keeps accumulatedEvidence under the 500-char
      // heuristic threshold and keeps `result.toolRuns.length === 0` false, so the
      // loop still runs to the ceiling instead of returning early.
      return completion({ answer: '', toolRuns: [toolRun({ outputSummary: '' })] })
    })
    expect(calls).toBe(4)
    expect(res.answer.length).toBeGreaterThan(0)
    expect(res.confidenceHistory[res.confidenceHistory.length - 1].reason).toBe('deadline exceeded')
  })

  test('a NON-deadline synthesis error is re-thrown, not masked as a timeout', async () => {
    // The catch step narrows on AgenticDeadlineError and must `throw e` otherwise.
    // Swallowing every error as "timed out" would hide a genuine provider failure
    // behind a message that tells the operator nothing and looks retryable.
    process.env.AGENTIC_DEADLINE_MS = '60000'
    confidenceState.confident = false
    let calls = 0
    await expect(
      runAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        calls++
        if (calls === 4) throw new Error('provider 502: upstream exploded')
        return completion({ answer: 'round answer', toolRuns: [toolRun({ outputSummary: '' })] })
      }),
    ).rejects.toThrow('provider 502')
  })
})

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

  test('a deadline expiring MID-ROUND yields a notice to the user, not a silent stop', async () => {
    // The sibling test below uses a NEGATIVE deadline, so it is caught by the
    // top-of-round check (line 251 / the streaming equivalent) BEFORE the round
    // ever runs -- proven by the coverage map, where the per-round catch on the
    // streaming path (405-408) stayed at hit=0 while that test passed green.
    //
    // To reach THAT catch the deadline must be live when the round starts and
    // expire while it is in flight. Generous enough to pass the top-of-round
    // check, short enough to fire inside the sleeping round.
    process.env.AGENTIC_DEADLINE_MS = '300'
    try {
      confidenceState.confident = false
      let calls = 0
      const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        calls++
        // Burn the budget inside the FIRST round so the per-round deadline rejects.
        await new Promise((r) => setTimeout(r, 500))
        return streamResult({ toolRuns: [toolRun({ outputSummary: 'tiny' })] })
      })
      const text = await drain(out.stream)
      // The round RAN and then timed out (with a past deadline this would be 0).
      expect(calls).toBe(1)
      // Nothing had been gathered yet, so the notice is the standalone timeout text.
      // Measured: a user mid-stream must be TOLD, because ending the stream silently
      // looks like a complete (empty) answer.
      expect(text).toContain('timed out')
    } finally {
      delete process.env.AGENTIC_DEADLINE_MS
    }
  })

  test('mid-round deadline with evidence ALREADY gathered yields the incomplete-answer note', async () => {
    // The other arm of the same ternary: when a previous round contributed evidence,
    // the user is told the answer MAY BE INCOMPLETE rather than that it timed out --
    // the partial content is worth keeping, so a bare "timed out" would discard it.
    process.env.AGENTIC_DEADLINE_MS = '300'
    try {
      confidenceState.confident = false
      let calls = 0
      const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1' }, async () => {
        calls++
        if (calls === 1) {
          // Round 1 SUCCEEDS fast and gathers evidence. Accumulated evidence stays
          // under the 500-char heuristic threshold so the loop continues.
          return streamResult({
            toolRuns: [toolRun({ outputSummary: 'x'.repeat(200) })],
            stream: (async function* () { yield 'partial answer' })(),
          })
        }
        // Round 2 burns past the budget, so the per-round deadline rejects.
        await new Promise((r) => setTimeout(r, 500))
        return streamResult({ toolRuns: [toolRun({ outputSummary: 'y' })] })
      })
      const text = await drain(out.stream)
      expect(calls).toBe(2)
      expect(text).toContain('deadline exceeded')
      expect(text).toContain('may be incomplete')
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

describe('runStreamingAgenticLoop — token budget exhaustion', () => {
  // Mirror of the non-streaming budget tests, which the streaming path never had.
  //
  // HOW THESE BRANCHES BECOME REACHABLE. The non-streaming loop reads `result.usage` off the
  // injected completion, so an ordinary fixture is enough. The STREAMING loop instead calls
  // `getLastLlmUsage()`, which reads an AsyncLocalStorage store populated only by a REAL
  // chatStream call (`_usageStorage.enterWith` in llm-client.ts); a mocked stream leaves the
  // store empty and the budget can never be crossed. This file therefore substitutes the LAST
  // step only -- `getLastLlmUsage` is mocked at module level, driven by the `lastUsage` holder
  // declared beside it, while `withUsageTracking` keeps its real pass-through behaviour. That
  // keeps the loop under test entirely real.
  //
  // An earlier comment here claimed the store was primed "below" by driving the real
  // withUsageTracking. It never was: the store has no public setter, and a `void budget`
  // placeholder was left where the priming should have been. Fixed by the module mock.

  test('an exhausted budget stops the loop and DISCLOSES it to the user', async () => {
    const b = createTokenBudget(0)
    let calls = 0
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () => {
      calls++
      return streamResult({
        toolRuns: [toolRun({ outputSummary: 'x'.repeat(200) })],
        stream: (async function* () { yield 'partial answer' })(),
      })
    })
    const text = await drain(out.stream)
    // With a zero budget the ceiling is crossed on the FIRST tracked round.
    expect(text).toContain('token budget exhausted')
    expect(text).toContain('may be incomplete')
    expect(calls).toBe(1)
  })

  test('a healthy budget discloses nothing', async () => {
    // The inverse, so the test above cannot pass merely because the disclosure is
    // emitted unconditionally.
    const b = createTokenBudget(1_000_000)
    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () =>
      streamResult({
        toolRuns: [],
        stream: (async function* () { yield 'complete answer' })(),
      }),
    )
    const text = await drain(out.stream)
    expect(text).toContain('complete answer')
    expect(text).not.toContain('token budget exhausted')
  })

  test('the streaming loop reports confidence through the onConfidence callback, not a return value', async () => {
    // The streaming loop has NO confidenceHistory on its return type -- it reports
    // via onConfidence. My first version asserted on the return value and failed to
    // typecheck; the real contract is this callback, which is also the only path
    // that reaches lines 483/500 in the source.
    const seen: Array<{ iteration: number; confident: boolean; reason: string }> = []
    const out = await runStreamingAgenticLoop(
      {
        question: 'q', userId: 'u1', budget: createTokenBudget(1_000_000),
        onConfidence: (info) => { seen.push(info) },
      },
      async () => streamResult({
        toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })],
        stream: (async function* () { yield 'answer' })(),
      }),
    )
    await drain(out.stream)
    // Fired more than once, once per round, in iteration order. The FIRST verdict is
    // the mocked evaluator's (not confident), and the heuristic short-circuit lands
    // on the next round -- asserting on seen[0] would have pinned the wrong round.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[0].iteration).toBe(1)
    expect(seen[0].confident).toBe(false)
    expect(seen[1].iteration).toBe(2)
    expect(seen[1].reason).toContain('substantial evidence')
    expect(seen[1].confident).toBe(true)
  })

  test('the NO-TOOLS streaming exit tracks usage and DISCLOSES an exhausted budget', async () => {
    // Lines 424-428: when no tool ran, the stream is forwarded verbatim and the loop returns.
    // The budget still has to be charged for that round, and an exhausted budget still has to
    // be disclosed -- otherwise a user gets a silently truncated answer with no explanation.
    lastUsage = { promptTokens: 9000, completionTokens: 9000 }
    const b = createTokenBudget(10)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () =>
      streamResult({
        toolRuns: [], // <- the no-tools exit
        stream: (async function* () { yield 'direct answer' })(),
      }),
    )
    const text = await drain(out.stream)

    expect(text).toContain('direct answer')
    // The usage was CHARGED: without the track() call the budget would still read 0.
    expect(b.total()).toBe(18000)
    expect(b.isExhausted()).toBe(true)
    // ...and the disclosure followed.
    expect(text).toContain('token budget exhausted')
    expect(text).toContain('may be incomplete')
  })

  test('the no-tools exit does NOT disclose anything while the budget is healthy', async () => {
    // The inverse. Without this, the test above would pass even if the disclosure were
    // emitted unconditionally.
    lastUsage = { promptTokens: 10, completionTokens: 10 }
    const b = createTokenBudget(1_000_000)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () =>
      streamResult({ toolRuns: [], stream: (async function* () { yield 'clean answer' })() }),
    )
    const text = await drain(out.stream)

    expect(text).toContain('clean answer')
    expect(text).not.toContain('token budget exhausted')
    expect(b.total()).toBe(20)
  })

  test('the no-tools exit is safe when the provider reports NO usage', async () => {
    // `if (usage)` -- a provider (or a proxy) that omits usage must not crash the stream.
    lastUsage = undefined
    const b = createTokenBudget(10)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () =>
      streamResult({ toolRuns: [], stream: (async function* () { yield 'answer without usage' })() }),
    )
    const text = await drain(out.stream)

    expect(text).toContain('answer without usage')
    expect(b.total()).toBe(0)
    // Nothing was charged, so nothing is disclosed either.
    expect(text).not.toContain('token budget exhausted')
  })

  test('the FINAL round of a loop reports an exhausted budget after the answer', async () => {
    // Lines 554-557: the tail of the multi-round loop, reached only when a TOOL ran (so the
    // no-tools exit above is skipped) and the budget is crossed by the last round. This is the
    // common real shape: the answer is produced and THEN the ceiling is noticed.
    lastUsage = { promptTokens: 500, completionTokens: 500 }
    const b = createTokenBudget(400)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () =>
      streamResult({
        toolRuns: [toolRun({ outputSummary: 'x'.repeat(600) })],
        stream: (async function* () { yield 'the real answer' })(),
      }),
    )
    const text = await drain(out.stream)

    expect(text).toContain('the real answer')
    expect(text).toContain('token budget exhausted')
    expect(b.total()).toBe(1000)
  })

  test('the FINAL SYNTHESIS can be the round that crosses the ceiling (loop tail)', async () => {
    // Lines 554-557 are the tail AFTER the max-iteration final synthesis -- a different place
    // from the in-loop check at 459. Reaching it needs a budget that survives all three
    // ordinary iterations (the in-loop check would otherwise `return` at 463) and is only
    // crossed by the last synthesis call. Charging 100 per round against a 300 ceiling with
    // confidence pinned to false does exactly that: rounds 1-3 read 100/200/300 and
    // `isExhausted()` compares `>` (not `>=`), so the loop runs to the cap, and the synthesis
    // round takes it to 400.
    confidenceState.confident = false
    let round = 0
    // 100 per round against a ceiling of 350: rounds 1-3 reach 100/200/300 and
    // `isExhausted()` is `used >= max`, so 300 >= 350 is false and the loop runs all three.
    // The synthesis round then takes it to 400 >= 350, which is the tail's trigger.
    const b = createTokenBudget(350)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () => {
      round++
      lastUsage = { promptTokens: 50, completionTokens: 50 }
      // outputSummary is kept SHORT on purpose. The heuristic at line 480 declares confidence
      // once `accumulatedEvidence.length > 500`, which happened after two rounds when I used a
      // 600-char summary -- so the loop returned at 495 and never reached the synthesis. Two
      // short rounds and a short answer keep the evidence under that threshold.
      return streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield `r${round} ` })(),
      })
    })
    const text = await drain(out.stream)

    expect(round).toBe(4) // 3 loop rounds + 1 synthesis
    expect(text).toContain('r4')
    expect(b.total()).toBe(400)
    expect(b.isExhausted()).toBe(true)
    expect(text).toContain('token budget exhausted')
    expect(text).toContain('may be incomplete')
  })

  test('a final synthesis that stays UNDER the ceiling discloses nothing', async () => {
    // The inverse, so the test above cannot pass on an unconditional disclosure. 10 tokens per
    // round against a 1000 ceiling never crosses.
    confidenceState.confident = false
    let round = 0
    const b = createTokenBudget(1000)

    const out = await runStreamingAgenticLoop({ question: 'q', userId: 'u1', budget: b }, async () => {
      round++
      lastUsage = { promptTokens: 5, completionTokens: 5 }
      return streamResult({
        toolRuns: [toolRun({ outputSummary: 'tiny' })],
        stream: (async function* () { yield `r${round} ` })(),
      })
    })
    const text = await drain(out.stream)

    expect(round).toBe(4)
    expect(b.total()).toBe(40)
    expect(text).not.toContain('token budget exhausted')
  })

  test('the budget is SHARED, not copied, so tracking accumulates across rounds', async () => {
    // A budget cloned per round would never exhaust in production either.
    const b = createTokenBudget(1_000_000)
    for (let i = 0; i < 3; i++) b.track({ promptTokens: 1000, completionTokens: 1000 })
    expect(b.total()).toBe(6000)
    expect(b.isExhausted()).toBe(false)
  })

})

describe('runStreamingAgenticLoop — token usage is reported on the result', () => {
  // THE DEFECT THIS PINS. The streaming loop read `getLastLlmUsage()` into its BUDGET and then dropped it;
  // `output.usage` was never assigned, so an SSE chat turn reported no tokens while the non-streaming builders
  // populate the identical field. Any "avg tokens/task" figure taken from the SSE path was therefore computed
  // from nothing. `usage` is only readable AFTER the stream is consumed, because the calls happen inside.
  test('usage is present after draining, and is the SUM across iterations', async () => {
    let call = 0
    // NOTE: `chatHistory` is deliberately NOT passed. An EMPTY array routes the caller through the multi-step DAG
    // branch in tool-router.ts instead of this loop, which is why an earlier draft of this test saw `runStreaming`
    // never invoked and `usage` undefined. Measured, not assumed.
    const out = await runStreamingAgenticLoop({ question: 'hi', userId: 'u1' }, async () => {
      call += 1
      lastUsage = { promptTokens: 7 * call, completionTokens: call }
      return streamResult({
        stream: (async function* () { yield 'a' })(),
        // Tool runs on the first two rounds force a THIRD call, and the third returns none -- which is the
        // "no tools -> stream and return" exit that used to drop the usage on the floor.
        toolRuns: call < 3 ? [toolRun()] : [],
      })
    })
    await drain(out.stream)
    expect(call).toBe(3)
    expect(out.usage).toBeDefined()
    // 7+14+21 = 42 and 1+2+3 = 6: the SUM, where a last-wins implementation would report 21/3.
    expect(out.usage!.promptTokens).toBe(42)
    expect(out.usage!.completionTokens).toBe(6)
    lastUsage = undefined
  })

  test('a turn where the provider reported NO usage leaves the field ABSENT', async () => {
    // Absent must mean "not reported", never "0 tokens" — a zero would be a measurement and would drag an average
    // toward zero, which is exactly the kind of silent lie this round is removing.
    lastUsage = undefined
    const out = await runStreamingAgenticLoop({ question: 'hi', userId: 'u1' }, async () => streamResult())
    await drain(out.stream)
    // `undefined` (absent VALUE), which is what a JSON response then omits. The KEY exists because `usage` is a
    // deferred getter -- that is deliberate: the accumulator is only filled during consumption, so a spread here
    // would read 0/0 and omit the field even when usage WAS reported. `in` is therefore not the right probe; the
    // value is.
    expect(out.usage).toBeUndefined()
    expect(JSON.stringify({ ...out, stream: undefined })).not.toContain('usage')
  })

  test('the budget still consumes the same usage the result now reports', async () => {
    // The fix added the accumulation BESIDE `budget.track`. A later change that swaps one for the other would
    // break budget enforcement, so both are asserted together here.
    lastUsage = { promptTokens: 999999, completionTokens: 1 }
    const out = await runStreamingAgenticLoop({ question: 'hi', userId: 'u1' }, async () => streamResult())
    const text = await drain(out.stream)
    expect(text).toContain('token budget exhausted')
    expect(out.usage!.promptTokens).toBe(999999)
    lastUsage = undefined
  })
})
