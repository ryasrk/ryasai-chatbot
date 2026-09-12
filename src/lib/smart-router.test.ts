import { describe, expect, test } from 'bun:test'
import { tokenize, keywordOverlap } from './smart-router'

// ponytail: test pure functions only — DB-backed functions need integration test infra.

describe('smart-router tokenize', () => {
  test('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Stok produk GUDANG')).toEqual(['stok', 'produk', 'gudang'])
  })

  test('drops single chars but keeps 2-char tokens', () => {
    // ponytail: the old floor was `length >= 3`, which deleted real schema
    // identifiers — `cd` is a plausible table name, and the retrieval
    // tokenizer in rag.ts never had that floor. Both now share
    // `isMeaningfulToken` (min 2), so routing and retrieval agree.
    expect(tokenize('a b cd efg hij')).toEqual(['cd', 'efg', 'hij'])
  })

  test('filters Indonesian + English stopwords', () => {
    // `show` is deliberately KEPT: the router's old private list treated it as
    // noise, but it is a real command word ("show me the orders"), and dropping
    // it lost signal for genuinely imperative queries. Only the purely
    // grammatical words below are filtered.
    const tokens = tokenize('yang show me the stok produk')
    expect(tokens).toEqual(['show', 'stok', 'produk'])
  })

  test('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  test('handles numbers and keeps schema-meaningful words', () => {
    // ponytail: the router used to keep its OWN stopword list, which listed
    // `total`, `count`, `table`, `data`, `amount`, `row` and `column` as noise —
    // exactly the words users type when asking about a database. The lists are
    // now one (rag.ts STOPWORDS), so `total` survives and can match a schema.
    expect(tokenize('invoice 2024 total')).toEqual(['invoice', '2024', 'total'])
  })
})

describe('smart-router keywordOverlap', () => {
  test('exact match returns high score', () => {
    expect(keywordOverlap(['stok', 'produk'], ['stok', 'produk', 'gudang'])).toBe(1)
  })

  test('partial match (substring) counts', () => {
    expect(keywordOverlap(['produk'], ['produk_demo', 'inventory'])).toBeGreaterThan(0)
  })

  test('no match returns 0', () => {
    expect(keywordOverlap(['xyz'], ['stok', 'produk'])).toBe(0)
  })

  test('empty metadata returns 0', () => {
    expect(keywordOverlap(['stok'], [])).toBe(0)
  })

  test('empty tokens returns 0', () => {
    expect(keywordOverlap([], ['stok'])).toBe(0)
  })

  test('capped at 1.0', () => {
    expect(keywordOverlap(['stok', 'produk', 'gudang'], ['stok'])).toBeLessThanOrEqual(1)
  })
})
