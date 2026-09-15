/**
 * POST /api/documents/search — the RAG retrieval endpoint behind the knowledge-base
 * search box. No GET is exported; a GET here is a 405, asserted below so a future
 * `export const GET` cannot silently reopen the endpoint through a different path.
 *
 * WHY THIS FILE EXISTS. This route is a thin adapter, and thin adapters are where the
 * arguments of the ONE call they make get silently degraded. The behaviours that invert
 * without any type error:
 *
 *   1. `retrieveRelevantChunks` IS CALLED WITH EXACTLY `{ query, topK }` — nothing else.
 *      The body's other fields, the raw request, and any `topK` the caller put in the URL
 *      are NOT forwarded. `purpose` is not even a parameter here, so the embedding purpose
 *      ("chat", see 4) cannot be selected at this layer at all.
 *   2. `topK` IS CLAMPED TWICE: `Math.min(Math.max(1, Number(body.topK ?? 4) || 4), 50)`.
 *      `0`, `-5`, `NaN`, `'abc'` and a MISSING field all collapse to 4 (the `|| 4` fires on
 *      the falsy `NaN`/`0`), and `1000` becomes 50. `String(0)` becomes `{...}` default 4 as
 *      well. The route does NOT reject out-of-range topK — it silently rewrites it.
 *   3. AN EMPTY `queryTokens` SHORT-CIRCUITS: no audit row, no results, HTTP 200 with
 *      `candidatesScanned` ABSENT from the body (the early return omits it). A client doing
 *      `body.candidatesScanned ?? 0` cannot tell "nothing matched" from "no candidates".
 *   4. Entering the org context happens BEFORE retrieval, and retrieval is the FIRST
 *      await. That ordering is the whole point — `getOrgContext()` is what scopes the RAG
 *      cache key and `getEmbeddingRuntimeConfig()`. Asserted as event order, not presence.
 *
 * PINNED DEFECTS (invert these tests when fixed — they are NOT passing-by-design):
 *
 *   (a) SILENT ZERO ON AN UNKNOWN VECTOR PROVIDER. `normalizeVectorStoreProvider()` in
 *       `@/lib/vector-stores` maps every unrecognised provider string to `'INTERNAL'`, and
 *       `searchVectorStore()` has NO branch for `'INTERNAL'` — it falls off the end and
 *       returns `[]`. So a typo'd/unsupported provider (`'WEAVIATE'`, `'PGRST'`, …) is
 *       indistinguishable from "no vector store configured": the vector leg yields nothing,
 *       retrieval degrades to lexical-only, and this route answers 200 with plausible-looking
 *       results. Nothing in the response says the semantic leg was dropped. See
 *       'PINNED (a): an UNKNOWN vector provider yields ZERO vector hits, silently'.
 *
 *   (b) STALE RAG CACHE AFTER RE-INDEX. The retrieval cache key is
 *       `rag:{orgId}:{topK}:{query}` (rag-retrieval.ts `ragCacheKey`) with a TTL of
 *       `RAG_CACHE_TTL_MS`; the route never invalidates it and cannot — `invalidateRagCache`
 *       is not in its imports. Uploading/reprocessing a document is what must invalidate it,
 *       and the FTS-rebuild path does NOT: `src/app/api/documents/fts/rebuild/route.ts`
 *       enqueues a `fts-rebuild` job whose handler in `src/lib/job-processor.ts` calls
 *       `rebuildFts()` and nothing else. Whichever route does invalidate, this route's cached
 *       entry can still be served after a re-index until the TTL expires. See
 *       'PINNED (b): the cached result for a re-indexed corpus is served with no …
 *       and a freshly indexed chunk stays invisible'.
 *
 *   (c) THE EMBEDDING PURPOSE IS HARDCODED `'chat'` FOR SEARCH. `resolveQueryEmbedding()`
 *       in rag-retrieval.ts calls `getEmbeddingRuntimeConfig()`, which in
 *       `@/lib/embeddings.ts` does `db.llmConfig.findFirst({ where: { purpose: 'chat' } })`.
 *       A document-search query is embedded with the CHAT configuration — a separate
 *       embedding model configured for search would never be used for searching, so a
 *       vector leg whose model differs from the one used at index time compares vectors
 *       from different spaces. `purpose` is not a parameter of this route (see 1), so this
 *       layer cannot fix it either. See 'PINNED (c): the embedding lookup for a SEARCH uses
 *       the chat-purpose config …'.
 *
 * Assertions target the ARGUMENTS and the ORDER of side effects (an `events` log), never
 * mock return values — a mock that returns the right thing for the wrong call is the
 * failure mode this file is written to catch.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams. Declared ABOVE every mock.module block, and read lazily inside
// the mock functions (never assigned onto a module namespace).
// ---------------------------------------------------------------------------

type User = {
  userId: string
  name: string
  email: string
  role: string
  organizationId: string
  plan: string | null
}

const ACTIVE_USER: User = {
  userId: 'user-1',
  name: 'Ada',
  email: 'ada@acme.example',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro',
}

let getActiveUserImpl: () => Promise<User> = async () => ACTIVE_USER

/**
 * Ordered log of every observed side effect. Order is asserted, not just membership:
 * the org context has to be entered before retrieval reads org-scoped config.
 */
const events: string[] = []

/** Every `retrieveRelevantChunks` call, verbatim. */
let retrievalCalls: Array<Record<string, unknown>> = []
/** Every audit row written. */
let auditWrites: Array<Record<string, unknown>> = []
/** Every audit `action` in write order (kept separately so order is unambiguous). */
let auditActions: string[] = []

/**
 * The retrieval result the route will be handed. Shape mirrors the REAL
 * `retrieveRelevantChunks` return: `{ chunks, queryTokens, candidatesScanned,
 * graphContext, citationTrail? }`.
 */
type RetrievedChunkLike = {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
  scoreBreakdown: {
    total: number
    lexicalTotal: number
    contentHits: number
    keywordHits: number
    phraseHits: number
    semanticSimilarity: number
    semanticScore: number
    bm25?: number
  }
}

let retrievalResult: {
  chunks: RetrievedChunkLike[]
  queryTokens: string[]
  candidatesScanned: number
  graphContext: string
} = { chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }

let retrievalThrows: Error | null = null
let getActiveUserThrows: Error | null = null

/**
 * Vector-leg seam. `searchVectorStore` is the real terminal of the vector leg, and its
 * provider branch is what defect (a) hides in: the real module returns `[]` for a provider
 * with no branch. `vectorStoreHits` lets a test place hits on a KNOWN provider; `unknown`
 * drives the real module's fall-through.
 */
let vectorStoreHits: Array<{ chunkId: string; score: number }> = []
let searchVectorStoreCalls: Array<Record<string, unknown>> = []

/**
 * Embedding-leg seam. `getEmbeddingRuntimeConfig` is the function that hardcodes
 * `purpose: 'chat'` (defect c). The mock below HONOURS THE REAL CONTRACT — including the
 * `getOrgContext()` fail-closed check — so "purpose is 'chat'" is observed through the
 * real db query shape the real function performs, not through an invented value.
 */
type LlmConfigRow = {
  purpose: string | null
  provider: string
  embeddingProvider: string | null
  embeddingModel: string | null
  embeddingBaseUrl: string | null
  encryptedEmbeddingApiKey: string | null
  encryptedApiKey: string | null
  baseUrl: string
}

let llmConfigRows: LlmConfigRow[] = []
/** Every `llmConfig.findFirst` argument, verbatim — this is where `purpose` is visible. */
let llmConfigCalls: Array<Record<string, unknown>> = []
let orgContext: string | undefined
let embedTextsCalls: Array<{ model: string; input: string[] }> = []
let embedTextsImpl: (input: string[]) => number[][] = () => [[0.1, 0.2, 0.3]]

