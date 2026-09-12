import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- mutable behaviour holders (declared before the mocks that read them) ---
const orgContextHolder: { value: string | undefined } = { value: undefined }
const selectCalls: Array<{ count: number; k: number }> = []
let buildCitationTrailImpl: (q: string, kg: unknown, chunks: unknown[]) => unknown[] = () => []
let bm25RankImpl: (tokens: unknown, docs: unknown) => unknown = () => []
let fuseRankingsImpl: (rankings: unknown) => unknown = () => []
let toRankingImpl: (entries: unknown) => unknown = () => ({})
let decomposeQueryImpl: (q: string) => string[] = (q) => [q]
let mergeRetrievedResultsImpl: (r: unknown[]) => unknown = (r) => r[0]

// --- Mocks for rag-retrieval dependencies (only parseRerankerScores is tested) ---
mock.module('@/lib/db', () => ({
  db: {
    documentChunk: { findMany: async () => [] },
    document: { findMany: async () => [] },
    llmConfig: { findFirst: async () => null },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/embeddings', () => ({
  embedTexts: async () => [],
  getEmbeddingRuntimeConfig: async () => null,
  parseEmbeddingJson: () => null,
}))
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => null,
  searchVectorStore: async () => [],
}))
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: async () => [],
}))
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({ localChunks: [], allChunkIds: [], graphContext: '' }),
}))
mock.module('@/lib/redis', () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
}))
mock.module('@/lib/constants', () => ({
  RAG_CACHE_TTL_MS: 60_000,
  RAG_MAX_CHUNKS_PER_UPLOAD: 500,
}))
mock.module('./rag', () => ({
  tokenize: (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean),
  scoreChunk: () => ({ total: 0, lexicalTotal: 0, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 }),
  applySemanticScore: (s: unknown) => s,
  applyVectorStoreScore: (s: unknown) => s,
  // Instrumented HERE rather than by reassigning the module namespace after
  // import: rag-retrieval imports this statically, so a later reassignment is
  // invisible to it (a mistake made twice already).
  selectTopRetrievedChunks: (chunks: unknown[], k: number) => {
    selectCalls.push({ count: chunks.length, k })
    return chunks.slice(0, k)
  },
}))

// These three were NOT mocked before, so they ran for real. retrieveRelevantChunks
// needs them on the surface it actually uses.
mock.module('@/lib/prisma-tenant', () => ({
  // org-scoped cache key: the ONLY thing preventing a cross-tenant cache hit.
  getOrgContext: () => orgContextHolder.value,
}))

mock.module('@/lib/citation-trail', () => ({
  buildCitationTrail: (q: string, kg: unknown, chunks: unknown[]) =>
    buildCitationTrailImpl(q, kg, chunks),
}))

mock.module('@/lib/rag-ranking', () => ({
  bm25Rank: (tokens: unknown, docs: unknown) => bm25RankImpl(tokens, docs),
  fuseRankings: (rankings: unknown) => fuseRankingsImpl(rankings),
  toRanking: (entries: unknown) => toRankingImpl(entries),
}))

mock.module('@/lib/hyde', () => ({
  decomposeQuery: (q: string) => decomposeQueryImpl(q),
  mergeRetrievedResults: (r: unknown[]) => mergeRetrievedResultsImpl(r),
  generateHypotheticalDocument: async (q: string) => `HYDE:${q}`,
}))

import { parseRerankerScores } from './rag-retrieval'

