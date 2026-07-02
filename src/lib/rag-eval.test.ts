import { describe, expect, test } from 'bun:test'
import { summarizeRagEval } from './rag-eval'

describe('RAG eval helpers', () => {
  test('computes precision and grounded rate', () => {
    const summary = summarizeRagEval([
      { ok: true, grounded: true, latencyMs: 10 },
      { ok: false, grounded: false, latencyMs: 30 },
    ])

    expect(summary.precisionAtK).toBe(0.5)
    expect(summary.groundedRate).toBe(0.5)
    expect(summary.avgLatencyMs).toBe(20)
  })
})