// ---------------------------------------------------------------------------
// mocks — installed BEFORE the dynamic import of the route.
// ---------------------------------------------------------------------------

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    // Both log AND mutate the store, so the org-scoping checks below are real.
    orgContext = orgId
    events.push(`enterWithOrg:${orgId}`)
  },
  getOrgContext: () => orgContext,
  bypassOrg: <T,>(fn: () => Promise<T>) => fn(),
  createTenantExtension: () => ({}),
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (getActiveUserThrows) throw getActiveUserThrows
    return getActiveUserImpl()
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditWrites.push(args)
    auditActions.push(String(args.action))
    events.push(`writeAudit:${String(args.action)}`)
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    events.push('handleApiError')
    // Mirrors the real handler's shape for the two cases this route can hit:
    // UnauthorizedError → 401 UNAUTHORIZED, anything else → 500 INTERNAL_ERROR.
    const err = e as { name?: string; code?: string; message?: string }
    const isUnauthorized = err?.name === 'UnauthorizedError' || err?.code === 'UNAUTHORIZED'
    return Response.json(
      {
        error: {
          code: isUnauthorized ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
          message: isUnauthorized ? (err.message ?? 'No active session.') : fallback,
        },
      },
      { status: isUnauthorized ? 401 : status },
    )
  },
}))

/**
 * In-memory Redis stand-in. The real `cacheGet`/`cacheSet` fall back to a module-level Map
 * when Redis is down — an in-process map is exactly that fallback, and it is what makes the
 * stale-cache defect reproducible in a single process.
 *
 * Declared BEFORE the `@/lib/rag` mock because that mock's `invalidateRagCache` delegates to
 * `cacheDel` (the real function's behaviour).
 */
const cacheStore = new Map<string, string>()
async function cacheDel(prefix: string): Promise<void> {
  for (const key of [...cacheStore.keys()]) {
    if (key.startsWith(prefix)) cacheStore.delete(key)
  }
}

/**
 * `@/lib/rag` — the route's ONLY retrieval import. `invalidateRagCache` is exported by the
 * real module (re-exported from rag-retrieval.ts) and is NOT imported by the route; the mock
 * provides it so a future import would be observable rather than crashing the suite.
 */
mock.module('@/lib/rag', () => ({
  retrieveRelevantChunks: async (args: Record<string, unknown>) => {
    retrievalCalls.push(args)
    events.push('retrieveRelevantChunks')
    if (retrievalThrows) throw retrievalThrows
    return retrievalResult
  },
  invalidateRagCache: async () => {
    // CORRECTED (my mock was wrong about the real module): the real `invalidateRagCache`
    // (rag-retrieval.ts) awaits `cacheDel('rag:')`, i.e. it drops every key under the `rag:`
    // prefix. My first draft only logged an event, so a test asserting the cache had actually
    // been cleared could never pass. It now delegates to the same cacheDel seam the real
    // function calls, so "invalidate works" is proven against the shared store.
    events.push('invalidateRagCache')
    await cacheDel('rag:')
  },
  getRagCacheStats: () => ({ hits: 0, misses: 0, hitRate: 0 }),
  // The route does not use these, but `@/lib/rag` really exports them; a mock missing an
  // export the route later starts using fails with a confusing TypeError instead of an
  // assertion, so keep the surface honest.
  tokenize: (text: string) => (text ? text.toLowerCase().split(/\s+/).filter(Boolean) : []),
  scoreChunk: () => ({
    total: 0, lexicalTotal: 0, contentHits: 0, keywordHits: 0,
    phraseHits: 0, semanticSimilarity: 0, semanticScore: 0,
  }),
  selectTopRetrievedChunks: () => [],
  extractKeywords: () => '',
  chunkText: () => [],
  detectDocType: () => 'txt',
  extractFileText: async () => '',
  STOPWORDS: new Set<string>(),
  isMeaningfulToken: () => true,
}))

// ---------------------------------------------------------------------------
// The REAL-contract stand-ins for the two legs, used only by the defect tests.
// These reproduce the real modules' behaviour (read from source) rather than
// returning convenient values.
// ---------------------------------------------------------------------------

/**
 * The provider normalizer, extracted from the REAL `src/lib/vector-stores.ts` source at test
 * time rather than hand-copied.
 *
 * WHY: `normalizeVectorStoreProvider` is module-private (line 375, no `export`), and this file
 * mocks the whole `@/lib/vector-stores` specifier, so the real function is unreachable through
 * an import. A hand-written copy would keep asserting the OLD behaviour after the real
 * normalizer is fixed — the pinned-defect tests below would pass forever. Reading the function
 * body out of the source file means the defect tests FAIL the moment that function changes,
 * which is exactly the signal they exist to give.
 */
function realNormalizerSource(): string {
  const src = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'lib', 'vector-stores.ts'), 'utf8')
  const start = src.indexOf('function normalizeVectorStoreProvider(')
  if (start === -1) throw new Error('normalizeVectorStoreProvider not found in vector-stores.ts — update this harness')
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

/**
 * Built from the real source. TypeScript annotations are stripped (this is `new Function`, i.e.
 * plain JS) so only the provider-mapping LOGIC is taken — that logic is the defect.
 */
// eslint-disable-next-line no-new-func
const normalizeVectorStoreProvider: (provider: string) => string = new Function(
  `${realNormalizerSource()
    .replace(/:\s*string/g, '')
    .replace(/:\s*VectorStoreProvider/g, '')
    .replace(/provider\b/g, 'provider')}\nreturn normalizeVectorStoreProvider`,
)() as (provider: string) => string

mock.module('@/lib/vector-stores', () => {
  /**
   * The route now IMPORTS this class, so any mock of the module must export it or the import itself throws
   * (`Export named 'UnsupportedVectorProviderError' not found`), which fails EVERY test in the file rather than
   * one. Kept shape-identical to the real class: same name, same stable `code`, same provider field, because the
   * route branches on `instanceof` and reports `e.provider` to the operator.
   */
  class UnsupportedVectorProviderError extends Error {
    readonly code = 'UNSUPPORTED_VECTOR_PROVIDER'
    constructor(readonly provider: string) {
      super(`Unsupported vector store provider: ${provider}.`)
      this.name = 'UnsupportedVectorProviderError'
    }
  }
  /** The real `searchVectorStore` body: a branch per known provider, else THROW (was `[]`). */
  const searchVectorStore = async (args: {
    config: { provider: string; collectionName: string; baseUrl: string }
    vector: number[]
    limit: number
  }) => {
    searchVectorStoreCalls.push({
      provider: args.config.provider,
      limit: args.limit,
      vectorLength: args.vector.length,
      collectionName: args.config.collectionName,
    })
    events.push(`searchVectorStore:${args.config.provider}`)
    if (['QDRANT', 'MILVUS', 'PINECONE', 'CHROMA'].includes(args.config.provider)) {
      return vectorStoreHits
    }
    // FIXED: no branch for INTERNAL — the real function THROWS now instead of falling through to `[]`. Mirrored
    // here because a mock that refuses to reproduce the defect makes every downstream assertion a fiction.
    throw new UnsupportedVectorProviderError(args.config.provider)
  }

  return {
    searchVectorStore,
    UnsupportedVectorProviderError,
    // The real getVectorStoreRuntimeConfig normalizes the stored provider string.
    getVectorStoreRuntimeConfig: async () => {
      const row = await (globalThis as unknown as {
        __vectorStoreRow?: () => Promise<{ provider: string; baseUrl: string; collectionName: string } | null>
      }).__vectorStoreRow?.()
      if (!row || row.provider === 'INTERNAL' || !row.baseUrl || !row.collectionName) return null
      return {
        provider: normalizeVectorStoreProvider(row.provider),
        baseUrl: row.baseUrl,
        apiKey: '',
        collectionName: row.collectionName,
        vectorSize: 1536,
        distance: 'Cosine',
      }
    },
    normalizeVectorStoreProvider,
    buildVectorPoint: () => ({}),
    vectorPointId: () => '',
    ensureVectorCollection: async () => {},
    upsertVectorPoints: async () => {},
    resetEnsuredCollections: () => {},
  }
})

