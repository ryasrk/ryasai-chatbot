/**
 * Tests for arm P2 (benchmark/arms/hybrid-arm.ts).
 *
 * WHY: the arm's row is what decides whether the Entity-Hop plan has room to win,
 * so a defect here looks like a finding about retrieval rather than a bug. These
 * pin the two legs separately (a document only the vector leg can find, a document
 * only the lexical leg can find), the NOT COMPUTABLE gate, the budget, and
 * determinism. No real embedding cache is read: every context below is hand-built.
 */
import { describe, expect, test } from 'bun:test'
import type { ArmContext } from '../arm-types'
import { arm } from './hybrid-arm'

/**
 * 5 documents, 4 dims. Axes: 0 = dock, 1 = vendor, 2 = invoice, 3 = leisure.
 * The texts are deliberately shaped so each required behaviour needs one leg:
 * `d3` shares no query token with the dock question (vector-only), `d2` carries
 * the literal id the question names (lexical-only).
 */
const texts: Record<string, string> = {
  d1: 'dock intake schedule berth allocation for containers',
  d2: 'vendor master record PT Bumi Sentosa registered DL-106',
  d3: 'quay side container unloading window at the terminal apron',
  d4: 'leisure package holiday resort vouchers and tourism',
  d5: 'invoice settlement terms for posted deliveries',
}
const docIds = ['d1', 'd2', 'd3', 'd4', 'd5']

/** A vector, given as axis weights (unit-scaled by the arm). */
function vec(weights: Record<number, number>): number[] {
  const v = [0, 0, 0, 0]
  for (const [axis, weight] of Object.entries(weights)) v[Number(axis)] = weight
  return v
}

const embeddings: Record<string, number[]> = {
  d1: vec({ 0: 1, 1: 0.2 }),
  d2: vec({ 1: 1, 2: 0.3 }),
  d3: vec({ 0: 0.95, 2: 0.1 }),
  d4: vec({ 3: 1 }),
  d5: vec({ 2: 1, 3: 0.1 }),
}

const ctx: ArmContext = { texts, docIds, embeddings }

describe('vector leg', () => {
  test('a document findable only by vector similarity is retrieved', () => {
    // The question shares NO token with any document ("space/availability/wharf/
    // time/slot" against the five texts below), so the lexical leg returns nothing
    // and only cosine can place anything. d3's vector is the dock axis.
    const question = 'space availability for a wharf time slot'
    const withVectors: ArmContext = {
      ...ctx,
      queryEmbeddings: { [question]: vec({ 0: 1, 2: 0.05 }) },
    }
    const ranked = arm.rank(question, withVectors, 5)
    expect(ranked).toContain('d3')
    expect(ranked[0]).toBe('d3')

    // Same question, no vector leg available at all => the arm refuses to run.
    expect(arm.ready(ctx)).toBe(false)
  })

  test('a near-orthogonal query does not put the far document first', () => {
    const question = 'tourism vouchers'
    const withVectors: ArmContext = {
      ...ctx,
      queryEmbeddings: { [question]: vec({ 3: 1 }) },
    }
    expect(arm.rank(question, withVectors, 1)[0]).toBe('d4')
  })

  test('a query vector of the wrong width is refused, not truncated', () => {
    // This question shares no token with any document, so the lexical leg is
    // empty and the vector leg is the only route to a result. That isolates the
    // width check: scoring a truncated dot product would still return documents.
    const question = 'space availability for a wharf time slot'
    const rightWidth: ArmContext = { ...ctx, queryEmbeddings: { [question]: vec({ 0: 1 }) } }
    const wrongWidth: ArmContext = { ...ctx, queryEmbeddings: { [question]: [1, 0, 0] } }
    expect(arm.rank(question, rightWidth, 5).length).toBeGreaterThan(0)
    expect(arm.rank(question, wrongWidth, 5)).toEqual([])
  })
})

describe('lexical leg', () => {
  test('a query whose answer is only findable lexically returns that doc', () => {
    // The literal id appears in d2's text and nowhere else. The query vector is
    // deliberately aimed at the leisure axis, so the vector leg cannot supply it.
    const question = 'which record covers DL-106'
    const withVectors: ArmContext = {
      ...ctx,
      queryEmbeddings: { [question]: vec({ 3: 1 }) },
    }
    expect(arm.rank(question, withVectors, 5)).toContain('d2')
  })
})

describe('readiness', () => {
  test('ready() is false when ctx.embeddings is absent', () => {
    expect(arm.ready({ texts, docIds })).toBe(false)
  })

  test('ready() is false when ctx.queryEmbeddings is absent', () => {
    expect(arm.ready(ctx)).toBe(false)
  })

  test('ready() is false when either map is empty, not merely undefined', () => {
    expect(arm.ready({ ...ctx, embeddings: {} })).toBe(false)
    expect(arm.ready({ ...ctx, queryEmbeddings: {} })).toBe(false)
  })

  test('ready() is true with both legs present', () => {
    expect(arm.ready({ ...ctx, queryEmbeddings: { q: vec({ 0: 1 }) } })).toBe(true)
  })

  test('a question missing from the query cache throws instead of degrading', () => {
    const withVectors: ArmContext = { ...ctx, queryEmbeddings: { 'other question': vec({ 0: 1 }) } }
    expect(() => arm.rank('dock container', withVectors, 5)).toThrow(/no query vector/)
  })
})

describe('shape and determinism', () => {
  const question = 'dock intake schedule and berth'
  const withVectors: ArmContext = {
    ...ctx,
    queryEmbeddings: { [question]: vec({ 0: 1, 1: 0.3 }) },
  }

  test('the returned list respects budget', () => {
    for (const budget of [1, 2, 3, 10]) {
      expect(arm.rank(question, withVectors, budget).length).toBeLessThanOrEqual(budget)
    }
    expect(arm.rank(question, withVectors, 3)).toHaveLength(3)
  })

  test('ids are unique and drawn from the corpus', () => {
    const ranked = arm.rank(question, withVectors, 10)
    expect(new Set(ranked).size).toBe(ranked.length)
    for (const id of ranked) expect(docIds).toContain(id)
  })

  test('two calls give identical arrays', () => {
    const first = arm.rank(question, withVectors, 10)
    const second = arm.rank(question, withVectors, 10)
    expect(second).toEqual(first)
  })

  test('a fresh context object with the same content gives the same ranking', () => {
    // Guards the WeakMap index cache: a cache keyed on something unstable, or one
    // that leaked across contexts, would show up here as an order change.
    const clone: ArmContext = {
      texts: { ...texts },
      docIds: [...docIds],
      embeddings: Object.fromEntries(Object.entries(embeddings).map(([k, v]) => [k, [...v]])),
      queryEmbeddings: { [question]: vec({ 0: 1, 1: 0.3 }) },
    }
    expect(arm.rank(question, clone, 10)).toEqual(arm.rank(question, withVectors, 10))
  })

  test('the arm reports the id and kind the harness registry expects', () => {
    expect(arm.id).toBe('hybrid-rrf')
    expect(arm.kind).toBe('hybrid')
  })
})
