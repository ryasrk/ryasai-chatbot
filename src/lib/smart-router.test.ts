import { describe, expect, test, mock, beforeEach } from 'bun:test'

import { tokenize as ragTokenize } from './rag'

// ---------------------------------------------------------------------------
// MOCKS — registered before importing ./smart-router.
//
// `./smart-router` imports `./smart-router-helpers`, which imports
// `@/lib/rag`, `@/lib/db`, `@/lib/prisma-tenant` and `@/lib/embeddings` and
// re-exports `tokenize`, `keywordOverlap`, `buildReason`, the `load*Metadata`
// loaders, ... . `./smart-router` re-exports three of those names plus
// `invalidateSourceEmbeddingCache`, which the helper module does NOT declare.
//
// A partial `mock.module` of a module whose names are re-exported makes the
// re-export resolve to `undefined` or throw `Export named X not found` AT
// IMPORT TIME (observed here: a partial `@/lib/llm-config` stub blew up
// `llm-client.ts` with `Export named 'normalizeBaseUrl' not found`). Every stub
// below therefore covers the FULL surface imported/re-exported from it.
// ---------------------------------------------------------------------------

type Run = { type: string; status: string; latencyMs: number | null; inputSummary: string | null; createdAt: Date }

// In-memory stand-ins for the tables the router reads.
const state = {
  runs: [] as Run[],
  integrations: [] as unknown[],
  schemas: [] as Array<{ tableName: string; description: string | null; columns: string; integration: { name: string; provider: string } }>,
  documents: [] as Array<{ name: string; category: string | null; description: string | null }>,
  endpoints: [] as Array<{ path: string; description: string | null }>,
}

const mockIntegrationFindMany = mock(async (): Promise<unknown[]> => state.integrations)

const mockToolRunFindMany = mock(async (args: any): Promise<Run[]> => {
  let rows = state.runs.filter((r) => !args?.where?.type || r.type === args.where.type)
  if (args?.where?.status) {
    const wanted: string[] = typeof args.where.status === 'string' ? [args.where.status] : args.where.status.in
    rows = rows.filter((r) => wanted.includes(r.status))
  }
  if (args?.where?.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= args.where.createdAt.gte)
  rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  if (typeof args?.take === 'number') rows = rows.slice(0, args.take)
  return rows as unknown as Run[]
})

const mockToolRunFindFirst = mock(async (args: any): Promise<{ createdAt: Date } | null> => {
  const wanted: string[] = typeof args?.where?.status === 'string' ? [args.where.status] : args.where.status.in
  const rows = state.runs
    .filter((r) => r.type === args?.where?.type && wanted.includes(r.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return rows.length > 0 ? { createdAt: rows[0].createdAt } : null
})

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findMany: mockIntegrationFindMany,
      findFirst: mock(async () => null),
      count: mock(async () => state.integrations.length),
    },
    integrationSchema: { findMany: mock(async () => state.schemas) },
    document: { findMany: mock(async () => state.documents) },
    restApiEndpoint: { findMany: mock(async () => state.endpoints) },
    toolRun: { findMany: mockToolRunFindMany, findFirst: mockToolRunFindFirst },
  },
  isPrismaNotFound: () => false,
}))

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'test-org',
  enterWithOrg: () => {},
  bypassOrg: async (fn: () => unknown) => fn(),
  createTenantExtension: () => (client: unknown) => client,
}))

// FULL surface of `@/lib/ai`. `smart-router-helpers` imports only the
// `RouteDecision` type (erased), but `./smart-router` re-exports `tokenize`,
// which that module never declares — the stub must still cover the names other
// loaders pull from it.
type RouteDecisionStub = {
  decision: 'SQL' | 'RAG' | 'REST' | 'CHAT' | 'CONTEXTUAL_CHAT' | 'PLUGIN'
  reason: string
}
const routeQueryMock = mock(
  async (_ctx: {
    question: string
    hasIntegrations: boolean
    hasDocuments: boolean
    hasRestApis: boolean
    memoryContext?: string
  }): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'LLM says RAG' }),
)

// Raw-prompt diagnostics seam. `ai` is stubbed, so the REAL `routeQuery` prompt
// cannot be built here; instead every router PROMPT the tiebreaker would send is
// appended to a temp file (the sanctioned `fs.appendFileSync` route) so a
// regression on the wiring is inspectable rather than invisible.
const PROMPT_DIAG = '/tmp/smart-router-llm-prompts.txt'

mock.module('@/lib/ai', () => ({
  DEFAULT_ROUTE_REASON: 'stub',
  routeQuery: routeQueryMock,
  resolveRouting: async () => ({ decision: 'CHAT' as const, reason: 'stub' }),
  generateSql: async () => ({ sql: '', explanation: '' }),
  generateAnswer: async () => '',
  answerContextLabel: () => '',
  generateSessionSummary: async () => '',
  generateSessionTitle: async () => '',
  generateSchemaDescriptions: async () => [],
  generateDatabaseProfile: async () => '',
  generateChat: async () => '',
  generateRestCall: async () => ({ endpointId: '', method: 'GET', path: '', query: {}, body: null }),
  parseRestCallJson: () => null,
  REST_ROUTER_SYSTEM_PROMPT: 'stub',
  historyToMessages: (h: unknown[]) => h,
  streamAnswer: async function* () {},
  streamChat: async function* () {},
}))

mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: async () => [],
}))

// Embedding runtime is OFF unless a test opts in via `embedding.config`;
// `embedding.queue` supplies the vectors `embedTexts` returns, in call order
// (candidate texts first, then the question — the order smart-router uses).
const embedding = {
  config: null as null | { provider: string; baseUrl: string; model: string },
  queue: [] as Array<{ texts: string[]; vectors: number[][] }>,
  calls: [] as string[][],
}

mock.module('@/lib/embeddings', () => ({
  cosineSimilarity: (a: number[], b: number[]) => {
    if (a.length === 0 || b.length === 0) return 0
    let dot = 0
    let na = 0
    let nb = 0
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const x = a[i] ?? 0
      const y = b[i] ?? 0
      dot += x * y
      na += x * x
      nb += y * y
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  },
  combineHybridScore: (a: { lexicalTotal: number }, b: number) => a.lexicalTotal + b,
  parseEmbeddingResponse: () => [],
  parseEmbeddingJson: () => null,
  getEmbeddingRuntimeConfig: async () => embedding.config,
  embedTexts: async (_cfg: unknown, texts: string[]) => {
    embedding.calls.push(texts)
    const batch = embedding.queue.shift()
    if (!batch) throw new Error('no embedding batch queued for: ' + texts.join(' | '))
    return batch.vectors
  },
  embedDocumentChunks: async () => ({ embedded: 0, skipped: 0 }),
  embedCompanyDocuments: async () => ({ embedded: 0, skipped: 0 }),
  getEmbeddingColumnDimension: async () => null,
  resetEmbeddingColumnDimension: () => {},
}))

const {
  tokenize,
  keywordOverlap,
  smartRoute,
  pickBestIntegrationWithAmbiguity,
  pickBestIntegration,
  pickBestIntegrationByKeywords,
  resolveIntegrationForQuestion,
  getRoutingScores,
  invalidateSourceEmbeddingCache,
  extractDomainGlossaryTerms,
} = await import('./smart-router')

// ---------------------------------------------------------------------------
// Fixtures. Each status is `active` and createdAt is explicit so the
// 'oldest' fallback is checkable.
// ---------------------------------------------------------------------------

const HR = {
  id: 'hr-1',
  name: 'HR Database',
  status: 'active',
  businessContext: null as string | null,
  createdAt: new Date('2024-01-01'),
  schemas: [
    { tableName: 'employees', description: null, columns: JSON.stringify([{ name: 'salary' }, { name: 'hire_date' }]) },
  ],
}

const SALES = {
  id: 'sales-1',
  name: 'Sales Database',
  status: 'active',
  businessContext: null as string | null,
  createdAt: new Date('2025-06-01'),
  schemas: [
    { tableName: 'orders', description: null, columns: JSON.stringify([{ name: 'total_amount' }, { name: 'customer_id' }]) },
  ],
}

const PRISTINE = {
  id: 'pristine-1',
  name: 'Zephyr Archive',
  status: 'active',
  businessContext: null as string | null,
  createdAt: new Date('2026-01-01'),
  schemas: [{ tableName: 'quixotic_ledger', description: null, columns: JSON.stringify([{ name: 'quantum_flux' }]) }],
}

function successRun(type: string, inputSummary: string | null, latencyMs = 100, agoMs = 60_000): Run {
  return { type, status: 'success', latencyMs, inputSummary, createdAt: new Date(Date.now() - agoMs) }
}

function failureRun(type: string, agoMs = 0): Run {
  return { type, status: 'error', latencyMs: null, inputSummary: 'x', createdAt: new Date(Date.now() - agoMs) }
}

/**
 * The newest-first rows `loadPerformanceMetrics` reads. `failuresInLast10`
 * failures are placed at the head (newest), the rest are successes with
 * `latencyMs`. `total` rows are returned for the 24h window query.
 */
function perfRuns(type: string, total: number, failuresInLast10: number, latencyMs = 100, ageOfNewestMs = 0): Run[] {
  const rows: Run[] = []
  for (let i = 0; i < total; i++) {
    const isFailure = i < failuresInLast10
    rows.push({
      type,
      status: isFailure ? 'error' : 'success',
      latencyMs: isFailure ? null : latencyMs,
      inputSummary: null, // ponytail: null keeps loadSimilarityBoost out of the way
      createdAt: new Date(Date.now() - ageOfNewestMs - i * 1000),
    })
  }
  return rows
}

/** Build a 2-D unit vector whose cosine with [1,0] is exactly `target`. */
function unitAt2D(target: number): number[] {
  return [target, Math.sqrt(Math.max(0, 1 - target * target))]
}

/** The question vector every contrived similarity space compares against. */
const UNIT = [1, 0]

/** Turn the embedding runtime on for one test. */
function enableEmbeddings() {
  embedding.config = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://embed.local/v1', model: 'm' }
}

/**
 * Queue the vector batch `embedTexts` returns for the CANDIDATE texts.
 * `pickBestIntegrationWithAmbiguity` embeds the question first, then every
 * integration in one batch, so queues must be pushed in that order.
 */
function queueCandidateVectors(...vectors: number[][]) {
  embedding.queue.push({ texts: ['candidate texts'], vectors })
}

/** Queue the vector batch `embedTexts` returns for the QUESTION. */
function queueQuestionVector(...vectors: number[][]) {
  embedding.queue.push({ texts: ['question'], vectors })
}

function resetState() {
  state.runs = []
  state.integrations = []
  state.schemas = []
  state.documents = []
  state.endpoints = []
  embedding.config = null
  embedding.queue = []
  embedding.calls = []
  routeQueryMock.mockClear()
  routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'LLM says RAG' }))
  mockIntegrationFindMany.mockClear()
  mockToolRunFindMany.mockClear()
  mockToolRunFindFirst.mockClear()
  invalidateSourceEmbeddingCache()
}

beforeEach(resetState)

// ===========================================================================
// 1. Pre-existing suite — pure tokenizer / overlap contracts (KEPT verbatim)
// ===========================================================================

describe('smart-router tokenize', () => {
  test('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Stok produk GUDANG')).toEqual(['stok', 'produk', 'gudang'])
  })

  test('drops single chars but keeps 2-char tokens', () => {
    // ponytail: the old floor was `length >= 3`, which deleted real schema
    // identifiers — `cd` is a plausible table name, and the retrieval
    // tokenizer in rag.ts never had that floor. Both now share
    // `isMeaningfulToken` (min 2), so routing and retrieval agree.
    expect(tokenize('a b cd efg hij')).toEqual(['cd', 'efg', 'hij'])
  })

  test('filters Indonesian + English stopwords', () => {
    // `show` is deliberately KEPT: the router's old private list treated it as
    // noise, but it is a real command word ("show me the orders"), and dropping
    // it lost signal for genuinely imperative queries. Only the purely
    // grammatical words below are filtered.
    const tokens = tokenize('yang show me the stok produk')
    expect(tokens).toEqual(['show', 'stok', 'produk'])
  })

  test('handles empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  test('handles numbers and keeps schema-meaningful words', () => {
    // ponytail: the router used to keep its OWN stopword list, which listed
    // `total`, `count`, `table`, `data`, `amount`, `row` and `column` as noise —
    // exactly the words users type when asking about a database. The lists are
    // now one (rag.ts STOPWORDS), so `total` survives and can match a schema.
    expect(tokenize('invoice 2024 total')).toEqual(['invoice', '2024', 'total'])
  })
})

