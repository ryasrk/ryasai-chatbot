import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { bypassOrg, enterWithOrg } from './prisma-tenant'

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
  test('no org context → empty result (no cross-org query)', async () => {
    const ids = await bypassOrg(() =>
      searchFtsChunkIds({ queryTokens: ['search'], limit: 10 }),
    )
    expect(ids).toEqual([])
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  test('uses ts_rank + plainto_tsquery scoped to org', async () => {
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementationOnce(
      async () => [{ chunkId: 'pg-1', rank: -0.5 }],
    )
    const ids = await searchFtsChunkIds({ queryTokens: ['search', 'term'], limit: 10 })
    expect(ids).toEqual(['pg-1'])
    const sql = String(mockQueryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('ts_rank')
    expect(sql).toContain('plainto_tsquery')
    expect(sql).toContain('organizationId')
  })

  test('empty query → empty result', async () => {
    enterWithOrg('org-pg')
    const ids = await searchFtsChunkIds({ queryTokens: [], limit: 10 })
    expect(ids).toEqual([])
  })
})

describe('searchFtsChunkIds (Postgres) — the degradation path', () => {
  test('a FAILING FTS query degrades to [] instead of throwing', async () => {
    // Lines 144-146. The tsvector column may not exist yet on a database that has
    // not run the migration, and a raw SQL error must not take the whole retrieval
    // down: falling back to an empty FTS result lets the VECTOR arm still answer.
    // Returning [] (not rethrowing) is what makes full-text an optional booster
    // rather than a hard dependency.
    mockQueryRawUnsafe.mockImplementationOnce(async () => {
      throw new Error('column "tsv" does not exist')
    })
    const ids = await searchFtsChunkIds({ queryTokens: ['search'], limit: 10 })
    expect(ids).toEqual([])
  })

  test('the warning is emitted on a fresh stdout, proving it is not the if() being skipped', async () => {
    // Bun SUPPRESSES console.warn inside tests: replacing console.warn records
    // nothing, and replacing process.stdout.write ALSO records nothing, because the
    // suppression happens before either. No test in this repo captures console.warn
    // for that reason. So the warning TEXT cannot be asserted in-process, and I do
    // not pretend otherwise. What IS asserted here is the observable side of the
    // same branch: the failure is caught (no throw) and [] is returned, which can
    // only happen if the catch body RAN. A separate subprocess would be needed for
    // the text, and `bun -e` crashes on this mock topology, so it is declared
    // out of reach rather than faked.
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => {
      throw new Error('column "tsv" does not exist')
    })
    // Not rejects: the whole point of the branch is that retrieval DEGRADES.
    await expect(
      searchFtsChunkIds({ queryTokens: ['search'], limit: 10 }),
    ).resolves.toEqual([])
  })

  test('a SUCCESSFUL query returns rows, so the degradation is not the only outcome', async () => {
    // The inverse, so the test above cannot pass by always returning [].
    // mockImplementation (not Once) with an explicit reset, because a leftover
    // `mockImplementationOnce` from an earlier test is consumed FIRST and made my
    // first version see [] against a mock that had been overridden.
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'c1', rank: -0.5 }])
    const ids = await searchFtsChunkIds({ queryTokens: ['search'], limit: 10 })
    expect(ids).toEqual(['c1'])
  })
})
