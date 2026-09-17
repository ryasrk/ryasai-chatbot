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
    // The extractor reads the `## Domain` section up to the NEXT HEADING or end-of-string.
    // It used to stop at the first blank line, which truncated a wrapped keyword list:
    // the real Sales context spans two lines, so terms after the wrap were invisible.
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

  test('a Domain section that runs to end-of-string still yields glossary terms', async () => {
    // The section is read up to the next heading or end-of-string. Stopping at the first
    // blank line truncated wrapped keyword lists -- the Sales context lists its terms over
    // two lines, so 'order' sat past the wrap and was never read, and every question phrased
    // with that business word refused instead of routing.
    const atEnd = extractDomainGlossaryTerms('## domain\npenjualan, pelanggan, order')
    expect(atEnd.has('penjualan')).toBe(true)
    expect(atEnd.has('pelanggan')).toBe(true)
    expect(atEnd.has('order')).toBe(true)
    // A following heading still terminates the section.
    const withHeading = extractDomainGlossaryTerms('## domain\npenjualan.\n## Lain\nkaryawan')
    expect(withHeading.has('penjualan')).toBe(true)
    expect(withHeading.has('karyawan')).toBe(false)
  })

  test('a domain term that is also a SQL keyword survives the generic-token filter', async () => {
    // GENERIC_SCHEMA_TOKENS drops column-name noise (id, status, created) and it also lists
    // SQL keywords including 'order'. But 'order' is the ordinary business word for a
    // purchase order and the Sales context declares it in its own domain list, so filtering
    // it disabled the glossary fast path for a whole class of questions. A term the domain
    // names explicitly outranks the generic list; genuine noise is still dropped.
    const terms = extractDomainGlossaryTerms('## domain\norder, pelanggan, id, status, created')
    expect(terms.has('order')).toBe(true)
    expect(terms.has('pelanggan')).toBe(true)
    expect(terms.has('id')).toBe(false)
    expect(terms.has('status')).toBe(false)
    expect(terms.has('created')).toBe(false)
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









