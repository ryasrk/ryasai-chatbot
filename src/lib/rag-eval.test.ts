import { describe, expect, test } from 'bun:test'
import {
  compareRagEval,
  isGrounded,
  relevantSourcesFor,
  scoreRetrieval,
  summarizeRagEval,
} from './rag-eval'

const chunks = (...names: string[]) => names.map((documentName) => ({ documentName }))

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

  test('averages recall and MRR across questions', () => {
    const summary = summarizeRagEval([
      { ok: true, grounded: true, latencyMs: 1, recall: 1, reciprocalRank: 1 },
      { ok: true, grounded: true, latencyMs: 1, recall: 0.5, reciprocalRank: 0.25 },
    ])
    expect(summary.recallAtK).toBe(0.75)
    expect(summary.mrr).toBe(0.625)
  })

  test('unlabelled cases do not inflate the averages', () => {
    const summary = summarizeRagEval([{ ok: true, grounded: true, latencyMs: 1 }])
    expect(summary.recallAtK).toBe(0)
    expect(summary.mrr).toBe(0)
  })
})

describe('scoreRetrieval', () => {
  test('MRR rewards ranking the right document first', () => {
    const first = scoreRetrieval(chunks('leave-policy.pdf', 'travel.pdf'), ['leave-policy'])
    const fourth = scoreRetrieval(
      chunks('a.pdf', 'b.pdf', 'c.pdf', 'leave-policy.pdf'),
      ['leave-policy'],
    )
    expect(first.reciprocalRank).toBe(1)
    expect(fourth.reciprocalRank).toBe(0.25)
    // Same recall, very different answer quality — the distinction the old
    // harness could not see at all.
    expect(first.recall).toBe(fourth.recall)
  })

  test('recall counts distinct expected sources, not chunk count', () => {
    // Three chunks from one document is NOT full recall of two sources.
    const partial = scoreRetrieval(
      chunks('leave-policy.pdf', 'leave-policy.pdf', 'leave-policy.pdf'),
      ['leave-policy', 'holiday-calendar'],
    )
    expect(partial.recall).toBe(0.5)
    expect(partial.precision).toBe(1)
  })

  test('precision penalises irrelevant chunks in the prompt', () => {
    const noisy = scoreRetrieval(chunks('leave-policy.pdf', 'x.pdf', 'y.pdf', 'z.pdf'), [
      'leave-policy',
    ])
    expect(noisy.recall).toBe(1)
    expect(noisy.precision).toBe(0.25)
  })

  test('nothing retrieved → all zero, not a divide-by-zero', () => {
    expect(scoreRetrieval([], ['leave-policy'])).toEqual({
      recall: 0,
      precision: 0,
      reciprocalRank: 0,
      hit: false,
    })
  })

  test('no labelled sources → hit reflects whether anything came back', () => {
    expect(scoreRetrieval(chunks('a.pdf'), []).hit).toBe(true)
    expect(scoreRetrieval([], []).hit).toBe(false)
  })

  test('matching is case-insensitive and substring-based', () => {
    expect(scoreRetrieval(chunks('HR-Leave-Policy-2024.PDF'), ['leave-policy']).recall).toBe(1)
  })
})

describe('relevantSourcesFor', () => {
  test('prefers relevantSources, falls back to the legacy expectedSource', () => {
    expect(relevantSourcesFor({ question: 'q', relevantSources: ['A', 'B'] })).toEqual(['a', 'b'])
    expect(relevantSourcesFor({ question: 'q', expectedSource: 'Legacy' })).toEqual(['legacy'])
    expect(relevantSourcesFor({ question: 'q' })).toEqual([])
  })
})

describe('compareRagEval', () => {
  const base = {
    total: 10,
    precisionAtK: 0.5,
    recallAtK: 0.5,
    mrr: 0.5,
    groundedRate: 0.5,
    avgLatencyMs: 100,
  }

  test('a real recall gain reads as better', () => {
    expect(compareRagEval(base, { ...base, recallAtK: 0.7, mrr: 0.6 }).verdict).toBe('better')
  })

  test('a regression reads as worse', () => {
    expect(compareRagEval(base, { ...base, recallAtK: 0.3, mrr: 0.4 }).verdict).toBe('worse')
  })

  test('noise-level movement is inconclusive, not a win', () => {
    expect(compareRagEval(base, { ...base, recallAtK: 0.505, mrr: 0.505 }).verdict).toBe(
      'inconclusive',
    )
  })

  test('recall up but MRR down by the same amount is not a win', () => {
    expect(compareRagEval(base, { ...base, recallAtK: 0.6, mrr: 0.4 }).verdict).toBe(
      'inconclusive',
    )
  })
})

describe('isGrounded', () => {
  test('no expected text → vacuously grounded', () => {
    expect(isGrounded('anything', undefined)).toBe(true)
    expect(isGrounded('anything', '  ')).toBe(true)
  })

  test('case-insensitive substring match', () => {
    expect(isGrounded('The Annual Leave is 12 days', 'annual leave')).toBe(true)
    expect(isGrounded('unrelated text', 'annual leave')).toBe(false)
  })
})