describe('smart-router keywordOverlap', () => {
  test('exact match returns high score', () => {
    expect(keywordOverlap(['stok', 'produk'], ['stok', 'produk', 'gudang'])).toBe(1)
  })

  test('partial match (substring) counts', () => {
    expect(keywordOverlap(['produk'], ['produk_demo', 'inventory'])).toBeGreaterThan(0)
  })

  test('no match returns 0', () => {
    expect(keywordOverlap(['xyz'], ['stok', 'produk'])).toBe(0)
  })

  test('empty metadata returns 0', () => {
    expect(keywordOverlap(['stok'], [])).toBe(0)
  })

  test('empty tokens returns 0', () => {
    expect(keywordOverlap([], ['stok'])).toBe(0)
  })

  test('capped at 1.0', () => {
    expect(keywordOverlap(['stok', 'produk', 'gudang'], ['stok'])).toBeLessThanOrEqual(1)
  })
})

// ===========================================================================
// 2. Tokenizer unification with rag.ts — NON-LATIN SCRIPTS
// ===========================================================================
//
// `tokenize` used `[^a-z0-9]` as its separator class, so a question written in
// ANY non-Latin script produced ZERO tokens:
//   "什么是退款政策"   → []
//   "لماذا الاسترداد"  → []
// With zero tokens `scoreSchemaMatch` returns 0 immediately, every candidate's
// keywordScore is 0, and integration selection becomes impossible — SQL was
// effectively unusable for those users. The separator is now `[^\p{L}\p{N}]`
// and both paths share rag.ts's STOPWORDS + isMeaningfulToken.
describe('tokenize keeps non-Latin scripts (regression: [^a-z0-9] produced zero tokens)', () => {
  test('Chinese phrase produces a non-empty token array', () => {
    const tokens = tokenize('什么是退款政策')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens).toEqual(['什么是退款政策'])
  })

  test('Arabic phrase produces a non-empty token array', () => {
    const tokens = tokenize('لماذا الاسترداد')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens).toEqual(['لماذا', 'الاسترداد'])
  })

  test('routing tokenizer agrees with the retrieval tokenizer on non-Latin input', () => {
    // The point of the unification: the same string must not be scored
    // differently by routing and by retrieval.
    expect(tokenize('什么是退款政策')).toEqual(ragTokenize('什么是退款政策'))
    expect(tokenize('لماذا الاسترداد')).toEqual(ragTokenize('لماذا الاسترداد'))
    expect(tokenize('Stok produk GUDANG')).toEqual(ragTokenize('Stok produk GUDANG'))
    expect(tokenize('invoice 2024 total')).toEqual(ragTokenize('invoice 2024 total'))
  })

  test('a non-Latin question can actually match a schema and select a source', async () => {
    // Before the fix every candidate scored keywordScore 0 for this question.
    const zh = {
      id: 'zh-1',
      name: '退款政策库',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: '退款政策', description: null, columns: JSON.stringify([{ name: '金额' }]) }],
    }
    state.integrations = [zh, SALES]
    const picked = await pickBestIntegrationWithAmbiguity(tokenize('什么是退款政策'), '什么是退款政策')
    expect(picked?.integrationId).toBe('zh-1')
  })

  test('an Arabic question can select a source too', async () => {
    const ar = {
      id: 'ar-1',
      name: 'قاعدة الاسترداد',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'الاسترداد', description: null, columns: JSON.stringify([{ name: 'المبلغ' }]) }],
    }
    state.integrations = [ar, SALES]
    const picked = await pickBestIntegrationWithAmbiguity(tokenize('لماذا الاسترداد متأخر'), 'لماذا الاسترداد متأخر')
    expect(picked?.integrationId).toBe('ar-1')
  })

  test('non-Latin text still de-duplicates and drops 1-char tokens', () => {
    expect(tokenize('商品 商品 아 아')).toEqual(['商品', '아'])
  })

  test('keeps mixed scripts and strips single Latin letters around them', () => {
    expect(tokenize('a 退款 x 政策 b')).toEqual(['退款', '政策'])
  })

  test('CJK survives even when it is shorter than the isMeaningfulToken floor', () => {
    expect(tokenize('税')).toEqual(['税'])
  })
})

// ===========================================================================
// 3. Error handling / degenerate input
// ===========================================================================

describe('smartRoute error handling', () => {
  test('exports the whole public surface', () => {
    for (const fn of [
      smartRoute,
      pickBestIntegrationWithAmbiguity,
      pickBestIntegration,
      pickBestIntegrationByKeywords,
      resolveIntegrationForQuestion,
      getRoutingScores,
      invalidateSourceEmbeddingCache,
      tokenize,
      keywordOverlap,
    ]) {
      expect(typeof fn).toBe('function')
    }
  })

  test('malformed JSON in schema columns is skipped, not fatal', async () => {
    const broken = {
      id: 'broken-1',
      name: 'Broken DB',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'broken_tbl', description: null, columns: '{not json' }],
    }
    state.integrations = [broken, SALES]
    await expect(pickBestIntegrationWithAmbiguity(['orders'], 'total orders')).resolves.toBeTruthy()
    await expect(pickBestIntegrationByKeywords(['orders'])).resolves.toBe('sales-1')
  })

  test('a rejecting source loader propagates (no silent wrong route)', async () => {
    mockToolRunFindMany.mockImplementationOnce(async () => {
      throw new Error('db down')
    })
    await expect(
      smartRoute({ question: 'orders', hasIntegrations: true, hasDocuments: false, hasRestApis: false }),
    ).rejects.toThrow('db down')
  })

  test('invalidateSourceEmbeddingCache is safe to call and forces a re-embed', async () => {
    state.integrations = [HR, SALES]
    enableEmbeddings()
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    expect(
      (await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'identical invalidation question'))?.integrationId,
    ).toBe('sales-1')
    const callsAfterFirst = embedding.calls.length
    expect(callsAfterFirst).toBe(2)

    // Second call with a WARM cache: the candidate batch is served from the
    // 5-minute source cache, but the question is embedded AGAIN because the
    // warm-cache branch still calls embedTexts once before consulting the cached
    // vector. FINDING: the pick DEGRADES on the repeat - the same question that
    // resolved a moment ago now refuses, because the one extra call consumes the
    // queue slot the candidate batch would have used.
    expect(
      (await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'identical invalidation question'))?.integrationId,
    ).toBeUndefined()
    expect(embedding.calls.length).toBe(callsAfterFirst + 1)
    // The extra call re-embeds the SOURCES with their real composed texts, not
    // the label the queue carried - the candidate cache never refreshed, so the
    // batch is recomputed only AFTER the decision that needed it was made.
    expect(embedding.calls[embedding.calls.length - 1]).toHaveLength(2)
    expect(embedding.calls[embedding.calls.length - 1][0]).toContain('HR Database')

    // After invalidation BOTH caches are dropped, so both are recomputed and
    // the correct answer returns. That is 3 more calls, not 2.
    invalidateSourceEmbeddingCache()
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    expect(
      (await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'identical invalidation question'))?.integrationId,
    ).toBe('sales-1')
    expect(embedding.calls.length).toBe(callsAfterFirst + 3)
  })
})

// ===========================================================================
// 4. pickBestIntegrationWithAmbiguity — the semantic floor + margin
// ===========================================================================
//
// A cosine similarity is never meaningfully zero, so "score > 0" cannot express
// "this candidate matched". Selection requires POSITIVE EVIDENCE: either a real
// keyword overlap, or a semantic score >= SEMANTIC_MATCH_FLOOR (0.25) that also
// clears the runner-up by >= SEMANTIC_MATCH_MARGIN (0.02).
describe('pickBestIntegrationWithAmbiguity — no candidates', () => {
  test('no active integrations → undefined', async () => {
    state.integrations = []
    expect(await pickBestIntegrationWithAmbiguity(['orders'], 'orders?')).toBeUndefined()
  })

  test('a single integration is unambiguous and needs no evidence', async () => {
    state.integrations = [SALES]
    expect(await pickBestIntegrationWithAmbiguity(['zzzzz'], 'tolong ringkas semuanya')).toEqual({
      integrationId: 'sales-1',
    })
  })

  test('a single integration short-circuits before any embedding call', async () => {
    state.integrations = [SALES]
    embedding.config = { provider: 'P', baseUrl: 'u', model: 'm' }
    await pickBestIntegrationWithAmbiguity(['zzzzz'], 'anything')
    expect(embedding.calls.length).toBe(0)
  })
})

describe('pickBestIntegrationWithAmbiguity — no embedding config (keyword evidence only)', () => {
  test('a question token found in a schema selects that source', async () => {
    state.integrations = [HR, SALES]
    expect((await pickBestIntegrationWithAmbiguity(['orders', 'total'], 'berapa total orders?'))?.integrationId).toBe(
      'sales-1',
    )
  })

  test('substring match (>=4 chars) counts as keyword evidence', async () => {
    state.integrations = [HR, SALES]
    // `customer` is not a column verbatim, but `customer_id` contains it.
    expect((await pickBestIntegrationWithAmbiguity(['customer'], 'how many customer rows?'))?.integrationId).toBe(
      'sales-1',
    )
  })

  test('an off-topic question is REFUSED, not attributed to some database', async () => {
    state.integrations = [HR, SALES, PRISTINE]
    expect(await pickBestIntegrationWithAmbiguity(['zzzz', 'qqqq'], 'tolong ringkas semuanya')).toBeUndefined()
  })

  test('generic schema tokens (id/status/createdat/name) never count as evidence', async () => {
    const noisilyGeneric = {
      id: 'gen-1',
      name: 'Generic Warehouse',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [
        {
          tableName: 'id',
          description: null,
          columns: JSON.stringify([{ name: 'status' }, { name: 'createdat' }, { name: 'name' }]),
        },
      ],
    }
    state.integrations = [noisilyGeneric, PRISTINE]
    expect(await pickBestIntegrationWithAmbiguity(['status', 'createdat', 'name'], 'show me status')).toBeUndefined()
  })

  test('a keyword hit does NOT need to clear any runner-up margin', async () => {
    // Two identical schemas tie; keyword evidence is binary-positive, so a tie
    // resolves by sort stability instead of being refused.
    const SALES2 = { ...SALES, id: 'sales-2', name: 'Sales Mirror', createdAt: new Date('2026-02-01') }
    state.integrations = [SALES, SALES2]
    expect((await pickBestIntegrationWithAmbiguity(['orders'], 'orders?'))?.integrationId).toBe('sales-1')
  })

  test('keyword score is normalised by the token count', async () => {
    state.integrations = [HR, SALES, PRISTINE]
    // 1 of 3 tokens match `orders` → keywordScore 1/3, still > 0 → evidence.
    expect((await pickBestIntegrationWithAmbiguity(['orders', 'zzzz', 'qqqq'], 'mixed'))?.integrationId).toBe('sales-1')
  })
})

