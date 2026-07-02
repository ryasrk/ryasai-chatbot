import { describe, expect, test } from 'bun:test'
import { buildFtsMatchQuery, normalizeFtsRows } from './rag-fts'

describe('RAG FTS helpers', () => {
  test('builds safe OR match query from tokens', () => {
    expect(buildFtsMatchQuery(['invoice', 'SKU-902', 'stok*'])).toBe(
      '"invoice" OR "SKU 902" OR "stok"',
    )
  })

  test('normalizes FTS rows by rank', () => {
    expect(
      normalizeFtsRows([
        { chunkId: 'b', rank: -3 },
        { chunkId: 'a', rank: -5 },
      ]),
    ).toEqual(['a', 'b'])
  })
})
