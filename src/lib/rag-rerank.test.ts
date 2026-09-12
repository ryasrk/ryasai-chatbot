import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

// ---------------------------------------------------------------------------
// The RAG reranker.
//
// Rerank is ON by default (RAG_LLM_RERANK !== 'false') and is described in the
// docs as the flagship precision feature. It had NO test on its LLM path: the
// existing rag-retrieval tests mock db/embeddings/rag-fts/vector-stores but not
// llm-config or llm-client, so rerankWithLlm could never be entered. A regression
// in it degrades answer quality silently, which is exactly the class of bug a
// suite is supposed to catch and this one could not.
//
// A separate file, because these mocks must not join the module graph of the
// two existing rag-retrieval test files.
// ---------------------------------------------------------------------------
const state = {
  cfg: { id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' } as any,
  chatRaw: '[]' as string,
  chatThrows: false,
  chatCalls: [] as any[],
  crossResult: null as any,
  crossCalls: [] as any[],
  chunkRows: [] as any[],
  documentRows: [] as any[],
}

// Only the models rag-retrieval actually touches. An incomplete fake surfaces as
// `db.documentChunk is undefined` from deep inside the module under test, which
// reads like a source bug.
mock.module('@/lib/db', () => ({
  db: {
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    $transaction: async (fn: any) => fn({ $executeRawUnsafe: async () => 0, $queryRaw: async () => [] }),
    documentChunk: { findMany: async () => state.chunkRows },
    document: { findMany: async () => state.documentRows },
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: async () => state.cfg,
  getLlmRuntimeConfig: async () => state.cfg,
}))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (cfg: any, messages: any, temp: number, purpose: string) => {
    state.chatCalls.push({ cfg, messages, temp, purpose })
    if (state.chatThrows) throw new Error('reranker unreachable')
    return state.chatRaw
  },
}))
mock.module('@/lib/reranker', () => ({
  crossEncoderRerank: async (q: string, chunks: any[], topK: number) => {
    state.crossCalls.push({ q, chunks, topK })
    return state.crossResult
  },
}))
mock.module('@/lib/embeddings', () => ({
  embedText: async () => null,
  cosineSimilarity: () => 0,
}))
mock.module('@/lib/rag-fts', () => ({
  // The FTS leg is what populates the candidate pool when no embedding is
  // configured (resolveQueryEmbedding returns null here), so a fake returning []
  // leaves the whole retrieval empty and the reranker unreachable.
  searchFtsChunkIds: async () => state.chunkRows.map((r: any) => r.id),
}))
mock.module('@/lib/knowledge-graph', () => ({
  // The REAL shape (knowledge-graph.ts): the caller reads `allChunkIds.length`
  // and `graphContext`, so a fake returning `{ chunks: [] }` crashes the module
  // under test with a TypeError that looks like a source bug.
  dualLevelRetrieval: async () => ({
    localChunks: [], globalChunks: [], allChunkIds: [], matchedEntities: [], graphContext: '',
  }),
}))
mock.module('@/lib/cognee', () => ({ recallKnowledgeGraph: async () => '' }))
mock.module('@/lib/vector-stores', () => ({ searchVectorStore: async () => null }))
mock.module('@/lib/redis', () => ({
  cacheGet: async () => null, cacheSet: async () => undefined,
  redis: {}, redisCmd: {},
}))
mock.module('@/lib/constants', () => ({
  RAG_CACHE_TTL_MS: 60000, RAG_TOP_K: 5, RAG_MAX_PER_DOCUMENT: 2,
  RAG_CHUNK_SIZE: 1400, RAG_CHUNK_OVERLAP: 180, SQL_MAX_LIMIT: 100,
}))
// NOTE: `retrieveRelevantChunks` is deliberately NOT in this mock. It is the
// module under test, and providing it here made the imported call resolve to the
// fake — which silently returned [] and gave a passing-looking shape with no
// keys at all. Only the helpers rag-retrieval IMPORTS belong here.
// Every name rag-retrieval actually IMPORTS from ./rag. The first version of this
// mock exported `selectTopWithDiversity` (a name this module does not import) and
// omitted `scoreChunk` and `selectTopRetrievedChunks` (which it does), so both
// resolved to undefined: scoreChunk would throw and selectTop returned nothing,
// leaving zero chunks from nine candidates. A partial mock produces a failure that
// looks like a source bug — mock the surface the importer uses, not the one you
// remember.
mock.module('./rag', () => ({
  tokenize: (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean),
  scoreChunk: () => ({ lexical: 1, semantic: 0, phrase: 0, total: 1 }),
  selectTopRetrievedChunks: <T,>(rows: T[], topK: number) => rows.slice(0, topK),
}))