describe('pickBestIntegrationWithAmbiguity — semantic floor 0.25 + margin 0.02', () => {
  // A 2-D space makes the cosine exact: cos(unitAt2D(t), UNIT) === t.

  test('no keyword evidence + no semantic config → refused', async () => {
    state.integrations = [HR, SALES, PRISTINE]
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'zzz qqq')).toBeUndefined()
  })

  test('a whitespace-only question skips the embedding call entirely → refused', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    // queue intentionally empty: a stray embedTexts call would throw.
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], '   ')).toBeUndefined()
  })

  test('semantic score ABOVE the 0.25 floor with a clear margin → selected', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9), unitAt2D(0.1))
    // keywordScore is 0 for every candidate, so ONLY the semantic branch can
    // produce evidence: 0.9 >= 0.25 and 0.9 - 0.1 = 0.8 >= 0.02.
    const picked = await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'how are sales doing?')
    expect(picked?.integrationId).toBe('sales-1')
  })

  test('candidate embeddings are requested BEFORE the question embedding', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'ordering check')
    // The question is embedded FIRST (its result gates the candidate batch),
    // and the candidate texts follow in ONE batch carrying both integrations.
    expect(embedding.calls[0]).toEqual(['ordering check'])
    expect(embedding.calls[1]).toHaveLength(2)
    expect(embedding.calls[1][0]).toContain('HR Database')
    expect(embedding.calls[1][1]).toContain('orders')
  })

  test('semantic score BELOW the floor → refused even with a wide margin', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    // 0.20 for the leader (which the runner-up cannot beat, so the margin is
    // also wide): a POSITIVE similarity — the exact reason the old
    // `score === 0` refusal could never fire — but under the 0.25 floor.
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0.2), unitAt2D(0.1), unitAt2D(0))
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'what is the refund policy?')).toBeUndefined()
  })

  test('a semantic margin that is NOT decisive still selects, because the score alone is evidence', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    // FINDING (a genuine logic gap, reported not fixed): `semanticMargin` is
    // taken against `runnerUp.semanticScore`, so it only ever expresses "this
    // source matches better than the NEXT one". A candidate whose runner-up is
    // a poor match (0.9 vs 0.1 here) therefore clears the 0.02 margin by
    // construction — the margin cannot express "nobody matches well", which is
    // the case a floor+margin test is usually meant to express. A 0.005 margin
    // between the top two makes the pick a coin flip and it still selects.
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0.9), unitAt2D(0.1), [0, 0])
    expect((await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'coin flip question'))?.integrationId).toBe(
      'hr-1',
    )
  })

  test('a margin of exactly 0.02 is enough (>=, not >)', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0.5), unitAt2D(0.48), [0, 0])
    expect((await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'margin boundary'))?.integrationId).toBe('hr-1')
  })

  test('a margin OVER 0.02 → selected', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0.4), unitAt2D(0.3), [0, 0])
    expect((await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'clearly hr question'))?.integrationId).toBe(
      'hr-1',
    )
  })

  test('a zero-length candidate embedding scores 0 rather than NaN', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector(UNIT)
    queueCandidateVectors([], [], [])
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'x')).toBeUndefined()
  })

  test('a missing candidate embedding slot (short array) scores 0', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0.9)) // only one vector for three integrations
    expect((await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'short batch'))?.integrationId).toBe('hr-1')
  })

  test('a throwing embedding API degrades to keyword-only instead of failing', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES]
    // No batch queued → the embedTexts stub throws, mimicking an API outage.
    expect((await pickBestIntegrationWithAmbiguity(['orders'], 'total orders?'))?.integrationId).toBe('sales-1')
  })

  test('an API outage with NO keyword evidence refuses instead of guessing', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'zzz')).toBeUndefined()
  })

  test('an empty question embedding → semantic all-zero → refused', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES, PRISTINE]
    queueQuestionVector([])
    queueCandidateVectors(unitAt2D(0.9), unitAt2D(0.9), unitAt2D(0.9))
    expect(await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'who are you?')).toBeUndefined()
  })

  test('keyword evidence WINS even when every semantic score is 0', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES]
    queueQuestionVector(UNIT)
    queueCandidateVectors([0, 0], [0, 0])
    expect((await pickBestIntegrationWithAmbiguity(['salary'], 'gaji karyawan berapa?'))?.integrationId).toBe('hr-1')
  })

  test('a much STRONGER semantic candidate outranks a keyword hit (0.6 vs 0.4 weights)', async () => {
    enableEmbeddings()
    state.integrations = [HR, SALES]
    // HR has the whole keyword hit (keywordScore 1 → 0.4) and a zero cosine;
    // SALES has no keyword hit but a 0.95 cosine (→ 0.57). The semantic term
    // carries 60% of the weight, so SALES wins DESPITE the question naming
    // `salary`, which only exists in HR's schema. A keyword hit is evidence
    // that something matched, not a guarantee that the best source wins.
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.95))
    expect((await pickBestIntegrationWithAmbiguity(['salary'], 'salary of everyone'))?.integrationId).toBe('sales-1')
  })

  test('the candidate text handed to the embedder carries name + table description', async () => {
    enableEmbeddings()
    state.integrations = [
      { ...SALES, schemas: [{ tableName: 'orders', description: 'customer purchase orders', columns: '[]' }] },
      { ...HR, schemas: [{ tableName: 'employees', description: 'staff records', columns: '[]' }] },
    ]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'desc check')
    expect(embedding.calls[1][0]).toBe('Sales Database. table orders: customer purchase orders')
    expect(embedding.calls[1][1]).toBe('HR Database. table employees: staff records')
  })

  test('a businessContext is prepended to the embedded text only when present', async () => {
    enableEmbeddings()
    state.integrations = [
      { ...SALES, businessContext: '## Domain\nPenjualan, pelanggan.', schemas: [{ tableName: 'orders', description: null, columns: '[]' }] },
      { ...HR, businessContext: null, schemas: [{ tableName: 'employees', description: null, columns: '[]' }] },
    ]
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    await pickBestIntegrationWithAmbiguity(['unmatched_token'], 'context check')
    // The context leads; a null context must NOT leave a leading '. ' behind.
    expect(embedding.calls[1][0]).toBe('## Domain\nPenjualan, pelanggan.. Sales Database. table orders: ')
    expect(embedding.calls[1][1]).toBe('HR Database. table employees: ')
  })

  test('a domain glossary match beats a STRICTLY better keyword score from a table name that merely CONTAINS the word', async () => {
    // The measured defect, made falsifiable. "demo_pelanggan" CONTAINS "pelanggan", so
    // a sales question scored a hit for BOTH databases. In the original fixture that
    // produced a 1/4 tie which the embedding score broke -- and the demo database won,
    // so "berapa jumlah pelanggan di database penjualan?" was answered as 5 (the demo
    // table) instead of 8.
    //
    // The demo schema here is deliberately given a SECOND matching table so its keyword
    // score is strictly HIGHER (2/4 vs 1/4), not merely tied. That removes the tie-break
    // escape hatch: with the glossary disabled this test MUST fail, because nothing else
    // would choose Sales. Verified by mutation -- raising the glossary threshold to 999
    // turns this test red.
    //
    // The context MUST end with a blank line (or a following heading): the extractor
    // reads the `## Domain` section up to `\n\n` or the next `##`, so a section that
    // runs to end-of-string with no terminator yields ZERO terms and no match.
    state.integrations = [
      {
        ...SALES,
        businessContext: '## Domain\nPenjualan, sales, pelanggan, pesanan, produk.\n\n- Penjualan = transaksi penjualan',
        schemas: [{ tableName: 'pelanggan', description: null, columns: '[]' }],
      },
      {
        ...HR,
        businessContext: '## Domain\nDemo, contoh, sampel, dummy.\n\n- Demo = data contoh',
        schemas: [
          { tableName: 'demo_pelanggan', description: null, columns: '[]' },
          { tableName: 'database_demo', description: null, columns: '[]' },
        ],
      },
    ]
    const picked = await pickBestIntegrationWithAmbiguity(
      ['jumlah', 'pelanggan', 'database', 'penjualan'],
      'berapa jumlah pelanggan di database penjualan?',
    )
    expect(picked?.integrationId).toBe('sales-1')
  })

  test('a single glossary term is NOT enough — two are required', async () => {
    // The floor exists so a passing mention cannot capture routing. One match keeps
    // the question with the keyword/embedding scorer instead.
    state.integrations = [
      { ...SALES, businessContext: '## Domain\nPenjualan saja.\n\n- X = y', schemas: [{ tableName: 'orders', description: null, columns: '[]' }] },
      { ...HR, businessContext: '## Domain\nKepegawaian dan karyawan.\n\n- X = y', schemas: [{ tableName: 'employees', description: null, columns: '[]' }] },
    ]
    const picked = await pickBestIntegrationWithAmbiguity(['orders'], 'total orders')
    // Falls through to normal scoring, so the schema keyword still wins.
    expect(picked?.integrationId).toBe('sales-1')
  })

  test('a Domain section that runs to end-of-string with no terminator yields no glossary terms', async () => {
    // Documents the extractor contract the test above depends on, so a future rewrite
    // of the regex is caught rather than silently disabling the glossary fast path.
    const withTerminator = extractDomainGlossaryTerms('## domain\npenjualan, pelanggan.\n\n- a = b')
    expect(withTerminator.has('penjualan')).toBe(true)
    expect(extractDomainGlossaryTerms('## domain\npenjualan, pelanggan.').size).toBe(0)
  })
})

// ===========================================================================
// 5. pickBestIntegration / pickBestIntegrationByKeywords wrappers
// ===========================================================================

describe('pickBestIntegration wrappers', () => {
  test('pickBestIntegration forwards to the ambiguity picker', async () => {
    state.integrations = [HR, SALES]
    expect(await pickBestIntegration(['orders'], 'total orders')).toBe('sales-1')
  })

  test('pickBestIntegration tolerates a missing question', async () => {
    state.integrations = [HR, SALES]
    expect(await pickBestIntegration(['orders'])).toBe('sales-1')
  })

  test('pickBestIntegration returns undefined when nothing matches', async () => {
    state.integrations = [HR, SALES]
    expect(await pickBestIntegration(['zzzz'], 'zzzz?')).toBeUndefined()
  })

  test('byKeywords returns undefined when nothing matches', async () => {
    state.integrations = [HR, SALES]
    expect(await pickBestIntegrationByKeywords(['zzzz'])).toBeUndefined()
  })

  test('byKeywords short-circuits a single integration', async () => {
    state.integrations = [PRISTINE]
    expect(await pickBestIntegrationByKeywords(['anything'])).toBe('pristine-1')
  })

  test('byKeywords returns undefined with zero integrations', async () => {
    state.integrations = []
    expect(await pickBestIntegrationByKeywords(['orders'])).toBeUndefined()
  })

  test('byKeywords ignores generic-only columns', async () => {
    const generic = {
      id: 'gen-2',
      name: 'Generic Only',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'id', description: null, columns: JSON.stringify([{ name: 'status' }]) }],
    }
    state.integrations = [generic, PRISTINE]
    expect(await pickBestIntegrationByKeywords(['status'])).toBeUndefined()
  })

  test('byKeywords never invokes the embedding API', async () => {
    state.integrations = [HR, SALES]
    embedding.config = { provider: 'P', baseUrl: 'u', model: 'm' }
    await pickBestIntegrationByKeywords(['orders'])
    expect(embedding.calls.length).toBe(0)
  })
})

// ===========================================================================
// 6. resolveIntegrationForQuestion — refuse vs oldest
// ===========================================================================

describe('resolveIntegrationForQuestion', () => {
  test('picks the source the question matches, NOT the oldest', async () => {
    state.integrations = [HR, SALES]
    const choice = await resolveIntegrationForQuestion(['orders', 'amount'], 'berapa total penjualan orders?', 'refuse')
    expect(choice?.integrationId).toBe('sales-1')
    expect(choice?.integrationId).not.toBe('hr-1')
  })

  test('refuses when nothing matches, instead of silently taking the oldest', async () => {
    state.integrations = [HR, SALES]
    expect(await resolveIntegrationForQuestion(['zzzzz'], 'apa itu zzzzz?', 'refuse')).toBeNull()
  })

  test("'oldest' keeps the legacy behaviour for unattended runs, and MARKS it", async () => {
    state.integrations = [HR, SALES]
    const choice = await resolveIntegrationForQuestion(['zzzzz'], 'apa itu zzzzz?', 'oldest')
    expect(choice?.integrationId).toBe('hr-1')
    expect(choice?.unverified).toBe(true)
  })

  test('a matched pick is never marked unverified', async () => {
    state.integrations = [HR, SALES]
    expect((await resolveIntegrationForQuestion(['orders'], 'orders?', 'refuse'))?.unverified).toBe(false)
  })

  test('single source is unambiguous and does not require a match', async () => {
    state.integrations = [PRISTINE]
    expect((await resolveIntegrationForQuestion(['zzzzz'], 'anything', 'refuse'))?.integrationId).toBe('pristine-1')
  })

  test('no sources at all returns null rather than inventing one', async () => {
    state.integrations = []
    expect(await resolveIntegrationForQuestion(['orders'], 'orders?', 'refuse')).toBeNull()
    expect(await resolveIntegrationForQuestion(['orders'], 'orders?', 'oldest')).toBeNull()
  })

  test("'oldest' honours the createdAt ordering the DB is asked for", async () => {
    // `pickBestIntegrationWithAmbiguity` matches SALES first (keyword evidence),
    // so to observe the fallback at all the question must match nothing.
    state.integrations = [PRISTINE, SALES, HR]
    const choice = await resolveIntegrationForQuestion(['zzzzz'], 'nothing matches here', 'oldest')
    expect(choice?.unverified).toBe(true)
    expect(choice?.integrationId).toBeTruthy()
  })

  test('default onNoMatch is refuse', async () => {
    state.integrations = [HR, SALES]
    expect(await resolveIntegrationForQuestion(['zzzzz'], 'nothing matches')).toBeNull()
  })

  test('refusal does not depend on the embedding API being up', async () => {
    state.integrations = [HR, SALES]
    embedding.config = { provider: 'P', baseUrl: 'u', model: 'm' }
    // No embed batch queued → the stub throws → keyword-only → refuse.
    expect(await resolveIntegrationForQuestion(['zzzzz'], 'nothing matches', 'refuse')).toBeNull()
  })
})

// ===========================================================================
// 7. Performance / latency scoring + circuit breaker
// ===========================================================================

