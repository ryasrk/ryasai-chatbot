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

describe('rebuildFts (Postgres) — the BM25 corpus-stats refresh', () => {
  test('ts_stat SUCCESS populates CORPUS_DF and CORPUS_N', async () => {
    // The happy path of the corpus-level document-frequency refresh. `ts_stat` reads from
    // the tsv column, one grouped query per rebuild instead of one per search, and the
    // parsed rows become the BM25 IDF table. Without this, corpus-wide ranking silently
    // degrades to pool-local IDF, which is a different (worse) relevance model.
    const { CORPUS_DF, CORPUS_N } = await import('@/lib/rag-ranking')
    CORPUS_DF.clear()
    CORPUS_N.total = 0
    // A STALE entry from a previous corpus. The refresh must REPLACE the table, not merge
    // into it: a word that has dropped out of the corpus would otherwise keep its old IDF
    // forever, and `clear()` is the only thing that removes it. A control deleting the
    // clear() produced no failing test until this entry existed.
    CORPUS_DF.set('word-from-old-corpus', 500)

    mockQueryRawUnsafe.mockImplementationOnce(async () => [
      { word: 'invoice', ndoc: '12' },
      { word: 'payment', ndoc: '7' },
    ])
    const result = await rebuildFts()

    expect(result.indexed).toBe(1)
    expect(CORPUS_DF.get('invoice')).toBe(12)
    expect(CORPUS_DF.get('payment')).toBe(7)
    // ndoc arrives as a STRING from the driver, so the Number() coercion is load-bearing:
    // '12' would otherwise poison every IDF computation.
    expect(typeof CORPUS_DF.get('invoice')).toBe('number')
    // CORPUS_N.total is the corpus SIZE, taken from the chunks just indexed.
    expect(CORPUS_N.total).toBe(1)
    // The stale word is GONE, proving the refresh replaced rather than merged.
    expect(CORPUS_DF.has('word-from-old-corpus')).toBe(false)
    expect(CORPUS_DF.size).toBe(2)
  })

  test('the ts_stat query is CAPPED and reads the tsv column, not the raw content', async () => {
    // Two properties of the query itself, invisible from the returned rows:
    //   * `LIMIT 50000` guards a pathological corpus from building an unbounded map. The
    //     comment calls it out, and ranking falls back when the table is stale -- so an
    //     unbounded map is a memory ceiling, not just a slowdown.
    //   * `ts_stat` must read `tsv` (the GIN-indexed column), NOT `content`, or the
    //     statistics would be recomputed from scratch on every rebuild and the index would
    //     be pointless.
    mockQueryRawUnsafe.mockImplementationOnce(async () => [{ word: 'w', ndoc: '1' }])
    await rebuildFts()
    const sql = String(mockQueryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('ts_stat')
    expect(sql).toContain('SELECT tsv FROM "DocumentChunk"')
    expect(sql).toContain('LIMIT 50000')
    // Scoped to documents that are actually searchable.
    expect(sql).toContain(`"status" = 'ready'`)
    expect(sql).toContain(`"isEnabled" = true`)
  })

  test('DECLARED EQUIVALENT: the !query guard in the Postgres path', async () => {
    // `if (!query) return []` short-circuits an all-whitespace token list. WITHOUT it the
    // query still runs and PostgreSQL's `plainto_tsquery('simple', '')` matches NOTHING,
    // so the empty array is returned either way -- the guard avoids a round trip, not a
    // different result. Declared, and pinned so the outcome cannot drift.
    enterWithOrg('org-empty')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    const ids = await searchFtsChunkIds({ queryTokens: [], limit: 10 })
    expect(ids).toEqual([])
    const whitespace = await searchFtsChunkIds({ queryTokens: ['   ', '  '], limit: 10 })
    expect(whitespace).toEqual([])
  })

  test('ts_stat FAILURE degrades to pool-local IDF and still reports indexed', async () => {
    // The catch is what keeps a rebuild from failing because the STATISTICS query could
    // not run -- an older Postgres without ts_stat, a permission problem, a timeout. The
    // chunks were already written by the bulk UPDATE, so the rebuild must still report
    // success and let ranking fall back rather than throwing and losing the whole index.
    const { CORPUS_DF } = await import('@/lib/rag-ranking')
    CORPUS_DF.clear()
    CORPUS_DF.set('stale-word', 999)

    mockQueryRawUnsafe.mockImplementationOnce(async () => {
      throw new Error('ts_stat: permission denied')
    })
    const result = await rebuildFts()

    expect(result.indexed).toBe(1)
    // The stale table was NOT half-replaced: CORPUS_DF.clear() never ran, so the previous
    // contents are intact rather than a partial merge of an aborted refresh.
    expect(CORPUS_DF.get('stale-word')).toBe(999)
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