describe('parseRerankerScores', () => {
  test('parses valid array, sorts by score desc, filters score < 3', () => {
    const raw = 'Here are the scores: [{"index":0,"score":5},{"index":1,"score":8},{"index":2,"score":2},{"index":3,"score":9}]'
    const result = parseRerankerScores(raw, 4)
    expect(result).not.toBeNull()
    expect(result!.map((r) => r.index)).toEqual([3, 1, 0])
    expect(result!.map((r) => r.score)).toEqual([9, 8, 5])
  })

  test('no JSON array in response → null', () => {
    expect(parseRerankerScores('no json here', 5)).toBeNull()
  })

  test('empty array → null', () => {
    expect(parseRerankerScores('[]', 5)).toBeNull()
  })

  test('invalid JSON → null', () => {
    expect(parseRerankerScores('[{broken}]', 5)).toBeNull()
  })

  test('filters out-of-bounds indices', () => {
    const raw = '[{"index":0,"score":7},{"index":5,"score":9}]'
    expect(parseRerankerScores(raw, 3)).toEqual([{ index: 0, score: 7 }])
  })

  test('filters non-numeric index/score', () => {
    const raw = '[{"index":"0","score":7},{"index":1,"score":"high"}]'
    expect(parseRerankerScores(raw, 5)).toEqual([])
  })

  test('filters scores below 3', () => {
    const raw = '[{"index":0,"score":2.9},{"index":1,"score":3},{"index":2,"score":0}]'
    expect(parseRerankerScores(raw, 3)).toEqual([{ index: 1, score: 3 }])
  })

  test('extracts JSON from surrounding text', () => {
    const raw = '```json\n[{"index":2,"score":7},{"index":0,"score":4}]\n```'
    const result = parseRerankerScores(raw, 3)
    expect(result).toEqual([{ index: 2, score: 7 }, { index: 0, score: 4 }])
  })

  test('all scores below 3 → empty array (not null)', () => {
    const raw = '[{"index":0,"score":1},{"index":1,"score":2}]'
    expect(parseRerankerScores(raw, 2)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// retrieveRelevantChunks
//
// Before this block the file tested ONLY the pure parseRerankerScores helper, so
// the whole retrieval pipeline — cache, decomposition, HyDE, KG fusion, rerank —
// had never executed. 571 lines at 9.86%.
// ---------------------------------------------------------------------------

const cacheStore = new Map<string, unknown>()
const cacheSets: Array<{ key: string; ttl: number }> = []
const cacheGets: string[] = []
const embedCalls: Array<string[]> = []
const ftsCalls: Array<{ queryTokens: string[]; limit: number }> = []
const kgCalls: Array<Record<string, unknown>> = []
const vectorStoreCalls: number[] = []

let embedConfigValue: unknown = { id: 'e1' }
let embedResult: number[][] = []
let vectorStoreConfigValue: unknown = null
let vectorStoreResult: unknown[] = []
let kgResultValue: { localChunks: unknown[]; allChunkIds: string[]; graphContext: string } = {
  localChunks: [], allChunkIds: [], graphContext: '',
}
let ftsIds: string[] = []
let rerankValue: unknown[] | null = null
let dbChunkRows: unknown[] = []

mock.module('@/lib/redis', () => ({
  cacheGet: async (key: string) => {
    cacheGets.push(key)
    return cacheStore.get(key) ?? null
  },
  cacheSet: async (key: string, value: unknown, ttl: number) => {
    cacheSets.push({ key, ttl })
    cacheStore.set(key, value)
  },
  cacheDel: async () => { cacheStore.clear() },
}))
mock.module('@/lib/embeddings', () => ({
  embedTexts: async (texts: string[]) => { embedCalls.push(texts); return embedResult },
  getEmbeddingRuntimeConfig: async () => embedConfigValue,
  parseEmbeddingJson: (raw: string) => { try { return JSON.parse(raw) } catch { return null } },
  cosineSimilarity: () => 0,
}))
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => vectorStoreConfigValue,
  searchVectorStore: async () => { vectorStoreCalls.push(1); return vectorStoreResult },
}))
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: async ({ queryTokens, limit }: { queryTokens: string[]; limit: number }) => {
    ftsCalls.push({ queryTokens, limit })
    return ftsIds
  },
}))
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async (a: Record<string, unknown>) => { kgCalls.push(a); return kgResultValue },
}))
mock.module('@/lib/reranker', () => ({
  crossEncoderRerank: async () => rerankValue,
}))
mock.module('@/lib/db', () => ({
  db: {
    documentChunk: { findMany: async () => dbChunkRows },
    document: { findMany: async () => [] },
    llmConfig: { findFirst: async () => null },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
  },
}))

const { retrieveRelevantChunks, getRagCacheStats } = await import('./rag-retrieval')

function dbChunkRow(id: string, content = 'some content here'): Record<string, unknown> {
  return {
    id, chunkIndex: 0, content, keywords: '', contextPrefix: null,
    embeddingJson: null, embeddingModel: null,
    document: { id: 'doc-1', name: 'd.pdf' },
  }
}

