/**
 * smart-router-helpers.ts — the scoring primitives behind the self-adjusting
 * router. 471 lines, 17 exports, and (until now) no test file of its own.
 *
 * The behaviours locked here are the ones with incident history or real
 * security weight:
 *  - `tokenize` is the ROUTER's tokenizer. It previously used `[^a-z0-9]` with a
 *    length-3 floor and its own STOPWORDS copy, which produced ZERO tokens for
 *    Chinese/Arabic and dropped `data`/`total`/`count`/`table` — the exact words
 *    users type about databases. Both tokenizers must now agree, because a
 *    disagreement means the same question is scored differently by routing and
 *    by retrieval (trial/fleet found 7 real defects this way).
 *  - `getQuestionEmbedding` caches on a scope of org + provider + baseUrl +
 *    model. The cache is module-scope (process-wide), so in one install with
 *    several orgs a question-only key would hand org B the vectors computed for
 *    org A by a DIFFERENT model. Proven at runtime (trial/50): both orgs asking
 *    the identical string got byte-identical embeddings. Cross-tenant state.
 *  - `checkAvailability` must return 0 for a tool whose source does not exist;
 *    a non-zero score is how the router proposes a tool that cannot run.
 *  - `loadPerformanceMetrics` remaps the DB's `REST_API` to the router's `REST`.
 *    A missed remap silently pins REST to NEUTRAL_PERF forever.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { EmbeddingRuntimeConfig } from '@/lib/embeddings'

// --- Mocked world -----------------------------------------------------------
type Row = Record<string, unknown>
let schemas: Row[] = []
let documents: Row[] = []
let endpoints: Row[] = []
let toolRuns: Row[] = []
let embeddingConfig: EmbeddingRuntimeConfig | null = null
let embedTextsImpl: ((cfg: unknown, texts: string[]) => Promise<number[][]>) | null = null
let orgContext: string | null = 'org-a'
const embedCalls: string[][] = []

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => orgContext,
  enterWithOrg: () => undefined,
  bypassOrg: async (fn: () => unknown) => fn(),
}))

mock.module('@/lib/db', () => ({
  db: {
    integrationSchema: { findMany: async () => schemas },
    document: { findMany: async () => documents },
    restApiEndpoint: { findMany: async () => endpoints },
    toolRun: {
      findMany: async (q?: { where?: { type?: string; status?: unknown } }) => {
        let rows = toolRuns
        if (q?.where?.type) rows = rows.filter((r) => r.type === q.where!.type)
        if (q?.where?.status === 'success') rows = rows.filter((r) => r.status === 'success')
        return rows
      },
      findFirst: async () => toolRuns.find((r) => r.status === 'error' || r.status === 'blocked') ?? null,
    },
  },
}))

// Mock the FULL export surface. A partial mock breaks the `@/lib/rag` barrel
// that smart-router-helpers imports (`parseEmbeddingJson` not found) — the same
// class of failure as the rag-hnsw-truncation incident.
mock.module('@/lib/embeddings', () => ({
  parseEmbeddingJson: (raw: string | null | undefined) => {
    if (!raw) return null
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  },
  combineHybridScore: () => 0,
  parseEmbeddingResponse: () => [],
  getEmbeddingColumnDimension: async () => null,
  resetEmbeddingColumnDimension: () => undefined,
  embedDocumentChunks: async () => ({ embedded: 0, failed: 0 }),
  embedCompanyDocuments: async () => ({ embedded: 0, failed: 0 }),
  getEmbeddingRuntimeConfig: async () => embeddingConfig,
  embedTexts: async (cfg: unknown, texts: string[]) => {
    embedCalls.push(texts)
    if (embedTextsImpl) return embedTextsImpl(cfg, texts)
    return texts.map(() => [1, 0, 0])
  },
  cosineSimilarity: (a: number[], b: number[]) => {
    if (a.length === 0 || b.length === 0) return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  },
}))

// NOTE: @/lib/rag is NOT mocked — tokenize delegates to its shared
// isMeaningfulToken/STOPWORDS, and mocking rag would make the
// "the two tokenizers agree" test assert the mock instead of the contract.
const { tokenize: tokenizeRag } = await import('@/lib/rag')

const {
  expandWithSynonyms,
  tokenize,
  safeParseColumns,
  keywordOverlap,
  checkAvailability,
  buildReason,
  NEUTRAL_PERF,
  WEIGHTS,
  invalidateSourceEmbeddingCache,
  getSourceEmbeddings,
  getQuestionEmbedding,
  computeSemanticScore,
  loadSchemaMetadata,
  loadEndpointMetadata,
  loadDocumentMetadata,
  loadPerformanceMetrics,
  loadSimilarityBoost,
} = await import('@/lib/smart-router-helpers')

function makeCfg(baseUrl: string, model: string): EmbeddingRuntimeConfig {
  return { provider: 'OPENAI_COMPATIBLE', baseUrl, model, apiKey: 'k' }
}

beforeEach(() => {
  schemas = []
  documents = []
  endpoints = []
  toolRuns = []
  embeddingConfig = null
  embedTextsImpl = null
  orgContext = 'org-a'
  embedCalls.length = 0
  invalidateSourceEmbeddingCache()
})

describe('tokenize — the router and retrieval tokenizers must agree', () => {
  test('strips the [Session started] [Current time] prefix', () => {
    const t = tokenize('[Session started: 09:00] [Current time: 10:00] show me sales')
    // The meta-tokens ("session", "started", "time") match internal schema
    // columns (ChatSession, startedAt) and polluted integration selection.
    expect(t).not.toContain('session')
    expect(t).not.toContain('started')
    expect(t).toContain('sales')
  })

  test('non-Latin scripts tokenize instead of vanishing', () => {
    // REGRESSION: `[^a-z0-9]` gave ZERO tokens here, so a Chinese question
    // could not select a data source at all.
    expect(tokenize('什么是退款政策')).toEqual(['什么是退款政策'])
    expect(tokenize('ما هي سياسة الاسترداد')).toContain('سياسة')
  })

  test('database vocabulary survives — these are the words users actually type', () => {
    // REGRESSION: the router's own STOPWORDS copy listed data/total/count/
    // table/amount/row/column as stopwords, so "total amount per table" became [].
    expect(tokenize('total amount per table')).toEqual(['total', 'amount', 'table'])
    expect(tokenize('show me the row count')).toContain('count')
  })

  test('agrees with the retrieval tokenizer on a sample of real questions', () => {
    const questions = [
      'total amount per table',
      'what is the refund policy',
      '什么是退款政策',
      'berapa jumlah pelanggan yang aktif',
      'top 10 products by revenue',
      'SELECT * FROM orders',
    ]
    for (const q of questions) {
      expect(tokenize(q), `router vs rag for "${q}"`).toEqual(tokenizeRag(q))
    }
  })

  test('deduplicates and drops genuine noise', () => {
    expect(tokenize('sales sales sales')).toEqual(['sales'])
    expect(tokenize('a b c')).toEqual([]) // length < 2
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })
})

describe('expandWithSynonyms', () => {
  test('adds known Indonesian→English business synonyms', () => {
    const out = expandWithSynonyms(['pelanggan'])
    expect(out).toContain('pelanggan')
    expect(out).toContain('customer')
  })

  test('leaves unknown tokens untouched and preserves order', () => {
    expect(expandWithSynonyms(['xyz', 'negara'])).toEqual(['xyz', 'negara', 'country'])
  })

  test('an empty input returns empty', () => {
    expect(expandWithSynonyms([])).toEqual([])
  })
})

describe('safeParseColumns', () => {
  test('parses a column array', () => {
    expect(safeParseColumns('[{"name":"id"},{"name":"total"}]')).toEqual([{ name: 'id' }, { name: 'total' }])
  })

  test('never throws — malformed JSON, non-arrays, and null entries', () => {
    // Called on every reflection row; a throw here would break routing entirely.
    expect(safeParseColumns('{not json')).toEqual([])
    expect(safeParseColumns('{"a":1}')).toEqual([])
    expect(safeParseColumns('null')).toEqual([])
    expect(safeParseColumns('[null,{"name":"x"}]')).toEqual([{ name: '' }, { name: 'x' }])
  })
})

describe('keywordOverlap', () => {
  test('returns the fraction of query tokens matched', () => {
    expect(keywordOverlap(['sales', 'orders'], ['sales', 'orders', 'extra'])).toBe(1)
    expect(keywordOverlap(['sales', 'orders'], ['sales'])).toBe(0.5)
  })

  test('substring matches count in either direction', () => {
    expect(keywordOverlap(['invoice'], ['customer_invoice'])).toBe(1)
    expect(keywordOverlap(['customer_invoice'], ['invoice'])).toBe(1)
  })

  test('empty metadata or tokens is 0, and the result is capped at 1', () => {
    expect(keywordOverlap([], ['x'])).toBe(0)
    expect(keywordOverlap(['x'], [])).toBe(0)
    expect(keywordOverlap(['a'], ['a', 'a', 'a'])).toBe(1)
  })
})

describe('checkAvailability — a tool with no source must score 0', () => {
  test('SQL/RAG/REST are gated by their own source flags', () => {
    expect(checkAvailability('SQL', false, true, true)).toBe(0)
    expect(checkAvailability('SQL', true, false, false)).toBe(1)
    expect(checkAvailability('RAG', false, true, false)).toBe(1)
    expect(checkAvailability('RAG', true, false, false)).toBe(0)
    expect(checkAvailability('REST', false, false, true)).toBe(1)
    expect(checkAvailability('REST', true, true, false)).toBe(0)
  })

  test('CHAT and PLUGIN are always available — they need no configured source', () => {
    expect(checkAvailability('CHAT', false, false, false)).toBe(1)
    expect(checkAvailability('CONTEXTUAL_CHAT', false, false, false)).toBe(1)
    expect(checkAvailability('PLUGIN', false, false, false)).toBe(1)
  })
})

describe('buildReason', () => {
  test('a tripped circuit breaker dominates every other signal', () => {
    const reason = buildReason('SQL', 0.9, { ...NEUTRAL_PERF, recentFailRate: 0.8 }, true, 0.5)
    expect(reason).toContain('circuit breaker tripped')
    expect(reason).toContain('80%')
  })

  test('names the signals that actually fired, and stays quiet about weak ones', () => {
    const strong = buildReason('SQL', 0.5, { ...NEUTRAL_PERF, successRate: 0.9, total: 20 }, false, 0.4)
    expect(strong).toContain('schema match 50%')
    expect(strong).toContain('success 90% (20 runs)')
    expect(strong).toContain('similar past query boost 40%')

    // Below the display thresholds (0.3 schema, 0.2 similarity) nothing is claimed.
    expect(buildReason('CHAT', 0.1, NEUTRAL_PERF, false, 0.1)).toContain('no strong signal')
  })
})

describe('WEIGHTS', () => {
  test('sum to exactly 1 so scores stay comparable across tools', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 10)
  })
})

describe('getSourceEmbeddings', () => {
  test('returns null when no embedding provider is configured', async () => {
    embeddingConfig = null
    expect(await getSourceEmbeddings()).toBeNull()
  })

  test('builds SQL source texts from reflected schema', async () => {
    embeddingConfig = makeCfg('http://x', 'm')
    schemas = [{
      tableName: 'orders',
      description: 'customer orders',
      columns: '[{"name":"id"},{"name":"total"}]',
      integration: { name: 'Sales' },
    }]
    const sources = await getSourceEmbeddings()
    expect(sources).not.toBeNull()
    expect(sources!.sql.texts[0]).toContain('Sales table orders')
    expect(sources!.sql.texts[0]).toContain('Columns: id, total')
  })

  test('returns null rather than throwing when the embedding call fails', async () => {
    embeddingConfig = makeCfg('http://x', 'm')
    schemas = [{ tableName: 't', description: null, columns: '[]', integration: { name: 'S' } }]
    embedTextsImpl = async () => { throw new Error('provider down') }
    // Graceful degradation: routing falls back to keyword-only scoring.
    expect(await getSourceEmbeddings()).toBeNull()
  })

  test('skips the embedding call for a source with no rows', async () => {
    embeddingConfig = makeCfg('http://x', 'm')
    documents = [{ name: 'doc.pdf', category: 'policy', description: null }]
    const sources = await getSourceEmbeddings()
    // Only the RAG batch should have been requested.
    expect(embedCalls).toHaveLength(1)
    expect(embedCalls[0]).toEqual(['doc.pdf [policy]: '])
    expect(sources!.sql.embeddings).toEqual([])
  })

  test('caches the second call instead of re-embedding', async () => {
    embeddingConfig = makeCfg('http://x', 'm')
    documents = [{ name: 'doc.pdf', category: 'policy', description: null }]
    await getSourceEmbeddings()
    const callsAfterFirst = embedCalls.length
    await getSourceEmbeddings()
    expect(embedCalls.length).toBe(callsAfterFirst)
  })
})

describe('getQuestionEmbedding — the cache must never cross a tenant or a model', () => {
  const cfgA = makeCfg('http://a', 'model-a')
  const cfgB = makeCfg('http://b', 'model-b')

  test('caches a repeat of the identical question in the same scope', async () => {
    embedTextsImpl = async () => [[0.1, 0.2, 0.3]]
    const first = await getQuestionEmbedding('same question', cfgA)
    const calls = embedCalls.length
    const second = await getQuestionEmbedding('same question', cfgA)
    expect(second).toEqual(first)
    expect(embedCalls.length).toBe(calls) // served from cache
  })

  test('a DIFFERENT ORG asking the identical question gets its own vectors', async () => {
    // REGRESSION (trial/50): the cache was keyed on the question string alone and
    // is module-scope/process-wide, so in a multi-org install org B received the
    // vectors computed for org A — by a different model. Retrieval ranking for
    // org B was then derived from another tenant's vector space.
    embedTextsImpl = async () => [[1, 0, 0]]
    await getQuestionEmbedding('identical question', cfgA)
    orgContext = 'org-b'
    embedTextsImpl = async () => [[0, 1, 0]]
    const forB = await getQuestionEmbedding('identical question', cfgB)
    expect(forB).toEqual([0, 1, 0]) // org B's OWN vector, not org A's [1,0,0]
  })

  test('the same org on a DIFFERENT model does not reuse the old vectors', async () => {
    embedTextsImpl = async () => [[1, 0, 0]]
    await getQuestionEmbedding('q', cfgA)
    embedTextsImpl = async () => [[0, 0, 1]]
    const other = await getQuestionEmbedding('q', cfgB)
    expect(other).toEqual([0, 0, 1])
  })

  test('an embedder failure degrades to an empty vector, not a throw', async () => {
    embedTextsImpl = async () => { throw new Error('down') }
    expect(await getQuestionEmbedding('q', cfgA)).toEqual([])
  })
})

describe('computeSemanticScore', () => {
  const cfg = makeCfg('http://x', 'm')

  test('returns 0 with no provider or no source embeddings', async () => {
    embeddingConfig = null
    expect(await computeSemanticScore('q', 'SQL')).toBe(0)

    embeddingConfig = cfg
    expect(await computeSemanticScore('q', 'SQL')).toBe(0) // no schemas reflected
  })

  test('takes the BEST similarity across candidate source texts', async () => {
    embeddingConfig = cfg
    schemas = [
      { tableName: 'far', description: null, columns: '[]', integration: { name: 'S' } },
      { tableName: 'near', description: null, columns: '[]', integration: { name: 'S' } },
    ]
    embedTextsImpl = async (_cfg, texts) =>
      texts.map((t) => (t.includes('near') ? [1, 0, 0] : [0, 1, 0]))
    // The question vector aligns with "near", so max (not mean) must be used.
    const score = await computeSemanticScore('q', 'SQL')
    expect(score).toBeGreaterThan(0.9)
  })

  test('CHAT has no source texts and scores 0', async () => {
    embeddingConfig = cfg
    schemas = [{ tableName: 't', description: null, columns: '[]', integration: { name: 'S' } }]
    expect(await computeSemanticScore('q', 'CHAT')).toBe(0)
  })
})

describe('loadPerformanceMetrics', () => {
  test('a tool with no recent runs gets NEUTRAL_PERF', async () => {
    const metrics = await loadPerformanceMetrics()
    expect(metrics.SQL).toEqual(NEUTRAL_PERF)
    expect(metrics.RAG).toEqual(NEUTRAL_PERF)
  })

  test('computes success rate and average latency over successful runs only', async () => {
    toolRuns = [
      { type: 'SQL', status: 'success', latencyMs: 100 },
      { type: 'SQL', status: 'success', latencyMs: 300 },
      { type: 'SQL', status: 'error', latencyMs: 50 },
    ]
    const metrics = await loadPerformanceMetrics()
    expect(metrics.SQL.successRate).toBeCloseTo(2 / 3, 5)
    // The failed run's 50ms must not drag the average down.
    expect(metrics.SQL.avgLatencyMs).toBe(200)
    expect(metrics.SQL.total).toBe(3)
  })

  test("remaps the DB's REST_API type to the router's REST", async () => {
    // A missed remap would pin REST to NEUTRAL_PERF forever and the router
    // would stop learning from REST outcomes.
    toolRuns = [{ type: 'REST_API', status: 'success', latencyMs: 500 }]
    const metrics = await loadPerformanceMetrics()
    expect(metrics.REST.successRate).toBe(1)
    expect(metrics.REST_API).toBeUndefined()
  })

  test('recentFailRate is measured over the last 10 runs, not the 50-run window', async () => {
    toolRuns = [
      ...Array.from({ length: 9 }, () => ({ type: 'SQL', status: 'error', latencyMs: 1 })),
      { type: 'SQL', status: 'success', latencyMs: 1 },
    ]
    const metrics = await loadPerformanceMetrics()
    expect(metrics.SQL.recentFailRate).toBeCloseTo(0.9, 5)
  })
})

describe('loadSimilarityBoost', () => {
  test('no tokens means no boost at all', async () => {
    expect(await loadSimilarityBoost([])).toEqual({})
  })

  test('boosts the tool that successfully served a similar question before', async () => {
    toolRuns = [{ type: 'SQL', status: 'success', inputSummary: 'show me total sales per region' }]
    const boosts = await loadSimilarityBoost(['total', 'sales', 'region'])
    expect(boosts.SQL).toBeGreaterThan(0.5)
    expect(boosts.RAG).toBe(0)
  })

  test('strips the session wrapper before comparing', async () => {
    // The stored summary carries the wrapper; without stripping it the
    // meta-tokens dominate the overlap and every past run looks similar.
    toolRuns = [{
      type: 'SQL',
      status: 'success',
      inputSummary: '[Session started: 09:00] [Current time: 10:00] total sales region',
    }]
    const boosts = await loadSimilarityBoost(['total', 'sales', 'region'])
    expect(boosts.SQL).toBeGreaterThan(0.5)
  })

  test('an unrelated past run produces no boost', async () => {
    toolRuns = [{ type: 'SQL', status: 'success', inputSummary: 'weather in tokyo tomorrow' }]
    const boosts = await loadSimilarityBoost(['invoice', 'revenue'])
    expect(boosts.SQL).toBe(0)
  })

  test('returns an entry for every routable tool, including PLUGIN', async () => {
    const boosts = await loadSimilarityBoost(['x'])
    expect(Object.keys(boosts).sort()).toEqual(['CHAT', 'PLUGIN', 'RAG', 'REST', 'SQL'])
  })
})

describe('metadata loaders', () => {
  test('loadSchemaMetadata collects table, integration, and column names', async () => {
    schemas = [{
      tableName: 'Orders',
      columns: '[{"name":"Total_Amount"}]',
      integration: { name: 'Sales DB', provider: 'POSTGRESQL' },
    }]
    const kws = await loadSchemaMetadata()
    // Integration-name words pass a >= 3 length guard and NO stopword filter, so
    // "sales" enters but "db" (2 chars) is dropped. Asserted exactly, because the
    // asymmetry between this path and loadEndpointMetadata is easy to misread.
    expect(kws).toEqual(['orders', 'sales', 'total_amount'])
  })

  test('loadSchemaMetadata survives malformed columns JSON', async () => {
    schemas = [{ tableName: 't', columns: '{broken', integration: { name: 'S', provider: 'P' } }]
    // Must not throw — a reflection row with bad JSON would break all routing.
    const kws = await loadSchemaMetadata()
    // Table name survives; the short integration name ('S', 1 char) is dropped by
    // the >= 3 length guard, and the malformed columns JSON is skipped silently.
    expect(kws).toEqual(['t'])
  })

  test('loadEndpointMetadata splits paths and filters stopwords', async () => {
    endpoints = [{ path: '/api/v1/customers', description: 'list of customers' }]
    const kws = await loadEndpointMetadata()
    expect(kws).toContain('customers')
    // Path segments are filtered by LENGTH only (>= 3), not by STOPWORDS, so
    // 'api' survives. Asserting that faithfully rather than asserting the
    // filtering I assumed existed.
    expect(kws).toContain('api')
  })

  test('loadDocumentMetadata uses name words, category, and description', async () => {
    documents = [{ name: 'Refund-Policy-2024.pdf', category: 'policy', description: 'how refunds work' }]
    const kws = await loadDocumentMetadata()
    expect(kws).toContain('refund')
    expect(kws).toContain('policy')
    expect(kws).toContain('refunds')
  })

  test('every loader returns [] when there is no data', async () => {
    expect(await loadSchemaMetadata()).toEqual([])
    expect(await loadEndpointMetadata()).toEqual([])
    expect(await loadDocumentMetadata()).toEqual([])
  })
})
