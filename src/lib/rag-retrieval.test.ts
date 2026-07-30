import { describe, expect, test, mock } from 'bun:test'

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
  selectTopRetrievedChunks: (chunks: unknown[]) => chunks,
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