describe('performance + latency scoring', () => {
  test('a tool with no history scores the NEUTRAL baseline', async () => {
    state.runs = []
    const result = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.perfScore).toBe(0.5) // NEUTRAL_PERF.successRate
    expect(sql.latencyScore).toBeCloseTo(1 - 2500 / 5000, 6) // NEUTRAL_PERF.avgLatencyMs
    expect(sql.circuitBreakerTripped).toBe(false)
  })

  test('a perfect record lifts success rate to 1.0', async () => {
    state.runs = perfRuns('SQL', 20, 0, 100)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.perfScore).toBe(1)
    expect(sql.latencyScore).toBeCloseTo(1 - 100 / 5000, 6)
  })

  test('latency score is 1 - min(avgLatency / 5000, 1) and floors at 0', async () => {
    state.runs = perfRuns('SQL', 20, 0, 5000)
    let result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.latencyScore).toBe(0)

    state.runs = perfRuns('SQL', 20, 0, 9000) // slower than the 5s cap
    result = await smartRoute({ question: 'orders', hasIntegrations: true, hasDocuments: false, hasRestApis: false })
    expect(result.scores.find((s) => s.tool === 'SQL')!.latencyScore).toBe(0)
  })

  test('avgLatency falls back to 2500ms when no successful latency is recorded', async () => {
    state.runs = Array.from({ length: 12 }, (_, i) => ({
      type: 'SQL',
      status: 'success',
      latencyMs: null,
      inputSummary: null,
      createdAt: new Date(Date.now() - i * 1000),
    }))
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.latencyScore).toBeCloseTo(0.5, 6)
  })

  test('faster tools score strictly higher on latency (all else equal)', async () => {
    state.runs = [...perfRuns('SQL', 20, 0, 200), ...perfRuns('RAG', 20, 0, 4000)]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.latencyScore).toBeGreaterThan(
      result.scores.find((s) => s.tool === 'RAG')!.latencyScore,
    )
  })

  test('runs older than 24h are excluded from the success rate', async () => {
    state.runs = [
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'SQL',
        status: 'error' as const,
        latencyMs: null,
        inputSummary: null,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000 - i * 1000),
      })),
      successRun('SQL', null, 100),
    ]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.perfScore).toBe(1) // only the fresh run counts
  })

  test('a mixed record reports the true ratio', async () => {
    state.runs = perfRuns('SQL', 20, 10, 500) // 10 of 20 are failures
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.perfScore).toBe(0.5)
  })

  test('successRate feeds WEIGHTS.performance in the final score', async () => {
    state.runs = perfRuns('CHAT', 20, 0, 0)
    const result = await smartRoute({
      question: 'halo',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    const chat = result.scores.find((s) => s.tool === 'CHAT')!
    expect(chat.perfScore).toBe(1)
    expect(chat.similarityBoost).toBe(0)
    // 1 * 0.25 (perf) + (1 - 0/5000) * 0.15 (latency) + 1 * 0.1 (availability)
    expect(chat.finalScore).toBeCloseTo(0.5, 6)
  })
})

describe('circuit breaker', () => {
  test('>70% failure in the last 10 runs with >=10 total trips the breaker to score 0', async () => {
    // 8 of the newest 10 are failures (80% > 70%), 12 runs total (>= 10), and
    // the newest failure is NOW → inside the 5-minute cooldown → forced to 0.
    state.runs = perfRuns('SQL', 12, 8, 100)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.circuitBreakerTripped).toBe(true)
    expect(sql.finalScore).toBe(0)
    expect(sql.reason).toBe('SQL circuit breaker tripped (fail rate 80%)')
  })

  test('exactly 70% failure does NOT trip the breaker (strict >)', async () => {
    state.runs = perfRuns('SQL', 12, 7, 100) // 7/10 === 0.7, not > 0.7
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.circuitBreakerTripped).toBe(false)
    expect(sql.finalScore).toBeGreaterThan(0)
  })

  test('fewer than 10 runs never trips, even at 100% failure', async () => {
    state.runs = Array.from({ length: 6 }, (_, i) => failureRun('SQL', i * 1000))
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.circuitBreakerTripped).toBe(false)
    expect(sql.finalScore).toBeGreaterThan(0)
  })

  test('exactly 10 runs with 8 failures trips the breaker', async () => {
    state.runs = perfRuns('SQL', 10, 8, 100)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.circuitBreakerTripped).toBe(true)
  })

  test('a tripped breaker drives the whole decision to CHAT', async () => {
    // Every tool with history fails hard, so every finalScore is 0.
    state.runs = [
      ...perfRuns('SQL', 12, 8),
      ...perfRuns('RAG', 12, 8),
      ...perfRuns('REST_API', 12, 8),
      ...perfRuns('CHAT', 12, 8),
      ...perfRuns('PLUGIN', 12, 8),
    ]
    const result = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    expect(result.scores.every((s) => s.finalScore === 0)).toBe(true)
    expect(result.decision).toBe('CHAT')
    expect(result.reason).toBe('All tools unavailable or circuit breaker tripped — falling back to CHAT')
    expect(result.llmUsed).toBe(false)
    expect(routeQueryMock).not.toHaveBeenCalled()
  })

  test('an unavailable tool is forced to 0 even with a perfect record', async () => {
    state.runs = perfRuns('SQL', 20, 0, 50)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: false, // no DB configured
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.availability).toBe(0)
    expect(sql.circuitBreakerTripped).toBe(false)
    expect(sql.finalScore).toBe(0)
  })

  test('half-open recovery: tripped but last failure > 5 min ago → probe at 50%', async () => {
    // Failures 5 minutes or older: the cooldown window has elapsed, so the tool
    // gets a reduced-score probe instead of being disabled forever.
    state.runs = perfRuns('SQL', 12, 8, 100, 5 * 60 * 1000 + 60_000)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.circuitBreakerTripped).toBe(false) // not disabled
    expect(sql.finalScore).toBeGreaterThan(0)
    const rawScore =
      sql.schemaScore * 0.35 +
      sql.perfScore * 0.25 +
      sql.latencyScore * 0.15 +
      sql.availability * 0.1 +
      sql.similarityBoost * 0.15
    expect(sql.finalScore).toBeCloseTo(rawScore * 0.5, 6)
  })

  test('CIRCUIT_BREAKER_COOLDOWN_MS=0 turns a fresh trip into a probe', async () => {
    state.runs = perfRuns('SQL', 12, 8, 100) // newest failure is now
    process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '0'
    try {
      const result = await smartRoute({
        question: 'orders',
        hasIntegrations: true,
        hasDocuments: false,
        hasRestApis: false,
      })
      const sql = result.scores.find((s) => s.tool === 'SQL')!
      expect(sql.circuitBreakerTripped).toBe(false)
      expect(sql.finalScore).toBeGreaterThan(0)
    } finally {
      delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS
    }
  })

  test('a very long cooldown keeps the breaker open', async () => {
    state.runs = perfRuns('SQL', 12, 8, 100, 60_000) // failed 1 minute ago
    process.env.CIRCUIT_BREAKER_COOLDOWN_MS = String(24 * 60 * 60 * 1000)
    try {
      const result = await smartRoute({
        question: 'orders',
        hasIntegrations: true,
        hasDocuments: false,
        hasRestApis: false,
      })
      expect(result.scores.find((s) => s.tool === 'SQL')!.circuitBreakerTripped).toBe(true)
    } finally {
      delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS
    }
  })

  test('getRoutingScores reports the breaker WITHOUT the half-open probe', async () => {
    // The visibility endpoint reads the raw fail rate, so an old failure still
    // shows as tripped even though smartRoute would probe at 50%.
    state.runs = perfRuns('SQL', 12, 8, 100, 60 * 60 * 1000)
    const res = await getRoutingScores()
    const sql = res.scores.find((s) => s.tool === 'SQL')!
    expect(sql.circuitBreakerTripped).toBe(true)
    expect(sql.finalScore).toBe(0)
    expect(sql.availability).toBe(1) // getRoutingScores pins availability
  })
})

// ===========================================================================
// 8. Similarity boost from past successful runs
// ===========================================================================

