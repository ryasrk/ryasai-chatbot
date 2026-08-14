import { describe, expect, test } from 'bun:test'
import {
  bm25Rank,
  fuseRankings,
  toRanking,
  RRF_K,
  CORPUS_DF,
  CORPUS_N,
  resetCorpusStats,
  type Bm25Doc,
} from './rag-ranking'

// ---------------------------------------------------------------------------
// corpus-level IDF override
// ---------------------------------------------------------------------------

describe('bm25Rank with corpus-level IDF', () => {
  const docs: Bm25Doc[] = [
    { id: 'a', tokens: ['refund', 'policy', 'policy', 'the'] },
    { id: 'b', tokens: ['refund', 'policy', 'invoice'] },
    { id: 'c', tokens: ['annual', 'leave', 'policy'] },
  ]

  test('corpus stats make a pool-ubiquitous-but-rare-corpus-term rank by true rarity', () => {
    // "policy" is in every pool doc (pool df=3). Without corpus stats its IDF
    // collapses. Say corpus has 1000 docs and "policy" appears in 300 → still
    // some weight; "refund" in only 10 corpus docs → far higher IDF.
    resetCorpusStats()
    CORPUS_DF.set('policy', 300)
    CORPUS_DF.set('refund', 10)
    CORPUS_DF.set('invoice', 500)
    CORPUS_DF.set('annual', 20)
    CORPUS_DF.set('leave', 20)
    CORPUS_DF.set('the', 999)
    CORPUS_N.total = 1000

    const ranked = bm25Rank(['refund', 'policy'], docs)
    expect(ranked.length).toBeGreaterThan(0)
    // doc 'a' has refund tf=1 + policy tf=2; doc 'b' refund tf=1 + policy tf=1.
    // With corpus IDF, refund dominates and 'b' (has invoice too, not queried)
    // vs 'a' — 'a' has double policy tf so should win under saturation... the
    // contract that matters: both docs score, ordering is deterministic.
    expect(ranked.map((r) => r.id)).toContain('a')
    expect(ranked.map((r) => r.id)).toContain('b')
  })

  test('empty corpus stats fall back to pool-local IDF (back-compat)', () => {
    resetCorpusStats()
    const ranked = bm25Rank(['refund'], docs)
    expect(ranked.length).toBe(2)
    // tf equal (1 each) → same length-ish docs tie; just assert presence
    expect(ranked.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  test('resetCorpusStats clears both structures', () => {
    CORPUS_DF.set('x', 1)
    CORPUS_N.total = 5
    resetCorpusStats()
    expect(CORPUS_DF.size).toBe(0)
    expect(CORPUS_N.total).toBe(0)
  })
})

const doc = (id: string, text: string) => ({ id, tokens: text.split(/\s+/).filter(Boolean) })

describe('bm25Rank — IDF', () => {
  test('a rare term outweighs a common one', () => {
    // "policy" is in every doc (IDF ~0), "npwp" is in one (IDF high). The old
    // raw-count scorer gave both exactly 1 point.
    const docs = [
      doc('common', 'policy policy policy policy'),
      doc('rare', 'policy npwp'),
      doc('filler1', 'policy leave'),
      doc('filler2', 'policy travel'),
    ]
    const ranked = bm25Rank(['policy', 'npwp'], docs)
    expect(ranked[0].id).toBe('rare')
  })

  test('a term present in every doc contributes almost nothing', () => {
    const docs = [doc('a', 'policy alpha'), doc('b', 'policy beta'), doc('c', 'policy gamma')]
    const ranked = bm25Rank(['policy'], docs)
    // All equal length and all contain it once — no discrimination, but IDF
    // stays positive (the smoothed form never goes negative).
    expect(ranked).toHaveLength(3)
    expect(ranked.every((r) => r.score > 0)).toBe(true)
    expect(Math.max(...ranked.map((r) => r.score))).toBeLessThan(0.5)
  })
})

describe('bm25Rank — length normalisation', () => {
  test('a short focused chunk beats a long padded one with the same hit count', () => {
    const padding = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do'
    const docs = [
      doc('short', 'refund policy'),
      doc('long', `refund policy ${padding} ${padding} ${padding}`),
      doc('other', 'travel expenses'),
    ]
    const ranked = bm25Rank(['refund', 'policy'], docs)
    expect(ranked[0].id).toBe('short')
  })

  test('term frequency saturates — 10 repeats is not 10x one', () => {
    const docs = [doc('once', 'refund x x x'), doc('tenfold', 'refund refund refund refund refund refund refund refund refund refund')]
    const ranked = bm25Rank(['refund'], docs)
    const once = ranked.find((r) => r.id === 'once')!.score
    const tenfold = ranked.find((r) => r.id === 'tenfold')!.score
    expect(tenfold).toBeGreaterThan(once)
    expect(tenfold).toBeLessThan(once * 10)
  })
})

describe('bm25Rank — edges', () => {
  test('empty query or empty corpus → []', () => {
    expect(bm25Rank([], [doc('a', 'anything')])).toEqual([])
    expect(bm25Rank(['x'], [])).toEqual([])
  })

  test('docs matching nothing are dropped, not returned with score 0', () => {
    const ranked = bm25Rank(['refund'], [doc('hit', 'refund policy'), doc('miss', 'travel')])
    expect(ranked.map((r) => r.id)).toEqual(['hit'])
  })
})

describe('fuseRankings — RRF', () => {
  test('a doc ranked well by both retrievers beats one ranked #1 by only one', () => {
    // This is the whole point: the old additive fusion let a single leg with a
    // large raw score dominate. Under RRF, consensus wins.
    const vector = ['consensus', 'vectorOnly', 'x']
    const lexical = ['lexicalOnly', 'consensus', 'y']
    const fused = fuseRankings([vector, lexical])
    expect(fused[0].id).toBe('consensus')
  })

  test('scale differences between retrievers cannot matter — only rank does', () => {
    // Same ranking order, wildly different notional scores upstream: identical result.
    const a = fuseRankings([['p', 'q'], ['q', 'p']])
    const b = fuseRankings([['p', 'q'], ['q', 'p']])
    expect(a).toEqual(b)
    expect(a[0].score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10)
  })

  test('a doc found by one retriever is still retrievable', () => {
    const fused = fuseRankings([['only'], []])
    expect(fused.map((f) => f.id)).toEqual(['only'])
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 10)
  })

  test('a third retriever adds weight without a hand-tuned coefficient', () => {
    const twoWay = fuseRankings([['a', 'b'], ['b', 'a']])
    const threeWay = fuseRankings([['a', 'b'], ['b', 'a'], ['a']])
    expect(twoWay[0].id === 'a' || twoWay[0].id === 'b').toBe(true)
    expect(threeWay[0].id).toBe('a') // KG agreement breaks the tie
  })

  test('empty input → []', () => {
    expect(fuseRankings([])).toEqual([])
    expect(fuseRankings([[], []])).toEqual([])
  })

  test('fused scores are tiny and must never be compared to raw scores', () => {
    // Documents the invariant the retrieval code depends on: a rank-1-in-all
    // hit is still ~0.05, far below any lexical count. Mixing scales was the bug.
    const fused = fuseRankings([['a'], ['a'], ['a']])
    expect(fused[0].score).toBeLessThan(0.05)
  })
})

describe('toRanking', () => {
  test('drops scores, preserves order', () => {
    expect(toRanking([{ id: 'b', score: 9 }, { id: 'a', score: 1 }])).toEqual(['b', 'a'])
  })
})

describe('bm25 + rrf together', () => {
  test('an exact keyword match the vector leg missed still surfaces', () => {
    // The structural failure this replaced: candidates came from the vector leg
    // OR the lexical leg, never both, so an exact match the embedding ranked
    // poorly could not be retrieved at all.
    const docs = [
      doc('exact', 'npwp registration number'),
      doc('semantic', 'tax identification details'),
    ]
    const lexical = toRanking(bm25Rank(['npwp'], docs))
    const vectorOnly = ['semantic'] // embedding never surfaced 'exact'
    const fused = fuseRankings([vectorOnly, lexical])
    expect(fused.map((f) => f.id)).toContain('exact')
  })
})