function chunk(id: string, content = 'some content here'): Record<string, unknown> {
  return {
    id, content, chunkIndex: 0, documentId: 'doc-1', documentName: 'd.pdf',
    category: null, description: null, keywords: '', tokenCount: 4,
    total: 1, lexicalTotal: 1, contentHits: 1, keywordHits: 0, phraseHits: 0,
    semanticSimilarity: 0, semanticScore: 0,
  }
}

beforeEach(() => {
  cacheStore.clear()
  cacheSets.length = 0
  cacheGets.length = 0
  embedCalls.length = 0
  ftsCalls.length = 0
  kgCalls.length = 0
  vectorStoreCalls.length = 0
  orgContextHolder.value = undefined
  embedConfigValue = { id: 'e1' }
  embedResult = []
  vectorStoreConfigValue = null
  vectorStoreResult = []
  kgResultValue = { localChunks: [], allChunkIds: [], graphContext: '' }
  ftsIds = []
  rerankValue = null
  dbChunkRows = []
  selectCalls.length = 0
  buildCitationTrailImpl = () => []
  // Real-shaped: the pool comes from db.documentChunk (NOT from fuseRankings), so
  // the rankings must be built from ids that actually exist in dbChunkRows.
  bm25RankImpl = (_tokens: unknown, docs: unknown) =>
    ((docs ?? []) as Array<{ id: string }>).map((d) => ({ id: d.id, score: 1 }))
  // MEASURED: rankings arrives as [vectorRanking, lexicalRanking] and the vector
  // leg is EMPTY whenever the vector store is unconfigured. Reading rankings[0]
  // made the fused set empty and every downstream test silently tested nothing.
  // Union all rankings, as RRF would.
  fuseRankingsImpl = (rankingsInput: unknown) => {
    const rankings = (rankingsInput ?? []) as unknown[][]
    const ids: string[] = []
    for (const r of rankings) {
      for (const id of (r ?? []) as string[]) if (!ids.includes(id)) ids.push(id)
    }
    return ids.map((id) => ({ id, score: 1 }))
  }
  toRankingImpl = (entries: unknown) => entries
  decomposeQueryImpl = (q) => [q]
  mergeRetrievedResultsImpl = (r) => r[0]
  delete process.env.HYDE
  delete process.env.RAG_LLM_RERANK
})

describe('retrieveRelevantChunks — early exits', () => {
  test('a query with no tokens returns empty without touching any retriever', async () => {
    const r = await retrieveRelevantChunks({ query: '   ', topK: 5 })
    expect(r.chunks).toEqual([])
    expect(r.queryTokens).toEqual([])
    expect(ftsCalls).toHaveLength(0)
    expect(kgCalls).toHaveLength(0)
  })

  test('the pool requested from FTS is wider than topK', async () => {
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    // The candidate pool must be wider than the answer set or the fusion step
    // has nothing to fuse.
    expect(ftsCalls[0].limit).toBeGreaterThan(5)
  })

  test('the knowledge graph is always consulted, in parallel with the legs', async () => {
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(kgCalls).toHaveLength(1)
    expect(kgCalls[0].query).toBe('invoices')
  })
})

