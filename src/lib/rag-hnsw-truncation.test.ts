import { describe, expect, test, mock, beforeEach } from 'bun:test'

/**
 * HNSW FILTER TRUNCATION — regression guard.
 *
 * pgvector applies a query's WHERE clause AFTER the HNSW approximate scan:
 *
 *   Limit
 *     -> Index Scan using DocumentChunk_embedding_hnsw
 *           Filter: ("organizationId" = ...)
 *
 * So a query asking for N neighbours returns far fewer than N when the org is
 * a minority of the shared table — the scan walks the GLOBAL nearest-neighbour
 * graph and the org filter discards nearly everything it finds. Measured on
 * pgvector 0.6.0 (trial/98, 20k vectors / 100 orgs, each 1% of the table):
 *
 *   hnsw_probe (HNSW index)    ->  0 rows
 *   hnsw_exact (no index)      -> 20 rows      <- identical table, same query
 *   ef_search=1000 (max)       ->  5 rows
 *
 * `hnsw.iterative_scan` (pgvector 0.8.0+) fixes it by scanning until enough
 * rows survive the filter; 0.6.x has no equivalent, and `ef_search` is capped
 * at 1000 so no value guarantees a complete result.
 *
 * Two behaviours are locked here:
 *  1. An under-filled pgvector leg is treated as FAILURE and the external
 *     vector store (which is exact) is tried. Before this, `size > 0` counted
 *     as success, so a partial — or empty — leg silently won and the exact
 *     store was never consulted. The fusion step then treated the survivors
 *     as the whole candidate set.
 *  2. `ef_search` is raised proportionally to the requested limit, and
 *     `iterative_scan` is used when the server supports it.
 */

const rawCalls: string[] = []
let pgvectorRows: Array<{ id: string; similarity: number }> = []
let hasIterativeScan = false
let storeHits: Array<{ chunkId: string; score: number }> = []
let storeConfig: { provider: string } | null = null

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-a',
  enterWithOrg: () => undefined,
  bypassOrg: async (fn: () => unknown) => fn(),
}))

// Chunks are only considered if they can be loaded from the DB, so the mock
// must serve rows for whatever candidate ids the legs produced.
mock.module('@/lib/db', () => ({
  db: {
    documentChunk: {
      findMany: async (q: { where?: { id?: { in?: string[] } } }) => {
        const ids = q?.where?.id?.in ?? []
        return ids.map((id, i) => ({
          id,
          chunkIndex: i,
          content: `content for ${id}`,
          keywords: '',
          contextPrefix: null,
          embeddingJson: null,
          embeddingModel: null,
          document: { id: 'doc-1', name: 'Doc' },
        }))
      },
    },
    document: { findMany: async () => [] },
    llmConfig: { findFirst: async () => null },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    // The probe issues SHOW hnsw.iterative_scan; the search runs inside a
    // transaction whose tx must expose the same raw API.
    $queryRawUnsafe: async (sql: string) => {
      rawCalls.push(sql)
      if (sql.includes('SHOW hnsw.iterative_scan')) {
        if (!hasIterativeScan) throw new Error('unrecognized configuration parameter')
        return [{ iterative_scan: 'off' }]
      }
      return pgvectorRows
    },
    $executeRawUnsafe: async (sql: string) => {
      rawCalls.push(sql)
      return 1
    },
    $transaction: async (fn: (tx: Record<string, unknown>) => unknown) =>
      fn({
        $executeRawUnsafe: async (sql: string) => {
          rawCalls.push(sql)
          return 1
        },
        $queryRaw: async () => pgvectorRows,
        $queryRawUnsafe: async (sql: string) => {
          rawCalls.push(sql)
          return pgvectorRows
        },
      }),
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/embeddings', () => ({
  // Must be non-null AND return a vector, otherwise resolveQueryEmbedding
  // yields null, resolveVectorScores short-circuits on `!args.vector`, and the
  // pgvector path under test is never reached (which is exactly how the first
  // version of this file silently asserted nothing).
  getEmbeddingRuntimeConfig: async () => ({ provider: 'OPENAI_COMPATIBLE', model: 'test-embed', dims: 3 }),
  embedTexts: async (_cfg: unknown, texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  parseEmbeddingJson: () => null,
  cosineSimilarity: () => 0,
  // `rag.ts` (the barrel) re-exports this; a partial mock makes the barrel
  // throw "Export named ... not found" at import time.
  combineHybridScore: () => 0,
}))
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => storeConfig,
  searchVectorStore: async () => storeHits,
  // REQUIRED, not decoration: `rag-retrieval` imports this class and re-throws it before its network-failure
  // fallback. A factory that omits an export the module imports fails the WHOLE file with
  // "Export named X not found" -- every test, not just the one that reaches it. Same shape as the real class so an
  // `instanceof` in the module under test still matches.
  UnsupportedVectorProviderError: class UnsupportedVectorProviderError extends Error {
    code = 'UNSUPPORTED_VECTOR_PROVIDER'
    constructor(provider?: string) {
      super(`Unsupported vector provider: ${provider ?? 'unknown'}`)
      this.name = 'UnsupportedVectorProviderError'
    }
  },
}))
mock.module('@/lib/rag-fts', () => ({ searchFtsChunkIds: async () => [] }))
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({ localChunks: [], allChunkIds: [], graphContext: '' }),
}))
mock.module('@/lib/redis', () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
}))
mock.module('@/lib/guardrails', () => ({ validateAndSanitizeLlmSql: () => ({ ok: true }) }))

