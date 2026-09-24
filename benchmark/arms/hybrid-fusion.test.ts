/**
 * Regression tests for the RRF head-dilution finding
 * (benchmark/results/retrieval-arms-decision.md §2b).
 *
 * WHY: with `RRF_K = 60`, one leg's rank 1 weighs 1/61 and another leg's rank 10
 * weighs 1/70 — a 15% gap. A document BOTH legs rank mid-list therefore outranks a
 * document a single leg ranks FIRST. Measured on the clean question set, that costs
 * the easy tier 0.43 absolute recall@10 (BM25 1.0000 vs the fused pipeline 0.5676),
 * which is the largest single effect this benchmark found.
 *
 * These tests pin the PROPERTY (a strong single-leg hit must not be buried by
 * cross-leg agreement) rather than the exact scores, so they stay meaningful if the
 * constant changes.
 */
import { describe, expect, test } from 'bun:test'
import { RRF_K, fuseRankings } from '@/lib/rag-ranking'

/** What a lone rank-1 hit from one leg scores. */
const loneRank1 = (k: number) => 1 / (k + 1)
/** What a document both legs place at `rank` scores. */
const agreedAt = (rank: number, k: number) => 2 / (k + rank)

describe('RRF_K = 60 dilutes the head', () => {
  test('at k=60, agreement at rank 40 beats a lone rank-1 hit', () => {
    // 2/100 = 0.0200 > 1/61 = 0.0164. This is the exact inversion measured live.
    expect(agreedAt(40, RRF_K)).toBeGreaterThan(loneRank1(RRF_K))
  })

  test('at k=1 the lone rank-1 hit wins instead', () => {
    expect(agreedAt(40, 1)).toBeLessThan(loneRank1(1))
  })

  test('the inversion is real in fuseRankings, not just in the arithmetic', () => {
    const answer = 'the-one-relevant-doc'
    const fillers = Array.from({ length: 80 }, (_, i) => `filler-${i}`)
    // Leg A (lexical): the answer is FIRST, and nothing else is close.
    const lexical = [answer, ...fillers]
    // Leg B (vector): the answer is ABSENT. The fillers occupy ranks 1-40, so a
    // filler both legs saw late still collects two contributions against the
    // answer's one.
    const vector = fillers.slice(0, 40)
    const agreedFiller = vector[vector.length - 1]

    const scoreOf = (fused: Array<{ id: string; score: number }>, id: string) =>
      fused.find((e) => e.id === id)!.score
    const fusedK60 = fuseRankings([vector, lexical], 60)
    const fusedK1 = fuseRankings([vector, lexical], 1)

    // The filler both legs ranked late still OUTSCORES the answer at k=60.
    expect(scoreOf(fusedK60, agreedFiller)).toBeGreaterThan(scoreOf(fusedK60, answer))
    // Lowering k restores the answer above that filler.
    expect(scoreOf(fusedK1, answer)).toBeGreaterThan(scoreOf(fusedK1, agreedFiller))
  })
})

describe('fuseRankings contract', () => {
  test('a document missing from a leg is not penalised, only unrewarded', () => {
    const fused = fuseRankings([['a'], []])
    expect(fused.map((e) => e.id)).toEqual(['a'])
  })

  test('is deterministic and order-stable for equal scores', () => {
    expect(fuseRankings([['a', 'b'], ['b', 'a']])).toEqual(fuseRankings([['a', 'b'], ['b', 'a']]))
  })

  test('no rankings yields no results rather than throwing', () => {
    expect(fuseRankings([])).toEqual([])
  })
})
