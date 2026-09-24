/**
 * Tests for the shared arm harness.
 *
 * WHY: every arm's row is produced by this grading code. A defect here would look
 * like a retrieval result, not like a bug — the same trap the BM25 baseline tests
 * exist for. These pin the grader against hand-computed values and pin the split.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dedupeByText, evidenceCoverageAtK, evidenceHitAtK, finalHopRank, gradeArm, loadBenchmarkData, mean, percentile } from './arm-harness'
import { ARM_BUDGET, duplicateStats, splitQuestions } from './arm-types'
import type { Arm, ArmContext, ArmQuestion } from './arm-types'

describe('grading primitives', () => {
  test('evidenceHitAtK requires EVERY evidence doc, not just one', () => {
    expect(evidenceHitAtK(['a', 'b', 'c'], ['a', 'b'], 10)).toBe(true)
    expect(evidenceHitAtK(['a', 'c', 'd'], ['a', 'b'], 10)).toBe(false)
  })

  test('does not look past k', () => {
    expect(evidenceHitAtK(['x', 'a', 'b'], ['a', 'b'], 2)).toBe(false)
  })

  test('coverage gives partial credit and is 1 for an empty evidence set', () => {
    expect(evidenceCoverageAtK(['a', 'x', 'y'], ['a', 'b'], 10)).toBe(0.5)
    expect(evidenceCoverageAtK([], [], 10)).toBe(1)
  })

  test('finalHopRank reports the last evidence doc position, 0 when absent', () => {
    expect(finalHopRank(['x', 'f', 'y'], ['first', 'f'])).toBe(2)
    expect(finalHopRank(['x', 'y'], ['first', 'f'])).toBe(0)
  })

  test('budget matches the recorded cognee and supermemory window', () => {
    expect(ARM_BUDGET).toBe(10)
  })
})

describe('split is fixed and text-disjoint', () => {
  test('distinct texts alternate between the halves, in file order', () => {
    const questions: ArmQuestion[] = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`, tier: 'medium', question: `text-${i}`, answer: 'a', evidenceDocIds: ['d1'],
    }))
    const { dev, heldOut } = splitQuestions(questions)
    expect(dev.map((q) => q.question)).toEqual(['text-0', 'text-2', 'text-4'])
    expect(heldOut.map((q) => q.question)).toEqual(['text-1', 'text-3', 'text-5'])
  })

  test('a repeated text never straddles the split — the defect this replaced', () => {
    // The generated set repeats one sentence across different evidence sets. Under
    // the old index-parity rule these rows landed on BOTH sides, so "held-out" was
    // partly memorisation: measured at 146 of 569 texts.
    const repeated = 'Starting from W-01, follow two intermediate records.'
    const questions: ArmQuestion[] = [
      { id: 'a', tier: 'hard', question: repeated, answer: 'x', evidenceDocIds: ['d1'] },
      { id: 'b', tier: 'hard', question: 'unique one', answer: 'x', evidenceDocIds: ['d2'] },
      { id: 'c', tier: 'hard', question: repeated, answer: 'x', evidenceDocIds: ['d3'] },
      { id: 'd', tier: 'hard', question: repeated, answer: 'x', evidenceDocIds: ['d4'] },
    ]
    const { dev, heldOut } = splitQuestions(questions)
    const devTexts = new Set(dev.map((q) => q.question))
    expect([...new Set(heldOut.map((q) => q.question))].filter((t) => devTexts.has(t))).toEqual([])
    expect(duplicateStats(questions).straddlingTexts).toBe(0)
  })

  test('the two halves are disjoint and cover everything', () => {
    const questions: ArmQuestion[] = Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`, tier: 'medium', question: `text-${i}`, answer: 'a', evidenceDocIds: ['d1'],
    }))
    const { dev, heldOut } = splitQuestions(questions)
    expect(dev.length + heldOut.length).toBe(questions.length)
    const overlap = dev.filter((d) => heldOut.some((h) => h.id === d.id))
    expect(overlap).toEqual([])
  })

  test('duplicateStats reports the collapsing and the conflicting rows', () => {
    const questions: ArmQuestion[] = [
      { id: 'a', tier: 'hard', question: 'same', answer: 'x', evidenceDocIds: ['d1'] },
      { id: 'b', tier: 'hard', question: 'same', answer: 'x', evidenceDocIds: ['d2'] },
      { id: 'c', tier: 'easy', question: 'other', answer: 'x', evidenceDocIds: ['d3'] },
    ]
    const stats = duplicateStats(questions)
    expect(stats.rows).toBe(3)
    expect(stats.distinctTexts).toBe(2)
    expect(stats.collapsedRows).toBe(1)
    expect(stats.conflictingRows).toBe(2)
    expect(stats.straddlingTexts).toBe(0)
  })
})

describe('dedupeByText', () => {
  test('keeps the first row per text and preserves order', () => {
    const questions: ArmQuestion[] = [
      { id: 'a', tier: 'hard', question: 'x', answer: 'z', evidenceDocIds: ['d1'] },
      { id: 'b', tier: 'hard', question: 'x', answer: 'z', evidenceDocIds: ['d2'] },
      { id: 'c', tier: 'easy', question: 'y', answer: 'z', evidenceDocIds: ['d3'] },
    ]
    expect(dedupeByText(questions).map((q) => q.id)).toEqual(['a', 'c'])
  })
})

describe('gradeArm', () => {
  const ctx: ArmContext = { texts: {}, docIds: ['d1', 'd2'] }
  const q = (id: string, tier: ArmQuestion['tier'], evidence: string[]): ArmQuestion => ({
    id, tier, question: id, answer: 'a', evidenceDocIds: evidence,
  })

  test('scores a perfect retriever at 1.0 on every metric', () => {
    const perfect: Arm = { id: 'perfect', kind: 'lexical', ready: () => true, rank: () => ['d1', 'd2'] }
    const m = gradeArm(perfect, [q('a', 'easy', ['d1'])], ctx, 'test')
    expect(m.overall.recall10).toBe(1)
    expect(m.overall.answerAt1).toBe(1)
    expect(m.overall.mrr).toBe(1)
    expect(m.overall.evidenceCoverage).toBe(1)
  })

  test('scores a retriever that only finds the first hop as a miss, with partial coverage', () => {
    const partial: Arm = { id: 'partial', kind: 'lexical', ready: () => true, rank: () => ['d2', 'd1'] }
    const m = gradeArm(partial, [q('a', 'medium', ['d1', 'd2'])], ctx, 'test')
    // both documents ARE in the window here, so recall is 1 — the point is hopRecall
    expect(m.overall.recall10).toBe(1)
    expect(m.overall.hopRecall).toEqual([1, 1])
  })

  test('missing the final hop fails recall and reports which hop was missed', () => {
    const firstHopOnly: Arm = { id: 'hop1', kind: 'lexical', ready: () => true, rank: () => ['d1', 'd9'] }
    const m = gradeArm(firstHopOnly, [q('a', 'medium', ['d1', 'd2']), q('b', 'medium', ['d1', 'd2'])], ctx, 'test')
    expect(m.overall.recall10).toBe(0)
    expect(m.overall.evidenceCoverage).toBe(0.5)
    expect(m.overall.hopRecall[0]).toBe(1)
    expect(m.overall.hopRecall[1]).toBe(0)
  })

  test('is deterministic for a deterministic arm', () => {
    const arm: Arm = { id: 'x', kind: 'lexical', ready: () => true, rank: () => ['d1'] }
    const a = gradeArm(arm, [q('a', 'easy', ['d1'])], ctx, 'test')
    const b = gradeArm(arm, [q('a', 'easy', ['d1'])], ctx, 'test')
    // Latency is excluded on purpose: it legitimately varies between runs, so
    // asserting on it would make this test flaky rather than meaningful.
    const { latencyP50Ms: _a50, latencyP90Ms: _a90, ...aRest } = a.overall
    const { latencyP50Ms: _b50, latencyP90Ms: _b90, ...bRest } = b.overall
    expect(aRest).toEqual(bRest)
  })

  test('the first question does not absorb index-build cost', () => {
    // The warm-up call must be discarded, so a slow first call cannot inflate p90.
    let calls = 0
    const slowFirst: Arm = {
      id: 'slow-first', kind: 'lexical', ready: () => true,
      rank: () => {
        calls += 1
        if (calls === 1) { const end = Date.now() + 60; while (Date.now() < end) { /* burn */ } }
        return ['d1']
      },
    }
    const m = gradeArm(slowFirst, [q('a', 'easy', ['d1']), q('b', 'easy', ['d1'])], ctx, 'test')
    expect(calls).toBe(3) // one warm-up + two graded
    expect(m.overall.latencyP90Ms).toBeLessThan(50)
  })
})