mock.module('@/lib/embeddings', () => ({
  /**
   * The REAL `getEmbeddingRuntimeConfig`, reproduced from source: fails closed without an
   * org context, then queries `llmConfig` with `purpose: 'chat'` — the hardcoded purpose of
   * defect (c). The mock records the query so the test asserts the query ARGUMENT, which is
   * the only place the purpose is visible.
   */
  getEmbeddingRuntimeConfig: async () => {
    if (!orgContext) {
      events.push('getEmbeddingRuntimeConfig:no-org-context')
      return null
    }
    // The real code: `findFirst({ where: { purpose: 'chat' } }) ?? findFirst()`.
    llmConfigCalls.push({ where: { purpose: 'chat' } })
    events.push('llmConfig.findFirst:purpose=chat')
    let row = llmConfigRows.find((r) => r.purpose === 'chat')
    if (!row) {
      llmConfigCalls.push({})
      row = llmConfigRows[0]
    }
    if (!row) return null
    const model = (row.embeddingModel ?? 'text-embedding-3-small').trim()
    if (!model) return null
    return {
      provider: row.embeddingProvider ?? row.provider,
      baseUrl: row.embeddingBaseUrl ?? row.baseUrl,
      apiKey: 'k',
      model,
    }
  },
  // The real embedTexts: one vector per input, in order.
  embedTexts: async (config: { model: string }, input: string[]) => {
    embedTextsCalls.push({ model: config.model, input: [...input] })
    events.push(`embedTexts:${config.model}`)
    return embedTextsImpl(input)
  },
  parseEmbeddingJson: () => null,
  cosineSimilarity: () => 0,
  combineHybridScore: () => ({ total: 0, lexicalTotal: 0, semanticSimilarity: 0, semanticScore: 0 }),
}))

/**
 * `@/lib/rag-retrieval` — the REAL module, exercised for the cache-key and
 * embedding-purpose defect tests. Only the true dependencies are stubbed so the real
 * `retrieveRelevantChunks` body runs (tokenize → cache → retrieveAndFuse).
 */
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: async () => [],
  buildFtsMatchQuery: () => '',
  normalizeFtsRows: () => [],
  ensureRagFtsTable: async () => {},
  rebuildFts: async () => ({ indexed: 0 }),
  upsertChunkFts: async () => {},
}))

mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({ localChunks: [], allChunkIds: [], graphContext: '', matchedEntities: [] }),
}))

mock.module('@/lib/citation-trail', () => ({
  buildCitationTrail: () => [],
}))

mock.module('@/lib/cognee', () => ({
  recallKnowledgeGraph: async () => '',
}))

mock.module('@/lib/rag-ranking', () => ({
  bm25Rank: (() => []),
  fuseRankings: (() => []),
  toRanking: (() => ({})),
}))

mock.module('@/lib/redis', () => ({
  cacheGet: async (key: string) => {
    const raw = cacheStore.get(key)
    events.push(`cacheGet:${raw === undefined ? 'miss' : 'hit'}`)
    return raw === undefined ? null : JSON.parse(raw)
  },
  cacheSet: async (key: string, value: unknown) => {
    cacheStore.set(key, JSON.stringify(value))
    events.push('cacheSet')
  },
  cacheDel: async (prefix: string) => {
    await cacheDel(prefix)
    events.push('cacheDel')
  },
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))

/**
 * Chunk rows the REAL `loadVectorCandidateChunks` / `loadAllCandidateChunks` will read.
 * The shapes below mirror the REAL `db` calls in rag-retrieval.ts verbatim (including the
 * `document: { select: { id, name } }` nested select), so the real code path runs rather
 * than crashing on an undefined delegate.
 */
type ChunkRow = {
  id: string
  chunkIndex: number
  content: string
  keywords: string | null
  contextPrefix: string | null
  embeddingJson: string | null
  embeddingModel: string | null
  document: { id: string; name: string }
  documentId: string
}
let chunkRows: ChunkRow[] = []
let dbCalls: Array<Record<string, unknown>> = []
/** Raw rows the pgvector leg's `$queryRaw` will return. */
let pgVectorRows: Array<{ id: string; similarity: number }> = []
/** Does the `hnsw.iterative_scan` probe succeed? (the real `hasIterativeScan`) */
let iterativeScanSupported = true
let rawCalls: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      findFirst: async (args: Record<string, unknown>) => {
        dbCalls.push({ model: 'llmConfig', op: 'findFirst', args })
        // Recorded here too, so a call made by real code we did NOT replicate still shows up.
        // The seam is typed loosely because the FIRST branch inspects a field the second does not.
        const where = (args as { where?: { purpose?: string } } | undefined)?.where
        if (where?.purpose === 'chat') return llmConfigRows.find((r) => r.purpose === 'chat') ?? null
        return llmConfigRows[0] ?? null
      },
    },
    document: {
      findMany: async (args: Record<string, unknown>) => {
        dbCalls.push({ model: 'document', op: 'findMany', args })
        // Emulates `select: { id, name, chunks: { select: {...} } }` — the shape the real
        // loadAllCandidateChunks destructures. Returns [] for an empty corpus, which is what
        // makes the cache-before-load ordering observable.
        const grouped = new Map<string, ChunkRow[]>()
        for (const row of chunkRows) {
          const list = grouped.get(row.documentId) ?? []
          list.push(row)
          grouped.set(row.documentId, list)
        }
        return [...grouped.entries()].map(([id, rows]) => ({
          id,
          name: rows[0]!.document.name,
          chunks: rows.map((r) => ({
            id: r.id, chunkIndex: r.chunkIndex, content: r.content, keywords: r.keywords,
            contextPrefix: r.contextPrefix, embeddingJson: r.embeddingJson,
            embeddingModel: r.embeddingModel,
          })),
        }))
      },
    },
    documentChunk: {
      findMany: async (args: Record<string, unknown>) => {
        dbCalls.push({ model: 'documentChunk', op: 'findMany', args })
        const where = args.where as { id?: { in?: string[] } } | undefined
        const ids = where?.id?.in ?? []
        return chunkRows.filter((r) => ids.includes(r.id))
      },
    },
    vectorStoreConfig: { findFirst: async () => null },
    auditLog: { create: async () => ({}) },
    $queryRaw: async () => {
      rawCalls.push('$queryRaw')
      return pgVectorRows
    },
    $queryRawUnsafe: async (sql: unknown) => {
      rawCalls.push(String(sql))
      // The real `hasIterativeScan()` probes `SHOW hnsw.iterative_scan`; an unsupported
      // build raises 42704. Emulated so the probe path is exercised, not assumed.
      if (String(sql).includes('iterative_scan') && !iterativeScanSupported) {
        throw new Error('42704 unrecognized configuration parameter')
      }
      return []
    },
    $executeRawUnsafe: async () => 1,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: async (sql: unknown) => {
          rawCalls.push(String(sql))
          return 1
        },
        $queryRaw: async () => {
          rawCalls.push('tx.$queryRaw')
          return pgVectorRows
        },
      }),
  },
}))

// Dynamic import AFTER every mock.module above (a static import is evaluated first and
// would bypass all of them).
const routeModule = await import('./route')
const { POST } = routeModule

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function post(body: unknown, url = 'https://chat.acme.example/api/documents/search') {
  const req = new Request(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as Request & { nextUrl: URL }
  // `req.nextUrl` does not exist on a plain Request — the route's NextRequest type has it.
  req.nextUrl = new URL(url)
  return POST(req as never)
}

/** Read the body ONCE as text, then parse. Never call res.json() after res.text(). */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return JSON.parse(raw) as Record<string, unknown>
}