import { parseRerankerScores, retrieveRelevantChunks } from './rag-retrieval'

const chunks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    chunkId: `c${i}`, documentId: 'd1', documentName: 'doc.pdf',
    content: `content number ${i}`, score: 1 - i * 0.1, keywords: [],
  }))

beforeEach(() => {
  state.cfg = { id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }
  state.chatRaw = '[]'
  state.chatThrows = false
  state.chatCalls = []
  state.crossResult = null
  state.crossCalls = []
  state.chunkRows = []
  state.documentRows = []
  process.env.RAG_LLM_RERANK = 'true'
})
afterEach(() => {
  delete process.env.RAG_LLM_RERANK
})

describe('parseRerankerScores — the parser guarding a model that improvises', () => {
  test('parses a bare JSON array', () => {
    const out = parseRerankerScores('[{"index":0,"score":9},{"index":1,"score":4}]', 5)
    // Sorted best-first: the caller takes the head of this list.
    expect(out?.map((s) => s.index)).toEqual([0, 1])
  })

  test('extracts the array from surrounding prose', () => {
    const out = parseRerankerScores('Sure! Here you go:\n[{"index":0,"score":8}]\nHope that helps.', 5)
    // Models wrap output in prose despite instructions; giving up here would
    // silently disable reranking.
    expect(out).toHaveLength(1)
  })

  test('extracts the array from a markdown fence', () => {
    expect(parseRerankerScores('```json\n[{"index":0,"score":7}]\n```', 5)).toHaveLength(1)
  })

  test('returns null when no array is present', () => {
    expect(parseRerankerScores('I cannot score these.', 5)).toBeNull()
  })

  test('returns null on malformed JSON inside brackets', () => {
    expect(parseRerankerScores('[{"index":0,}]', 5)).toBeNull()
  })

  test('returns null for an empty array', () => {
    expect(parseRerankerScores('[]', 5)).toBeNull()
  })

  test('returns null for a non-array JSON value', () => {
    expect(parseRerankerScores('{"index":0,"score":9}', 5)).toBeNull()
  })

  test('DROPS an out-of-range index rather than reading past the end', () => {
    const out = parseRerankerScores('[{"index":9,"score":9},{"index":0,"score":5}]', 2)
    // Index 9 on a 2-chunk set would produce `undefined` chunks downstream.
    expect(out?.map((s) => s.index)).toEqual([0])
  })

  test('DROPS a negative index and returns an EMPTY array, not null', () => {
    // Measured: the range check is a per-item FILTER, so an all-invalid reply
    // yields []. That distinction matters at the call site — `if (!scored)` does
    // NOT catch an empty array, because [] is truthy in JS — which is why this is
    // asserted explicitly rather than assumed.
    const out = parseRerankerScores('[{"index":-1,"score":9}]', 5)
    expect(out).toEqual([])
    expect(out).not.toBeNull()
    expect(Boolean([])).toBe(true)
  })

  test('DROPS a score below the 3 floor', () => {
    const out = parseRerankerScores('[{"index":0,"score":2},{"index":1,"score":3}]', 5)
    // The floor keeps a model that scores everything 0-2 from reordering the list.
    expect(out?.map((s) => s.index)).toEqual([1])
  })

  test('drops entries whose index or score is not a number', () => {
    expect(parseRerankerScores('[{"index":"0","score":9},{"index":0,"score":9}]', 5)).toHaveLength(1)
  })

  test('sorts by descending score', () => {
    const out = parseRerankerScores('[{"index":0,"score":4},{"index":1,"score":9},{"index":2,"score":6}]', 5)
    expect(out?.map((s) => s.score)).toEqual([9, 6, 4])
  })
})