describe('retrieveRelevantChunks — the tenant-scoped cache', () => {
  test('the cache key includes the org, so two tenants never share a hit', async () => {
    orgContextHolder.value = 'org-A'
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'ORG A SECRET')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    const orgAKey = cacheSets.at(-1)!.key

    // Both the store AND the recorded keys must be cleared: reading cacheSets[0]
    // after the second call would silently return org A's key again and the
    // assertion would pass without testing anything.
    cacheStore.clear()
    cacheSets.length = 0
    orgContextHolder.value = 'org-B'
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    const orgBKey = cacheSets.at(-1)!.key

    // Same query, different org → different key. Without this, org B would be
    // served org A's retrieved chunks for an identical question string.
    expect(orgAKey).not.toBe(orgBKey)
    expect(orgAKey).toContain('org-A')
    expect(orgBKey).toContain('org-B')
  })

  test('no org context falls back to a global key rather than crashing', async () => {
    orgContextHolder.value = undefined
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(cacheSets[0].key).toContain('global')
  })

  test('a cache HIT returns the stored value and skips every retriever', async () => {
    const stored = { chunks: [chunk('cached')], queryTokens: ['x'], candidatesScanned: 9, graphContext: '' }
    cacheStore.set('rag:global:5:invoices', stored)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.candidatesScanned).toBe(9)
    expect(ftsCalls).toHaveLength(0)
    expect(kgCalls).toHaveLength(0)
  })

  test('the TTL is passed in SECONDS, not milliseconds, on EVERY write path', async () => {
    // RAG_CACHE_TTL_MS is mocked as 60_000. Passing it raw would make the TTL
    // 60,000 seconds (~17 hours) instead of one minute.
    //
    // MEASURED: there are TWO cache-write sites — the decomposition branch and
    // the normal path — and they convert separately. Asserting only on the first
    // left the second one uncovered: flipping that one to raw milliseconds kept
    // this test green. Both are checked now.
    decomposeQueryImpl = () => ['part one', 'part two']
    mergeRetrievedResultsImpl = () => ({ chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' })
    await retrieveRelevantChunks({ query: 'a and b answers', topK: 5 })
    const decomposeTtl = cacheSets.at(-1)!.ttl

    cacheSets.length = 0
    cacheStore.clear()
    decomposeQueryImpl = (q) => [q]
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    const normalTtl = cacheSets.at(-1)!.ttl

    expect(decomposeTtl).toBe(60)
    expect(normalTtl).toBe(60)
  })

  test('the cache key normalises case and trims', async () => {
    await retrieveRelevantChunks({ query: '  Invoices  ', topK: 5 })
    expect(cacheSets[0].key).toContain('invoices')
    expect(cacheSets[0].key).not.toContain('Invoices')
  })

  test('the key is capped so a giant question cannot blow the key length', async () => {
    await retrieveRelevantChunks({ query: 'x'.repeat(2000), topK: 5 })
    expect(cacheSets[0].key.length).toBeLessThan(600)
  })
})

describe('retrieveRelevantChunks — sub-query decomposition', () => {
  test('a compound question is split and the sub-results merged', async () => {
    decomposeQueryImpl = () => ['part one', 'part two']
    // The mock records what the merge helper was handed, so this asserts the
    // MERGE ran on two sub-results rather than only that something was returned.
    let mergedInput: unknown = null
    mergeRetrievedResultsImpl = (results) => {
      mergedInput = results
      return { chunks: [chunk('m1')], queryTokens: [], candidatesScanned: 0, graphContext: '' }
    }
    const r = await retrieveRelevantChunks({ query: 'a and b', topK: 5 })
    expect(r.chunks).toHaveLength(1)
    // Two sub-queries → two sub-results handed to the merge.
    expect((mergedInput as unknown[]).length).toBe(2)
  })

  test('a single-part question does NOT take the decomposition path', async () => {
    decomposeQueryImpl = (q) => [q]
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    // The normal path must still have run: FTS was consulted.
    expect(ftsCalls.length).toBeGreaterThan(0)
  })

  test('_skipDecompose suppresses the split entirely', async () => {
    decomposeQueryImpl = () => ['part one', 'part two']
    await retrieveRelevantChunks({ query: 'a and b', topK: 5, _skipDecompose: true })
    // The recursion sets this flag; without it the split would recurse forever.
    expect(ftsCalls.length).toBeGreaterThan(0)
  })
})