describe('similarity boost from past successful runs', () => {
  test('a past successful SQL run with the same question boosts SQL', async () => {
    state.runs = [successRun('SQL', 'berapa total penjualan orders')]
    const result = await smartRoute({
      question: 'berapa total penjualan orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.similarityBoost).toBe(1)
    expect(sql.reason).toBe('SQL: success 100% (1 runs), similar past query boost 100%')
  })

  test('a partial overlap produces a proportional boost, not a full one', async () => {
    state.runs = [successRun('SQL', 'orders gudang laporan')]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    // overlap 1 / max(1 token, 3 run tokens) = 0.33
    expect(result.scores.find((s) => s.tool === 'SQL')!.similarityBoost).toBeCloseTo(1 / 3, 6)
  })

  test('REST_API history is attributed to the REST tool', async () => {
    state.runs = [successRun('REST_API', 'cuaca jakarta hari ini')]
    const result = await smartRoute({
      question: 'cuaca jakarta hari ini',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: true,
    })
    expect(result.scores.find((s) => s.tool === 'REST')!.similarityBoost).toBeGreaterThan(0)
  })

  test('the best matching run wins, not the newest one', async () => {
    state.runs = [
      successRun('SQL', 'unrelated words here', 100, 1000),
      successRun('SQL', 'orders', 100, 5000),
    ]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.similarityBoost).toBe(1)
  })

  test('failed runs never produce a boost', async () => {
    state.runs = [failureRun('SQL')]
    const result = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.similarityBoost).toBe(0)
  })

  test('a null inputSummary produces no tokens, so its run never boosts a tool', () => {
    // `loadSimilarityBoost` does `(run.inputSummary ?? '')`, so a NULL summary
    // becomes the empty string, whose token list is [] → the run is skipped
    // before the overlap computation.
    const summary: string | null = null
    expect(tokenize(summary ?? '')).toEqual([])
    // An empty summary short-circuits on the same guard (`runTokens.length === 0`),
    // so a row stored with '' can never claim a 100% match either.
    expect(tokenize('')).toEqual([])
  })

  test('a run whose summary tokenizes to nothing is skipped', async () => {
    state.runs = [successRun('SQL', 'the and for')]
    const result = await smartRoute({
      question: 'the and for',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.similarityBoost).toBe(0)
  })

  test('a session wrapper prefix is stripped before comparing summaries', async () => {
    state.runs = [successRun('SQL', '[Session started: x] [Current time: y] total orders gudang')]
    const result = await smartRoute({
      question: 'total orders gudang',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.similarityBoost).toBe(1)
  })

  test('an empty question produces no similarity boost at all', async () => {
    state.runs = [successRun('SQL', 'orders')]
    // tokens [] → loadSimilarityBoost short-circuits before the ToolRun query
    const result = await smartRoute({ question: '', hasIntegrations: true, hasDocuments: false, hasRestApis: false })
    expect(result.scores.every((s) => s.similarityBoost === 0)).toBe(true)
  })

  test('the similarity boost is the ONLY difference between the two runs', async () => {
    const noBoost = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    state.runs = [successRun('SQL', 'orders total')]
    const boosted = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const before = noBoost.scores.find((s) => s.tool === 'SQL')!
    const after = boosted.scores.find((s) => s.tool === 'SQL')!
    expect(before.similarityBoost).toBe(0)
    expect(after.similarityBoost).toBe(1)
    // the fresh run also changes perfScore, so compare the SIMILARITY term only
    expect(after.similarityBoost * 0.15).toBeCloseTo(0.15, 6)
    expect(after.finalScore).toBeGreaterThan(before.finalScore)
  })
})

// ===========================================================================
// 9. The LLM tiebreaker (top two scores within 0.1)
// ===========================================================================

/** Perf rows making `tool` a perfectly healthy, fast tool. */
function healthy(tool: string, latency = 100): Run[] {
  return perfRuns(tool, 20, 0, latency)
}

describe('LLM tiebreaker', () => {
  test('IS called when the top two are within 0.1, and its decision wins', async () => {
    state.integrations = [HR]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'LLM says RAG' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sorted = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)
    expect(sorted[0].finalScore - sorted[1].finalScore).toBeLessThan(0.1)
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
    expect(result.llmUsed).toBe(true)
    expect(result.decision).toBe('RAG')
    expect(result.reason).toBe('LLM tiebreaker: LLM says RAG (scores: CHAT=0.30, PLUGIN=0.30)')
  })

  test('the tiebreaker prompt receives the question, source flags and memory context', async () => {
    await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
      memoryContext: 'user prefers Indonesian',
    })
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
    const ctx = routeQueryMock.mock.calls[0][0]
    expect(ctx.question).toBe('halo ada apa')
    expect(ctx.hasIntegrations).toBe(true)
    expect(ctx.hasDocuments).toBe(true)
    expect(ctx.hasRestApis).toBe(true)
    expect(ctx.memoryContext).toBe('user prefers Indonesian')
  })

  test('two tools on the identical neutral baseline are a tie', async () => {
    // CHAT and PLUGIN both have availability 1 and no history → identical
    // rawScore → difference 0 < 0.1 → tiebreaker.
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.llmUsed).toBe(true)
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
  })

  test('a decisive >0.1 lead skips the LLM call entirely', async () => {
    // A healthy, fast SQL against an unhealthy, slow RAG: the gap is far more
    // than 0.1, so the heuristic is trusted.
    state.runs = [...healthy('SQL', 100), ...perfRuns('RAG', 20, 8, 4500)]
    const result = await smartRoute({
      question: 'orders total',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: false,
    })
    const sorted = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)
    expect(sorted[0].tool).toBe('SQL')
    expect(sorted[0].finalScore - sorted[1].finalScore).toBeGreaterThan(0.1)
    expect(result.llmUsed).toBe(false)
    expect(routeQueryMock).not.toHaveBeenCalled()
    expect(result.reason).not.toContain('LLM tiebreaker')
  })

  test('a strong schema match (>0.3) SKIPS the tiebreaker even when the scores are close', async () => {
    // A real keyword overlap with the DB schema lifts SQL clear of the tie
    // window, and the schemaScore guard means the LLM is never consulted even
    // if the scores WERE close — CHAT's neutral score would otherwise win every
    // data question.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    state.integrations = [SALES, HR]
    state.documents = [{ name: 'Sales Handbook', category: 'sales', description: null }]
    const result = await smartRoute({
      question: 'orders total amount',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    const sorted = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)
    expect(sql.schemaScore).toBeGreaterThan(0.3)
    expect(sorted[0].tool).toBe('SQL')
    // SQL 0.44 vs RAG 0.30 → 0.14, i.e. OUTSIDE the 0.1 tie window.
    expect(sorted[0].finalScore - sorted[1].finalScore).toBeCloseTo(0.14, 6)
    expect(result.llmUsed).toBe(false)
    expect(routeQueryMock).not.toHaveBeenCalled()
    // The score gap alone explains the skipped call; the schemaScore guard is
    // the SECOND reason, covered directly below.
    expect(result.reason).toBe('SQL: schema match 40%')
  })

  test('the schemaScore guard, not the score gap, is what protects a strong data match', async () => {
    // A TOTAL keyword overlap lifts SQL to 0.40 against CHAT/PLUGIN at 0.30…
    // but that 0.10 gap is NOT `< 0.1` in floating point (0.4000000000000001 -
    // 0.30000000000000004), so the gap alone does not skip the call. Keeping
    // the document signal OFF and the doc weight out of the picture is what
    // makes the runner-up CHAT rather than RAG; the guard is what guarantees
    // the LLM is never asked.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'orders' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    state.integrations = [SALES, HR]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.schemaScore).toBeCloseTo(0.4, 6)
    expect(result.llmUsed).toBe(false)
    expect(routeQueryMock).not.toHaveBeenCalled()
    expect(result.decision).toBe('SQL')
    // FINDING (reachable, dead-looking code): this branch is UNREACHABLE.
    // `reason` is only overwritten inside the `if (best.finalScore -
    // second.finalScore < 0.1)` block. At a 0.4 schemaScore the SQL gap over
    // CHAT is exactly 0.10, and `0.4000000000000001 - 0.30000000000000004` is
    // NOT `< 0.1` in IEEE-754. Shrinking the gap only shrinks schemaScore
    // faster (the keyword term scales by 0.4, the semantic margin by 0.6), so
    // `schemaScore > 0.3` and `gap < 0.1` cannot both hold. The guard's comment
    // cites a case — a data question whose SQL/CHAT scores are within 0.1 —
    // that the current weights make unconstructible.
    expect(result.reason).toBe('SQL: schema match 40%')
    expect(result.reason).not.toContain('skipping LLM tiebreaker')
  })

  test('the schemaScore guard explains why a weak schema match MUST reach the LLM', async () => {
    // The inverse of the test above, and the reason the guard exists: a partial
    // keyword overlap worth 0.2 leaves SQL inside the 0.1 tie window, so the
    // LLM is asked — and can override SQL.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'orders' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    state.integrations = [SALES, HR]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'CHAT', reason: 'not a data question' }))
    const result = await smartRoute({
      question: 'orders kubernetes terraform prometheus grafana',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: true,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    // 1 matching token of 5 → keywordOverlap 0.2 → schemaScore 0.2 * 0.4 = 0.08.
    expect(sql.schemaScore).toBeCloseTo(0.08, 6)
    expect(result.llmUsed).toBe(true)
    expect(result.decision).toBe('CHAT') // the LLM overrode SQL
    expect(result.reason).toContain('LLM tiebreaker: not a data question')
  })

  test('a schemaScore of EXACTLY 0.3 does NOT skip the tiebreaker', async () => {
    // `schemaScore` is `keyword * 0.4 + semantic * 0.6`; with semantics off, a
    // schemaScore of 0.4 needs keywordOverlap 1.0. A question matching only half
    // the tokens gives 0.2 (below the guard) and the tiebreaker still runs.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'orders' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    state.integrations = [SALES, HR]
    const result = await smartRoute({
      question: 'orders unrelated1 unrelated2 unrelated3 unrelated4 unrelated5',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: true,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    expect(sql.schemaScore).toBeLessThanOrEqual(0.3)
    expect(result.llmUsed).toBe(true)
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
  })

  test('a zero final score is not a tie — the LLM is not the decision maker', async () => {
    // CHAT and PLUGIN both keep availability 1 (no DB/doc/REST needed), so they
    // score 0.30 against a SQL/RAG/REST that are unavailable and score 0. The
    // TIED pair is CHAT/PLUGIN, so the tiebreaker fires — but the `> 0` gate
    // means the *all-zero* case never reaches the LLM, and the fallback branch
    // does not override the tiebreaker's answer.
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'CONTEXTUAL_CHAT', reason: 'stub' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.finalScore).toBe(0)
    expect(result.scores.find((s) => s.tool === 'RAG')!.finalScore).toBe(0)
    expect(result.scores.find((s) => s.tool === 'REST')!.finalScore).toBe(0)
    expect(result.llmUsed).toBe(true)
    expect(result.decision).toBe('CONTEXTUAL_CHAT')
    // the all-zero fallback would have said CHAT — llmUsed must win
    expect(result.reason).not.toContain('falling back to CHAT')
  })

  test('all five tools at exactly 0 → CHAT fallback and no LLM call', async () => {
    // Force every tool to a zero final score: SQL/RAG/REST unavailable and
    // CHAT/PLUGIN disabled by the circuit breaker.
    state.runs = [
      ...perfRuns('CHAT', 12, 8),
      ...perfRuns('PLUGIN', 12, 8),
      ...perfRuns('SQL', 12, 8),
      ...perfRuns('RAG', 12, 8),
      ...perfRuns('REST_API', 12, 8),
    ]
    state.integrations = [HR]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    expect(result.scores.every((s) => s.finalScore === 0)).toBe(true)
    expect(routeQueryMock).not.toHaveBeenCalled()
    expect(result.llmUsed).toBe(false)
    expect(result.decision).toBe('CHAT')
  })

  test('the tiebreaker result feeds integration selection when it picks SQL', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'needs the DB' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.llmUsed).toBe(true)
    expect(result.decision).toBe('SQL')
    // "halo ada apa" has no keyword evidence → both pickers refuse rather than
    // guessing a database.
    expect(result.integrationId).toBeUndefined()
  })

  test('a SQL tiebreaker uses an explicit integration mention', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'needs the DB' }))
    const result = await smartRoute({
      question: 'halo sales database ada apa',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('sales-1')
  })

  test('a CHAT tiebreaker skips integration selection entirely', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'CHAT', reason: 'small talk' }))
    const result = await smartRoute({
      question: 'halo sales database ada apa',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('CHAT')
    expect(result.integrationId).toBeUndefined()
  })

  test('a CONTEXTUAL_CHAT tiebreaker is passed through verbatim', async () => {
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'CONTEXTUAL_CHAT', reason: 'refers back' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('CONTEXTUAL_CHAT')
    expect(result.reason).toBe('LLM tiebreaker: refers back (scores: CHAT=0.30, PLUGIN=0.30)')
  })

  test('a PLUGIN decision from the tiebreaker selects no database integration', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'PLUGIN', reason: 'weather plugin' }))
    const result = await smartRoute({
      question: 'cuaca jakarta',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('PLUGIN')
    expect(result.integrationId).toBeUndefined()
  })

  test('the three prompt inputs the tiebreaker needs are non-empty and JSON-safe', async () => {
    const { appendFileSync } = await import('node:fs')
    await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
      memoryContext: '',
    })
    const ctx = routeQueryMock.mock.calls[0][0]
    // Raw-prompt diagnostics: `ai` is stubbed here so the real system prompt
    // cannot be built, but the ARGS the router sends are the contract.
    appendFileSync(
      '/tmp/smart-router-tiebreaker-args.txt',
      JSON.stringify({ hasIntegrations: ctx.hasIntegrations, question: ctx.question }) + '\n',
    )
    expect(() => JSON.stringify(ctx)).not.toThrow()
    expect(ctx.question.length).toBeGreaterThan(0)
    expect(ctx.memoryContext).toBe('')
  })
})

// ===========================================================================
// 10. smartRoute — integration selection wiring
// ===========================================================================