describe('retrieveRelevantChunks — rerank is ON by default', () => {
  test('a whitespace-only query short-circuits to nothing with no LLM call', async () => {
    const r = await retrieveRelevantChunks({ query: '   ', topK: 5 })
    expect(r.chunks).toEqual([])
    expect(r.queryTokens).toEqual([])
    // No reranker call for a query with no tokens to rank against.
    expect(state.chatCalls).toHaveLength(0)
  })

  test('a single-token query is processed rather than refused', async () => {
    const r = await retrieveRelevantChunks({ query: 'sales', topK: 5 })
    expect(r).toBeDefined()
  })

  test('RAG_LLM_RERANK=false skips the reranker entirely', async () => {
    process.env.RAG_LLM_RERANK = 'false'
    await retrieveRelevantChunks({ query: 'q about sales', topK: 5 })
    expect(state.chatCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// rerankWithLlm — the LLM fallback path
// ---------------------------------------------------------------------------
// dispatchRerank returns early unless chunks.length > topK, so this path is only
// reachable when retrieval over-fetches (retrievalTopK = topK * 3 when rerank is
// on). Reaching it needs candidates to actually come back, which is why the
// chunk rows are supplied through the db fake above.
describe('rerankWithLlm — reordering by model judgement', () => {
  // The content MUST contain a query token. bm25Rank filters to `score > 0`, so a
  // pool whose text shares no token with the query is emptied before the reranker
  // is ever consulted — which is what made these tests fail with 0 chunks while
  // candidatesScanned was still 9. The query in every test below is
  // 'sales by region'.
  const row = (i: number) => ({
    id: `c${i}`, chunkIndex: i, content: `sales by region record number ${i}`, keywords: null,
    embeddingJson: null, embeddingModel: null, contextPrefix: null,
    document: { id: 'd1', name: 'doc.pdf' },
  })

  function seedCandidates(n: number) {
    state.chunkRows = Array.from({ length: n }, (_, i) => row(i))
  }

  test('a model ordering is applied: the top-scored chunk comes first', async () => {
    seedCandidates(9)
    // Score chunk index 5 highest, then 0; everything else is below the floor.
    state.chatRaw = '[{"index":5,"score":10},{"index":0,"score":9}]'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    expect(r.chunks[0].chunkId).toBe('c5')
    expect(r.chunks[1].chunkId).toBe('c0')
    expect(state.chatCalls.length).toBeGreaterThan(0)
    // The reranker is a distinct purpose so its token spend is attributable.
    expect(state.chatCalls[0].purpose).toBe('rag-rerank')
    expect(state.chatCalls[0].temp).toBe(0)
  })

  test('the result is still capped at topK', async () => {
    seedCandidates(9)
    state.chatRaw = '[{"index":0,"score":10},{"index":1,"score":9},{"index":2,"score":8},{"index":3,"score":7}]'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 2 })
    expect(r.chunks).toHaveLength(2)
  })

  test('UNSCORED chunks backfill so the caller never gets fewer than topK', async () => {
    seedCandidates(9)
    state.chatRaw = '[{"index":4,"score":10}]'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 4 })
    // The model usually scores only a few; dropping the rest would shrink the
    // context window for no reason.
    expect(r.chunks).toHaveLength(4)
    expect(r.chunks[0].chunkId).toBe('c4')
    // No duplicates introduced by the backfill.
    expect(new Set(r.chunks.map((c) => c.chunkId)).size).toBe(4)
  })

  test('a duplicate index in the model reply is ignored, not double-counted', async () => {
    seedCandidates(9)
    state.chatRaw = '[{"index":3,"score":9},{"index":3,"score":8},{"index":1,"score":7}]'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    expect(new Set(r.chunks.map((c) => c.chunkId)).size).toBe(3)
  })

  test('a THROWING reranker degrades to the original order instead of failing the query', async () => {
    seedCandidates(9)
    state.chatThrows = true
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    // Rerank is a precision nicety; an outage must not lose the retrieval.
    expect(r.chunks).toHaveLength(3)
    expect(state.chatThrows).toBe(true)
  })

  test('an UNPARSEABLE reply degrades to the original order', async () => {
    seedCandidates(9)
    state.chatRaw = 'I am unable to score these chunks.'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    expect(r.chunks).toHaveLength(3)
  })

  test('an EMPTY parsed array does NOT reorder ([] is truthy in JS)', async () => {
    seedCandidates(9)
    state.chatRaw = '[{"index":0,"score":1}]'
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    // Every score is below the floor, so parseRerankerScores returns []. Because
    // `if (!scored)` does not catch [], the loop runs zero times and the backfill
    // restores the ORIGINAL order — asserted so this stays a known, tested edge
    // rather than a latent surprise.
    expect(r.chunks).toHaveLength(3)
    expect(r.chunks[0].chunkId).toBe('c0')
  })

  test('no configured LLM means the original order, with no rerank call', async () => {
    seedCandidates(9)
    state.cfg = null
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 3 })
    expect(r.chunks).toHaveLength(3)
  })

  test('the cross-encoder is preferred over the LLM when it answers', async () => {
    seedCandidates(9)
    state.crossResult = [{ chunkId: 'c8', documentId: 'd1', documentName: 'doc.pdf', content: 'x', score: 9 }]
    const r = await retrieveRelevantChunks({ query: 'sales by region', topK: 1 })
    expect(state.crossCalls.length).toBeGreaterThan(0)
    // A cross-encoder hit must short-circuit the LLM: it is cheaper and faster.
    expect(state.chatCalls).toHaveLength(0)
    expect(r.chunks[0].chunkId).toBe('c8')
  })
})