const { retrieveRelevantChunks, _resetIterativeScanProbe } = await import('@/lib/rag-retrieval')

// Diagnostic: dump the raw SQL seen during a run (used by the assertion-failure
// path so a broken mock does not silently assert nothing).
function dumpCalls() {
  return rawCalls.join(' ||| ')
}

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `chunk-${i}`, similarity: 0.9 - i * 0.01 }))
}

beforeEach(() => {
  // Reset the capability cache FIRST: the probe itself writes to rawCalls, and
  // clearing after would leave the previous test's SHOW in this test's log.
  _resetIterativeScanProbe()
  rawCalls.length = 0
  pgvectorRows = []
  hasIterativeScan = false
  storeHits = []
  storeConfig = null
})

describe('HNSW filter truncation', () => {
  test('raises hnsw.ef_search proportionally to the requested limit', async () => {
    // The query must ask the index for more candidates than the org filter will
    // leave behind. Leaving ef_search at the server default (40) is the bug.
    pgvectorRows = rows(24)
    await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    const setLocal = rawCalls.find((s) => s.includes('hnsw.ef_search'))
    expect(setLocal, `no ef_search in: ${dumpCalls().slice(0, 300)}`).toBeDefined()
    const value = Number(setLocal!.match(/hnsw\.ef_search\s*=\s*(\d+)/)![1])
    expect(value).toBeGreaterThan(40)
    expect(value).toBeLessThanOrEqual(1000) // server rejects anything larger (22023)
  })

  test('uses iterative_scan when the server supports it (pgvector 0.8.0+)', async () => {
    hasIterativeScan = true
    pgvectorRows = rows(24)
    await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    const all = rawCalls.join('\n')
    expect(all).toContain('hnsw.iterative_scan')
    expect(all).toContain('relaxed_order')
  })

  test('does NOT request iterative_scan when the server lacks it (pgvector 0.6.x)', async () => {
    hasIterativeScan = false
    pgvectorRows = rows(24)
    await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    // 0.6.x raises 42704 on an unknown GUC; issuing it would break every query.
    // Note: the capability PROBE legitimately issues `SHOW hnsw.iterative_scan`
    // (and matches on the parameter name), so filter to SET statements only —
    // asserting on the bare substring would pass/fail for the wrong reason.
    const setIterative = rawCalls.filter(
      (s) => s.includes('iterative_scan') && !s.trim().toUpperCase().startsWith('SHOW'),
    )
    expect(setIterative).toEqual([])
  })

  test('an EMPTY pgvector leg falls through to the external store', async () => {
    // The real-world case: 0 rows returned while the table holds plenty.
    pgvectorRows = []
    storeConfig = { provider: 'QDRANT' }
    storeHits = [{ chunkId: 'from-store', score: 0.8 }]

    const { chunks } = await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    expect(chunks.some((c) => c.chunkId === 'from-store')).toBe(true)
  })

  test('a PARTIAL pgvector leg also falls through, not treated as success', async () => {
    // 2 rows when far more were requested: previously `size > 0` won and the
    // exact store was never consulted, so the missing rows were simply absent.
    pgvectorRows = rows(2)
    storeConfig = { provider: 'QDRANT' }
    storeHits = [{ chunkId: 'complete-a', score: 0.9 }, { chunkId: 'complete-b', score: 0.8 }]

    const { chunks } = await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    const ids = chunks.map((c) => c.chunkId)
    expect(ids).toContain('complete-a')
    expect(ids).toContain('complete-b')
  })

  test('keeps the partial pgvector rows when no external store is configured', async () => {
    // Degrading to a short list is better than degrading to nothing, as long as
    // the operator-visible warning fires (asserted via the warn call path).
    pgvectorRows = rows(3)
    storeConfig = null

    const { chunks } = await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    expect(chunks.length).toBeGreaterThan(0)
  })

  test('a healthy pgvector leg is used without consulting the external store', async () => {
    pgvectorRows = rows(24)
    storeConfig = { provider: 'QDRANT' }
    storeHits = [{ chunkId: 'should-not-appear', score: 0.99 }]

    const { chunks } = await retrieveRelevantChunks({ query: 'refund policy overtime', topK: 3 })

    expect(chunks.some((c) => c.chunkId === 'should-not-appear')).toBe(false)
  })
})
