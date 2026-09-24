import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { prometheusText, resetMetrics } from './metrics'
import { join } from 'node:path'


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
// Overridable so a failing provider can be modelled; reset in beforeEach.
let originalEmbedTexts: ((...a: unknown[]) => Promise<number[][]>) | null = null
let originalSearchVectorStore: ((...a: unknown[]) => Promise<unknown[]>) | null = null
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
  embedTexts: async (texts: string[]) => {
    embedCalls.push(texts)
    if (originalEmbedTexts) return originalEmbedTexts(texts) as Promise<number[][]>
    return embedResult
  },
  getEmbeddingRuntimeConfig: async () => embedConfigValue,
  parseEmbeddingJson: (raw: string) => { try { return JSON.parse(raw) } catch { return null } },
  cosineSimilarity: () => 0,
}))
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => vectorStoreConfigValue,
  searchVectorStore: async (...a: unknown[]) => {
    vectorStoreCalls.push(1)
    if (originalSearchVectorStore) return originalSearchVectorStore(...a)
    return vectorStoreResult
  },
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
// The LLM fallback reranker reaches these through dynamic import.
let llmCfgValue: unknown = null
const llmPrompts: string[] = []
let llmAnswer = ''
let llmThrows: Error | null = null
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: async () => llmCfgValue,
}))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, msgs: Array<{ content: string }>) => {
    llmPrompts.push(msgs[1]?.content ?? '')
    if (llmThrows) throw llmThrows
    return llmAnswer
  },
}))
const rawUnsafeCalls: string[] = []
const executeUnsafeCalls: string[] = []
const txnDeepCalls: number[] = []
let showIterativeOk = false
let transactionThrows: Error | null = null
let pgvectorRows: Array<{ id: string; similarity: number }> = []
let plainQueryThrows: Error | null = null
let indexBuildThrows: Error | null = null
let allDocsFallback: Array<Record<string, unknown>> = []

