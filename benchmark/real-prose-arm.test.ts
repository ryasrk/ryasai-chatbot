/**
 * Tests for the Phase 3 real-prose runner.
 *
 * WHY: this runner's output is what decides whether the mechanism has any reach on
 * customer-shaped text, so its question builder must be shown not to leak the answer
 * location and not to accept sentences that cannot be asked about. A leak here would
 * make the coverage finding look better than it is.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildQuestions, coverageOf, extractiveQuestion, sentencesOf } from './real-prose-arm'

describe('sentencesOf', () => {
  test('splits on sentence enders and newlines, trimming whitespace', () => {
    expect(sentencesOf('Satu dua tiga. Empat lima enam!\nTujuh delapan sembilan?')).toEqual([
      'Satu dua tiga.', 'Empat lima enam!', 'Tujuh delapan sembilan?',
    ])
  })

  test('drops empty fragments rather than emitting blanks', () => {
    expect(sentencesOf('Satu.\n\n\nDua.')).toEqual(['Satu.', 'Dua.'])
  })
})

describe('extractiveQuestion', () => {
  const ok = 'Kebijakan pengadaan barang dan jasa menetapkan ambang batas nilai pengadaan tertentu.'

  test('builds a question for an ordinary declarative sentence', () => {
    const q = extractiveQuestion(ok, 0)
    expect(q).not.toBeNull()
    expect(q!.id).toBe('real-ext-0000')
    expect(q!.question.length).toBeGreaterThan(0)
  })

  test('never embeds the source document name — the origin must not be named', () => {
    // golden-set.ts puts the document name in every template; that makes the answer's
    // chunk findable by filename alone and would inflate both arms.
    const q = extractiveQuestion(ok, 0)!
    expect(q.question).not.toContain('Kebijakan')
    expect(q.question).not.toMatch(/\.(pdf|docx|txt)/i)
  })

  test('rejects sentences that are already questions', () => {
    expect(extractiveQuestion('Bagaimana prosedur pengadaan barang di perusahaan ini?', 0)).toBeNull()
    expect(extractiveQuestion('What is the procurement threshold for goods here?', 0)).toBeNull()
  })

  test('rejects fragments: too short, no terminator, or too few words', () => {
    expect(extractiveQuestion('Terlalu pendek.', 0)).toBeNull()
    expect(extractiveQuestion('Kalimat ini tidak diakhiri titik sehingga bukan kalimat utuh', 0)).toBeNull()
    expect(extractiveQuestion('Satu dua tiga empat lima.', 0)).toBeNull()
  })

  test('is deterministic for the same sentence and index', () => {
    expect(extractiveQuestion(ok, 7)).toEqual(extractiveQuestion(ok, 7))
  })
})

describe('buildQuestions', () => {
  const chunks = {
    'chunk-a': 'Kebijakan pengadaan barang dan jasa menetapkan ambang batas nilai pengadaan tertentu.',
    'chunk-b': 'Setiap karyawan memperoleh laptop dengan spesifikasi standar minimal enam belas gigabyte.',
  }

  test('points every question at the chunk its sentence came from', () => {
    const built = buildQuestions(chunks)
    expect(built.length).toBeGreaterThan(0)
    for (const { q, sourceChunkId } of built) {
      expect(q.evidenceDocIds).toEqual([sourceChunkId])
      expect(Object.keys(chunks)).toContain(sourceChunkId)
    }
  })

  test('assigns unique ids so a grader cannot double-count one question', () => {
    const built = buildQuestions(chunks)
    const ids = built.map((b) => b.q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('produces nothing from text with no usable sentence', () => {
    expect(buildQuestions({ x: 'ringkasan' })).toEqual([])
  })
})

describe('coverageOf', () => {
  test('reports the share of documents where a hop is even possible', () => {
    const c = coverageOf({
      a: 'Delivery DL-106 reached W-01 under batch B-0001.',
      b: 'No identifiers appear in this sentence at all, only plain prose words.',
    })
    expect(c.documents).toBe(2)
    expect(c.withEntity).toBe(1)
    expect(c.coverageShare).toBe(0.5)
    expect(c.meanEntitiesPerDoc).toBeGreaterThan(0)
  })

  test('is zero, not NaN, on a corpus with no extractable entities', () => {
    const c = coverageOf({ a: 'plain lowercase prose with nothing to extract' })
    expect(c.withEntity).toBe(0)
    expect(c.coverageShare).toBe(0)
    expect(c.distinctEntities).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The Phase 3 finding itself. These pin the DIRECTION, not the exact values, so a
// regression that flips the conclusion fails here rather than being discovered by
// re-reading a report.
// ---------------------------------------------------------------------------
describe('real-prose result is recorded, and its direction is pinned', () => {
  const result = JSON.parse(
    readFileSync(new URL('./results/real-prose-arm.json', import.meta.url), 'utf8'),
  ) as {
    coverage: { documents: number; coverageShare: number; meanEntitiesPerDoc: number }
    rows: Array<{ arm: string; ready: boolean; recall10: number | null; mrr: number | null }>
  }
  const row = (arm: string) => result.rows.find((r) => r.arm === arm)!

  test('entity coverage on real prose is recorded AND low', () => {
    // The mechanism can only hop where an entity exists. If a future extraction change
    // raises this, the Phase 3 conclusion must be revisited rather than assumed.
    expect(result.coverage.documents).toBeGreaterThan(50)
    expect(result.coverage.coverageShare).toBeLessThan(0.25)
  })

  test('the comparison is computable, so the numbers are not NOT COMPUTABLE placeholders', () => {
    for (const arm of ['bm25-baseline', 'lexical-first-hybrid', 'entity-hop']) {
      expect(row(arm).ready).toBe(true)
      expect(row(arm).recall10).not.toBeNull()
      expect(row(arm).mrr).not.toBeNull()
    }
  })

  test('Entity-Hop is NOT better than the production ranking on real prose (gate 3 direction)', () => {
    const p2 = row('lexical-first-hybrid')
    const hop = row('entity-hop')
    expect(hop.recall10!).toBeLessThanOrEqual(p2.recall10!)
    expect(hop.mrr!).toBeLessThanOrEqual(p2.mrr!)
  })

  test('the SHIPPED ranking matches the best keyword baseline instead of losing to it', () => {
    // This assertion is INVERTED from the Phase 3 finding it replaces, deliberately and
    // on the recorded direction, exactly as that test's own comment required ("If fusion
    // is ever fixed, this flips and the report must be updated deliberately").
    //
    // Phase 3 measured RRF fusion LOSING to plain keyword search (answer@1 0.4628 vs
    // 0.9504). That is why production now ships lexical-first with a term-frequency,
    // hyphen-preserving tokenizer (docs/retrieval-production-integration-plan.md §12):
    // `lexical-first-hybrid` in this file is that shipping arm, so the equality below is the
    // product matching the best baseline while still admitting vector-only candidates,
    // not the product merely tying a straw man.
    const bm25 = row('bm25-baseline')
    const shipped = row('lexical-first-hybrid')
    expect(shipped.recall10!).toBeGreaterThanOrEqual(bm25.recall10!)
    expect(shipped.mrr!).toBeGreaterThanOrEqual(bm25.mrr!)
    // The regression this replaced must not come back: the RRF variant, which the
    // comparison harness still grades even though production no longer ships it.
    const rrf = row('lexical-first-hybrid-k60')
    if (rrf?.ready) expect(rrf.mrr!).toBeLessThan(shipped.mrr!)
  })
})
