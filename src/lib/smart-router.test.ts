import { describe, expect, test } from 'bun:test'
import { tokenize, keywordOverlap } from './smart-router'

// ponytail: test pure functions only — DB-backed functions need integration test infra.

describe('smart-router tokenize', () => {
  test('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Stok produk GUDANG')).toEqual(['stok', 'produk', 'gudang'])
  })

  test('filters tokens < 3 chars', () => {
    expect(tokenize('a b cd efg hij')).toEqual(['efg', 'hij'])
  })

  test('filters Indonesian + English stopwords', () => {
    const tokens = tokenize('yang show me the stok produk')
    expect(tokens).toEqual(['stok', 'produk'])
  })

  test('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  test('handles numbers', () => {
    // 'total' is now a stopword (common query word that pollutes schema matching)
    expect(tokenize('invoice 2024 total')).toEqual(['invoice', '2024'])
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