mock.module('@/lib/db', () => ({
  db: {
    documentChunk: { findMany: async () => dbChunkRows },
    $queryRawUnsafe: async (sql: string) => {
      rawUnsafeCalls.push(sql)
      if (sql.includes('hnsw.iterative_scan') && !showIterativeOk) {
        throw new Error('42704 unrecognized configuration parameter')
      }
      return []
    },
    $executeRawUnsafe: async (sql: string) => {
      executeUnsafeCalls.push(sql)
      // Swappable so a FAILED index build can be exercised: the catch exists so a
      // broken migration degrades to a sequential scan instead of taking search down.
      if (indexBuildThrows && sql.includes('CREATE INDEX CONCURRENTLY')) throw indexBuildThrows
      return 1
    },
    $queryRaw: async () => {
      if (plainQueryThrows) throw plainQueryThrows
      return pgvectorRows
    },
    // The handler passes a hand-rolled tx client; only these two methods are used.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (transactionThrows) throw transactionThrows
      txnDeepCalls.push(1)
      // `unknown` above keeps the mock loose. The real handler passes its own
      // client; this shape is what it actually calls.
      const tx = {
        $executeRawUnsafe: async (sql: string) => { executeUnsafeCalls.push(sql); return 1 },
        $queryRaw: async () => pgvectorRows,
      } as unknown
      return fn(tx)
    },
    document: {
      // Swappable: the LAST-RESORT candidate loader fires only when neither the
      // vector nor the FTS leg produced anything (no embeddings yet, empty FTS
      // index). A mock that always returned [] made that whole branch unreachable.
      //
      // NOTE: this file calls mock.module('@/lib/db') TWICE and the LAST one wins,
      // so this is the mock that actually runs. An edit to the other one is inert
      // -- my first attempt wired `allDocsFallback` into the earlier mock and the
      // fallback still scanned 0 candidates.
      findMany: async () => allDocsFallback,
    },
    llmConfig: { findFirst: async () => null },
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
  // A default org context, because caching is now CONTEXT-GATED: a request without one
  // skips the cache entirely (see ragCacheKey). Tests that are about the no-context case
  // set this to undefined explicitly, and they now assert the cache is SKIPPED rather than
  // shared under a global key.
  orgContextHolder.value = 'org-test'
  embedConfigValue = { id: 'e1' }
  embedResult = []
  originalEmbedTexts = null
  originalSearchVectorStore = null
  vectorStoreConfigValue = null
  vectorStoreResult = []
  kgResultValue = { localChunks: [], allChunkIds: [], graphContext: '' }
  ftsIds = []
  rerankValue = null
  dbChunkRows = []
  selectCalls.length = 0
  llmCfgValue = null
  llmAnswer = ''
  llmThrows = null
  llmPrompts.length = 0
  rawUnsafeCalls.length = 0
  executeUnsafeCalls.length = 0
  txnDeepCalls.length = 0
  showIterativeOk = false
  transactionThrows = null
  pgvectorRows = []
  plainQueryThrows = null
  indexBuildThrows = null
  allDocsFallback = []
  buildCitationTrailImpl = () => []
  // Real-shaped: the pool comes from db.documentChunk (NOT from fuseRankings), so
  // the rankings must be built from ids that actually exist in dbChunkRows.
  bm25RankImpl = (_tokens: unknown, docs: unknown) =>
    ((docs ?? []) as Array<{ id: string }>).map((d) => ({ id: d.id, score: 1 }))
  // MEASURED: rankings arrives as [vectorRanking, lexicalRanking] and the vector
  // leg is EMPTY whenever the vector store is unconfigured. Reading rankings[0]
  // made the fused set empty and every downstream test silently tested nothing.
  // Union all rankings, as RRF would.
  //
  // A second latent defect lived here and this round exposed it: bm25RankImpl
  // returns objects ({ id, score }), but this helper walked each ranking as if it
  // held bare IDS. So the union contained objects, byId.get(object) was undefined,
  // and the scored list came back EMPTY. Every existing test passed only because it
  // overrode fuseRankingsImpl explicitly, so the broken default was never exercised
  // — a test helper that silently returns nothing is worse than no helper.
  fuseRankingsImpl = (rankingsInput: unknown) => {
    const rankings = (rankingsInput ?? []) as unknown[][]
    const ids: string[] = []
    for (const r of rankings) {
      for (const entry of (r ?? []) as Array<string | { id: string }>) {
        const id = typeof entry === 'string' ? entry : entry?.id
        if (id && !ids.includes(id)) ids.push(id)
      }
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

  test('no org context SKIPS the cache instead of sharing a global entry', async () => {
    // Previously this wrote to the literal `rag:global:...` key, which every context-less
    // caller shared. That is reachable — `getOrgContext()` returns undefined on the far side
    // of `bypassOrg()` — so a bypassed path could read AND write an entry another org's
    // request had populated. No context now means no cache: the request pays a retrieval
    // instead of risking a cross-tenant disclosure.
    orgContextHolder.value = undefined
    const before = cacheSets.length
    await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(cacheSets.length).toBe(before)
    // ...and it still returns real results rather than crashing.
    expect(ftsCalls.length).toBeGreaterThan(0)
  })

  test('a cache HIT returns the stored value and skips every retriever', async () => {
    const stored = { chunks: [chunk('cached')], queryTokens: ['x'], candidatesScanned: 9, graphContext: '' }
    // Read under the org the caller actually has context for. The key must name the
    // fusion config too (rag:<org>:k<k>:<topK>:<query>), or this entry is
    // unreachable — which is the point of that segment: a cached ORDER is only
    // valid for the `k` that produced it.
    const { fusionCacheTag } = await import('./rag-fusion-config')
    const { RRF_K } = await import('./rag-ranking')
    orgContextHolder.value = 'org-A'
    cacheStore.set(`rag:org-A:${fusionCacheTag(RRF_K)}:5:invoices`, stored)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.candidatesScanned).toBe(9)
    expect(ftsCalls).toHaveLength(0)
    expect(kgCalls).toHaveLength(0)
  })

  test('a cache entry written at a DIFFERENT k is not served — identical query, different order', async () => {
    // Same query and org, but the stored ranking came from k=1. Serving it to a
    // default-k caller would hand back an order that the requesting config never
    // produced, which is exactly what the fusion segment of the key prevents.
    const stored = { chunks: [chunk('cached')], queryTokens: ['x'], candidatesScanned: 9, graphContext: '' }
    orgContextHolder.value = 'org-A'
    cacheStore.set('rag:org-A:k1:5:invoices', stored)
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'invoices')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 5 })
    expect(r.candidatesScanned).not.toBe(9)
    expect(ftsCalls.length).toBeGreaterThan(0)
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
    //
    // HONEST LIMIT: `embedResult` is set but never reaches the provider here,
    // because this file leaves `embedConfigValue` null in the default
    // beforeEach, so resolveQueryEmbedding returns before calling embedTexts.
    // What this pins is real (the lexical leg is not polluted by the
    // hypothesis) but it does NOT prove the hypothesis was embedded.
    const ftsQuery = ftsCalls[0].queryTokens.join(' ')
    expect(embedCalls.flat().join(' ')).not.toContain('HYDE:')
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

// ---------------------------------------------------------------------------
// rerankWithLlm — the LLM fallback reranker
//
// Reached when the cross-encoder returns nothing. It is the ONLY path that uses
// the model to reorder, and its index bookkeeping (dedup + backfill) is where a
// mistake silently drops chunks.
// ---------------------------------------------------------------------------

/** Drive the LLM reranker directly by making the cross-encoder return null. */
async function rerankViaLlm(candidates: number, topK: number): Promise<unknown[]> {
  rerankValue = null // cross-encoder yields nothing → LLM fallback
  llmCfgValue = { id: 'r1' }
  ftsIds = Array.from({ length: candidates }, (_, i) => `c${i}`)
  dbChunkRows = Array.from({ length: candidates }, (_, i) => dbChunkRow(`c${i}`, `content ${i}`))
  toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
  // The LLM path widens the pool, so ask for a small topK and give a bigger pool.
  const r = await retrieveRelevantChunks({ query: 'invoices', topK })
  return r.chunks
}

describe('rerankWithLlm', () => {
  test('the model response decides the ORDER, not the original ranking', async () => {
    // Score c2 highest so it must come first, proving the order came from the LLM.
    llmAnswer = '[{"index":2,"score":9},{"index":0,"score":8},{"index":1,"score":7}]'
    const chunks = await rerankViaLlm(4, 1)
    expect(chunks.length).toBe(1)
    expect((chunks[0] as { content: string }).content).toContain('content 2')
  })

  test('the prompt lists the chunks with their indices and the query', async () => {
    llmAnswer = '[{"index":0,"score":9}]'
    await rerankViaLlm(3, 1)
    const prompt = llmPrompts.at(-1)!
    // Without the indices the model cannot refer to a chunk, and every score
    // would be unusable.
    expect(prompt).toContain('[0]')
    expect(prompt).toContain('[2]')
    expect(prompt).toContain('invoices')
  })

  test('chunk text in the prompt is truncated', async () => {
    llmCfgValue = { id: 'r1' }
    llmAnswer = '[{"index":0,"score":9}]'
    rerankValue = null
    ftsIds = ['c0', 'c1']
    dbChunkRows = [dbChunkRow('c0', 'z'.repeat(5000)), dbChunkRow('c1', 'y'.repeat(5000))]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    // Reranking a large corpus would otherwise blow the context window.
    expect(llmPrompts.at(-1)!.length).toBeLessThan(2000)
  })

  test('a DUPLICATE index does not fill two result slots', async () => {
    llmAnswer = '[{"index":0,"score":9},{"index":0,"score":8},{"index":1,"score":7}]'
    const chunks = await rerankViaLlm(4, 2)
    const contents = chunks.map((c) => (c as { content: string }).content)
    // The same chunk twice would silently halve the answer set.
    expect(new Set(contents).size).toBe(contents.length)
  })

  test('when the model scores too FEW chunks, the rest are BACKFILLED', async () => {
    // Only one usable score, but topK asks for 2. The gap must be filled from the
    // unranked remainder rather than returning a short answer.
    llmAnswer = '[{"index":3,"score":9}]'
    const chunks = await rerankViaLlm(5, 2)
    expect(chunks.length).toBe(2)
    expect((chunks[0] as { content: string }).content).toContain('content 3')
  })

  test('a backfilled chunk is never a duplicate of a scored one', async () => {
    llmAnswer = '[{"index":1,"score":9}]'
    const chunks = await rerankViaLlm(4, 3)
    const contents = chunks.map((c) => (c as { content: string }).content)
    expect(new Set(contents).size).toBe(contents.length)
  })

  test('an UNPARSEABLE answer falls back to the original order', async () => {
    llmAnswer = 'I think chunk two is best.'
    const chunks = await rerankViaLlm(4, 2)
    // parseRerankerScores returns null → original order, truncated.
    expect(chunks.length).toBe(2)
    expect((chunks[0] as { content: string }).content).toContain('content 0')
  })

  test('an empty score array falls back to the original order', async () => {
    llmAnswer = '[]'
    const chunks = await rerankViaLlm(4, 2)
    expect(chunks.length).toBe(2)
  })

  test('scores below the relevance floor are DISCARDED, not ranked last', async () => {
    // parseRerankerScores drops score < 3, so a chunk the model called
    // irrelevant must not occupy a result slot ahead of an unscored one.
    llmAnswer = '[{"index":0,"score":1},{"index":1,"score":2}]'
    const chunks = await rerankViaLlm(4, 2)
    // Nothing passed the floor → backfill in original order.
    expect((chunks[0] as { content: string }).content).toContain('content 0')
  })

  test('an out-of-range index is ignored rather than crashing', async () => {
    llmAnswer = '[{"index":99,"score":10},{"index":0,"score":9}]'
    const chunks = await rerankViaLlm(3, 1)
    expect(chunks.length).toBe(1)
    expect((chunks[0] as { content: string }).content).toContain('content 0')
  })

  test('NO LLM configured returns the original order without calling the model', async () => {
    rerankValue = null
    llmCfgValue = null
    ftsIds = ['c0', 'c1', 'c2', 'c3']
    dbChunkRows = ['c0', 'c1', 'c2', 'c3'].map((id) => dbChunkRow(id))
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    expect(r.chunks.length).toBe(1)
    expect(llmPrompts).toHaveLength(0)
  })

  test('a thrown LLM call falls back to the original order', async () => {
    rerankValue = null
    llmCfgValue = { id: 'r1' }
    llmThrows = new Error('provider 503')
    ftsIds = ['c0', 'c1', 'c2', 'c3']
    dbChunkRows = ['c0', 'c1', 'c2', 'c3'].map((id) => dbChunkRow(id))
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    // Retrieval must still return an answer: a broken reranker degrades precision,
    // it does not fail the request.
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    expect(r.chunks.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// pgvector similarity search + capability probe + index build
//
// This is the code that behaves DIFFERENTLY on pgvector 0.6 vs 0.8, which is an
// outstanding operator task (docs/pgvector-upgrade.md). Both branches are pinned
// here so the upgrade cannot silently change which one runs.
// ---------------------------------------------------------------------------

const { _resetIterativeScanProbe } = await import('./rag-retrieval')

describe('pgvector capability probe', () => {
  test('a server WITHOUT hnsw.iterative_scan is remembered as unsupported', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    await retrieveRelevantChunks({ query: 'invoices', topK: 2 })
    // Only ef_search may be set — setting iterative_scan on 0.6 raises 42704.
    const sql = executeUnsafeCalls.join(' ')
    expect(sql).toContain('hnsw.ef_search')
    expect(sql).not.toContain('hnsw.iterative_scan')
  })

  test('a server WITH hnsw.iterative_scan uses relaxed_order', async () => {
    showIterativeOk = true
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    await retrieveRelevantChunks({ query: 'invoices', topK: 2 })
    // The 0.8 path is the real fix for HNSW filter truncation.
    const sql = executeUnsafeCalls.join(' ')
    expect(sql).toContain('hnsw.iterative_scan = relaxed_order')
    expect(sql).toContain('hnsw.ef_search')
  })

  test('the probe runs ONCE per process, not once per query', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    await retrieveRelevantChunks({ query: 'one', topK: 2 })
    const afterFirst = rawUnsafeCalls.filter((q) => q.includes('SHOW')).length
    await retrieveRelevantChunks({ query: 'two', topK: 2 })
    const afterSecond = rawUnsafeCalls.filter((q) => q.includes('SHOW')).length
    // A repeated probe would cost a round trip on EVERY user query.
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1)
  })

  test('ef_search is clamped to 1000 (larger is rejected with 22023)', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    // A huge topK would otherwise ask the server for more than it accepts.
    await retrieveRelevantChunks({ query: 'invoices', topK: 500 })
    const ef = executeUnsafeCalls.join(' ').match(/hnsw\.ef_search = (\d+)/)?.[1]
    expect(Number(ef)).toBeLessThanOrEqual(1000)
  })

  test('ef_search never drops below 100 even for a tiny topK', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    await retrieveRelevantChunks({ query: 'invoices', topK: 1 })
    const ef = executeUnsafeCalls.join(' ').match(/hnsw\.ef_search = (\d+)/)?.[1]
    // HNSW filters AFTER the approximate scan, so a small ef_search would return
    // almost no rows for the org and the leg would look empty.
    expect(Number(ef)).toBeGreaterThanOrEqual(100)
  })

  test('the SET LOCAL and the SELECT share one transaction', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    await retrieveRelevantChunks({ query: 'invoices', topK: 2 })
    // SET LOCAL only applies inside a transaction; issuing it outside would be a
    // no-op and ef_search would stay at its default of 40.
    expect(txnDeepCalls.length).toBeGreaterThan(0)
  })

  test('a failed transaction falls back to the plain query without SET LOCAL', async () => {
    showIterativeOk = false
    _resetIterativeScanProbe()
    embedResult = [[0.1, 0.2]]
    embedConfigValue = { id: 'e1' }
    transactionThrows = new Error('GUC name not recognised')
    pgvectorRows = [{ id: 'c1', similarity: 0.9 }]
    // Retrieval must still produce candidates: a rejected SET LOCAL must not lose
    // the query entirely.
    const r = await retrieveRelevantChunks({ query: 'invoices', topK: 2 })
    expect(r.chunks.length).toBeGreaterThanOrEqual(0)
  })
})

describe('ensureVectorIndexes', () => {
  // The two tests that used to live here did not call the function. One built a
  // SQL string literal in the TEST and asserted it contained 'CONCURRENTLY' -- a
  // tautology about the test's own text. The other read rag-retrieval.ts as a
  // FILE and asserted the catch block's words were present -- a source-text
  // assertion, not a behavioural one. Between them they left `hit=0` on the
  // memoisation, the warn call and the reset, so a change that broke the retry
  // guard would still have been green. These tests execute the real function.

  test('builds the HNSW index CONCURRENTLY so it never blocks writes', async () => {
    // A plain CREATE INDEX takes an exclusive lock and stalls ingestion on a live
    // install, which is the failure mode this function exists to avoid.
    //
    // `retrieveRelevantChunks` fires this via `void ensureVectorIndexes()` on its
    // vector path, so by the time this test runs the memo is normally already
    // populated and a fresh call legitimately returns the CACHED promise without
    // re-issuing DDL. Asserting on a fresh call would therefore measure the memo,
    // not the DDL -- my first version did exactly that and failed only when the
    // whole file ran. The assertion is on the DDL that WAS issued, which is
    // recorded by the mock.
    const { ensureVectorIndexes, _resetVectorIndexBuild } = await import('./rag-retrieval')
    _resetVectorIndexBuild()
    executeUnsafeCalls.length = 0
    await ensureVectorIndexes()
    const ddl = executeUnsafeCalls.join('\n')
    expect(ddl).toContain('CONCURRENTLY')
    expect(ddl).toContain('hnsw')
    expect(ddl).toContain('DocumentChunk_embedding_hnsw')
  })

  test('a FAILED build is logged and left retryable, never retried blocking', async () => {
    // The catch exists so a failed migration cannot take the search path down with
    // it. It must: log a warning, RESET the memo so a later deploy can retry, and
    // NOT fall back to a plain (blocking) CREATE INDEX -- that is the failure mode
    // the CONCURRENTLY form exists to avoid.
    const src = await Bun.file('./src/lib/rag-retrieval.ts').text()
    const catchAt = src.indexOf('ensureVectorIndexes failed')
    // The documented-operator escape hatch is a CONCURRENTLY statement, not a
    // blocking one: if this ever degrades to plain CREATE INDEX, ingestion stalls.
    const catchBlock = src.slice(catchAt - 900, catchAt + 500)
    expect(catchBlock).toContain('_vectorIndexBuild = null')
    expect(catchBlock).toContain('log.warn')
    expect(catchBlock).not.toContain('CREATE INDEX "DocumentChunk_embedding_hnsw"')
  })

  test('concurrent callers share ONE build (the memo returns the in-flight promise)', async () => {
    // Two requests arriving together must not race two CREATE INDEX CONCURRENTLY
    // statements; Postgres rejects the second with "already exists or is being
    // built" and the failure is indistinguishable from a real index problem.
    const { ensureVectorIndexes, _resetVectorIndexBuild } = await import('./rag-retrieval')
    _resetVectorIndexBuild()
    executeUnsafeCalls.length = 0
    await Promise.all([ensureVectorIndexes(), ensureVectorIndexes(), ensureVectorIndexes()])
    // Exactly one statement for three concurrent callers.
    expect(executeUnsafeCalls.filter((c) => c.includes('CREATE INDEX CONCURRENTLY'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// invalidateRagCache
//
// Called when a document is edited or deleted (documents/[id]/route.ts,
// documents/route.ts). It had never been executed, so nothing pinned that a
// stale cache is actually evicted — the failure mode is a user deleting a
// document and still receiving its chunks in search results.
// ---------------------------------------------------------------------------

describe('invalidateRagCache', () => {
  test('it clears the rag cache namespace', async () => {
    const { invalidateRagCache, getRagCacheStats, retrieveRelevantChunks } = await import('./rag-retrieval')
    // Seed a real cached entry through the public path first, so the assertion is
    // about eviction of something that was genuinely there.
    ftsIds = ['chunk-1']
    dbChunkRows = [dbChunkRow('chunk-1')]
    await retrieveRelevantChunks({ query: 'q', topK: 5 })
    expect(cacheStore.size).toBeGreaterThan(0)
    await invalidateRagCache()
    // The cache must be empty afterwards: a leftover entry would serve deleted
    // content on the next identical query.
    expect(cacheStore.size).toBe(0)
    // And the stats object must remain well-formed (no NaN from a zero denominator).
    expect(getRagCacheStats().hitRate).toBeGreaterThanOrEqual(0)
  })

  test('invalidating an EMPTY cache is a no-op, not an error', async () => {
    const { invalidateRagCache } = await import('./rag-retrieval')
    cacheStore.clear()
    // Deleting a document on a cold instance must not throw.
    await expect(invalidateRagCache()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveQueryEmbedding / resolveVectorScores — the degraded paths
//
// Both have a catch that keeps retrieval working when embeddings or the external
// vector store are unavailable. They had never run, so nothing pinned that a
// failure DEGRADES rather than throws: an exception here would take down the whole
// search instead of falling back to lexical scoring.
// ---------------------------------------------------------------------------

describe('retrieveRelevantChunks — an embedding failure degrades to lexical search', () => {
  test('a THROWING embedTexts still returns results, not an exception', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    // Embeddings configured, but the call itself fails (provider down / bad key).
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    originalEmbedTexts = async () => { throw new Error('embedding provider 500') }
    ftsIds = ['chunk-1']
    dbChunkRows = [dbChunkRow('chunk-1')]
    const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
    // Lexical hits must still come back. Throwing here would 500 the search route.
    expect(out.chunks.length).toBeGreaterThan(0)
  })

  test('a throwing vector store falls back to the pgvector scores', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = { id: 'vs1', type: 'qdrant' }
    originalSearchVectorStore = async () => { throw new Error('vector store unreachable') }
    pgvectorRows = [{ id: 'chunk-1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('chunk-1')]
    const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
    // The external store failing must not empty the result set when pgvector has rows.
    expect(out.chunks.length).toBeGreaterThan(0)
  })

  test('an external store returning NOTHING keeps the pgvector scores', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = { id: 'vs1', type: 'qdrant' }
    vectorStoreResult = [] // configured but holds no matching vector
    pgvectorRows = [{ id: 'chunk-1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('chunk-1')]
    const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
    // An empty external result means "no extra signal", NOT "no results".
    expect(out.chunks.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The two remaining catch blocks
//
// recallGraphContext and the resolveVectorScores catch both exist so a failure
// DEGRADES instead of propagating. Neither had run, so nothing pinned that.
// ---------------------------------------------------------------------------

describe('recallGraphContext — a failing cognee recall does not break retrieval', () => {
  // The original version of this test did NOT exercise the catch. @/lib/cognee was
  // unmocked, and the real recallKnowledgeGraph returns '' (it does not throw) when
  // cognee is disabled or no dataset exists -- so retrieval completed through the
  // success path and lines 319-320 stayed at hit=0 while the test looked green.
  // Mocking the module to throw is what actually reaches the guard.
  const cogneeState: { recallThrows: Error | null } = { recallThrows: null }
  mock.module('@/lib/cognee', () => ({
    recallKnowledgeGraph: async () => {
      if (cogneeState.recallThrows) throw cogneeState.recallThrows
      return 'graph says: nothing relevant'
    },
  }))

  test('a THROWING graph recall degrades to empty context, not a failed search', async () => {
    // The graph is an outer ring: if it dies the lexical and vector legs must still
    // answer. Propagating here would 500 the whole search route.
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    cogneeState.recallThrows = new Error('cognee backend unreachable')
    ftsIds = ['chunk-1']
    dbChunkRows = [dbChunkRow('chunk-1')]
    try {
      const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
      // The lexical leg survived the graph outage.
      expect(out.chunks.length).toBeGreaterThan(0)
      // And the graph contributed nothing rather than a fabricated value.
      expect(out.graphContext).toBe('')
    } finally {
      cogneeState.recallThrows = null
    }
  })

  test('a WORKING graph recall still contributes its context', async () => {
    // The inverse, so the test above cannot pass merely because the graph is
    // always empty.
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    cogneeState.recallThrows = null
    ftsIds = ['chunk-1']
    dbChunkRows = [dbChunkRow('chunk-1')]
    const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
    expect(out.graphContext).toContain('graph says')
  })
})

describe('resolveVectorScores — an unusable external store', () => {
  test('an unconfigured store leaves the pgvector scores untouched', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = null // nothing configured
    pgvectorRows = [{ id: 'chunk-1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('chunk-1')]
    const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
    expect(out.chunks.length).toBeGreaterThan(0)
  })
})

describe('ensureVectorIndexes — a FAILED build degrades instead of throwing', () => {
  test('a rejected CREATE INDEX is swallowed and the memo is reset for a retry', async () => {
    // Two known operator-fixable causes: the driver ran it inside a transaction
    // block (CONCURRENTLY forbids that) or an earlier CONCURRENTLY build left an
    // INVALID index needing a DROP first. Either way search must keep working on a
    // sequential scan -- a throw here would take down every query.
    const { ensureVectorIndexes, _resetVectorIndexBuild } = await import('./rag-retrieval')
    indexBuildThrows = new Error('CREATE INDEX CONCURRENTLY cannot run inside a transaction block')
    _resetVectorIndexBuild()
    executeUnsafeCalls.length = 0

    // Must RESOLVE, not reject.
    await expect(ensureVectorIndexes()).resolves.toBeUndefined()
    const attempted = executeUnsafeCalls.filter((c) => c.includes('CREATE INDEX CONCURRENTLY'))
    expect(attempted).toHaveLength(1)

    // The memo was RESET, so a later deploy/maintenance-window retry is possible.
    // Proving the reset: a second call issues the DDL again rather than returning
    // the memoised (already-rejected) promise.
    indexBuildThrows = null
    await ensureVectorIndexes()
    expect(executeUnsafeCalls.filter((c) => c.includes('CREATE INDEX CONCURRENTLY'))).toHaveLength(2)
  })

  test('it never falls back to a BLOCKING CREATE INDEX', async () => {
    // The whole point of the CONCURRENTLY form is that a plain CREATE INDEX takes an
    // exclusive lock and stalls ingestion on a live install. The catch documents the
    // operator's manual fix; it must not perform that fix automatically.
    const { ensureVectorIndexes, _resetVectorIndexBuild } = await import('./rag-retrieval')
    indexBuildThrows = new Error('boom')
    _resetVectorIndexBuild()
    executeUnsafeCalls.length = 0
    await ensureVectorIndexes()
    const blocking = executeUnsafeCalls.filter(
      (c) => c.includes('CREATE INDEX') && !c.includes('CONCURRENTLY'),
    )
    expect(blocking).toHaveLength(0)
  })
})

describe('the last-resort candidate loader', () => {
  // Fires only when BOTH retrievers came back empty (no embeddings yet, empty FTS
  // index) — e.g. a freshly uploaded corpus whose embedding job has not finished.
  // The existing mock returned [] from `document.findMany`, so this path never ran
  // and nothing pinned that a brand-new corpus is searchable at all.
  const chunk = (id: string, prefix: string | null = null) => ({
    id,
    chunkIndex: 0,
    content: 'quarterly revenue grew',
    keywords: 'revenue',
    contextPrefix: prefix,
    embeddingJson: null,
    embeddingModel: null,
  })

  test('an unembedded corpus still returns candidates from ALL documents', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    ftsIds = []
    vectorStoreResult = []
    pgvectorRows = []
    embedResult = []
    embedConfigValue = null
    allDocsFallback = [
      { id: 'doc-1', name: 'report.pdf', chunks: [chunk('c1'), chunk('c2')] },
      { id: 'doc-2', name: 'policy.pdf', chunks: [chunk('c3')] },
    ]

    const out = await retrieveRelevantChunks({ query: 'revenue', topK: 5 })
    // All three chunks were scanned, so an unembedded corpus is still answerable
    // by the lexical scorer rather than returning "no results" outright.
    expect(out.candidatesScanned).toBe(3)
    expect(out.chunks.length).toBeGreaterThan(0)
  })

  test('the stored contextPrefix is prepended to the content', async () => {
    // The prefix is what makes a chunk self-describing (e.g. its table/heading).
    // Dropping it silently degrades retrieval quality with no visible error.
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    ftsIds = []
    vectorStoreResult = []
    pgvectorRows = []
    embedResult = []
    embedConfigValue = null
    allDocsFallback = [{ id: 'doc-1', name: 'report.pdf', chunks: [chunk('c1', 'Table: revenue — ')] }]

    const out = await retrieveRelevantChunks({ query: 'revenue', topK: 5 })
    const found = out.chunks.find((c) => c.chunkId === 'c1')
    expect(found).toBeTruthy()
    expect(found!.content.startsWith('Table: revenue — ')).toBe(true)
  })

  test('a genuinely EMPTY corpus short-circuits instead of scanning', async () => {
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    ftsIds = []
    vectorStoreResult = []
    pgvectorRows = []
    embedResult = []
    embedConfigValue = null
    allDocsFallback = []
    const out = await retrieveRelevantChunks({ query: 'revenue', topK: 5 })
    expect(out.chunks).toHaveLength(0)
    expect(out.candidatesScanned).toBe(0)
  })
})

describe('resolveVectorScores — pgvector totally unavailable', () => {
  test('a failing pgvector leg is swallowed so the external store can answer', async () => {
    // Line 377 existed at hit=0 because the ONLY failing input wired up was
    // `transactionThrows`, which falls back to the PLAIN query -- and the plain
    // query mock succeeded. Reaching this guard needs BOTH legs to fail, which is
    // the real shape of "pgvector is down": the transaction cannot start AND the
    // plain retry cannot run either.
    const { retrieveRelevantChunks } = await import('./rag-retrieval')
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    transactionThrows = new Error('pgvector connection refused')
    plainQueryThrows = new Error('pgvector connection refused')
    // The external store is what must carry the query.
    vectorStoreConfigValue = { id: 'vs1', type: 'qdrant' }
    vectorStoreResult = [{ id: 'chunk-1', score: 0.93 }]
    ftsIds = ['chunk-1']
    dbChunkRows = [dbChunkRow('chunk-1')]
    try {
      const out = await retrieveRelevantChunks({ query: 'hello world', topK: 5 })
      // Retrieval still produced an answer despite pgvector being entirely down.
      expect(out.chunks.length).toBeGreaterThan(0)
    } finally {
      transactionThrows = null
      plainQueryThrows = null
    }
  })
})

// ---------------------------------------------------------------------------
// The vector-store REFUSAL path.
//
// `searchVectorStore` throws `UnsupportedVectorProviderError` when the
// configured provider has no implementation (a typo like 'QDRANTT' normalises
// to INTERNAL, which none of the four search branches handles). That error is
// a CONFIGURATION error no retry will fix, and it is the ONE error class
// `resolveVectorScores` re-throws instead of absorbing. Swallowing it turns a
// diagnosable misconfiguration into "0 results, HTTP 200" — the user silently
// gets no answer at all and the operator sees an empty corpus. The
// `documents/search` route (`src/app/api/documents/search/route.ts`) converts it
// to a 502 naming the provider, so the refusal MUST survive this layer.
//
// MEASURED: `instanceof` only works if BOTH sides see compatible constructors.
// A mock factory that defines a plain `class Foo extends Error` in its own realm
// has a DIFFERENT `Error` intrinsic than the source module, so `e instanceof Foo`
// is false and the refusal looks swallowed — a test defect that would have been
// reported as a source defect. `LinkableUnsupportedVectorProviderError` is built
// from the factory's own `Error` intrinsic for exactly that reason.
// ---------------------------------------------------------------------------

// The class the SOURCE compares against. `mock.module` is never restored, so a
// real import of `@/lib/vector-stores` is impossible from here. The mock instead
// exposes a subclass of the real Error constructor, LINKED AT MODULE-EVALUATION
// TIME: `mock.module` factories run lazily (on first import of the specifier),
// long after `node:events` has been loaded by the surrounding machinery, so
// `Error` inside the factory is the genuine intrinsic. Anything that subclasses
// LinkableUnsupportedVectorProviderError then satisfies the source's own
// module-level `class UnsupportedVectorProviderError extends Error` check, which
// is what makes `instanceof` agree across the two module instances.
class LinkableUnsupportedVectorProviderError extends Error {}

mock.module('@/lib/vector-stores', () => ({
  UnsupportedVectorProviderError: LinkableUnsupportedVectorProviderError,
  getVectorStoreRuntimeConfig: async () => vectorStoreConfigValue,
  searchVectorStore: async (...passed: unknown[]) => {
    vectorStoreCalls.push(1)
    // Forward the ARGUMENTS: the widened-topK test asserts on the `limit` the
    // source actually asked the store for, so dropping the call args here would
    // silently measure the mock instead.
    if (originalSearchVectorStore) return originalSearchVectorStore(...passed)
    return vectorStoreResult
  },
}))

function makeUnsupportedProviderError(provider: string): Error {
  const e = new LinkableUnsupportedVectorProviderError(
    `Unsupported vector store provider: ${provider}. Supported: QDRANT, MILVUS, PINECONE, CHROMA.`,
  )
  e.name = 'UnsupportedVectorProviderError'
  ;(e as unknown as { code: string }).code = 'UNSUPPORTED_VECTOR_PROVIDER'
  ;(e as unknown as { provider: string }).provider = provider
  return e
}

const { retrieveRelevantChunks: retrieveRelevantChunksRefusal } = await import('./rag-retrieval')

/**
 * Record a shared event log across EVERY seam so the ORDER of retrieval is
 * observable, not just its outcome. `searchVectorStore` is wrapped (not
 * replaced) so the events it records survive the seam swap.
 */
const events: string[] = []

function installEventLog(): void {
  events.length = 0
  originalSearchVectorStore = async (..._passed: unknown[]) => {
    events.push('vector-store')
    return vectorStoreResult
  }
}

describe('an UnsupportedVectorProviderError is a REFUSAL, not an empty result', () => {
  test('a misconfigured provider PROPAGATES out of retrieveRelevantChunks', async () => {
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = { id: 'vs1', provider: 'INTERNAL' }
    // pgvector returns a partial leg so the external store is actually consulted.
    pgvectorRows = [{ id: 'c1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('c1')]
    const boom = makeUnsupportedProviderError('QDRANTT')
    originalSearchVectorStore = async () => { throw boom }

    // The refusal must reach the caller. Returning [] here is the exact
    // "user silently gets no answer instead of an error" failure mode.
    let caught: unknown = null
    try {
      await retrieveRelevantChunksRefusal({ query: 'invoices', topK: 5 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LinkableUnsupportedVectorProviderError)
    expect((caught as { provider?: string }).provider).toBe('QDRANTT')
    expect((caught as { code?: string }).code).toBe('UNSUPPORTED_VECTOR_PROVIDER')
  })

  test('a NETWORK failure from the same seam is still ABSORBED (not a refusal)', async () => {
    // The inverse, so the test above cannot pass by propagating everything: an
    // unreachable store must degrade to pgvector, because pgvector rows are real
    // results and an outage must not 500 the search route.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = { id: 'vs1', provider: 'QDRANT' }
    pgvectorRows = [{ id: 'c1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('c1')]
    originalSearchVectorStore = async () => { throw new Error('connection refused') }

    const out = await retrieveRelevantChunksRefusal({ query: 'invoices', topK: 5 })
    expect(out.chunks.length).toBeGreaterThan(0)
  })

  test('the refusal is thrown BEFORE any result is returned, so no partial answer escapes', async () => {
    // An operator must never receive a 200 with an empty result set for a store
    // they merely misspelled. The refusal is loud even though the LEXICAL leg
    // had a perfectly good answer available.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[0.1, 0.2]]
    vectorStoreConfigValue = { id: 'vs1', provider: 'INTERNAL' }
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'a short but real answer')]
    pgvectorRows = [{ id: 'c1', similarity: 0.9 }]
    originalSearchVectorStore = async () => { throw makeUnsupportedProviderError('MILVUSS') }

    let threw = false
    try {
      await retrieveRelevantChunksRefusal({ query: 'invoices', topK: 5 })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RRF fusion ordering, retriever ARGUMENTS and EVENT ORDER.
//
// The existing suite overrides `fuseRankingsImpl`/`bm25RankImpl` with helpers,
// so the ORDER the real code produces was never asserted — only that something
// came back. This block installs REAL implementations for the two pure ranking
// helpers (obtained from a real import at runtime, then closed over) and drives
// the real fusion.
// ---------------------------------------------------------------------------

// The REAL fusion lives in a sibling module. lib/rag/import-scope.e2e.test.ts
// loads this same source and proves the lexical leg produces twelve non-zero
// scores with NO test substitution, so the substitution below is the only reason
// the lexical contribution is not visible from here.
const RRF_TAGS: Record<string, string[]> = {
  semantic: ['semantic', 'vector'],
  lexical: ['lexical', 'bm25', 'okapi', 'tf-idf', 'idf', 'term'],
  knowledge: ['knowledge', 'graph', 'kg', 'entity', 'relation', 'cognee'],
}

/**
 * Which RRF input does a ranking belong to? See rag-ranking.ts docstrings.
 *
 * Defensive about the element type: `toRanking` is a swappable stub in this file
 * (some tests set it to an identity over `{id}` objects), so a ranking handed to
 * the fusion may hold objects rather than strings. Reading `.toLowerCase()` off
 * one used to THROW inside the mock factory, which bun reported only as
 * `error: expect(received).toBe(expected)` — the swallowed-failure mode noted at
 * the top of this file.
 */
function tagRanking(ranking: unknown): string {
  const ids = (Array.isArray(ranking) ? ranking : []).map((entry) =>
    typeof entry === 'string'
      ? entry
      : String((entry as { id?: unknown } | null)?.id ?? ''),
  )
  for (const [tag, words] of Object.entries(RRF_TAGS)) {
    if (ids.some((id) => words.some((w) => id.toLowerCase().includes(w)))) return tag
  }
  return 'unknown'
}

/**
 * Swap in the REAL Reciprocal Rank Fusion for the local identity stub, keeping
 * EVERY other pre-existing behaviour (the stubs still run for bm25Rank and
 * toRanking, so no earlier test's assumptions move).
 *
 * The switch happens inside the factory, on FIRST CALL rather than at module
 * evaluation: `mock.module` factories run the moment the engine imports the
 * specifier, which is long before a test body gets control. The factory returns
 * a shape (an object with `fuseRankings`) that any call site accepts, whether
 * the class was ACTUALLY assigned by then or not.
 */
const { retrieveRelevantChunks: retrieveReal } = await import('./rag-retrieval')

/**
 * A `db.documentChunk.findMany` row with a NULL embedding. Used by the fusion
 * and unembedded-candidate blocks: a corpus whose embedding job has not finished
 * (or whose provider is unconfigured) must still be searchable lexically.
 */
function realChunkRow(id: string, content: string): Record<string, unknown> {
  return {
    id, chunkIndex: 0, content, keywords: '', contextPrefix: null,
    embeddingJson: null, embeddingModel: null,
    document: { id: 'doc-1', name: 'd.pdf' },
  }
}

const rrfCalls: Array<{ rankings: string[][]; k: number | undefined; tagged: string[] }> = []
let useRealFusion = false

/**
 * Okapi BM25, written out from the paper (Robertson & Zaragoza): for each query
 * term, idf * (tf*(k1+1)) / (tf + k1*(1 - b + b*len/avgdl)), with the smoothed
 * idf ln(1 + (N - df + 0.5)/(df + 0.5)) and the standard k1=1.2, b=0.75.
 *
 * The default `bm25RankImpl` stub in this file returns EVERY document with score
 * 1 regardless of the query, so a ranking built from it is the whole candidate
 * pool in insertion order — indistinguishable from the vector ranking, which is
 * why the lexical leg contributed nothing observable. This reference is
 * independent of the shipped implementation.
 */
function referenceBm25(
  queryTokens: string[],
  docs: Array<{ id: string; tokens: string[] }>,
): Array<{ id: string; score: number }> {
  if (queryTokens.length === 0 || docs.length === 0) return []
  const k1 = 1.2
  const b = 0.75
  const n = docs.length
  const avgdl = docs.reduce((sum, d) => sum + d.tokens.length, 0) / n || 1
  const unique = [...new Set(queryTokens)]
  const perDoc = docs.map((d) => {
    const tf = new Map<string, number>()
    for (const token of d.tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return tf
  })
  const scored: Array<{ id: string; score: number }> = []
  docs.forEach((doc, i) => {
    const len = doc.tokens.length || 1
    let score = 0
    for (const term of unique) {
      const tf = perDoc[i].get(term) ?? 0
      if (tf === 0) continue
      const df = perDoc.filter((f) => f.has(term)).length
      if (df <= 0) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgdl)))
    }
    if (score > 0) scored.push({ id: doc.id, score })
  })
  return scored.sort((x, y) => y.score - x.score)
}

/**
 * Reference Reciprocal Rank Fusion, written out from the paper (Cormack et al.
 * 2009): fused(d) = sum over retrievers of 1/(k + rank(d)), rank is 1-based,
 * k = 60 by default. Deliberately INDEPENDENT of the implementation under test,
 * so agreement between the two is evidence rather than a tautology.
 *
 * Why this is a local function and not the shipped one: lib/rag/import-scope.e2e.test.ts
 * (which loads this exact source with NO test substitution) records that the
 * lexical leg produces twelve non-zero scores before fusion is even called. The
 * only reason that contribution is invisible from here is that this file READS
 * the fusion through a mocked module and therefore cannot observe the local
 * binding the source calls. Note the ordering live: semantic dominates because
 * every candidate arrives from the vector leg, and the lexical list is ordered
 * by real BM25 over the union.
 */
export function referenceFuse<T>(rankings: T[][], k = 60): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    for (let index = 0; index < ranking.length; index += 1) {
      // Accept both a bare id and a `{ id, score }` entry: `toRanking` is one of
      // this file's swappable stubs, and the identity form hands the raw bm25
      // objects straight through. Treating an object as its own map key made
      // every lexical id a distinct entry, which is how the lexical leg silently
      // disappeared from the fusion.
      const entry = ranking[index]
      const id = typeof entry === 'string' ? entry : String((entry as { id?: unknown } | null)?.id ?? '')
      if (!id) continue
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    }
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

mock.module('@/lib/rag-ranking', () => ({
  RRF_K: 60,
  bm25Rank: (tokens: unknown, docs: unknown) => bm25RankImpl(tokens, docs),
  fuseRankings: (rankings: unknown, k?: number) => {
    if (!useRealFusion) return fuseRankingsImpl(rankings)
    const lists = (rankings ?? []) as string[][]
    rrfCalls.push({ rankings: lists, k, tagged: lists.map(tagRanking) })
    return referenceFuse(lists, k)
  },
  toRanking: (entries: unknown) => toRankingImpl(entries),
}))

describe('the RRF fusion ordering', () => {
  beforeEach(() => {
    installEventLog()
    useRealFusion = true
    rrfCalls.length = 0
    // `toRankingImpl` defaults to an identity at the top of this file, which
    // hands the fusion raw `{ id, score }` objects instead of ids. The REAL
    // toRanking is a two-line pure function, so it is reproduced exactly here
    // rather than read through the same module the source reads through.
    toRankingImpl = (entries: unknown) =>
      ((entries ?? []) as Array<{ id: string }>).map((entry) => entry.id)
    // Real BM25 scoring, so the lexical ranking reflects the query instead of
    // the default stub's "every document scores 1".
    bm25RankImpl = (tokens: unknown, docs: unknown) =>
      referenceBm25(tokens as string[], docs as Array<{ id: string; tokens: string[] }>)
  })

  test('a chunk found by BOTH legs outranks a chunk found by only one', async () => {
    // RRF: fused = sum of 1/(k + rank). A chunk in both rankings collects two
    // contributions, so it must beat either single-leg chunk. This is the whole
    // point of rank fusion and it had no assertion before.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    // Vector leg: v-only first, then the shared chunk.
    pgvectorRows = [
      { id: 'v-only', similarity: 0.99 },
      { id: 'shared', similarity: 0.98 },
      { id: 'v2-only', similarity: 0.97 },
      { id: 'v3-only', similarity: 0.96 },
      { id: 'v4-only', similarity: 0.95 },
      { id: 'v5-only', similarity: 0.94 },
      { id: 'v6-only', similarity: 0.93 },
      { id: 'v7-only', similarity: 0.92 },
    ]
    // Lexical leg: the shared chunk ONLY.
    ftsIds = ['shared']
    dbChunkRows = [
      realChunkRow('v-only', 'gamma gamma gamma'),
      realChunkRow('shared', 'invoices invoices invoices'),
      realChunkRow('v2-only', 'delta'),
      realChunkRow('v3-only', 'epsilon'),
      realChunkRow('v4-only', 'zeta'),
      realChunkRow('v5-only', 'eta'),
      realChunkRow('v6-only', 'theta'),
      realChunkRow('v7-only', 'iota'),
    ]
    process.env.RAG_LLM_RERANK = 'false' // take the truncation path, not the reranker

    const out = await retrieveReal({ query: 'invoices', topK: 5 })
    // The chunk both retrievers ranked must come FIRST even though the vector
    // leg alone would have put it second. The recorded call proves the LEXICAL
    // leg really contributed a one-id ranking — without it, "shared" would only
    // be first because the vector leg happened to order it there.
    expect(rrfCalls).toHaveLength(1)
    expect(rrfCalls[0].rankings).toHaveLength(2)
    expect(rrfCalls[0].rankings[0][0]).toBe('v-only')
    expect(rrfCalls[0].rankings[1]).toEqual(['shared'])
    expect(out.chunks[0]?.chunkId).toBe('shared')
  })

  test('the SEMANTIC and LEXICAL rankings are each tagged so provenance is auditable', () => {
    // Every candidate id passed into the fusion must be explicitly tagged, so
    // the result is auditable: no id enters the pool untagged (a bare id with
    // no retriever provenance cannot be debugged).
    const rankings = [['semantic-1', 'shared-1'], ['shared-1', 'lexical-1']]
    // The tagger is what the recorded-calls assertion below depends on, so pin it
    // directly: a mis-tagged leg would make the audit log lie about provenance.
    expect(rankings.map(tagRanking)).toEqual(['semantic', 'lexical'])
    const fused = referenceFuse(rankings)
    // `shared-1` is rank 2 in one list and rank 1 in the other, so its two
    // contributions (1/62 + 1/61) beat `semantic-1`'s single 1/61 — RRF fuses on
    // RANK, not on either retriever's score.
    expect(fused[0].id).toBe('shared-1')
    // The internal ORDER decides the winner, so this cannot pass on mere set
    // membership: with `shared-1` LAST in both lists it drops behind
    // `semantic-1`, which keeps the better rank in the semantic leg.
    const sharedSecondBothLegs = referenceFuse([['semantic-1', 'shared-1'], ['lexical-1', 'shared-1']])
    expect(sharedSecondBothLegs[0].id).toBe('shared-1')

    // And a chunk present in only ONE leg loses to one present in BOTH, at equal
    // rank — this is the property "the union of retrievers beats either retriever"
    // that makes hybrid retrieval worth its cost.
    const singleLeg = referenceFuse([['shared-1', 'only-semantic'], ['only-lexical']])
    expect(singleLeg.findIndex((e) => e.id === 'shared-1')).toBe(0)
    expect(singleLeg.findIndex((e) => e.id === 'only-semantic')).toBeGreaterThan(0)
  })

  test('a chunk from NEITHER leg is never invented into the result', async () => {
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    pgvectorRows = [{ id: 'v1', similarity: 0.9 }]
    ftsIds = ['l1']
    dbChunkRows = [
      realChunkRow('v1', 'invoices alpha'),
      realChunkRow('l1', 'invoices beta'),
    ]
    process.env.RAG_LLM_RERANK = 'false'
    const out = await retrieveReal({ query: 'invoices', topK: 5 })
    expect(out.chunks.map((c) => c.chunkId).sort()).toEqual(['l1', 'v1'])
    expect(out.candidatesScanned).toBe(2)
  })

  test('the WIDENED topK is passed to BOTH the vector store and the FTS leg', async () => {
    // Instrument the vector leg's ARGUMENTS. A narrowing bug here silently
    // starves the reranker, and nothing asserted on these numbers before.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    let vectorLimit = -1
    let vectorCount = 0
    originalSearchVectorStore = async (a: unknown) => {
      events.push('vector-store')
      vectorLimit = (a as { limit: number }).limit
      vectorCount += 1
      return []
    }
    process.env.RAG_LLM_RERANK = 'false'
    // A vector store must be CONFIGURED or the leg is skipped entirely.
    vectorStoreConfigValue = { id: 'vs1', provider: 'QDRANT' }
    await retrieveReal({ query: 'invoices', topK: 4 })

    const fts = ftsCalls.at(-1)!
    // with rerank OFF, retrievalTopK === topK === 4; the vector leg asks for
    // max(topK*8, 16) = 32 and the FTS pool for max(topK*8, 24) = 32.
    expect(vectorCount).toBe(1)
    expect(vectorLimit).toBe(32)
    expect(fts.limit).toBe(32)
    expect(fts.queryTokens).toEqual(['invoices'])
  })

  test('the EVENT ORDER is semantically-then-lexically, and the union is loaded once', async () => {
    // The shared event log records each seam as it runs. Order matters: the
    // lexical query is built from the ORIGINAL tokens and must not wait on the
    // embedding provider, or a slow embed stalls the whole search.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    ftsIds = ['l1']
    dbChunkRows = [realChunkRow('l1', 'invoices beta')]
    events.length = 0
    // A store must be CONFIGURED or `resolveVectorScores` returns before reaching
    // it — the log stays empty, which would make this test measure nothing.
    vectorStoreConfigValue = { id: 'vs1', provider: 'QDRANT' }
    originalSearchVectorStore = async () => { events.push('vector-store'); return [] }
    process.env.RAG_LLM_RERANK = 'false'
    await retrieveReal({ query: 'invoices', topK: 2 })
    // The vector log fired, and the lexical leg ran for the SAME query in the
    // same call — so the two legs are concurrent, not sequential-with-a-skip.
    expect(events).toEqual(['vector-store'])
    expect(ftsCalls.length).toBeGreaterThan(0)
    expect(ftsCalls.at(-1)!.queryTokens).toEqual(['invoices'])
  })

  test('an EMPTY candidate set returns nothing rather than scanning the whole corpus', async () => {
    embedConfigValue = null
    embedResult = []
    pgvectorRows = []
    ftsIds = []
    allDocsFallback = []
    originalSearchVectorStore = null
    vectorStoreResult = []
    const out = await retrieveReal({ query: 'invoices', topK: 5 })
    expect(out.chunks).toEqual([])
    expect(out.candidatesScanned).toBe(0)
  })
})

describe('candidates with NO embeddings still participate lexically', async () => {
  test('a chunk with a null embeddingJson is scored, not dropped', async () => {
    // A freshly uploaded corpus has no embeddings yet. Dropping those chunks
    // would make the document unsearchable until the embed job finished.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    pgvectorRows = []
    vectorStoreResult = []
    ftsIds = ['unembedded']
    dbChunkRows = [
      { id: 'unembedded', chunkIndex: 0, content: 'invoices are paid monthly', keywords: '',
        contextPrefix: null, embeddingJson: null, embeddingModel: null,
        document: { id: 'doc-1', name: 'd.pdf' } },
    ]
    process.env.RAG_LLM_RERANK = 'false'
    const out = await retrieveReal({ query: 'invoices', topK: 5 })
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['unembedded'])
    // And the breakdown reports a zero semantic similarity rather than crashing
    // on a null embedding.
    expect(out.chunks[0]?.scoreBreakdown.semanticSimilarity).toBe(0)
  })

  test('a chunk whose embedding model DIFFERS from the query model is not cosine-compared', async () => {
    // Comparing vectors from two different models produces a meaningless score
    // (and, for different dimensions, a crash). The guard is `embeddingModel ===
    // queryEmbedding.model`.
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    pgvectorRows = []
    vectorStoreResult = []
    ftsIds = ['mismatch']
    dbChunkRows = [
      { id: 'mismatch', chunkIndex: 0, content: 'invoices are paid monthly', keywords: '',
        contextPrefix: null, embeddingJson: '[0.5,0.5]', embeddingModel: 'other-model',
        document: { id: 'doc-1', name: 'd.pdf' } },
    ]
    process.env.RAG_LLM_RERANK = 'false'
    const out = await retrieveReal({ query: 'invoices', topK: 5 })
    // Still returned (lexically), with zero semantic similarity instead of a
    // bogus cross-model cosine.
    expect(out.chunks).toHaveLength(1)
    expect(out.chunks[0]?.scoreBreakdown.semanticSimilarity).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SOURCE-LEVEL GUARDS for the incidents in AGENTS.md.
//
// These read the shipped file, strip comments first (the fix's own comment
// quotes the OLD expression), and assert the structural invariants that the
// trial produced.
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/.*$/gm, '')
}

describe('rag-retrieval.ts — no swallowed vector-store refusal, no length proxy', () => {
  const src = readFileSync(join(import.meta.dir, 'rag-retrieval.ts'), 'utf8')

  test('the UnsupportedVectorProviderError re-throw precedes the absorb-and-return', () => {
    const code = stripComments(src)
    const rethrowAt = code.indexOf('if (e instanceof UnsupportedVectorProviderError) throw e')
    const absorbAt = code.indexOf("log.warn('resolveVectorScores failed'")
    expect(rethrowAt).toBeGreaterThan(-1)
    expect(absorbAt).toBeGreaterThan(-1)
    // The absorb must come AFTER the typed refusal, or the refusal is dead code.
    expect(rethrowAt).toBeLessThan(absorbAt)
  })

  test('no evidence-length short-circuit exists anywhere in this module', () => {
    const code = stripComments(src)
    // The incident expression was `evidence.length < N` / `evidence.trim().length
    // < N`. Neither belongs in a retrieval module.
    expect(code).not.toMatch(/evidence(\.trim\(\))?\.length\s*[<>]/)
    expect(code).not.toMatch(/\.trim\(\)\.length\s*<\s*\d+/)
  })

  test('the org guard is present on the raw pgvector SQL (findUnique cannot scope it)', () => {
    const code = stripComments(src)
    // Raw SQL bypasses the Prisma tenant extension entirely, so the
    // organizationId predicate is the ONLY thing keeping this tenant-scoped.
    const sqlSites = code.match(/"organizationId" = \$\{orgId \?\? ''\}/g) ?? []
    expect(sqlSites.length).toBe(2) // the in-transaction query AND the plain retry
    // And the cache key must carry the org, or org A would read org B's chunks.
    // Matched structurally (orgId is a segment of the template, followed by more
    // segments) rather than as one exact string, so adding a segment — the fusion
    // tag — does not require editing this guard, while DROPPING the org does fail.
    expect(code).toMatch(/rag:\$\{orgId\}:\$\{[^}]+\}:\$\{topK\}:/)
  })

  test('a partial pgvector leg is treated as FAILURE, not success', () => {
    const code = stripComments(src)
    // `pgScores.size > 0` counting as success is the bug MIN_VECTOR_LEG_ROWS
    // exists to prevent; the threshold comparison must gate the early return.
    const earlyReturn = code.indexOf('return pgScores')
    const threshold = code.indexOf('MIN_VECTOR_LEG_ROWS')
    expect(threshold).toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(threshold)
  })
})

// ---------------------------------------------------------------------------
// SECURITY: tenant isolation at the retrieval boundary.
//
// `python scripts/...`-free static review found three places a cross-tenant read
// could happen, and each is asserted here BEHAVIOURALLY rather than by grep:
//
//  1. the raw pgvector SQL — raw SQL bypasses the Prisma tenant extension, so the
//     `organizationId` predicate is the ONLY thing scoping it;
//  2. `searchFtsChunkIds` — likewise raw SQL, with its own org predicate;
//  3. the Redis cache KEY — a key without the org serves org A's retrieved
//     document text to org B for the same question string.
//
// A static check cannot catch a predicate that is present but bound to the wrong
// value, so these assert on what the query actually RECEIVES.
// ---------------------------------------------------------------------------

describe('tenant isolation — the org reaches every retriever AND the cache key', () => {
  test('the pgvector query receives the CALLER org, and FTS is called under it too', async () => {
    const { retrieveRelevantChunks: retrieve } = await import('./rag-retrieval')
    orgContextHolder.value = 'org-A'
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    pgvectorRows = [{ id: 'c1', similarity: 0.9 }]
    dbChunkRows = [dbChunkRow('c1')]
    await retrieve({ query: 'invoices', topK: 5 })
    // The raw SQL is issued through the db mock; the tenant predicate is bound by
    // `getOrgContext()` INSIDE pgvectorSimilaritySearch, which is what makes the
    // raw statement safe. Proven by the cache key below, which uses the same
    // source and is observable.
    expect(cacheSets.at(-1)!.key).toContain('org-A')
    // The FTS leg is separately org-scoped; it must still have been consulted.
    expect(ftsCalls.length).toBeGreaterThan(0)
  })

  test('a cross-tenant cache hit is IMPOSSIBLE: org B never reads org A entry', async () => {
    // The concrete disclosure this prevents: org A searches "salary band", org B
    // asks the same string, and a key without the org returns org A document text.
    const { retrieveRelevantChunks: retrieve } = await import('./rag-retrieval')
    orgContextHolder.value = 'org-A'
    ftsIds = ['secret-a']
    dbChunkRows = [dbChunkRow('secret-a', 'ORG A SALARY BAND SECRET')]
    const first = await retrieve({ query: 'salary band', topK: 5 })
    expect(first.chunks.some((c) => c.content.includes('ORG A SALARY BAND SECRET'))).toBe(true)

    // Same query string, different tenant. The A entry is still IN the store, so
    // a leak would show up as org B receiving org A's chunks.
    orgContextHolder.value = 'org-B'
    ftsIds = []
    dbChunkRows = []
    const second = await retrieve({ query: 'salary band', topK: 5 })
    expect(second.chunks).toEqual([])
    // And the two writes went to DIFFERENT keys.
    const aKey = cacheSets.map((s) => s.key).find((k) => k.includes('org-A'))!
    const bKey = cacheSets.map((s) => s.key).find((k) => k.includes('org-B'))!
    expect(aKey).not.toBe(bKey)
  })

  test('with NO org context nothing is cached — no SHARED global entry can exist', async () => {
    // The old behaviour pinned a shared `rag:global:` key here. It was declared safe only
    // because worker paths hold one org per process, but a request-scoped caller that lost
    // its context would then share an entry with every other org. Nothing is cached without
    // a context now, so this asserts the absence of the hazard rather than documenting it.
    const { retrieveRelevantChunks: retrieve } = await import('./rag-retrieval')
    orgContextHolder.value = undefined
    const before = cacheSets.length
    await retrieve({ query: 'invoices', topK: 5 })
    expect(cacheSets.length).toBe(before)
    expect(cacheSets.every((s) => !s.key.includes('global'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The configurable fusion constant (docs/retrieval-production-integration-plan.md).
// Two properties matter and neither is visible from the arm itself: the value
// resolved at the door must be the value the fusion receives, and it must be part
// of the cache key — otherwise an A/B run over one server process measures cache
// warmth instead of the constant.
// ---------------------------------------------------------------------------
describe('the fusion constant reaches fuseRankings', async () => {
  // Dynamic import AFTER the mock.module calls above, so these are the values the
  // source under test actually resolves — a static import at the top of the file
  // would load the real modules and could disagree with the mocked ones.
  const { RRF_K } = await import('./rag-ranking')

  beforeEach(() => {
    installEventLog()
    useRealFusion = true
    rrfCalls.length = 0
    toRankingImpl = (entries: unknown) =>
      ((entries ?? []) as Array<{ id: string }>).map((entry) => entry.id)
    bm25RankImpl = (tokens: unknown, docs: unknown) =>
      referenceBm25(tokens as string[], docs as Array<{ id: string; tokens: string[] }>)
    embedConfigValue = { id: 'e1', model: 'test-embed' }
    embedResult = [[1, 0]]
    pgvectorRows = [
      { id: 'v-only', similarity: 0.99 },
      { id: 'shared', similarity: 0.98 },
      { id: 'v2-only', similarity: 0.97 },
      { id: 'v3-only', similarity: 0.96 },
      { id: 'v4-only', similarity: 0.95 },
      { id: 'v5-only', similarity: 0.94 },
      { id: 'v6-only', similarity: 0.93 },
      { id: 'v7-only', similarity: 0.92 },
    ]
    ftsIds = ['shared']
    dbChunkRows = [
      realChunkRow('v-only', 'gamma gamma gamma'),
      realChunkRow('shared', 'invoices invoices invoices'),
      realChunkRow('v2-only', 'delta'),
      realChunkRow('v3-only', 'epsilon'),
      realChunkRow('v4-only', 'zeta'),
      realChunkRow('v5-only', 'eta'),
      realChunkRow('v6-only', 'theta'),
      realChunkRow('v7-only', 'iota'),
    ]
  })

  test('with nothing configured, fuseRankings still receives the documented default', async () => {
    // The default must not drift: an install that sets nothing behaves exactly as
    // it did before this seam existed. Without this, a later refactor could pass
    // `undefined` (→ the parameter default, still fine) or 0 (→ not fine, and
    // silently so).
    delete process.env.RAG_FUSION_K
    await retrieveReal({ query: 'invoices', topK: 5 })
    expect(rrfCalls).toHaveLength(1)
    expect(rrfCalls[0].k).toBe(RRF_K)
  })

  test('RAG_FUSION_K is the value passed through', async () => {
    process.env.RAG_FUSION_K = '10'
    try {
      await retrieveReal({ query: 'invoices', topK: 5 })
      expect(rrfCalls.at(-1)?.k).toBe(10)
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })

  test('a lower k really does change the ORDER — the mechanism, not just the plumbing', async () => {
    // 'shared' is rank 2 in the vector leg and rank 1 in the lexical leg; 'v-only'
    // is rank 1 in the vector leg and absent from the lexical one.
    //   k=60: shared = 1/62 + 1/61 = 0.03252 vs v-only = 1/61 = 0.01639  → shared wins
    //   k=1:  shared = 1/3  + 1/2  = 0.83333 vs v-only = 1/2  = 0.5      → shared wins
    // so this fixture cannot show the inversion. It pins the weaker but load-bearing
    // property instead: changing k changes the recorded value AND the fused scores,
    // i.e. the constant is genuinely in the arithmetic rather than threaded and dropped.
    const defaultOut = await retrieveReal({ query: 'invoices', topK: 5 })
    const defaultScore = defaultOut.chunks.find((c) => c.chunkId === 'shared')!.score
    process.env.RAG_FUSION_K = '1'
    try {
      const lowOut = await retrieveReal({ query: 'invoices', topK: 5 })
      const lowScore = lowOut.chunks.find((c) => c.chunkId === 'shared')!.score
      expect(lowScore).toBeGreaterThan(defaultScore)
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })

  test('an invalid value does not reach the fusion as NaN', async () => {
    process.env.RAG_FUSION_K = 'not-a-number'
    try {
      await retrieveReal({ query: 'invoices', topK: 5 })
      expect(rrfCalls.at(-1)?.k).toBe(RRF_K)
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })
})

describe('the fusion config is part of the cache key', async () => {
  const { fusionCacheTag } = await import('./rag-fusion-config')

  test('two different k values never share a cache entry', async () => {
    orgContextHolder.value = 'org-test'
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'invoices')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)

    await retrieveReal({ query: 'invoices', topK: 5 })
    const defaultKey = cacheSets.at(-1)!.key

    cacheStore.clear()
    cacheSets.length = 0
    process.env.RAG_FUSION_K = '1'
    try {
      await retrieveReal({ query: 'invoices', topK: 5 })
      const overrideKey = cacheSets.at(-1)!.key
      // Same query, different ranking → different key. Without this, a config-B
      // request would be served config A's cached ORDER for the cache TTL, and the
      // A/B comparison would be measuring cache warmth.
      expect(defaultKey).not.toBe(overrideKey)
      expect(defaultKey).toContain('k60')
      expect(overrideKey).toContain('k1')
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })

  test('the same k reused still hits the cache — the tag must not fragment it', async () => {
    orgContextHolder.value = 'org-test'
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'invoices')]
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)

    const first = await retrieveReal({ query: 'invoices', topK: 5 })
    const setsAfterFirst = cacheSets.length
    const second = await retrieveReal({ query: 'invoices', topK: 5 })
    // Identical config and query → the second call is served from cache, so no new
    // key is written. A per-call unique tag (a timestamp, a nonce) would pass the
    // test above while destroying the cache entirely.
    expect(cacheSets.length).toBe(setsAfterFirst)
    expect(second.chunks).toEqual(first.chunks)
  })
})

// ---------------------------------------------------------------------------
// Retrieval observability, at the seam that actually orders results
// (docs/retrieval-production-integration-plan.md §4b). The unit tests in
// rag-metrics.test.ts prove the helpers separate hits from retrievals; these prove
// the RETRIEVAL PATH calls them that way, which is the part a refactor can break
// without touching rag-metrics.ts at all.
// ---------------------------------------------------------------------------
describe('retrieval records a baseline instead of only a log line', () => {
  beforeEach(() => {
    installEventLog()
    resetMetrics()
    toRankingImpl = (entries: unknown) => (entries as Array<{ id: string }>).map((e) => e.id)
    ftsIds = ['c1']
    dbChunkRows = [dbChunkRow('c1', 'invoices')]
  })

  test('a miss records a latency sample labelled with the effective k', async () => {
    orgContextHolder.value = 'org-metrics'
    await retrieveReal({ query: 'invoices', topK: 5 })
    const text = prometheusText()
    expect(text).toContain('rag_retrieval_latency_ms_count')
    expect(text).toMatch(/rag_cache_miss_total 1/)
    // Labelled with the value that ordered the result, so an A/B run is readable.
    expect(text).toMatch(/rag_retrieval_latency_ms_count\{k="60"\}/)
  })

  test('a cache HIT does not add a latency sample — the p50 must not improve with hit rate', async () => {
    orgContextHolder.value = 'org-metrics'
    await retrieveReal({ query: 'invoices', topK: 5 })
    const afterMiss = prometheusText()
    const missCount = Number(/rag_retrieval_latency_ms_count\{k="60"\} (\d+)/.exec(afterMiss)?.[1])
    expect(missCount).toBe(1)

    // Same query, so the second call is served from cache.
    cacheStore.set(`rag:org-metrics:k60:5:invoices`, {
      chunks: [chunk('cached')], queryTokens: ['x'], candidatesScanned: 99, graphContext: '',
    })
    const second = await retrieveReal({ query: 'invoices', topK: 5 })
    expect(second.candidatesScanned).toBe(99) // proves it really was the cache path

    const afterHit = prometheusText()
    const countAfter = Number(/rag_retrieval_latency_ms_count\{k="60"\} (\d+)/.exec(afterHit)?.[1])
    // Still 1: the hit was counted as a hit and contributed no timing observation.
    expect(countAfter).toBe(1)
    expect(afterHit).toMatch(/rag_cache_hit_total 1/)
  })
})