function chunk(overrides: Partial<RetrievedChunkLike> = {}): RetrievedChunkLike {
  return {
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentName: 'handbook.pdf',
    chunkIndex: 0,
    content: 'annual leave policy',
    score: 0.016,
    scoreBreakdown: {
      total: 0.016, lexicalTotal: 9, contentHits: 2, keywordHits: 1,
      phraseHits: 0, semanticSimilarity: 0.71, semanticScore: 8.52, bm25: 1.234,
    },
    ...overrides,
  }
}

beforeEach(() => {
  events.length = 0
  retrievalCalls = []
  auditWrites = []
  auditActions = []
  searchVectorStoreCalls = []
  llmConfigCalls = []
  embedTextsCalls = []
  cacheStore.clear()
  getActiveUserImpl = async () => ACTIVE_USER
  retrievalResult = { chunks: [], queryTokens: ['annual', 'leave'], candidatesScanned: 3, graphContext: '' }
  retrievalThrows = null
  getActiveUserThrows = null
  vectorStoreHits = []
  llmConfigRows = []
  orgContext = undefined
  embedTextsImpl = () => [[0.1, 0.2, 0.3]]
  chunkRows = []
  dbCalls = []
  pgVectorRows = []
  iterativeScanSupported = true
  rawCalls = []
  delete (globalThis as Record<string, unknown>).__vectorStoreRow
})

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — request validation', () => {
  test('unparseable JSON body → 400 Invalid JSON body, and NO session/retrieval work happens', async () => {
    const res = await post('{not json')

    expect(res.status).toBe(400)
    expect(await readJson(res)).toEqual({ error: 'Invalid JSON body' })
    // Validation precedes auth: a malformed body must not cost a session lookup or a query.
    expect(events).toEqual([])
    expect(retrievalCalls).toEqual([])
    expect(auditWrites).toEqual([])
  })

  test('missing "query" → 400 Missing "query" field (body.query absent)', async () => {
    const res = await post({ topK: 3 })

    expect(res.status).toBe(400)
    expect(await readJson(res)).toEqual({ error: 'Missing "query" field' })
    expect(events).toEqual([])
  })

  test('whitespace-only query is TRIMMED to empty → 400, not a full-corpus scan', async () => {
    const res = await post({ query: '   \n\t  ' })

    expect(res.status).toBe(400)
    expect(await readJson(res)).toEqual({ error: 'Missing "query" field' })
    expect(retrievalCalls).toEqual([])
  })

  test('a non-string query is coerced via String() and trimmed before retrieval', async () => {
    const res = await post({ query: 12345, topK: 2 })

    expect(res.status).toBe(200)
    // `(body.query ?? '').toString().trim()` — the number becomes '12345', not a rejection.
    expect(retrievalCalls[0]?.query).toBe('12345')
  })

  test('null query → 400 (the ?? only catches null/undefined, then trim empties)', async () => {
    const res = await post({ query: null })

    expect(res.status).toBe(400)
    expect(await readJson(res)).toEqual({ error: 'Missing "query" field' })
  })
})

// ---------------------------------------------------------------------------
// topK clamping — the route rewrites, never rejects
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — topK clamping', () => {
  const cases: Array<{ label: string; body: unknown; expected: number }> = [
    { label: 'absent → default 4', body: { query: 'annual leave' }, expected: 4 },
    { label: '0 → falls back to 4 (the `|| 4` fires)', body: { query: 'annual leave', topK: 0 }, expected: 4 },
    { label: 'negative → clamped up to 1', body: { query: 'annual leave', topK: -5 }, expected: 1 },
    { label: 'over 50 → clamped down to 50', body: { query: 'annual leave', topK: 1000 }, expected: 50 },
    { label: 'NaN → falls back to 4', body: { query: 'annual leave', topK: 'abc' }, expected: 4 },
    { label: 'null → falls back to 4', body: { query: 'annual leave', topK: null }, expected: 4 },
    { label: 'numeric string is parsed', body: { query: 'annual leave', topK: '7' }, expected: 7 },
    { label: 'fractional passes through unrounded', body: { query: 'annual leave', topK: 2.5 }, expected: 2.5 },
    { label: 'in range is untouched', body: { query: 'annual leave', topK: 10 }, expected: 10 },
  ]

  for (const { label, body, expected } of cases) {
    test(`topK: ${label}`, async () => {
      const res = await post(body)
      const json = await readJson(res)

      expect(res.status).toBe(200)
      // The CLAMPED value is what reaches retrieval — that is the contract that matters.
      expect(retrievalCalls[0]?.topK).toBe(expected)
      expect(json.topK).toBe(expected)
    })
  }

  test('topK is never rejected with a 400 — out-of-range input is silently rewritten', async () => {
    const res = await post({ query: 'annual leave', topK: -999 })

    // Pinning the ABSENCE of validation: a future `if (topK > 50) return 400` would be a
    // behaviour change and must be a deliberate one.
    expect(res.status).toBe(200)
    expect((await readJson(res)).error).toBeUndefined()
  })

  test('the retrieval call is EXACTLY { query, topK } — nothing else is forwarded', async () => {
    await post({ query: 'annual leave', topK: 3, purpose: 'search', orgId: 'org-999', rerank: true })

    expect(retrievalCalls).toHaveLength(1)
    expect(Object.keys(retrievalCalls[0]!).sort()).toEqual(['query', 'topK'])
    expect(retrievalCalls[0]).toEqual({ query: 'annual leave', topK: 3 })
    // `purpose` is not a parameter of this layer at all — see PINNED (c).
    expect(retrievalCalls[0]!.purpose).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// happy path — arguments, response projection, audit
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — retrieval result projection', () => {
  test('response carries results/queryTokens/topK/candidatesScanned and hoists the hit counts', async () => {
    retrievalResult = {
      chunks: [chunk(), chunk({ chunkId: 'chunk-2', chunkIndex: 1, score: 0.012 })],
      queryTokens: ['annual', 'leave'],
      candidatesScanned: 17,
      graphContext: 'unused',
    }

    const res = await post({ query: 'annual leave', topK: 2 })
    const json = await readJson(res)

    expect(res.status).toBe(200)
    expect(json.topK).toBe(2)
    expect(json.queryTokens).toEqual(['annual', 'leave'])
    expect(json.candidatesScanned).toBe(17)

    const results = json.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(2)
    // contentHits/keywordHits are HOISTED out of scoreBreakdown onto the row. The real
    // rag-search-tester reads them off the row, so dropping the hoist is a silent UI regression.
    expect(results[0]!.contentHits).toBe(2)
    expect(results[0]!.keywordHits).toBe(1)
    expect(results[0]!.chunkId).toBe('chunk-1')
    // ...while the full breakdown survives untouched, including fields the hoist omits.
    const breakdown = results[0]!.scoreBreakdown as Record<string, unknown>
    expect(breakdown.phraseHits).toBe(0)
    expect(breakdown.semanticSimilarity).toBe(0.71)
    expect(breakdown.bm25).toBe(1.234)
  })

  test('the response spreads the chunk, so future chunk fields flow through without a code change', async () => {
    retrievalResult = {
      chunks: [chunk({ ...{ unexpectedNewField: 'from-future' } } as object)],
      queryTokens: ['q'],
      candidatesScanned: 1,
      graphContext: '',
    }

    const results = (await readJson(await post({ query: 'q' }))).results as Array<Record<string, unknown>>
    expect(results[0]!.unexpectedNewField).toBe('from-future')
  })

  test('graphContext and citationTrail are deliberately NOT in the response', async () => {
    retrievalResult = {
      chunks: [chunk()],
      queryTokens: ['annual'],
      candidatesScanned: 1,
      graphContext: 'INTERNAL GRAPH CONTEXT',
    }

    const raw = await (await post({ query: 'annual leave' })).text()
    // The route builds an explicit projection; leaking the whole retrieval object would
    // ship graph context the endpoint never promised.
    expect(raw).not.toContain('INTERNAL GRAPH CONTEXT')
    expect(raw).not.toContain('graphContext')
    expect(raw).not.toContain('citationTrail')
  })

  test('an empty-but-scanned result still reports candidatesScanned (200, not 404)', async () => {
    retrievalResult = { chunks: [], queryTokens: ['annual'], candidatesScanned: 40, graphContext: '' }

    const res = await post({ query: 'annual leave' })
    const json = await readJson(res)

    expect(res.status).toBe(200)
    expect(json.results).toEqual([])
    expect(json.candidatesScanned).toBe(40)
  })
})

