import { describe, expect, test } from 'bun:test'
import { appendToolRuns, dedupeToolRuns, toolRunTypeFor } from './tool-router-agentic'
import type { PendingToolRun } from './tool-utils'

function run(over: Partial<PendingToolRun> = {}): PendingToolRun {
  return {
    type: 'CHAT',
    status: 'success',
    inputSummary: 'what is the total revenue?',
    ...over,
  }
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