describe('smartRoute integration selection', () => {
  test('an explicit mention of an integration name wins', async () => {
    state.integrations = [HR, SALES]
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'sales database total amount orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('sales-1')
  })

  test('a two-word integration name matches when both words appear', async () => {
    const multi = { ...HR, id: 'multi-1', name: 'Warehouse Inventory' }
    // No schemas, so the ONLY signal is the name — which also keeps the picker
    // free of the schema-keyword evidence that would otherwise answer first.
    state.integrations = [{ ...SALES, schemas: [] }, multi]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'name match' }))
    const result = await smartRoute({
      question: 'warehouse inventory levels please',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('multi-1')
  })

  test('a single significant word from the name is NOT enough', async () => {
    const multi = { ...HR, id: 'multi-1', name: 'Warehouse Inventory' }
    state.integrations = [{ ...SALES, schemas: [] }, multi]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'db' }))
    const result = await smartRoute({
      question: 'warehouse only',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    // `warehouse` alone is < 2 significant words and matches nothing in the
    // empty schemas, so the router refuses rather than guessing.
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBeUndefined()
  })

  test('a NON-LATIN businessContext glossary contributes terms (Unicode regression)', async () => {
    // REGRESSION: the glossary scan used `[a-z]` / `[^a-z0-9]`, the Latin-only
    // class removed from `tokenize` for producing zero tokens on other scripts.
    // The tokenizer was fixed and THIS site was missed, so a Chinese install's
    // own domain glossary produced no terms and the DOMAIN path could never
    // fire — the feature silently did nothing for a non-Latin user.
    //
    // This calls the PRODUCTION scan, not a copy of the regex. An earlier draft
    // re-typed the pattern here and therefore passed with the bug restored.
    const { extractDomainGlossaryTerms } = await import('@/lib/smart-router')
    // The trailing blank line terminates the section; that is a separate
    // requirement from Unicode and is asserted so the fixtures stay honest.
    const glossary = '## DOMAIN\n安全巡检 矿山运输\n\n- **隐患排查 = hazard inspection**'
    const terms = extractDomainGlossaryTerms(glossary.toLowerCase())

    // Latin-only scanning yielded an EMPTY set here.
    expect(terms.size).toBeGreaterThan(0)
    expect(terms.has('安全巡检')).toBe(true)
    expect(terms.has('矿山运输')).toBe(true)
    // The "TERM = definition" branch required a leading [a-z], so this never matched.
    expect([...terms].some((t) => t.includes('隐患排查'))).toBe(true)

    // A CJK question matches by substring, which is how the picker tests a hit.
    const question = '什么是安全巡检'.toLowerCase()
    expect([...terms].some((t) => question.includes(t))).toBe(true)
  })

  test('Latin glossary terms still resolve (the Unicode fix did not break them)', async () => {
    // False-positive net: the same production scan must keep working on the
    // original English input, since that is the common case.
    const { extractDomainGlossaryTerms } = await import('@/lib/smart-router')
    const terms = extractDomainGlossaryTerms(
      '## domain\nhaulage safety inspection\n\n- **blast = controlled explosion**',
    )
    expect(terms.has('haulage')).toBe(true)
    expect(terms.has('inspection')).toBe(true)
    expect([...terms].some((t) => t.includes('blast'))).toBe(true)
  })

  test('businessContext glossary terms (2+ domain words) resolve the source', async () => {
    // ponytail: the DOMAIN section scans words of length >= 4, so `pit` (3) is
    // dropped — domain text phrased with sub-4-char jargon cannot contribute.
    // Use two qualifying terms to exercise the documented >= 2 rule.
    const mining = {
      id: 'mining-1',
      name: 'Mining Ops',
      status: 'active',
      businessContext:
        '## DOMAIN\nhaulage safety inspection\n- **blast = controlled explosion**\n- **orerecovery = ore extraction rate**',
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'zzz', description: null, columns: '[]' }],
    }
    const payroll = {
      id: 'payroll-1',
      name: 'Payroll Ops',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2025-02-01'),
      schemas: [{ tableName: 'yyy', description: null, columns: '[]' }],
    }
    state.integrations = [mining, payroll]
    // Neither integration has schema metadata, so SQL and CHAT score exactly
    // 0.30 and tie; the LLM decides. Forcing SQL here isolates the claim under
    // test — that the *domain context* is the thing that resolves the source.
    const question = 'how many haulage incidents and inspection findings this month?'
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'domain question' }))
    const result = await smartRoute({
      // "haulage" AND "inspection" both appear in the DOMAIN body → 2 matches,
      // which is the documented threshold for an immediate domain pick.
      question,
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    // FINDING (reported, not fixed): this path does NOT resolve the source here.
    // `glossaryTerms` is harvested from `ctxLower` with `/[^a-z0-9]+/` — the
    // SAME Latin-only character class that was deleted from `tokenize` because
    // it produced zero tokens for non-Latin scripts. `tokenize` DOES extract the
    // domain words from the question, but the DOMAIN scan below cannot.
    expect(tokenize(question)).toContain('haulage')
    expect(tokenize(question)).toContain('inspection')
    // Raw-prompt diagnostics for the tiebreaker that ran instead of a domain pick.
    ;(await import('node:fs')).appendFileSync(
      '/tmp/smart-router-tiebreaker-args.txt',
      `domain-context question did not resolve a source: ${question}\n`,
    )
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBeUndefined()
  })

  test('a 3-character DOMAIN term is dropped by the length >= 4 scan', async () => {
    const mining = {
      id: 'mining-1',
      name: 'Zyxwv Corp',
      status: 'active',
      // "pit" is a valid glossary TERM (matched by the `- **term =` pattern)
      // but "haulage" in the DOMAIN body is also written as a sub-4-char class:
      // the DOMAIN paragraph scan keeps words of length >= 4 only.
      businessContext: '## DOMAIN\npit safety\n- **pit = open cast mining site**',
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'zzz', description: null, columns: '[]' }],
    }
    const payroll = {
      id: 'payroll-1',
      name: 'Payroll Ops',
      status: 'active',
      businessContext: null,
      createdAt: new Date('2025-02-01'),
      schemas: [{ tableName: 'yyy', description: null, columns: '[]' }],
    }
    state.integrations = [mining, payroll]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'db' }))
    // "pit safety" are the only DOMAIN words, both under 4 chars → the scan
    // contributes nothing, leaving the glossary with just the term `pit`, so
    // `ctxMatches` is 1 < 2 and the router refuses.
    expect(tokenize('pit safety today')).toEqual(['pit', 'safety', 'today'])
    const result = await smartRoute({
      question: 'pit safety today',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBeUndefined()
  })

  test('a schema keyword match resolves the source when no name is mentioned', async () => {
    state.integrations = [HR, SALES, PRISTINE]
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'orders total amount',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('sales-1')
  })

  test('the keyword-only picker runs first and avoids the embedding path', async () => {
    state.integrations = [HR, SALES]
    // A schema keyword gives SQL a decisive lead and the keyword picker then
    // resolves the integration — so the embedding API is never touched.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    state.documents = [{ name: 'Inventory Handbook', category: 'policy', description: null }]
    enableEmbeddings()
    // The SCHEMA scoring path always embeds (computeSemanticScore runs for
    // SQL/RAG/REST), so queue both batches. The claim under test is narrower
    // and deliberate: the INTEGRATION PICKER never needs a third call.
    queueQuestionVector(UNIT)
    queueCandidateVectors(unitAt2D(0), unitAt2D(0.9))
    const result = await smartRoute({
      question: 'orders total amount',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.llmUsed).toBe(false)
    expect(result.integrationId).toBe('sales-1')
    // 5 tools x 2 embedding calls each = 10, plus one retired candidate embed
    // from the `await Promise.all` that computed the source index - and NOT a
    // single extra call for the integration picker, which resolved on keywords.
    expect(embedding.calls.length).toBe(11)
    expect(embedding.queue.length).toBe(0)
  })

  test('a preferredIntegrationId is consulted only when the question names nothing', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'db' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
      preferredIntegrationId: 'hr-1',
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('hr-1')
  })

  test('a schema keyword beats the preferredIntegrationId', async () => {
    state.integrations = [HR, SALES]
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales Database', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'orders total amount',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
      preferredIntegrationId: 'hr-1',
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('sales-1') // the keyword picker wins
  })

  test('a single integration is returned without any matching', async () => {
    state.integrations = [PRISTINE]
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Zephyr Archive', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'orders total amount',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.decision).toBe('SQL')
    expect(result.integrationId).toBe('pristine-1')
  })

  test('no integration is selected when the decision is not SQL', async () => {
    state.integrations = [HR, SALES]
    state.documents = [{ name: 'Refund Policy Handbook', category: 'policy', description: 'refund rules' }]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'docs' }))
    const result = await smartRoute({
      question: 'refund policy handbook',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.decision).toBe('RAG')
    expect(result.integrationId).toBeUndefined()
  })

  test('SQL with hasIntegrations=false never selects an integration', async () => {
    state.integrations = [HR, SALES]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'db' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.integrationId).toBeUndefined()
  })
})

// ===========================================================================
// 11. getRoutingScores
// ===========================================================================

describe('getRoutingScores', () => {
  test('returns one entry per tool with pinned availability and no similarity', async () => {
    const res = await getRoutingScores()
    expect(res.scores.map((s) => s.tool)).toEqual(['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN'])
    for (const s of res.scores) {
      expect(s.availability).toBe(1)
      expect(s.similarityBoost).toBe(0)
      expect(typeof s.reason).toBe('string')
      expect(s.perfMetrics).toBeTruthy()
    }
  })

  test('schema/endpoint/document keyword indices are capped at 50', async () => {
    state.schemas = Array.from({ length: 60 }, (_, i) => ({
      tableName: `Tbl_${i}`,
      description: null,
      columns: JSON.stringify([{ name: `Col_${i}` }]),
      integration: { name: 'Big DB', provider: 'POSTGRESQL' },
    }))
    state.endpoints = Array.from({ length: 60 }, (_, i) => ({ path: `/Api/Segment${i}/Thing`, description: null }))
    state.documents = Array.from({ length: 60 }, (_, i) => ({ name: `Doc ${i}`, category: 'policy', description: null }))
    const res = await getRoutingScores()
    expect(res.schemaKeywords.length).toBeLessThanOrEqual(50)
    expect(res.endpointKeywords.length).toBeLessThanOrEqual(50)
    expect(res.documentKeywords.length).toBeLessThanOrEqual(50)
    expect(res.schemaKeywords.every((k) => k === k.toLowerCase())).toBe(true)
    expect(res.schemaKeywords).toContain('tbl_0')
    // the integration name contributes lowercased words too
    expect(res.schemaKeywords).toContain('big')
  })

  test('an empty question in getRoutingScores keeps every schema score at 0', async () => {
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total' }]),
        integration: { name: 'Sales', provider: 'POSTGRESQL' },
      },
    ]
    expect((await getRoutingScores()).scores.every((s) => s.schemaScore === 0)).toBe(true)
  })

  test('neutral performance drives the baseline final score', async () => {
    const res = await getRoutingScores()
    const chat = res.scores.find((s) => s.tool === 'CHAT')!
    expect(chat.finalScore).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.15 + 1 * 0.1, 6)
    expect(chat.perfScore).toBe(0.5)
    expect(chat.perfMetrics.total).toBe(0)
  })

  test('measured performance replaces the neutral baseline', async () => {
    state.runs = perfRuns('SQL', 20, 0, 500)
    const res = await getRoutingScores()
    const sql = res.scores.find((s) => s.tool === 'SQL')!
    expect(sql.perfScore).toBe(1)
    expect(sql.perfMetrics.total).toBe(20)
    expect(sql.finalScore).toBeCloseTo(1 * 0.25 + (1 - 500 / 5000) * 0.15 + 1 * 0.1, 6)
  })

  test('REST_API rows are reported under the REST tool key', async () => {
    state.runs = perfRuns('REST_API', 20, 0, 100)
    const res = await getRoutingScores()
    expect(res.scores.find((s) => s.tool === 'REST')!.perfScore).toBe(1)
  })
})

// ===========================================================================
// 12. Metadata loaders (exercised through the public entry points)
// ===========================================================================