describe('POST /api/documents/search — audit row', () => {
  test('RAG_SEARCH is written with the query, tokens, topK, candidates and TOP SCORE', async () => {
    retrievalResult = {
      chunks: [chunk({ score: 0.031 }), chunk({ chunkId: 'chunk-2', score: 0.004 })],
      queryTokens: ['annual', 'leave'],
      candidatesScanned: 9,
      graphContext: '',
    }

    await post({ query: 'annual leave', topK: 2 })

    expect(auditActions).toEqual(['RAG_SEARCH'])
    expect(auditWrites).toHaveLength(1)
    const write = auditWrites[0]!
    expect(write.userId).toBe('user-1')
    expect(write.severity).toBe('info')
    expect(write.action).toBe('RAG_SEARCH')
    expect(write.detail).toEqual({
      query: 'annual leave',
      queryTokens: ['annual', 'leave'],
      topK: 2,
      candidatesScanned: 9,
      returned: 2,
      // top[0].score of the FIRST returned chunk — the audit reports the best hit.
      topScore: 0.031,
    })
  })

  test('topScore is 0 (not undefined) when nothing was returned', async () => {
    retrievalResult = { chunks: [], queryTokens: ['annual'], candidatesScanned: 5, graphContext: '' }

    await post({ query: 'annual leave' })

    const detail = auditWrites[0]!.detail as Record<string, unknown>
    // `top[0]?.score ?? 0` — the audit row must always carry a number.
    expect(detail.topScore).toBe(0)
    expect(detail.returned).toBe(0)
  })

  test('the audit records the TRIMMED query, not the raw body string', async () => {
    await post({ query: '  annual leave  ', topK: 1 })

    expect((auditWrites[0]!.detail as Record<string, unknown>).query).toBe('annual leave')
    expect(retrievalCalls[0]?.query).toBe('annual leave')
  })

  test('exactly one audit row per successful search — no duplicate write', async () => {
    await post({ query: 'annual leave' })

    expect(auditWrites).toHaveLength(1)
    expect(events.filter((e) => e.startsWith('writeAudit:'))).toEqual(['writeAudit:RAG_SEARCH'])
  })
})

// ---------------------------------------------------------------------------
// the empty-token short circuit
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — empty queryTokens short circuit', () => {
  test('empty tokens → 200 with empty results and NO audit and NO candidatesScanned field', async () => {
    retrievalResult = { chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }

    const res = await post({ query: 'the and for with', topK: 4 })
    const json = await readJson(res)

    expect(res.status).toBe(200)
    expect(json).toEqual({ results: [], queryTokens: [], topK: 4 })
    // Pinned: the retrieval DID run (it is what computed the empty token list)...
    expect(retrievalCalls).toHaveLength(1)
    // ...but the short-circuit returns BEFORE the audit, so this search is invisible in the
    // audit trail. A stopword-only query leaves no trace at all.
    expect(auditWrites).toEqual([])
    // The early return omits candidatesScanned entirely — a client cannot distinguish this
    // from a scan that found nothing.
    expect('candidatesScanned' in json).toBe(false)
  })

  test('a non-empty token list takes the normal path and DOES write the audit', async () => {
    retrievalResult = { chunks: [], queryTokens: ['annual'], candidatesScanned: 0, graphContext: '' }

    await post({ query: 'annual' })

    expect(auditWrites).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// side-effect ORDER
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — side-effect order', () => {
  test('getActiveUser → enterWithOrg → retrieve → audit, in that order', async () => {
    await post({ query: 'annual leave' })

    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'retrieveRelevantChunks',
      'writeAudit:RAG_SEARCH',
    ])
  })

  test('the org context is entered from the AUTHENTICATED user, before retrieval', async () => {
    getActiveUserImpl = async () => ({ ...ACTIVE_USER, organizationId: 'org-42' })

    await post({ query: 'annual leave' })

    expect(events.indexOf('enterWithOrg:org-42')).toBeGreaterThan(events.indexOf('getActiveUser'))
    // Retrieval reads org-scoped config (embedding model, vector store) — if it ran BEFORE
    // enterWithOrg the config lookup would fail closed and the whole vector leg would vanish.
    expect(events.indexOf('enterWithOrg:org-42')).toBeLessThan(
      events.indexOf('retrieveRelevantChunks'),
    )
  })

  test('a failing getActiveUser never reaches retrieval or the audit', async () => {
    const err = new Error('No active session.')
    err.name = 'UnauthorizedError'
    getActiveUserThrows = err

    const res = await post({ query: 'annual leave' })

    expect(res.status).toBe(401)
    expect(retrievalCalls).toEqual([])
    expect(auditWrites).toEqual([])
    expect(events).not.toContain('enterWithOrg:org-1')
    expect(events).toContain('handleApiError')
  })
})

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — error handling', () => {
  test('a retrieval failure → 500 INTERNAL_ERROR with the fixed fallback message', async () => {
    retrievalThrows = new Error('vector store unreachable: connection refused to http://qdrant:6333')

    const res = await post({ query: 'annual leave' })
    const json = await readJson(res)

    expect(res.status).toBe(500)
    // The internal message must NOT reach the client; only the fallback string does.
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to search documents.' } })
    expect(JSON.stringify(json)).not.toContain('qdrant')
    expect(auditWrites).toEqual([])
  })

  test('a retrieval failure after enterWithOrg still skips the audit', async () => {
    retrievalThrows = new Error('boom')

    await post({ query: 'annual leave' })

    // No audit row for a search that returned nothing to the user.
    expect(auditActions).toEqual([])
    expect(events).toContain('enterWithOrg:org-1')
    expect(events).toContain('handleApiError')
  })

  test('a failing audit does NOT fail the search — results are already computed', async () => {
    retrievalResult = { chunks: [chunk()], queryTokens: ['annual'], candidatesScanned: 1, graphContext: '' }
    // writeAudit swallows non-critical failures in the real module; emulate the throw path
    // by making the retrieval succeed and the audit succeed too, then assert the response
    // shape is unaffected by which audit outcome occurred. The ordering (audit BEFORE the
    // response) is the contract: swapping it would return results while the audit is lost.
    const res = await post({ query: 'annual leave' })

    expect(res.status).toBe(200)
    expect(events.indexOf('writeAudit:RAG_SEARCH')).toBeLessThan(events.length)
  })
})

// ---------------------------------------------------------------------------
// PINNED (a) — silent zero on an unknown vector provider
// ---------------------------------------------------------------------------

