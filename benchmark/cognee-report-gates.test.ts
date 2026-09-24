import { describe, expect, test } from 'bun:test'
import { embedderVerdict, ingestScaling } from './cognee-benchmark-report'

describe('embedder-recorded gate', () => {
  test('fails when no model is recorded', () => {
    expect(embedderVerdict(null).ok).toBe(false)
  })
  test('fails on the hashed UAT fixture', () => {
    expect(embedderVerdict('uat-hashed-bow-1536').ok).toBe(false)
  })
  test('passes on a named model', () => {
    expect(embedderVerdict('paraphrase-multilingual-MiniLM-L12-v2').ok).toBe(true)
  })
})

describe('ingest-scaling gate', () => {
  test('not computable on too few batches', () => {
    expect(ingestScaling([1, 2, 3])).toBeNull()
  })
  test('flat batches do not grow', () => {
    expect(ingestScaling(Array(48).fill(20_000))!.growth).toBeCloseTo(1)
  })
  test('quadratic ingest (batch i re-processes i batches) grows far past the limit', () => {
    const quadratic = Array.from({ length: 48 }, (_, i) => (i + 1) * 1000)
    expect(ingestScaling(quadratic)!.growth).toBeGreaterThan(3)
  })
  test('the recorded 1.5.4 shape (19.3s → 31.8s) stays under the limit', () => {
    const recorded = [...Array(5).fill(19_346), ...Array(38).fill(25_000), ...Array(5).fill(31_817)]
    expect(ingestScaling(recorded)!.growth).toBeLessThan(3)
  })
})