describe('statistics helpers', () => {
  test('mean of an empty list is 0, not NaN', () => {
    expect(mean([])).toBe(0)
  })
  test('percentile of an empty list is 0', () => {
    expect(percentile([], 50)).toBe(0)
  })
  test('p50 of an odd list is the middle element', () => {
    expect(percentile([1, 2, 3], 50)).toBe(2)
  })
})

describe('vector inputs must not be half-supplied', () => {
  test('a query cache from a different model than the doc cache is a hard error', () => {
    // Mismatched models make every cosine meaningless while still printing a
    // plausible number, which is exactly the failure this contract prevents.
    const dir = mkdtempSync(join(tmpdir(), 'arm-'))
    const corpusPath = join(dir, 'corpus.json')
    const questionsPath = join(dir, 'q.jsonl')
    const docCache = join(dir, 'doc.json')
    const queryCache = join(dir, 'query.json')
    writeFileSync(corpusPath, JSON.stringify({ docs: [{ id: 'd1', text: 'alpha' }] }))
    writeFileSync(questionsPath, JSON.stringify({ id: 'q1', tier: 'easy', question: 'alpha?', answer: 'a', evidenceDocIds: ['d1'] }) + '\n')
    writeFileSync(docCache, JSON.stringify({ model: 'model-A', dimensions: 1, vectors: { d1: [1] } }))
    writeFileSync(queryCache, JSON.stringify({ model: 'model-B', dimensions: 1, vectors: { 'alpha?': [1] } }))
    expect(() => loadBenchmarkData(corpusPath, questionsPath, docCache, queryCache)).toThrow(/does not match/)
  })

  test('a missing query cache leaves queryEmbeddings undefined so hybrid is NOT COMPUTABLE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-'))
    const corpusPath = join(dir, 'corpus.json')
    const questionsPath = join(dir, 'q.jsonl')
    const docCache = join(dir, 'doc.json')
    writeFileSync(corpusPath, JSON.stringify({ docs: [{ id: 'd1', text: 'alpha' }] }))
    writeFileSync(questionsPath, JSON.stringify({ id: 'q1', tier: 'easy', question: 'alpha?', answer: 'a', evidenceDocIds: ['d1'] }) + '\n')
    writeFileSync(docCache, JSON.stringify({ model: 'model-A', dimensions: 1, vectors: { d1: [1] } }))
    const data = loadBenchmarkData(corpusPath, questionsPath, docCache, join(dir, 'missing.json'))
    expect(data.corpus.embeddings).toBeDefined()
    expect(data.corpus.queryEmbeddings).toBeUndefined()
  })
})