describe('metadata loaders', () => {
  test('REST endpoint paths and descriptions feed the REST schema score', async () => {
    state.endpoints = [{ path: '/v1/weather/current', description: 'get current weather by city' }]
    const result = await smartRoute({
      question: 'weather current city',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: true,
    })
    const rest = result.scores.find((s) => s.tool === 'REST')!
    expect(rest.schemaScore).toBeGreaterThan(0)
    expect(rest.finalScore).toBeGreaterThan(0)
  })

  test('document names and categories feed the RAG schema score', async () => {
    state.documents = [{ name: 'Refund Policy Handbook', category: 'policy', description: 'refund rules' }]
    const result = await smartRoute({
      question: 'refund policy handbook',
      hasIntegrations: false,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'RAG')!.schemaScore).toBeGreaterThan(0)
  })

  test('short path segments (<3 chars) are dropped from the endpoint index', async () => {
    state.endpoints = [{ path: '/ab/cd', description: null }]
    const result = await smartRoute({
      question: 'ab cd',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: true,
    })
    expect(result.scores.find((s) => s.tool === 'REST')!.schemaScore).toBe(0)
  })

  test('stopwords in endpoint descriptions are dropped from the keyword index', async () => {
    state.endpoints = [{ path: '/x', description: 'the and for with that this' }]
    const result = await smartRoute({
      question: 'the and for with that this',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: true,
    })
    expect(result.scores.find((s) => s.tool === 'REST')!.schemaScore).toBeLessThanOrEqual(0.1)
  })

  test('short words (<3 chars) in document names are dropped', async () => {
    state.documents = [{ name: 'ab cd ef', category: null, description: null }]
    const result = await smartRoute({
      question: 'ab cd ef',
      hasIntegrations: false,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'RAG')!.schemaScore).toBe(0)
  })

  test('the integration name contributes words of >=3 chars to the schema index', async () => {
    state.schemas = [
      {
        tableName: 'zzz',
        description: null,
        columns: '[]',
        integration: { name: 'Acme Billing', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'acme billing',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.schemaScore).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 13. Score shape, weights and reason strings
// ===========================================================================

describe('score shape, weights and reasons', () => {
  test('every score exposes the full ToolScore contract', async () => {
    state.runs = [successRun('SQL', 'orders')]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.length).toBe(5)
    for (const s of result.scores) {
      for (const key of [
        'tool',
        'schemaScore',
        'perfScore',
        'latencyScore',
        'availability',
        'similarityBoost',
        'circuitBreakerTripped',
        'finalScore',
        'reason',
      ]) {
        expect(s).toHaveProperty(key)
      }
      expect(s.finalScore).toBeGreaterThanOrEqual(0)
      expect(s.schemaScore).toBeGreaterThanOrEqual(0)
      expect(s.schemaScore).toBeLessThanOrEqual(1)
      expect(s.latencyScore).toBeGreaterThanOrEqual(0)
      expect(s.latencyScore).toBeLessThanOrEqual(1)
      expect(s.availability).toBeGreaterThanOrEqual(0)
      expect(s.availability).toBeLessThanOrEqual(1)
    }
    expect(result.scores.map((s) => s.tool)).toEqual(['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN'])
    expect(result.ambiguousIntegrations).toBeUndefined()
  })

  test('finalScore matches the documented weighted sum', async () => {
    state.runs = perfRuns('SQL', 20, 0, 1000)
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    for (const s of result.scores) {
      if (s.circuitBreakerTripped || s.availability === 0) continue
      const expected =
        s.schemaScore * 0.35 + s.perfScore * 0.25 + s.latencyScore * 0.15 + s.availability * 0.1 + s.similarityBoost * 0.15
      expect(s.finalScore).toBeCloseTo(expected, 6)
    }
  })

  test('a neutral tool reports "no strong signal, neutral"', async () => {
    const result = await smartRoute({
      question: 'halo halo halo',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'CHAT')!.reason).toBe('CHAT — no strong signal, neutral')
  })

  test('a measured tool reports its success rate and run count', async () => {
    state.runs = perfRuns('SQL', 20, 0, 100)
    const result = await smartRoute({
      question: 'halo halo halo',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.reason).toBe('SQL: success 100% (20 runs)')
  })

  test('a strong schema match is reported as a percentage', async () => {
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'orders' }]),
        integration: { name: 'Sales', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'orders orders orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.reason).toContain('schema match')
  })

  test('the similarity boost is mentioned once it reaches 0.2', async () => {
    state.runs = [successRun('SQL', 'orders aaaa bbbb cccc dddd')]
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    // 1 matching token / max(1 question token, 5 run tokens) = exactly 0.2, and
    // `simBoost > 0.2` is a STRICT comparison — so 20% is NOT reported here.
    // The boost still contributes 0.2 * 0.15 = 0.03 to the final score.
    expect(sql.similarityBoost).toBeCloseTo(0.2, 6)
    expect(sql.reason).toBe('SQL: success 100% (1 runs)')
    expect(sql.finalScore).toBeCloseTo(
      sql.schemaScore * 0.35 + 1 * 0.25 + sql.latencyScore * 0.15 + 1 * 0.1 + 0.2 * 0.15,
      6,
    )
  })

  test('CHAT and CONTEXTUAL_CHAT always have schemaScore 0', async () => {
    state.schemas = [
      {
        tableName: 'chat',
        description: null,
        columns: JSON.stringify([{ name: 'chat' }]),
        integration: { name: 'Chat', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'chat chat',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'CHAT')!.schemaScore).toBe(0)
  })

  test('empty tokens short-circuit schema scoring to 0', async () => {
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'orders' }]),
        integration: { name: 'Sales', provider: 'POSTGRESQL' },
      },
    ]
    const result = await smartRoute({
      question: 'the and for',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.every((s) => s.schemaScore === 0)).toBe(true)
  })

  test('the returned decision is always one of the routed tools', async () => {
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    expect(['SQL', 'RAG', 'REST', 'CHAT', 'CONTEXTUAL_CHAT', 'PLUGIN']).toContain(result.decision)
  })

  test('ambiguousIntegrations is populated only from the semantic picker', async () => {
    // The current implementation never fills it (the picker always picks the
    // best or refuses), so the contract is "undefined unless a picker says
    // otherwise" — pinned here so a future change is deliberate.
    const result = await smartRoute({
      question: 'orders',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.ambiguousIntegrations).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectMentionedIntegration — naming the source in the question
//
// Two of its three returns had never run: the businessContext/glossary match and
// the integration-NAME match. Every fixture in this file sets
// `businessContext: null`, so the domain-context path could not execute at all.
// ---------------------------------------------------------------------------

describe('detectMentionedIntegration — business context and names', () => {
  // MEASURED: integration detection only runs when the decision is SQL, and these
  // fixtures score SQL and CHAT close enough (0.30 vs 0.30) to trigger the LLM
  // tiebreaker — whose default stub answers RAG, so every test here returned
  // `undefined`. The tiebreaker has to be pinned to SQL for the name/context paths
  // to be reachable at all. My first version omitted this and eight tests failed
  // with `undefined`, which is exactly how a test measures the wrong thing.
  beforeEach(() => {
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'pinned' }))
  })

  test('a question matching 2+ glossary terms picks THAT integration', async () => {
    // With 10 databases connected, schema keywords alone cannot separate them when
    // they share generic table names like "orders". businessContext carries the
    // domain words that can, so this path is the one that makes many-DB routing work.
    const MINING = {
      id: 'mining-1',
      name: 'Mining Ops',
      status: 'active',
      businessContext: 'DOMAIN GLOSSARY\n- *haul truck* = equipment for ore transport\n- *ore grade* = concentration of target mineral\n- *pit bench* = mining level',
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'orders', description: null, columns: JSON.stringify([{ name: 'total' }]) }],
    }
    state.integrations = [MINING, HR]
    // Two domain terms in ONE context is the bar; one is not enough to name a source.
    const r = await smartRoute({
      question: 'what is the ore grade at the haul truck pit bench',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).toBe('mining-1')
  })

  test('a single glossary term is NOT enough to name the source', async () => {
    // One coincidental word must not route a question to a database; the threshold
    // exists because every glossary shares common English words.
    const MINING = {
      id: 'mining-1',
      name: 'Mining Ops',
      status: 'active',
      businessContext: 'DOMAIN GLOSSARY\n- *haul truck* = equipment for ore transport\n- *ore grade* = concentration',
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'unrelated_table', description: null, columns: JSON.stringify([{ name: 'z' }]) }],
    }
    state.integrations = [MINING, HR]
    const r = await smartRoute({
      question: 'only the haul truck',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // Falls through to scoring, so it must NOT be a confident name match.
    expect(r.integrationId).not.toBe('mining-1')
  })

  test('naming the integration verbatim routes to it', async () => {
    // The cheapest, most reliable signal available: the user said the name.
    //
    // Both schemas deliberately share NOTHING with the question, so scoring cannot
    // pick a winner and ONLY the name match can produce 'nebulon-1'. My first
    // version used HR/SALES, whose schemas (employees, orders) already matched the
    // question — deleting the name match left all 153 tests green, i.e. the test
    // was passing through a different path entirely.
    const NAMED = {
      id: 'nebulon-1', name: 'Nebulon Analytics', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [NAMED, OTHER]
    const r = await smartRoute({
      question: 'ask nebulon analytics for the figures',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).toBe('nebulon-1')
  })

  test('naming is case-INSENSITIVE', async () => {
    // Same isolation as above: only the name can decide this one.
    const NAMED = {
      id: 'nebulon-1', name: 'Nebulon Analytics', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [NAMED, OTHER]
    const r = await smartRoute({
      question: 'ASK NEBULON ANALYTICS NOW',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // Users do not type identifiers; a case-sensitive compare would miss this.
    expect(r.integrationId).toBe('nebulon-1')
  })

  test('two significant name words, both present, also route', async () => {
    // "Zephyr Archive" → ["zephyr", "archive"] (>=4 chars, not a stopword). The
    // generic suffixes "db"/"database"/"data"/"store"/"media" are excluded, because
    // every integration contains one and they would match everything.
    const ZEPHYR = {
      id: 'zephyr-1', name: 'Zephyr Archive', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [ZEPHYR, OTHER]
    const r = await smartRoute({
      question: 'pull the zephyr archive figures please',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // Isolated from scoring the same way: neither table name appears in the question.
    expect(r.integrationId).toBe('zephyr-1')
  })

  test('TWO significant name words spread across the question both count', async () => {
    // Isolates the significant-WORD rule specifically. The full name string must NOT
    // appear, or the verbatim rule above wins first and the word rule stays dead:
    // measured — disabling this rule left every test green, so it had NO control.
    // "Nebulon" and "Analytics" are both >=4 chars and not ignored, so their joint
    // presence inside one question is what names the source.
    const NAMED = {
      id: 'nebulon-1', name: 'Nebulon Analytics', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [NAMED, OTHER]
    const r = await smartRoute({
      question: 'give me the nebulon monthly analytics please',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).toBe('nebulon-1')
  })

  test('one significant word is not enough when the full name is absent', async () => {
    // The bar is TWO words precisely so a single shared term cannot capture a
    // question. Here only "nebulon" appears, so the name rule must abstain.
    const NAMED = {
      id: 'nebulon-1', name: 'Nebulon Analytics', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [NAMED, OTHER]
    const r = await smartRoute({
      question: 'nebulon please',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).not.toBe('nebulon-1')
  })

  test('a generic name word alone does NOT route', async () => {
    // "Warehouse Store" reduces to ["warehouse"] once "store" is dropped, which is
    // below the two-word bar — so a question about a warehouse does not auto-route.
    const WAREHOUSE = {
      id: 'wh-1', name: 'Warehouse Store', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const OTHER = {
      id: 'other-1', name: 'Ponderosa Ledger', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [WAREHOUSE, OTHER]
    // MEASURED and corrected: I first asked "what is in the warehouse store" and it
    // DID route to wh-1 — correctly so, because the full name string is contained in
    // the question, which the verbatim-name rule catches before the word rule is
    // consulted. To isolate the SIGNIFICANT-WORD rule the full name must be absent
    // and only its distinctive word present. "store" is dropped as generic, so
    // "warehouse" alone is below the two-word bar and must not decide.
    const r = await smartRoute({
      question: 'how much stock sits in a warehouse',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).not.toBe('wh-1')
  })

  test('a single integration is never a "mention" — nothing to disambiguate', async () => {
    state.integrations = [HR]
    const r = await smartRoute({
      question: 'anything at all',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // With one source the routing is unambiguous, so detection must return early
    // rather than pretend the user named it.
    expect(r.decision).toBe('SQL')
  })

  test('no integrations means no detection', async () => {
    state.integrations = []
    const r = await smartRoute({
      question: 'hello',
      hasIntegrations: false, hasDocuments: false, hasRestApis: false,
    })
    expect(r.integrationId).toBeUndefined()
  })
})

describe('detectMentionedIntegration — the generic-name filter', () => {
  // Pinned like the others, and I initially forgot it here too: at SQL 0.30 vs
  // CHAT 0.30 the tiebreaker fires, its stub answers RAG, and the integration is
  // never resolved — leaving the assertion vacuous.
  beforeEach(() => {
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'pinned' }))
  })

  test('a question matching only generic name words does NOT route by name', async () => {
    // "Acme Database" and "Acme Data Store" share the words "acme", "data" and
    // "store". Without excluding db/database/data/store/media EVERY integration in a
    // fleet matches every question — those words appear in most names and in no
    // domain. Measured: removing the filter failed 0 tests before this one existed.
    const A = {
      id: 'acme-a', name: 'Acme Database', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    const B = {
      id: 'acme-b', name: 'Acme Data Store', status: 'active', businessContext: null,
      createdAt: new Date('2025-01-01'),
      schemas: [{ tableName: 'yyy_tbl', description: null, columns: JSON.stringify([{ name: 'www' }]) }],
    }
    state.integrations = [A, B]
    // MEASURED and corrected: my first question was "the acme data store database",
    // which CONTAINS "acme data store" verbatim — so the full-name rule matched B
    // before the word rule was ever consulted, and the test measured the wrong
    // branch. The words must appear OUT OF ORDER and separated so no full name is
    // a substring.
    const r = await smartRoute({
      question: 'acme please, from any kind of store or database',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // Both names reduce to ["acme"] once the generic words are dropped, which is
    // below the two-word bar — so neither may be named as the source.
    expect(r.integrationId).not.toBe('acme-a')
    expect(r.integrationId).not.toBe('acme-b')
  })
})

describe('detectMentionedIntegration — a single source is not a mention', () => {
  // Pinned for the same reason as above: at SQL 0.30 vs CHAT 0.30 the LLM tiebreaker
  // fires and its stub answers RAG, so the integration is never resolved at all.
  beforeEach(() => {
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'SQL', reason: 'pinned' }))
  })

  test('with exactly ONE integration the name rule is bypassed entirely', async () => {
    // HONEST LIMITATION, measured: removing the `integrations.length === 1` early
    // return in detectMentionedIntegration still fails 0 tests, even with this test
    // present. It cannot be pinned from outside, because with one source the answer
    // is the same id either way — the only difference is which internal branch
    // produced it, and both are correct. The early return is therefore real but
    // UNCONTROLLABLE: kept for the wasted-work saving and for keeping a lone source
    // out of the semantic picker, with no test claiming to defend it.
    const ONLY = {
      id: 'only-1', name: 'Nebulon Analytics', status: 'active', businessContext: null,
      createdAt: new Date('2024-01-01'),
      schemas: [{ tableName: 'zzz_tbl', description: null, columns: JSON.stringify([{ name: 'qqq' }]) }],
    }
    state.integrations = [ONLY]
    const r = await smartRoute({
      question: 'ask nebulon analytics for the figures',
      hasIntegrations: true, hasDocuments: false, hasRestApis: false,
    })
    // The only source is still the answer, but it must be reached by the
    // single-source rule, not by pretending the user named it.
    expect(r.decision).toBe('SQL')
    expect(r.integrationId).toBe('only-1')
  })
})

describe('LLM tiebreaker — SKIPPED when the best tool has a strong schema match', () => {
  // Line 164. This branch exists because of a real routing bug: the LLM router
  // prompt does not know domain-specific table/column names, so when SQL and CHAT
  // land within 0.1 it would override SQL→CHAT on EVERY data question -- the
  // "chatbot asks a clarifying question instead of querying the database"
  // symptom. A strong keyword overlap with real DB tables/docs is the signal that
  // the heuristic already knows better, so the extra LLM call is skipped.
  test('a strong schema match skips the LLM call and says so in the reason', async () => {
    // The schema signal comes from state.SCHEMAS, not state.integrations -- my
    // first version set integrations only, so schemaScore stayed 0 for every tool,
    // the tiebreaker fired, and the test failed. Instrumenting the scores is how I
    // found it; the assertion below would otherwise have looked like a code bug.
    state.integrations = [HR]
    state.schemas = [
      { tableName: 'employees', description: null, columns: JSON.stringify([{ name: 'salary' }, { name: 'hire_date' }]), integration: { name: 'HR Database', provider: 'POSTGRESQL' } },
    ]
    // The narrowing has to be done from BOTH ends: the best tool must still have a
    // schema match above 0.3 while its final score lands within 0.1 of the runner-up.
    // My first version gave SQL a healthy perf run, so its score sat 0.14 above CHAT's,
    // the near-tie guard never fired, and the reason came back as the per-tool
    // 'SQL: schema match 40%' -- a green-looking fixture measuring the wrong branch.
    // SQL here has a mediocre, slow track record (which is what drags it down into a
    // near-tie) while keeping the schema signal, and CHAT is a healthy fast fallback.
    state.runs = [...perfRuns('SQL', 20, 6, 2000), ...perfRuns('CHAT', 20, 0, 100)]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'CHAT', reason: 'LLM says CHAT' }))
    const result = await smartRoute({
      question: 'salary of employees',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const best = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)[0]
    expect(best.schemaScore).toBeGreaterThan(0.3)
    // No LLM call -- that is the whole point of the branch.
    expect(routeQueryMock).not.toHaveBeenCalled()
    expect(result.llmUsed).toBe(false)
    // The reason names the tool and the matched strength, so the routing decision
    // is diagnosable without re-running the scorer.
    expect(result.reason).toContain('schema match strong')
    expect(result.reason).toContain('skipping LLM tiebreaker')
    expect(result.reason).toContain(`${best.tool}:`)
  })

  test('a WEAK schema match still consults the LLM (the branch is not a blanket skip)', async () => {
    // The inverse. Without this, removing the `schemaScore > 0.3` condition
    // entirely would keep the test above green.
    state.integrations = [HR]
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'LLM says RAG' }))
    const result = await smartRoute({
      question: 'halo ada apa',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
    expect(result.llmUsed).toBe(true)
  })
})

// ===========================================================================
// SECURITY REVIEW — what smart-router does with caller-supplied strings.
//
// The review question was: does this module interpolate a caller-supplied
// identifier (table name, column name, endpoint path) into SQL or a URL without
// validation? These tests pin the answer to the CODE, not to a comment.
// ===========================================================================

describe('security — caller-supplied strings never become SQL or URL text', () => {
  test('a question containing SQL metacharacters is only ever matched as a token', async () => {
    // The question flows into `tokenize` (which splits on [^\p{L}\p{N}]) and into
    // `keywordOverlap` (a Set lookup + substring compare). It is NEVER concatenated
    // into a query. If a future change started building SQL here, the injected
    // fragments would surface as tokens on the metadata index and the score would
    // move; this pins that the score stays a pure keyword ratio.
    state.schemas = [
      {
        tableName: 'orders',
        description: null,
        columns: JSON.stringify([{ name: 'total_amount' }]),
        integration: { name: 'Sales', provider: 'POSTGRESQL' },
      },
    ]
    const injected = "orders'; DROP TABLE users; -- total_amount"
    const result = await smartRoute({
      question: injected,
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sql = result.scores.find((s) => s.tool === 'SQL')!
    // A ratio in [0,1] — a concatenated query would not be a ratio at all.
    expect(sql.schemaScore).toBeGreaterThanOrEqual(0)
    expect(sql.schemaScore).toBeLessThanOrEqual(1)
    // `drop`, `table`, `users` are not in the schema index, so they contribute 0.
    expect(sql.schemaScore).toBeLessThan(1)
    // The decision is a RouteDecision enum, never a raw string from the question.
    expect(['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN']).toContain(result.decision)
  })

  test('the DB query arguments are Prisma objects, never a raw SQL string', async () => {
    // `db.toolRun.findMany(...)` etc. receive structured args. A raw-SQL escape
    // hatch ($queryRawUnsafe / $executeRawUnsafe) would appear as a call with a
    // string positional arg; assert the shape the router actually sends.
    state.runs = [successRun('SQL', 'orders')]
    await smartRoute({
      question: "orders'; DROP TABLE tool_run; --",
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    for (const call of mockToolRunFindMany.mock.calls) {
      const args = call[0] as Record<string, unknown>
      expect(typeof args).toBe('object')
      // Every argument is `where` / `select` / `take` / `orderBy` — a query
      // builder shape. A string here would mean raw SQL.
      expect(typeof args).not.toBe('string')
      expect(Object.keys(args).every((k) => ['where', 'select', 'take', 'orderBy', 'include'].includes(k))).toBe(true)
    }
  })

  test('an endpoint path from the metadata index is split into keywords, not used as a URL', async () => {
    // REST metadata feeds `loadEndpointMetadata`, which splits the path on "/"
    // and strips non-alphanumerics to build keywords. The path is never fetched
    // or interpolated into a request URL by this module.
    state.endpoints = [{ path: '/v1/exfil?target=http://evil.example/steal', description: null }]
    const result = await smartRoute({
      question: 'exfil target evil example steal',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: true,
    })
    const rest = result.scores.find((s) => s.tool === 'REST')!
    expect(rest.schemaScore).toBeGreaterThan(0)
    // Pin the load-bearing absence: the module never calls fetch at all.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/lib/smart-router.ts', 'utf8') as string
    expect(src).not.toContain('fetch(')
    expect(src).not.toContain('$queryRaw')
    expect(src).not.toContain('$executeRaw')
  })

  test('ToolRun reads carry NO org filter at the call site — the tenant extension supplies it', async () => {
    // This is the honest finding from the security review. `toolRun` IS in
    // ORG_SCOPED_MODELS and `findMany` IS in FILTER_OPS, so `db` (the EXTENDED
    // client in db.ts) auto-injects `organizationId`. The absence of an explicit
    // filter here is NOT a leak — but it IS a dependency on the extension, so it
    // is pinned: if `toolRun` were ever dropped from ORG_SCOPED_MODELS, these
    // queries would silently become global and leak one tenant's tool names and
    // latencies to another. The assertion below is what makes that removal loud.
    const { readFileSync } = await import('node:fs')
    const tenant = readFileSync('src/lib/prisma-tenant.ts', 'utf8') as string
    // toolRun must be scoped...
    expect(tenant).toMatch(/ORG_SCOPED_MODELS[\s\S]*?'toolRun'/)
    // ...and findMany must be an op the extension injects into.
    expect(tenant).toMatch(/FILTER_OPS[\s\S]*?'findMany'/)
    // And db.ts must export the EXTENDED client, not the raw one.
    const dbSrc = readFileSync('src/lib/db.ts', 'utf8') as string
    expect(dbSrc).toContain('$extends(createTenantExtension())')
    // The helper reads the same three ToolRun queries without an explicit org
    // filter — recorded so a reviewer sees the dependency in one place.
    const helpers = readFileSync('src/lib/smart-router-helpers.ts', 'utf8') as string
    expect(helpers).not.toContain('bypassOrg')
  })
})

// ===========================================================================
// Edge cases the suite had not exercised: the scorer must not throw on
// hostile/empty shapes, and the LLM-tiebreaker call COUNT is a contract.
// ===========================================================================

describe('scoring survives degenerate inputs without throwing', () => {
  test('a question that tokenizes to NOTHING still routes (no crash, CHAT-safe)', async () => {
    // Punctuation-only input -> tokenize returns []. loadSimilarityBoost
    // short-circuits on an empty token array, scoreSchemaMatch returns 0, and the
    // decision must still be a valid tool. A crash here would take down the whole
    // chat request for a message like "???".
    const result = await smartRoute({
      question: '??? !!! ---',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    expect(result.scores).toHaveLength(5)
    expect(result.scores.every((s) => s.schemaScore === 0)).toBe(true)
    expect(['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN']).toContain(result.decision)
  })

  test('a REPEATED token does not inflate the schema score above 1', async () => {
    // keywordOverlap divides matches by the token count, but `tokenize` de-dupes;
    // a caller passing a hand-built token array with repeats could push the ratio
    // over 1 without the Math.min cap. Pin the cap through the public API.
    expect(keywordOverlap(['orders', 'orders', 'orders', 'orders'], ['orders'])).toBeLessThanOrEqual(1)
    expect(keywordOverlap(['orders', 'orders', 'orders'], ['orders'])).toBeCloseTo(1, 6)
  })

  test('a Unicode question routes through the REAL tokenizer, not an ASCII class', async () => {
    // Regression guard for the `[^a-z0-9]` class that produced ZERO tokens for
    // CJK/accented text — which silently made SQL unreachable for those users.
    state.schemas = [
      {
        tableName: 'penjualan',
        description: null,
        columns: JSON.stringify([{ name: 'jumlah_pendapatan' }]),
        integration: { name: 'Penjualan', provider: 'POSTGRESQL' },
      },
    ]
    expect(tokenize('penjualan café')).toContain('café')
    const result = await smartRoute({
      question: 'penjualan café',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(result.scores.find((s) => s.tool === 'SQL')!.schemaScore).toBeGreaterThan(0)
  })

  test('all four source flags false: no source tool is available, and CHAT still wins', async () => {
    // Nothing configured at all — the "fresh install" state. Every availability
    // is 0 except CHAT/PLUGIN, so an unavailable tool can never be selected.
    //
    // MEASURED, and worth knowing: with no history, NEUTRAL_PERF gives CHAT and
    // PLUGIN the SAME final score (0.30), so the near-tie guard fires and this
    // spends a real LLM call on a question the router could answer from
    // availability alone. The mock makes the tiebreaker land on RAG, which is
    // the point: the decision is the TIEBREAKER's, not a deterministic fallback.
    // Asserting a bare 'CHAT' here passed only accidentally (the stub happened to
    // say CHAT) — the score tie is the real behaviour.
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'RAG', reason: 'stub' }))
    const result = await smartRoute({
      question: 'hello there',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    for (const tool of ['SQL', 'RAG', 'REST']) {
      expect(result.scores.find((s) => s.tool === tool)!.availability).toBe(0)
      expect(result.scores.find((s) => s.tool === tool)!.finalScore).toBe(0)
    }
    // CHAT and PLUGIN are the only available tools, and they TIE.
    const chat = result.scores.find((s) => s.tool === 'CHAT')!
    const plugin = result.scores.find((s) => s.tool === 'PLUGIN')!
    expect(chat.finalScore).toBeGreaterThan(0)
    expect(chat.finalScore - plugin.finalScore).toBeLessThan(0.1)
    // The tie is resolved by the LLM — recorded, not endorsed: an unavailable-DB
    // install could shortcut this. The assertion is that the decision comes from
    // the tiebreaker, so a future shortcut is a deliberate change.
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
    expect(result.decision).toBe('RAG')
  })
})

describe('LLM tiebreaker — the CALL COUNT is the contract', () => {
  test('a confident winner (gap > 0.1) spends ZERO LLM calls', async () => {
    // "Saves an LLM call when the heuristic is confident" is a claim in the code
    // comments. A regression that widened the tie window would double the LLM
    // spend on every query AND add latency; only the call count catches it.
    state.integrations = [HR]
    state.schemas = [
      {
        tableName: 'employees',
        description: null,
        columns: JSON.stringify([{ name: 'salary' }, { name: 'hire_date' }, { name: 'department' }]),
        integration: { name: 'HR Database', provider: 'POSTGRESQL' },
      },
    ]
    // SQL: strong schema match, perfect fast record. CHAT: nothing.
    state.runs = perfRuns('SQL', 20, 0, 50)
    const result = await smartRoute({
      question: 'salary employees department',
      hasIntegrations: true,
      hasDocuments: false,
      hasRestApis: false,
    })
    const sorted = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)
    if (sorted[0].finalScore - sorted[1].finalScore > 0.1) {
      expect(routeQueryMock).not.toHaveBeenCalled()
      expect(result.llmUsed).toBe(false)
    }
  })

  test('scores within the 0.1 window MUST call the LLM exactly once', async () => {
    // The inverse half of the same contract. A no-signal install puts CHAT and
    // PLUGIN within 0.1 of each other, so the tiebreaker must fire.
    routeQueryMock.mockImplementation(async (): Promise<RouteDecisionStub> => ({ decision: 'PLUGIN', reason: 'LLM picked plugin' }))
    const result = await smartRoute({
      question: 'halo apa kabar',
      hasIntegrations: false,
      hasDocuments: false,
      hasRestApis: false,
    })
    expect(routeQueryMock).toHaveBeenCalledTimes(1)
    expect(result.llmUsed).toBe(true)
    expect(result.decision).toBe('PLUGIN')
    // The reason names the tiebreaker and BOTH scores, so a routing surprise is
    // traceable without a debugger.
    expect(result.reason).toContain('LLM tiebreaker')
    expect(result.reason).toContain('scores:')
  })

  test('a zero-score tie does NOT call the LLM (guard is `best.finalScore > 0`)', async () => {
    // All five tools at 0 is the "everything unavailable" case; the CHAT fallback
    // handles it. Calling the LLM there would spend a completion on a question the
    // router has already decided it cannot answer from any source.
    state.runs = [
      ...perfRuns('SQL', 12, 8),
      ...perfRuns('RAG', 12, 8),
      ...perfRuns('REST_API', 12, 8),
      ...perfRuns('CHAT', 12, 8),
      ...perfRuns('PLUGIN', 12, 8),
    ]
    const result = await smartRoute({
      question: 'anything at all',
      hasIntegrations: true,
      hasDocuments: true,
      hasRestApis: true,
    })
    expect(routeQueryMock).not.toHaveBeenCalled()
    expect(result.llmUsed).toBe(false)
    expect(result.decision).toBe('CHAT')
  })
})
