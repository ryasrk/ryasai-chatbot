/**
 * Tests for the Phase 3 real-prose runner.
 *
 * WHY: this runner's output is what decides whether the mechanism has any reach on
 * customer-shaped text, so its question builder must be shown not to leak the answer
 * location and not to accept sentences that cannot be asked about. A leak here would
 * make the coverage finding look better than it is.
 */
import { describe, expect, test } from 'bun:test'
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
