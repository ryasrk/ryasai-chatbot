import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- DB mock (must precede import) ---
const mockExecuteRawUnsafe = mock<(sql: string, ...params: unknown[]) => Promise<number>>(async () => 1)
const mockQueryRawUnsafe = mock(
  async (_sql: string, ..._params: unknown[]): Promise<unknown[]> => [],
)

mock.module('@/lib/db', () => ({
  db: {
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $queryRawUnsafe: mockQueryRawUnsafe,
    documentChunk: {
      findMany: async () => [
        { id: 'chunk-1', content: 'hello world', keywords: 'greeting' },
        { id: 'chunk-2', content: 'foo bar', keywords: null },
      ],
    },
  },
}))
mock.module('@/lib/db-provider', () => ({ getDbProvider: () => 'sqlite' as const }))

import { buildFtsMatchQuery, normalizeFtsRows, ensureRagFtsTable, upsertChunkFts, rebuildFts, searchFtsChunkIds } from './rag-fts'

beforeEach(() => {
  mockExecuteRawUnsafe.mockClear()
  mockQueryRawUnsafe.mockClear()
})

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

describe('ensureRagFtsTable (SQLite)', () => {
  test('creates FTS5 virtual table', async () => {
    await ensureRagFtsTable()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    const ftsCreate = sqls.find((s) => s.includes('CREATE VIRTUAL TABLE') && s.includes('fts5'))
    expect(ftsCreate).toBeDefined()
    expect(ftsCreate).toContain('DocumentChunkFts')
  })
})

describe('upsertChunkFts (SQLite)', () => {
  test('deletes then inserts into FTS table', async () => {
    await upsertChunkFts({ chunkId: 'c1', content: 'text', keywords: 'kw' })
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('DELETE FROM DocumentChunkFts'))).toBe(true)
    expect(sqls.some((s) => s.includes('INSERT INTO DocumentChunkFts'))).toBe(true)
  })
})

describe('rebuildFts (SQLite)', () => {
  test('deletes all then re-inserts chunks, returns indexed count', async () => {
    const result = await rebuildFts()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s === 'DELETE FROM DocumentChunkFts')).toBe(true)
    expect(result.indexed).toBe(2)
  })
})

describe('searchFtsChunkIds (SQLite)', () => {
  test('issues bm25 match query and returns sorted chunkIds', async () => {
    mockQueryRawUnsafe.mockImplementationOnce(
      async () => [{ chunkId: 'b', rank: -3 }, { chunkId: 'a', rank: -5 }],
    )
    const ids = await searchFtsChunkIds({ queryTokens: ['hello', 'world'], limit: 10 })
    expect(ids).toEqual(['a', 'b'])
    const sql = String(mockQueryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('bm25')
    expect(sql).toContain('DocumentChunkFts')
  })

  test('empty tokens → empty result (no DB call)', async () => {
    const ids = await searchFtsChunkIds({ queryTokens: [], limit: 10 })
    expect(ids).toEqual([])
  })

  test('DB error → returns empty array (graceful)', async () => {
    mockQueryRawUnsafe.mockImplementationOnce(async () => {
      throw new Error('FTS table missing')
    })
    const ids = await searchFtsChunkIds({ queryTokens: ['x'], limit: 5 })
    expect(ids).toEqual([])
  })
})
