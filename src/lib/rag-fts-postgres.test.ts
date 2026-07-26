import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks: Postgres provider + DB (must precede import) ---
const mockExecuteRawUnsafe = mock<(sql: string, ...params: unknown[]) => Promise<number>>(async () => 1)
const mockQueryRawUnsafe = mock(
  async (_sql: string, ..._params: unknown[]): Promise<unknown[]> => [],
)

mock.module('@/lib/db', () => ({
  db: {
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $queryRawUnsafe: mockQueryRawUnsafe,
    documentChunk: {
      findMany: async () => [{ id: 'pg-1', content: 'pg content', keywords: 'kw' }],
    },
  },
}))
mock.module('@/lib/db-provider', () => ({ getDbProvider: () => 'postgresql' as const }))

import { ensureRagFtsTable, upsertChunkFts, rebuildFts, searchFtsChunkIds } from './rag-fts'

beforeEach(() => {
  mockExecuteRawUnsafe.mockClear()
  mockQueryRawUnsafe.mockClear()
})

describe('ensureRagFtsTable (Postgres)', () => {
  test('adds tsvector column + GIN index (not FTS5)', async () => {
    await ensureRagFtsTable()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('ADD COLUMN IF NOT EXISTS tsv tsvector'))).toBe(true)
    expect(sqls.some((s) => s.includes('USING GIN(tsv)'))).toBe(true)
    expect(sqls.some((s) => s.includes('CREATE VIRTUAL TABLE'))).toBe(false)
  })
})

describe('upsertChunkFts (Postgres)', () => {
  test('updates tsv via to_tsvector (no FTS insert)', async () => {
    await upsertChunkFts({ chunkId: 'c1', content: 'text', keywords: 'kw' })
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('to_tsvector') && s.includes('UPDATE "DocumentChunk"'))).toBe(true)
    expect(sqls.some((s) => s.includes('INSERT INTO DocumentChunkFts'))).toBe(false)
  })
})

describe('rebuildFts (Postgres)', () => {
  test('bulk UPDATE tsv with JOIN (no per-row insert)', async () => {
    const result = await rebuildFts()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('UPDATE "DocumentChunk"') && s.includes('to_tsvector'))).toBe(true)
    expect(result.indexed).toBe(1)
    expect(sqls.some((s) => s.includes('DELETE FROM DocumentChunkFts'))).toBe(false)
  })
})

describe('searchFtsChunkIds (Postgres)', () => {
  test('uses ts_rank + plainto_tsquery (not bm25)', async () => {
    mockQueryRawUnsafe.mockImplementationOnce(
      async () => [{ chunkId: 'pg-1', rank: -0.5 }],
    )
    const ids = await searchFtsChunkIds({ queryTokens: ['search', 'term'], limit: 10 })
    expect(ids).toEqual(['pg-1'])
    const sql = String(mockQueryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('ts_rank')
    expect(sql).toContain('plainto_tsquery')
  })

  test('empty query → empty result', async () => {
    const ids = await searchFtsChunkIds({ queryTokens: [], limit: 10 })
    expect(ids).toEqual([])
  })
})
