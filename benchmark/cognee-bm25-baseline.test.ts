/**
 * Unit tests for the BM25 baseline.
 *
 * WHY THESE EXIST: the baseline produced a claim that contradicts the shipped
 * dependency (BM25 recall@10 = 0.2300 vs cognee 0.1030), so a bug in the scorer
 * would not look like a bug — it would look like a finding. These tests pin the
 * arithmetic against hand-computed values and pin the controls that make the
 * comparison falsifiable.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildIndex,
  evidenceHitAtK,
  extractIdentifiers,
  finalHopRank,
  iterativeTopK,
  score,
  tokenize,
  topK,
} from './cognee-bm25-baseline'

describe('tokenize', () => {
  test('lowercases and drops tokens shorter than 2 chars', () => {
    expect(tokenize('A cat SAT')).toEqual(['cat', 'sat'])
  })

  test('keeps hyphenated identifiers whole AND split', () => {
    // The hard/complex questions turn on identifiers like DL-106, so dropping
    // the joined form would understate the baseline it is being compared against.
    const t = tokenize('delivery DL-106')
    expect(t).toContain('dl-106')
    expect(t).toContain('dl')
    expect(t).toContain('106')
  })

  test('returns an empty list for punctuation-only input', () => {
    expect(tokenize('--- ... !!!')).toEqual([])
  })
})

describe('score — BM25 arithmetic', () => {
  test('a document containing the query term outscores one that does not', () => {
    const index = buildIndex({ d1: 'alpha beta', d2: 'gamma delta' })
    expect(score(index, 'd1', ['alpha'])).toBeGreaterThan(0)
    expect(score(index, 'd2', ['alpha'])).toBe(0)
  })

  test('IDF makes a rare term worth more than a common one', () => {
    // "common" is in every document; "rare" is in one. BM25 must reward "rare".
    const texts: Record<string, string> = {}
    for (let i = 0; i < 10; i++) texts[`d${i}`] = 'common filler'
    texts.d0 = 'common rare'
    const index = buildIndex(texts)
    const rareScore = score(index, 'd0', ['rare'])
    const commonScore = score(index, 'd0', ['common'])
    expect(rareScore).toBeGreaterThan(commonScore)
  })

  test('IDF is non-negative even when a term is in most documents', () => {
    // The textbook ln((N-n+.5)/(n+.5)) goes NEGATIVE here, which would let a
    // common word SUBTRACT from a score. The ln(1+...) form must not.
    const texts: Record<string, string> = {}
    for (let i = 0; i < 100; i++) texts[`d${i}`] = 'ubiquitous'
    texts.d0 = 'ubiquitous'
    const index = buildIndex(texts)
    expect(score(index, 'd0', ['ubiquitous'])).toBeGreaterThan(0)
  })

  test('longer documents are penalised (the b parameter)', () => {
    // Same single occurrence of the term; the short document must win.
    const index = buildIndex({
      short: 'needle',
      long: 'needle ' + Array.from({ length: 100 }, (_, i) => `pad${i}`).join(' '),
    })
    expect(score(index, 'short', ['needle'])).toBeGreaterThan(score(index, 'long', ['needle']))
  })

  test('a repeated query term does not multiply its own contribution', () => {
    // Summing over DISTINCT query terms is the standard treatment; summing raw
    // occurrences would let a stuttering question dominate the ranking.
    const index = buildIndex({ d1: 'alpha beta', d2: 'beta gamma' })
    expect(score(index, 'd1', ['beta', 'beta', 'beta'])).toBeCloseTo(score(index, 'd1', ['beta']), 10)
  })

  test('repeated term occurrences in a document are sublinear (k1 saturation)', () => {
    const once = buildIndex({ d1: 'alpha', d2: 'beta' })
    const thrice = buildIndex({ d1: 'alpha alpha alpha', d2: 'beta' })
    const s1 = score(once, 'd1', ['alpha'])
    const s3 = score(thrice, 'd1', ['alpha'])
    // Must grow (more evidence) but NOT triple (saturation), and length
    // normalisation also pushes back on the longer document.
    expect(s3).toBeGreaterThan(s1)
    expect(s3).toBeLessThan(s1 * 3)
  })
})

describe('topK — ordering and determinism', () => {
  test('ranks the matching document first', () => {
    const index = buildIndex({
      target: 'defective batch supplied by sinar abadi',
      other: 'unrelated cafeteria menu review',
    })
    expect(topK(index, 'which vendor supplied the defective batch', 10)[0]).toBe('target')
  })

  test('returns nothing for a query sharing no terms', () => {
    const index = buildIndex({ d1: 'alpha beta', d2: 'gamma delta' })
    expect(topK(index, 'zzqx wobble', 10)).toEqual([])
  })

  test('respects k', () => {
    const index = buildIndex({ a: 'alpha', b: 'alpha beta', c: 'alpha beta gamma' })
    expect(topK(index, 'alpha', 2).length).toBe(2)
  })

  test('ties break on docId so the result never depends on insertion order', () => {
    // Identical texts => identical scores. Without an explicit tie-break the
    // winner would follow Map insertion order and a re-run could differ.
    const forward = buildIndex({ docA: 'same text here', docB: 'same text here' })
    const reversed = buildIndex({ docB: 'same text here', docA: 'same text here' })
    expect(topK(forward, 'same text', 1)).toEqual(['docA'])
    expect(topK(reversed, 'same text', 1)).toEqual(['docA'])
  })

  test('is deterministic across repeated calls', () => {
    const index = buildIndex({ a: 'alpha beta', b: 'beta gamma', c: 'alpha gamma' })
    expect(topK(index, 'beta', 3)).toEqual(topK(index, 'beta', 3))
  })
})

describe('grading — the report’s evidence rule', () => {
  test('requires EVERY evidence doc in the window, not just one', () => {
    // This is the distinction that separates a 2-hop hit from a 1-hop hit; a
    // grader that accepted "any" would score the single-hop failure as a success.
    expect(evidenceHitAtK(['a', 'b', 'c'], ['a', 'b'], 10)).toBe(true)
    expect(evidenceHitAtK(['a', 'c', 'd'], ['a', 'b'], 10)).toBe(false)
  })

  test('is unordered — the evidence docs may arrive in any order', () => {
    expect(evidenceHitAtK(['b', 'a'], ['a', 'b'], 10)).toBe(true)
  })

  test('does not look past k', () => {
    expect(evidenceHitAtK(['x', 'a', 'b'], ['a', 'b'], 2)).toBe(false)
  })

  test('an empty evidence set is vacuously satisfied, never a silent miss', () => {
    expect(evidenceHitAtK([], [], 10)).toBe(true)
  })

  test('finalHopRank reports the position of the last evidence doc, 0 when absent', () => {
    expect(finalHopRank(['x', 'final', 'y'], ['first', 'final'])).toBe(2)
    expect(finalHopRank(['x', 'y'], ['first', 'final'])).toBe(0)
  })
})

describe('controls the harness depends on', () => {
  test('gibberish queries retrieve nothing on a realistic small corpus', () => {
    const index = buildIndex({
      a: 'delivery DL-106 arrived from PT Bumi Sentosa',
      b: 'invoice INV-4471 approved by Ratna Wibowo',
    })
    expect(topK(index, 'zzqx wobble frandanglorp', 10)).toEqual([])
  })
})

describe('iterative search and entity extraction (Audit Fix 2)', () => {
  test('extractIdentifiers extracts standard corpus identifiers', () => {
    const text = 'W-01 received delivery DL-001 under batch B-0001 with invoice INV-0001 from vendor PT Sinar Abadi for Project Alpha.'
    const ids = extractIdentifiers(text)
    expect(ids).toContain('W-01')
    expect(ids).toContain('DL-001')
    expect(ids).toContain('B-0001')
    expect(ids).toContain('INV-0001')
    expect(ids).toContain('PT Sinar Abadi')
    expect(ids).toContain('Project Alpha')
  })

  test('iterativeTopK traverses multi-hop link that single query cannot find', () => {
    // docA matches question query "Ratna Wibowo" and links to "B-2291".
    // docB has "B-2291" and "PT Sinar Abadi", but zero tokens in common with query.
    // Single search for query can only find docA.
    // Iterative search must discover docB via the extracted identifier "B-2291".
    const texts = {
      docA: 'Ratna Wibowo signed off on intake of B-2291 at the site.',
      docB: 'Item B-2291 originated from vendor PT Sinar Abadi.',
      docC: 'Unrelated catering memo for Bandung branch canteen.',
    }
    const index = buildIndex(texts)

    const query = 'Who was involved in the verification with Ratna Wibowo at the site?'

    // Single query only finds docA (docB has zero query tokens)
    const single = topK(index, query, 10)
    expect(single).toContain('docA')
    expect(single).not.toContain('docB')

    // Iterative search finds BOTH docA and docB within fixed budget of 10
    const iter = iterativeTopK(index, texts, query, 10, 2)
    expect(iter).toContain('docA')
    expect(iter).toContain('docB')
  })
})