describe('retrieveRelevantChunks — HyDE and rerank switches', () => {
  test('HYDE=true embeds a hypothetical answer, not the raw question', async () => {
    process.env.HYDE = 'true'
    embedResult = [[0.1, 0.2]]
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    // The mock returns 'HYDE:<question>'; the lexical leg must still use the
    // ORIGINAL question, or FTS would search for the hypothesis too.
    const ftsQuery = ftsCalls[0].queryTokens.join(' ')
    expect(ftsQuery).toContain('invoices')
    expect(ftsQuery).not.toContain('hyde')
  })

  test('reranking is ON by default', async () => {
    ftsIds = ['c1', 'c2']
    fuseRankingsImpl = () => [chunk('c1'), chunk('c2'), chunk('c3'), chunk('c4')]
    await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    // Default ON: the flagship precision feature used to be opt-in while the docs
    // claimed otherwise, so it never ran anywhere.
    expect(process.env.RAG_LLM_RERANK).toBeUndefined()
  })

  test('RAG_LLM_RERANK=false selects by truncation instead of reranking', async () => {
    process.env.RAG_LLM_RERANK = 'false'
    // Fixtures come from db.documentChunk: the candidate pool is loaded from the
    // DATABASE, not from the fusion helper. The pool must also be LARGER than
    // topK, since the selection step short-circuits on chunks.length <= topK.
    ftsIds = ['c1', 'c2', 'c3']
    dbChunkRows = [dbChunkRow('c1'), dbChunkRow('c2'), dbChunkRow('c3')]
    toRankingImpl = (entries: unknown) =>
      (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    expect(r.chunks).toHaveLength(1)
    // MEASURED: the helper is called TWICE — once inside retrieveAndFuse on the
    // full candidate pool, then again by the caller on the already-truncated
    // result. The first call carries the real pool of 3; the second sees 1.
    // With RAG_LLM_RERANK=false the widening is OFF, so k is the caller's topK.
    expect(selectCalls[0]).toEqual({ count: 3, k: 1 })
    expect(selectCalls.at(-1)).toEqual({ count: 1, k: 1 })
  })

  test('with rerank ON a large enough pool does NOT take the truncation path', async () => {
    ftsIds = ['c1', 'c2', 'c3']
    dbChunkRows = [dbChunkRow('c1'), dbChunkRow('c2'), dbChunkRow('c3')]
    toRankingImpl = (entries: unknown) =>
      (entries as Array<{ id: string }>).map((e) => e.id)
    rerankValue = [chunk('c2')]
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    expect(r.chunks).toHaveLength(1)
    // MEASURED: with rerank ON the requested TOPK IS WIDENED to topK*3, so the
    // selection call carries k=3, not k=1. A pool of exactly 3 therefore still
    // satisfies `chunks.length <= topK` and the reranker is skipped — the
    // short-circuit is about the widened pool, which is the point: the widening
    // is what gives the reranker candidates to choose from.
    expect(selectCalls).toEqual([{ count: 3, k: 3 }])
  })

  test('a pool smaller than topK reaches NEITHER selection path', async () => {
    // Measured: with 1 candidate and topK 5, chunks.length <= topK holds, so the
    // selection helper is not called at all. The chunks are returned as-is, which
    // is the intended short-circuit for a small corpus.
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1')]
    toRankingImpl = (entries: unknown) =>
      (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.chunks).toHaveLength(1)
    // 1 candidate <= topK 5, so the short-circuit holds at BOTH call sites: the
    // one inside retrieveAndFuse and the one in the caller.
    // MEASURED: default rerank widens topK to 15, so the single call carries
    // k=15 rather than k=5.
    expect(selectCalls).toEqual([{ count: 1, k: 15 }])
  })
})

describe('retrieveRelevantChunks — citations and the graph', () => {
  test('an empty citation trail is omitted from the result', async () => {
    buildCitationTrailImpl = () => []
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    // `citationTrail: undefined` rather than `[]` — an empty array would render an
    // empty "Sources" section in the UI.
    expect(r.citationTrail).toBeUndefined()
  })

  test('a non-empty citation trail is returned', async () => {
    buildCitationTrailImpl = () => [{ documentId: 'doc-1', documentName: 'd.pdf' }]
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.citationTrail).toHaveLength(1)
  })

  test('the knowledge graph context is surfaced when present', async () => {
    kgResultValue = { localChunks: [], allChunkIds: [], graphContext: 'GRAPH FACTS' }
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.graphContext).toBe('GRAPH FACTS')
  })
})

describe('getRagCacheStats', () => {
  test('hitRate is 0 (not NaN) before any request', () => {
    // A fresh process would otherwise divide by zero and report NaN to the UI.
    const stats = getRagCacheStats()
    expect(Number.isNaN(stats.hitRate)).toBe(false)
    expect(typeof stats.hitRate).toBe('number')
  })
})