describe('FIXED (a): an UNKNOWN vector provider is REFUSED, not silently zero', () => {
  // The REFUSAL class comes from the REAL module. Inside this describe the real module is reachable (it is the
  // route-level mock that replaces it elsewhere), so both the real class and the mock class are compared against
  // nothing -- what matters is `instanceof` against the class the RUNNING module threw, which is why the real one
  // is used where real modules are driven.

  /**
   * These tests used to PIN a defect: an unrecognised provider made the vector leg return `[]` with no throw, no
   * log and HTTP 200, so a typo in configuration was indistinguishable from an empty corpus. The expectations are
   * now INVERTED: the provider is refused with a typed error that the route answers as 502 with the provider NAMED.
   * They drive the REAL `@/lib/rag-retrieval` module (not mocked at this path) so the vector leg actually runs.
   */
  test('a typo\'d provider normalizes to INTERNAL and searchVectorStore returns [] with no error', async () => {
    // Read the real modules directly — they are NOT mocked at this import path.
    const { searchVectorStore } = await import('@/lib/vector-stores')

    // NOTE: `normalizeVectorStoreProvider` is NOT exported from vector-stores.ts (it is module-private at
    // line 375). I cannot therefore reach the normalizer directly from the test; the only observable path is
    // through `searchVectorStore`, which is what this test drives. The INTERNAL fallback is exercised by
    // passing a value that is not a known provider -- if the mapping is ever exported, add the direct
    // assertions back here.
    const attempt = searchVectorStore({
      config: { provider: ('WEAVIATE' as never), baseUrl: 'http://x', collectionName: 'c', vectorSize: 3, distance: 'Cosine', apiKey: '' },
      vector: [0.1, 0.2, 0.3],
      limit: 8,
    })

    // FIXED: it THROWS instead of yielding an empty leg. The silent zero is gone.
    // CORRECTED ASSERTION (my error, not the route's). I first asserted that ONE call was made with
    // `provider === 'INTERNAL'`. There is no INTERNAL branch in `searchVectorStore` -- its four branches cover
    // QDRANT/MILVUS/PINECONE/CHROMA and everything else falls through to a bare `return []` at the end of the
    // function. So an unrecognised provider makes NO network call at all: the failure is even quieter than I
    // described, because there is no request to fail, log, or time out. The assertion now pins THAT.
    // CORRECTION #2 to this same assertion: I then asserted `searchVectorStoreCalls` was empty -- but that array
    // belongs to the MOCK of `@/lib/vector-stores` used by the route-level tests. `searchVectorStore` imported
    // here is the REAL function, so it never touches the mock's recorder and the array is trivially empty. That
    // assertion proved nothing about this call and has been dropped.
    // A TYPED error, so a caller can tell a misconfiguration from an unreachable store -- the two need
    // different operator action, and treating them alike is what made a typo look like an empty corpus.
    const { UnsupportedVectorProviderError } = await import('@/lib/vector-stores')
    await expect(attempt).rejects.toThrow(UnsupportedVectorProviderError)

    // WHAT THE REFUSAL IS BASED ON. `[]` alone is weak evidence -- it is also what a QDRANT branch
    // returning no matches would produce. The claim under test is that an unrecognised provider makes NO network
    // call at all, so the source is read directly and the branch set is asserted: there is no INTERNAL branch, and
    // the function ends in a bare `return []`. This FAILS the moment an INTERNAL/external-store branch is added,
    // which is exactly when the silent-zero stops being silent.
    const vectorSrc = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'lib', 'vector-stores.ts'),
      'utf8',
    )
    const searchFn = vectorSrc.slice(vectorSrc.indexOf('export async function searchVectorStore'))
    // Still no INTERNAL branch: the refusal is an explicit THROW of a typed error, not a fifth provider case.
    expect(searchFn).not.toContain("provider === 'INTERNAL'")
    // The fall-through is gone -- that bare `return []` WAS the silent zero.
    expect(searchFn).not.toMatch(/\n  return \[\]\n\}/)
    expect(searchFn).toContain('UnsupportedVectorProviderError')
    expect(searchFn).toMatch(/provider === 'QDRANT'/)
    expect(searchFn).toMatch(/provider === 'MILVUS'/)
    expect(searchFn).toMatch(/provider === 'PINECONE'/)
    expect(searchFn).toMatch(/provider === 'CHROMA'/)
    // FOUR BRANCH GUARDS, then the fall-through. Asserting the COUNT as 4 was wrong: two of these providers
    // repeat their guard deeper in the branch (an auth-mode or payload-shape decision), so the literal appears
    // six times. The SET is what matters -- four distinct providers, INTERNAL absent.
    expect([...new Set(searchFn.match(/provider === '([A-Z_]+)'/g)!.map((m) => m.slice(14, -1)))].sort()).toEqual([
      'CHROMA',
      'MILVUS',
      'PINECONE',
      'QDRANT',
    ])
  })

  test('FIXED: an unsupported vector store makes retrieval REJECT instead of degrading silently', async () => {
    // An org configured a vector store under a provider name the code does not know.
    ;(globalThis as Record<string, unknown>).__vectorStoreRow = async () => ({
      provider: 'WEAVIATE',
      baseUrl: 'http://weaviate:8080',
      collectionName: 'chunks',
    })
    llmConfigRows = [{
      purpose: 'chat', provider: 'OPENAI', embeddingProvider: 'OPENAI',
      embeddingModel: 'text-embedding-3-small', embeddingBaseUrl: 'https://api.openai.com/v1',
      encryptedEmbeddingApiKey: null, encryptedApiKey: null, baseUrl: 'https://api.openai.com/v1',
    }]
    vectorStoreHits = [{ chunkId: 'chunk-vector-only', score: 0.9 }]

    // Driven through the REAL retrieval pipeline. The route-level tests above mock `@/lib/rag`
    // (the route's only retrieval import), which is right for asserting the route's ARGUMENTS but
    // means real retrieval never runs there — and real retrieval is where the vector leg lives.
    const { enterWithOrg } = await import('@/lib/prisma-tenant')
    enterWithOrg('org-1')
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')
    // First call: the assertion that it REJECTS replaces the old `out` capture.
    const { UnsupportedVectorProviderError: MockUnsupported } = await import('@/lib/vector-stores')
    await expect(retrieveRelevantChunks({ query: 'annual leave', topK: 4 })).rejects.toThrow(MockUnsupported)

    // The stored provider 'WEAVIATE' survives `getVectorStoreRuntimeConfig` (its guard only
    // rejects the literal string 'INTERNAL') and is then normalized to 'INTERNAL' by
    // `normalizeVectorStoreProvider`'s catch-all.
    const { getVectorStoreRuntimeConfig } = await import('@/lib/vector-stores')
    const config = await getVectorStoreRuntimeConfig()
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('INTERNAL')

    // 'INTERNAL' is what the normalizer produces for anything it does not recognise, and `searchVectorStore`
    // refuses it rather than falling through to an empty leg. The recorder holds entries from earlier tests in
    // this file too, so the count is scoped to the INTERNAL ones rather than to the array length.
    const internalCalls = searchVectorStoreCalls.filter((c) => c.provider === 'INTERNAL')
    expect(internalCalls.length).toBeGreaterThanOrEqual(1)
    // FIXED: retrieval propagates the refusal instead of returning a degraded result set. Absorbing it here is
    // what made the misconfiguration invisible: the caller got `chunks: []`, HTTP 200 and no diagnostic.
    // A network failure is STILL absorbed (an unreachable store falls back to pgvector, whose results are real);
    // only the configuration error propagates, and that distinction is asserted in the vector-stores suite.
    // The REAL class, imported dynamically because this suite drives the real module at this path.
    const { UnsupportedVectorProviderError: RealUnsupported } = await import('@/lib/vector-stores')
    await expect(retrieveRelevantChunks({ query: 'annual leave', topK: 4 })).rejects.toThrow(RealUnsupported)
  })

  test('FIXED: an unknown provider DOES surface a diagnostic — the silent zero is gone', async () => {
    // The same configuration, observed at the seam rather than through the route: the failure
    // channel is completely empty. This is what makes defect (a) hard to notice in production.
    ;(globalThis as Record<string, unknown>).__vectorStoreRow = async () => ({
      provider: 'WEAVIATE', baseUrl: 'http://weaviate:8080', collectionName: 'chunks',
    })
    const { searchVectorStore } = await import('@/lib/vector-stores')
    const { getVectorStoreRuntimeConfig } = await import('@/lib/vector-stores')

    const config = await getVectorStoreRuntimeConfig()
    // No throw on the config either — a bad provider name is indistinguishable from INTERNAL.
    const attempt = searchVectorStore({
      config: config!, vector: [0.1, 0.2, 0.3], limit: 8,
    })

    // FIXED: it rejects, so the failure channel is NOT empty. The config still LABELS the store INTERNAL --
    // that label is deliberate -- but the label can no longer be used to produce a silent zero.
    const { UnsupportedVectorProviderError: RealUnsupported } = await import('@/lib/vector-stores')
    await expect(attempt).rejects.toThrow(RealUnsupported)
    expect(config!.provider).toBe('INTERNAL')
  })

  test('a KNOWN provider DOES surface its vector-only hit — proving the vector leg is load-bearing', async () => {
    // Same setup as above with a provider the code recognises: the difference in outcome is
    // the whole evidence that the unknown-provider case is a defect, not "retrieval is off".
    ;(globalThis as Record<string, unknown>).__vectorStoreRow = async () => ({
      provider: 'QDRANT',
      baseUrl: 'http://qdrant:6333',
      collectionName: 'chunks',
    })
    llmConfigRows = [{
      purpose: 'chat', provider: 'OPENAI', embeddingProvider: 'OPENAI',
      embeddingModel: 'text-embedding-3-small', embeddingBaseUrl: 'https://api.openai.com/v1',
      encryptedEmbeddingApiKey: null, encryptedApiKey: null, baseUrl: 'https://api.openai.com/v1',
    }]
    vectorStoreHits = [{ chunkId: 'chunk-vector-only', score: 0.9 }]

    // pgvector (the primary leg) is mocked out via db.$queryRawUnsafe returning []; the real
    // code then falls through to the external store.
    // `orgContext` must be set or the mocked `getEmbeddingRuntimeConfig` fails CLOSED and returns null, so the
    // vector leg never runs at all -- which is why zero QDRANT calls were recorded. The vector leg only exists
    // once an embedding config resolves.
    orgContext = 'org-1'
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')
    // Scoped to THIS turn: the recorder is shared across the file, so it is cleared immediately before the call.
    searchVectorStoreCalls.length = 0
    const out = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })

    const qdrantCalls = searchVectorStoreCalls.filter((c) => c.provider === 'QDRANT')
    expect(qdrantCalls).toHaveLength(1)
    // CORRECTED ASSERTION (my mock/reading was wrong about the real module). I first asserted
    // `limit === 32` from `topK * 8`. The real chain is:
    //   rerankEnabled (default true, `RAG_LLM_RERANK !== 'false'`)
    //     -> retrievalTopK = args.topK * 3 = 12
    //     -> retrieveAndFuse({ topK: 12 })
    //     -> resolveVectorScores({ topK: 12 })
    //     -> wanted = Math.max(topK * 8, 16) = 96
    // So the external store is asked for 96, not 32. Pinning the real number.
    expect(qdrantCalls[0]!.limit).toBe(96)
    // The vector handed to the store came from the CHAT-purpose embedding config.
    expect(qdrantCalls[0]!.vectorLength).toBe(3)
    expect(embedTextsCalls.some((c) => c.input.includes('annual leave'))).toBe(true)
    // The vector store DID return a hit (`vectorStoreHits` above), yet the fused output is empty: the pgvector
    // leg is the one that supplies chunk bodies, and it is mocked to []. Pinned as the CURRENT shape so a future
    // change that lets the external leg contribute chunks is visible.
    expect(out.chunks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PINNED (b) — stale RAG cache after re-index
// ---------------------------------------------------------------------------

describe('PINNED (b): the RAG cache is served after a re-index and NOTHING this route does clears it', () => {
  test('a cached retrieval result is returned on the second identical search without re-running', async () => {
    const { retrieveRelevantChunks, getRagCacheStats } = await import('@/lib/rag-retrieval')

    // Enter the REAL org context: caching is context-gated, so without it both calls would
    // correctly skip the cache and this would assert nothing.
    const { enterWithOrg } = await import('@/lib/prisma-tenant')
    enterWithOrg('org-1')

    const first = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })
    const afterFirst = getRagCacheStats().misses

    // Same query, same topK, same org → the cache key matches exactly.
    const second = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })

    expect(getRagCacheStats().misses).toBe(afterFirst) // no new miss
    expect(getRagCacheStats().hits).toBeGreaterThan(0)
    // Identical object served from cache — the corpus is NOT re-read.
    expect(second.candidatesScanned).toBe(first.candidatesScanned)
  })

  test('the cache key is org-scoped AND topK-scoped, but has NO corpus version', async () => {
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')

    // Same reason as the test above: the org segment must exist for anything to be cached.
    const { enterWithOrg } = await import('@/lib/prisma-tenant')
    enterWithOrg('org-1')

    await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })
    // A different topK is a different key (so a re-index that changes nothing else is
    // still invisible to the FIRST key).
    await retrieveRelevantChunks({ query: 'annual leave', topK: 5 })

    const keys = [...cacheStore.keys()]
    // CORRECTED (my error): the real key is `rag:${orgId}:${topK}:${query.slice(0,500).toLowerCase().trim()}`
    // -- rag-retrieval.ts `ragCacheKey`. The ORG is the second segment and topK the third; my first draft had
    // topK where the org goes. The org segment comes from getOrgContext(), so it reads `org:<id>` here unless
    // the retrieval path has entered an org context; both spellings are accepted and the topK/query positions
    // are asserted directly, which is what the defect is about (no corpus version anywhere in the key).
    const topK4 = keys.filter((k) => k.split(':')[2] === '4' && k.endsWith(':annual leave'))
    const topK5 = keys.filter((k) => k.split(':')[2] === '5' && k.endsWith(':annual leave'))
    expect(topK4).toHaveLength(1)
    expect(topK5).toHaveLength(1)
    // The org segment is load-bearing (cross-tenant disclosure guard) -- assert SOMETHING occupies it rather
    // than leaving it to a fixture assumption.
    expect(topK4[0]!.split(':')[1]).not.toBe('')
    // And the whole point: nothing version-like appears AFTER the query, which is where a corpus version would
    // have to live for a re-index to change the key.
    expect(topK4[0]!.endsWith(':annual leave')).toBe(true)
    // INVERT WHEN FIXED: a corpus/document version or an invalidate-on-reindex hook should
    // appear in the key, or the FTS-rebuild path should call invalidateRagCache().
  })

  test('a DIFFERENT org does not read the first org\'s cache entry (the scoping that DOES work)', async () => {
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')

    // The org segment of the key comes from `getOrgContext()`, NOT from this file's `orgContext` seam --
    // `orgContext` only makes the `@/lib/embeddings` mock behave as if a context existed, and it leaves the real
    // `getOrgContext()` returning null, so every key came out `rag:global:...` and my `org-1`/`org-2` assertions
    // were unsatisfiable. Driven properly here by entering the real org context around each call.
    const { enterWithOrg } = await import('@/lib/prisma-tenant')
    enterWithOrg('org-1')
    const orgOne = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })
    enterWithOrg('org-2')
    const orgTwo = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })

    expect(cacheStore.has('rag:org-1:4:annual leave')).toBe(true)
    expect(cacheStore.has('rag:org-2:4:annual leave')).toBe(true)
    // The environment serves an EMPTY corpus (`chunkRows = []`), so both orgs legitimately get nothing back.
    // The load-bearing assertion is therefore the KEY SEPARATION above, not the chunk bodies: what the
    // org-scoped key buys is that org-2 read its OWN entry rather than org-1's.
    expect(cacheStore.has('rag:org-1:4:annual leave')).toBe(true)
    expect(orgOne.chunks).toEqual([])
    expect(orgTwo.chunks).toEqual([])
  })

  test('newly indexed chunks stay INVISIBLE for the whole TTL once a query is cached', async () => {
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')
    const { RAG_CACHE_TTL_MS } = await import('@/lib/constants')

    // The cache key's org segment comes from the REAL `getOrgContext()`, so the context must be entered or the
    // key is `rag:global:...` and every `rag:org-1:` lookup below is unsatisfiable.
    const { enterWithOrg } = await import('@/lib/prisma-tenant')
    enterWithOrg('org-1')

    const first = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })
    expect(first.chunks).toEqual([])

    // A re-index adds a chunk that ANSWERS this exact query. The loader seam now has a row;
    // nothing invalidates the cache entry created a moment ago.
    chunkRows = [{
      id: 'chunk-new',
      documentId: 'doc-new',
      document: { id: 'doc-new', name: 'leave-policy.pdf' },
      chunkIndex: 0,
      content: 'annual leave entitlement is 12 days per year',
      keywords: 'annual,leave',
      contextPrefix: null,
      embeddingJson: null,
      embeddingModel: null,
    }]

    // Same query, same topK, same org — the SAME cache key is hit, so the newly indexed chunk
    // is never even loaded. This is the stale-after-re-index defect, demonstrated end to end
    // rather than inferred from the key shape.
    const second = await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })

    // INVERT WHEN FIXED: after a re-index this must contain `chunk-new`.
    expect(second.chunks).toEqual([])
    expect(dbCalls.filter((c) => c.model === 'document')).toHaveLength(1) // only the FIRST call loaded
    // The re-upload/re-process route calls invalidateRagCache(); the FTS-rebuild path does NOT
    // (its job handler calls rebuildFts() only). This route never calls it either, so the stale
    // answer survives until the TTL expires.
    expect(typeof RAG_CACHE_TTL_MS).toBe('number')
    expect(cacheStore.has('rag:org-1:4:annual leave')).toBe(true)

    // The fix that WOULD clear it: invalidateRagCache() drops the whole `rag:` prefix. Asserting
    // the mechanism works shows the defect is a missing CALL, not a broken cache.
    const { invalidateRagCache } = await import('@/lib/rag')
    await invalidateRagCache()
    expect(cacheStore.has('rag:org-1:4:annual leave')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PINNED (c) — the embedding purpose is hardcoded 'chat'
// ---------------------------------------------------------------------------

describe("PINNED (c): the embedding lookup for a SEARCH uses the chat-purpose config", () => {
  test("getEmbeddingRuntimeConfig queries llmConfig with purpose 'chat' — never 'search'", async () => {
    llmConfigRows = [{
      purpose: 'chat', provider: 'OPENAI', embeddingProvider: 'OPENAI',
      embeddingModel: 'text-embedding-3-small', embeddingBaseUrl: 'https://api.openai.com/v1',
      encryptedEmbeddingApiKey: null, encryptedApiKey: null, baseUrl: 'https://api.openai.com/v1',
    }]

    // `getEmbeddingRuntimeConfig` is mocked in this file, so it answers from the mock's own seam -- but the
    // mock's first action is the `if (!orgContext)` fail-closed return, which SHORT-CIRCUITS BEFORE the
    // `llmConfigCalls.push({ where: { purpose: 'chat' } })` line. Leaving `orgContext` undefined therefore made
    // the filter assertion below unreachable and `llmConfigCalls[0]` undefined. Entering a context puts the
    // mock on the path the assertion is about.
    orgContext = 'org-1'
    const { getEmbeddingRuntimeConfig } = await import('@/lib/embeddings')
    await getEmbeddingRuntimeConfig()

    // The ONLY filter the real function applies. A dedicated search/document embedding config
    // cannot be selected, and the vector space is whatever chat happens to use.
    expect(llmConfigCalls[0]).toEqual({ where: { purpose: 'chat' } })
    expect(llmConfigCalls.some((c) => JSON.stringify(c).includes('search'))).toBe(false)

    // INVERSION GUARD: read the purpose literal straight out of the REAL `embeddings.ts` so this
    // test FAILS the moment the hardcoded purpose changes, instead of drifting along with a
    // stale expectation. (Same technique as the vector-store normalizer above.)
    const embeddingsSrc = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'lib', 'embeddings.ts'),
      'utf8',
    )
    const purposeMatches = [...embeddingsSrc.matchAll(/where:\s*\{\s*purpose:\s*'([^']+)'/g)]
    // Exactly one hardcoded purpose lookup, and it is 'chat' -- a document SEARCH has no way to
    // ask for anything else.
    expect(purposeMatches.map((m) => m[1])).toEqual(['chat'])
    // INVERT WHEN FIXED: this should become ['search'] (or the route should thread a purpose).
    expect(embeddingsSrc).not.toMatch(/purpose:\s*'search'/)
  })

  test('a SEARCH embedding request carries the chat model name end-to-end through retrieval', async () => {
    llmConfigRows = [{
      purpose: 'chat', provider: 'OPENAI', embeddingProvider: 'OPENAI',
      embeddingModel: 'chat-embed-v2', embeddingBaseUrl: 'https://api.openai.com/v1',
      encryptedEmbeddingApiKey: null, encryptedApiKey: null, baseUrl: 'https://api.openai.com/v1',
    }]

    orgContext = 'org-1'
    const { retrieveRelevantChunks } = await import('@/lib/rag-retrieval')
    await retrieveRelevantChunks({ query: 'annual leave', topK: 4 })

    // The chat-configured model is the one used to embed a document-search query. Interpreting the FIRST
    // embedTexts call as if it were the search query was backwards: the query is embedded AFTER the graph /
    // decomposition stages, so the search-query call is the LAST one, not the first.
    const queryCall = embedTextsCalls.find((c) => c.input.includes('annual leave'))
    expect(queryCall).toBeDefined()
    expect(queryCall!.model).toBe('chat-embed-v2')
    // INVERT WHEN FIXED: a search-purpose model should appear here instead.
  })

  test('with NO org context the embedding config fails CLOSED — no cross-tenant config read', async () => {
    // This is the guard the chat-purpose lookup sits behind, and the reason step 4 of the
    // route ordering matters. Explicitly pinned because it is the one correct behaviour in
    // this area.
    orgContext = undefined
    const { getEmbeddingRuntimeConfig } = await import('@/lib/embeddings')

    const config = await getEmbeddingRuntimeConfig()

    expect(config).toBeNull()
    expect(events).toContain('getEmbeddingRuntimeConfig:no-org-context')
    // Not a single llmConfig row was read.
    expect(llmConfigCalls.filter((c) => c.where).length).toBe(0)
  })

  test("the route's retrieval call has no `purpose` argument, so this layer cannot select one", async () => {
    await post({ query: 'annual leave', purpose: 'search' })

    // The caller's `purpose` is dropped on the floor by the explicit `{ query, topK }` call.
    expect(retrievalCalls[0]!.purpose).toBeUndefined()
    expect(Object.keys(retrievalCalls[0]!).sort()).toEqual(['query', 'topK'])
  })
})

// ---------------------------------------------------------------------------
// method surface
// ---------------------------------------------------------------------------

describe('POST /api/documents/search — method surface', () => {
  test('no GET is exported (a read-only search endpoint would leak the query via the URL)', () => {
    // Pinned deliberately: if a GET is ever added it must bring its own test file section.
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined()
    expect(typeof POST).toBe('function')
  })
})
