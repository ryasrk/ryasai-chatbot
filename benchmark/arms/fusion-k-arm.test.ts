/**
 * Tests for the `k` sweep arm.
 *
 * The sweep's output is quoted in the production-integration plan, so its arm must be
 * shown to (a) actually use the `k` it is named for, and (b) refuse to produce a hybrid
 * number when the vector leg is unavailable — otherwise a lexically-computed row would be
 * reported as a hybrid score and would understate every comparison.
 */
import { describe, expect, test } from 'bun:test'
import type { ArmContext } from '../arm-types'
import { FUSION_K_CANDIDATES, SHIPPED_K, makeFusionKArm } from './fusion-k-arm'
import { RRF_K, bm25Rank, fuseRankings, toRanking } from '@/lib/rag-ranking'
import { tokenize } from '@/lib/rag'

// A corpus where the two legs DISAGREE, so the fused order depends on `k`:
//   vector leg: v-only (1st), shared (2nd), v2 (3rd)
//   lexical leg: shared (1st) and nothing else strong
// At a low k, rank positions dominate; at a high k the curve flattens.
const ctx: ArmContext = {
  docIds: ['v-only', 'shared', 'v2', 'other'],
  texts: {
    'v-only': 'zebra zebra zebra',
    shared: 'invoices invoices invoices',
    v2: 'quartz',
    other: 'unrelated filler text about nothing in particular',
  },
  embeddings: {
    'v-only': [1, 0, 0],
    shared: [0.9, 0.1, 0],
    v2: [0.8, 0.2, 0],
    other: [0, 0, 1],
  },
  embeddingModel: 'test-model',
  queryEmbeddings: { 'invoices zebra': [1, 0, 0] },
  queryEmbeddingModel: 'test-model',
}

const QUESTION = 'invoices zebra'

describe('the sweep arm uses the k it is named for', () => {
  test('the id names the value, so a harness table is self-describing', () => {
    expect(makeFusionKArm(1).id).toBe('hybrid-rrf-k1')
    expect(makeFusionKArm(60).id).toBe('hybrid-rrf-k60')
  })

  test('the shipped default is one of the swept candidates', () => {
    // A sweep that omits its own baseline cannot report a delta against it.
    expect(FUSION_K_CANDIDATES).toContain(SHIPPED_K)
    expect(SHIPPED_K).toBe(RRF_K)
  })

  test('candidates bracket the regimes rather than searching finely', () => {
    expect(FUSION_K_CANDIDATES[0]).toBe(1) // lowest legal value: pure 1/rank
    expect(Math.max(...FUSION_K_CANDIDATES)).toBeGreaterThanOrEqual(200) // near-flat
    // Ascending and unique, so a printed table reads in order and no row is duplicated.
    const sorted = [...FUSION_K_CANDIDATES].sort((a, b) => a - b)
    expect(sorted).toEqual(FUSION_K_CANDIDATES)
    expect(new Set(FUSION_K_CANDIDATES).size).toBe(FUSION_K_CANDIDATES.length)
  })

  test('every candidate produces a full, deduplicated ranking within budget', () => {
    for (const k of FUSION_K_CANDIDATES) {
      const ranked = makeFusionKArm(k).rank(QUESTION, ctx, 4)
      expect(ranked.length).toBeLessThanOrEqual(4)
      expect(new Set(ranked).size).toBe(ranked.length)
      for (const id of ranked) expect(ctx.docIds).toContain(id)
    }
  })

  test('changing k REORDERS the head — the mechanism, not just the plumbing', () => {
    // The fixture is built so the two regimes genuinely disagree, and the legs were
    // verified numerically before this assertion was written (a first attempt asserted an
    // inversion its own fixture could not produce, and the failure was the TEST's, not the
    // arm's):
    //   vector leg : A first (closest to the query), then B
    //   lexical leg: L1..L4 (heavy term overlap), then B, and A NOT AT ALL
    // Measured fuseRankings output:
    //   k=1  → A at rank 3, B at rank 4
    //   k=60 → A at rank 6, B at rank 3     (cross-leg agreement overtakes the head)
    // A k-parameterised arm that returns the same order at both ends is measuring nothing.
    const docs = [
      { id: 'L1', tokens: tokenize('invoices zebra zebra zebra zebra zebra zebra zebra zebra') },
      { id: 'L2', tokens: tokenize('invoices zebra zebra zebra zebra zebra zebra zebra') },
      { id: 'L3', tokens: tokenize('invoices zebra zebra zebra zebra zebra zebra') },
      { id: 'L4', tokens: tokenize('invoices zebra zebra zebra zebra zebra') },
      { id: 'B', tokens: tokenize('invoices zebra') },
      { id: 'A', tokens: tokenize('quantum') },
    ]
    const vectorLeg = ['A', 'B', 'L1', 'L2', 'L3', 'L4']
    // Assert the fixture's premise rather than assuming it: A must be ABSENT from the
    // lexical leg, or its single-leg rank-1 bonus would not be single-leg at all.
    const lexicalLeg = toRanking(bm25Rank(tokenize('invoices zebra'), docs))
    expect(lexicalLeg).not.toContain('A')
    expect(lexicalLeg).toContain('B')

    const posOf = (rankings: string[][], k: number, id: string) =>
      toRanking(fuseRankings(rankings, k)).indexOf(id) + 1

    const aAt1 = posOf([vectorLeg, lexicalLeg], 1, 'A')
    const aAt60 = posOf([vectorLeg, lexicalLeg], 60, 'A')
    const bAt1 = posOf([vectorLeg, lexicalLeg], 1, 'B')
    const bAt60 = posOf([vectorLeg, lexicalLeg], 60, 'B')

    expect(aAt1).toBeLessThan(aAt60) // the head weakens for a lone strong hit as k flattens
    expect(bAt60).toBeLessThan(bAt1) // cross-leg agreement gains as k flattens
  })
})

describe('the arm refuses to report a hybrid number without the vector leg', () => {
  test('no query vector for the question THROWS rather than scoring lexically', () => {
    // A silent lexical fallback would be printed as a hybrid row and would understate the
    // comparison — the failure mode this arm's `ready()` and throw both exist to prevent.
    expect(() => makeFusionKArm(60).rank('a question not in the cache', ctx, 4)).toThrow(/no query vector/)
  })

  test('ready() is false without embeddings, so a harness reports NOT COMPUTABLE', () => {
    const lexicalOnly: ArmContext = { docIds: ctx.docIds, texts: ctx.texts }
    expect(makeFusionKArm(60).ready(lexicalOnly)).toBe(false)
    expect(makeFusionKArm(60).ready(ctx)).toBe(true)
  })
})
