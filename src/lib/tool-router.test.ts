import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks (must be before imports of modules under test) ---

type RouteDecision = 'CHAT' | 'SQL' | 'RAG' | 'REST' | 'PLUGIN' | 'CONTEXTUAL_CHAT'

const mockIntegrationCount = mock(async () => 0)
const mockDocumentCount = mock(async () => 0)
const mockDocumentFindMany = mock(async () => [] as unknown[])
const mockRestEndpointCount = mock(async () => 0)
const mockRestEndpointFindMany = mock(async () => [] as Array<{ method: string; path: string; description: string | null }>)
const mockIntegrationFindFirst = mock(async () => null as unknown)
const mockIntegrationFindMany = mock(async () => [] as Array<{ name: string }>)
const mockIntegrationSchemaFindMany = mock(async () => [] as Array<{ tableName: string; description: string | null; integration: { name: string } }>)
const mockToolRunFindMany = mock(async () => [] as unknown[])
const mockAuditLogCreate = mock(async () => ({}))
const mockQueryHistoryCreate = mock(async () => ({}))
const mockRestApiConnectorFindMany = mock(async () => [] as unknown[])
const mockRestApiRequestLogCreate = mock(async () => ({}))
const mockPluginFindFirst = mock(async () => null as unknown)
const mockDocChunkFindMany = mock(async () => [] as unknown[])
const mockLlmConfigFindFirst = mock(async () => null)
const mockVectorStoreConfigFindFirst = mock(async () => null)

mock.module('@/lib/db', () => ({
  db: {
    integration: { count: mockIntegrationCount, findFirst: mockIntegrationFindFirst, findMany: mockIntegrationFindMany },
    integrationSchema: { findMany: mockIntegrationSchemaFindMany },
    document: { count: mockDocumentCount, findMany: mockDocumentFindMany },
    documentChunk: { findMany: mockDocChunkFindMany },
    restApiEndpoint: { count: mockRestEndpointCount, findMany: mockRestEndpointFindMany },
    toolRun: { findMany: mockToolRunFindMany },
    auditLog: { create: mockAuditLogCreate },
    queryHistory: { create: mockQueryHistoryCreate },
    restApiConnector: { findMany: mockRestApiConnectorFindMany },
    restApiRequestLog: { create: mockRestApiRequestLogCreate },
    plugin: { findFirst: mockPluginFindFirst },
    llmConfig: { findFirst: mockLlmConfigFindFirst },
    vectorStoreConfig: { findFirst: mockVectorStoreConfigFindFirst },
  },
}))

const mockRouteQuery = mock(async () => ({ decision: 'CHAT' as RouteDecision, reason: 'test' }))
const mockGenerateSql = mock(async () => ({ sql: 'SELECT 1', explanation: 'test' }))
const mockGenerateAnswer = mock(async () => 'The answer is 42')
const mockGenerateChat = mock(async () => 'Hello!')
const mockGenerateRestCall = mock(async () => ({ endpointId: 'ep-1', query: {}, body: null, explanation: 'test' }))

async function* mockGen() {
  yield 'mock-token'
}

const mockStreamAnswer = mock(() => mockGen())
const mockStreamChat = mock(() => mockGen())

// Real implementation so re-export test passes
function parseRestCallJsonImpl(raw: string) {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const parsed = JSON.parse(cleaned) as Record<string, unknown>
  const query = parsed.query && typeof parsed.query === 'object' && !Array.isArray(parsed.query)
    ? parsed.query
    : {}
  return {
    endpointId: String(parsed.endpointId ?? '').trim(),
    query: query as Record<string, unknown>,
    body: parsed.body === undefined ? null : parsed.body,
    explanation: String(parsed.explanation ?? '').trim(),
  }
}

mock.module('@/lib/ai', () => ({
  routeQuery: mockRouteQuery,
  generateSql: mockGenerateSql,
  generateAnswer: mockGenerateAnswer,
  generateChat: mockGenerateChat,
  generateRestCall: mockGenerateRestCall,
  streamAnswer: mockStreamAnswer,
  streamChat: mockStreamChat,
  parseRestCallJson: parseRestCallJsonImpl,
}))

const mockSmartRoute = mock(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined as string | undefined }))
// The importer destructures FOUR names from this module. Exporting only
// smartRoute left pickBestIntegration/pickBestIntegrationByKeywords/tokenize
// undefined, so the last-resort integration path threw and every test that
// reached it silently fell through to plain chat. A mock must cover the full
// surface its importer uses.
const mockPickBestIntegrationByKeywords = mock(async () => null as string | null)
const mockPickBestIntegration = mock(async () => null as string | null)
mock.module('@/lib/smart-router', () => ({
  smartRoute: mockSmartRoute,
  pickBestIntegration: mockPickBestIntegration,
  pickBestIntegrationByKeywords: mockPickBestIntegrationByKeywords,
  // MEASURED: omitting this one let the REAL smart-router run, which read
  // `integ.schemas` off my findMany fixture and threw
  // "undefined is not an object" — a partial mock silently executes production
  // code. A mock must cover every name the module graph can reach.
  pickBestIntegrationWithAmbiguity: async () => null,
  getRoutingScores: async () => ({ byTool: {}, totals: { calls: 0 } }),
  tokenize: (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean),
  keywordOverlap: () => 0,
  invalidateSourceEmbeddingCache: () => {},
  extractDomainGlossaryTerms: () => new Set<string>(),
  resolveIntegrationForQuestion: async () => null,
}))

const mockSearchFtsChunkIds = mock(async () => [] as string[])
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: mockSearchFtsChunkIds,
}))

mock.module('@/lib/cognee', () => ({
  recallContext: mock(async () => null),
  rememberChatTurn: mock(async () => undefined),
  recallKnowledgeGraph: async () => '',
}))

// In-memory Redis mock — rag.ts imports cacheGet/cacheSet/cacheDel
mock.module('@/lib/redis', () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
}))

// KG mock — dual-level retrieval returns empty in tests
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({
    localChunks: [],
    globalChunks: [],
    allChunkIds: [],
    matchedEntities: [],
    graphContext: '',
  }),
}))

const mockGetPromptSettings = mock(async () => ({
  systemPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}))
mock.module('@/lib/prompt-settings', () => ({
  getPromptSettings: mockGetPromptSettings,
}))

// The NON-STREAMING path was missing this mock entirely, so analyzeIntent ran for
// real here and its `needsClarification` could never be driven from a test — which
// is why the clarification branch was dead in this file while being covered in the
// streaming twin. Two parallel implementations, one of them untested (see 1.7aa).
const intentState: { value: Record<string, unknown> } = {
  value: { needsClarification: false, needsRetrieval: true },
}
mock.module('@/lib/intent-pipeline', () => ({
  analyzeIntent: async () => intentState.value,
  rewriteQuery: async (a: { question: string }) => a.question,
}))

// The agentic branch hands off to runAgenticLoop. Its arguments are captured
// because the likeliest defect is a field DROPPED in the hand-off — the caller
// sees a turn that lost its session or its memory and nothing looks broken.
const agenticState: {
  calls: Array<Record<string, unknown>>
  result: Record<string, unknown>
  delegate: boolean
} = {
  calls: [],
  result: { answer: 'agentic answer', citations: [], chartData: null, toolRuns: [] },
  delegate: false,
}
// runMultiStepDag must keep its REAL implementation — the existing DAG tests drive
// it through the planner mocks, and stubbing it here broke three of them. Measured,
// not guessed: my first version replaced the whole module and those tests failed.
// Only runAgenticLoop is intercepted, via a delegating wrapper.
const realAgentic = await import('@/lib/tool-router-agentic')
mock.module('@/lib/tool-router-agentic', () => ({
  ...realAgentic,
  runAgenticLoop: async (a: Record<string, unknown>, runCompletion: unknown) => {
    agenticState.calls.push(a)
    if (agenticState.delegate) return realAgentic.runAgenticLoop(a as never, runCompletion as never)
    return agenticState.result
  },
}))

const mockExecuteQuery = mock(async () => ({
  rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  rowCount: 2,
  executionMs: 10,
}))
const mockGetConnector = mock(() => ({ executeQuery: mockExecuteQuery }))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: mockGetConnector },
  describeSchema: mock(() => 'Table: users (10 rows)\nColumns: id, name'),
}))

const mockValidateSql = mock(() => ({ ok: true, sanitized: 'SELECT * FROM users LIMIT 10' }) as { ok: true; sanitized: string } | { ok: false; reason: string; detectedNodes: unknown[] })
mock.module('@/lib/guardrails', () => ({
  validateAndSanitizeLlmSql: mockValidateSql,
}))

mock.module('@/lib/crypto', () => ({
  decryptConfig: mock(() => ({})),
}))

mock.module('@/lib/rest-api-connectors', () => ({
  buildAuthHeaders: mock(async () => ({})),
  buildEndpointUrl: mock(() => 'http://localhost/api'),
  matchEndpoint: mock(() => ({ id: 'ep-1' })),
  sanitizeHeaders: mock(() => ({})),
}))

mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: mock(async () => []),
}))

mock.module('@/lib/plugin-registry', () => ({
  executePlugin: mock(async () => ({ ok: true, output: 'plugin-result', error: null })),
}))

const mockGetAvailableTools = mock(async () => [
  { id: 'sql', description: 'Query DB', paramDescription: '{}', requiresDataSource: 'integration' as const },
  { id: 'chat', description: 'General chat', paramDescription: '{}', requiresDataSource: 'none' as const },
])
mock.module('@/lib/tool-registry', () => ({
  getAvailableTools: mockGetAvailableTools,
}))

const mockPlanQuery = mock(async () => ({
  steps: [
    { id: 's1', tool: 'sql', input: { question: 'sales' } },
    { id: 's2', tool: 'chat', input: {}, dependsOn: ['s1'] },
  ] as Array<{ id: string; tool: string; input: Record<string, unknown>; dependsOn?: string[] }>,
  needsSynthesis: true,
}))
const mockExecutePlan = mock(async () => [
  { stepId: 's1', tool: 'sql', ok: true, output: 'sales data', latencyMs: 10 },
  { stepId: 's2', tool: 'chat', ok: true, output: 'chat result', latencyMs: 5 },
])
const mockSynthesizeAnswer = mock(async () => 'Combined answer from multiple steps')
mock.module('@/lib/planner', () => ({
  planQuery: mockPlanQuery,
  executePlan: mockExecutePlan,
  synthesizeAnswer: mockSynthesizeAnswer,
}))

// --- Imports ---

import {
  buildChartDataFromRows,
  buildDocumentCitation,
  chooseAvailableDecision,
  formatDocForIntent,
  parseRestCallJson,
  runNonStreamingChatCompletion,
  sanitizeSqlError,
  summarize,
  withSqlConcurrency,
} from './tool-router'
import { invalidateRagCache } from './rag'

// --- Setup / teardown ---

beforeEach(() => {
  intentState.value = { needsClarification: false, needsRetrieval: true }
  agenticState.calls = []
  agenticState.result = { answer: 'agentic answer', citations: [], chartData: null, toolRuns: [] }
  agenticState.delegate = false
  invalidateRagCache()
  mockIntegrationCount.mockClear()
  mockDocumentCount.mockClear()
  mockRestEndpointCount.mockClear()
  mockIntegrationFindFirst.mockClear()
  mockToolRunFindMany.mockClear()
  mockAuditLogCreate.mockClear()
  mockQueryHistoryCreate.mockClear()
  mockRestApiConnectorFindMany.mockClear()
  mockRestApiRequestLogCreate.mockClear()
  mockPluginFindFirst.mockClear()
  mockRouteQuery.mockClear()
  mockGenerateSql.mockClear()
  mockGenerateAnswer.mockClear()
  mockGenerateChat.mockClear()
  mockGenerateRestCall.mockClear()
  mockStreamAnswer.mockClear()
  mockStreamChat.mockClear()
  mockSmartRoute.mockClear()
  mockPickBestIntegrationByKeywords.mockClear()
  mockPickBestIntegration.mockClear()
  mockGetPromptSettings.mockClear()
  mockExecuteQuery.mockClear()
  mockGetConnector.mockClear()
  mockValidateSql.mockClear()
  mockGetAvailableTools.mockClear()
  mockPlanQuery.mockClear()
  mockExecutePlan.mockClear()
  mockSynthesizeAnswer.mockClear()

  // Reset default implementations
  mockIntegrationCount.mockImplementation(async () => 0)
  mockDocumentCount.mockImplementation(async () => 0)
  mockDocumentFindMany.mockImplementation(async () => [])
  mockRestEndpointCount.mockImplementation(async () => 0)
  mockIntegrationFindFirst.mockImplementation(async () => null)
  mockToolRunFindMany.mockImplementation(async () => [])
  mockAuditLogCreate.mockImplementation(async () => ({}))
  mockQueryHistoryCreate.mockImplementation(async () => ({}))
  mockRestApiConnectorFindMany.mockImplementation(async () => [])
  mockRestApiRequestLogCreate.mockImplementation(async () => ({}))
  mockPluginFindFirst.mockImplementation(async () => null)
  mockDocChunkFindMany.mockImplementation(async () => [])
  mockLlmConfigFindFirst.mockImplementation(async () => null)
  mockVectorStoreConfigFindFirst.mockImplementation(async () => null)
  mockSearchFtsChunkIds.mockImplementation(async () => [])
  mockRouteQuery.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, reason: 'test' }))
  mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT 1', explanation: 'test' }))
  mockGenerateAnswer.mockImplementation(async () => 'The answer is 42')
  mockGenerateChat.mockImplementation(async () => 'Hello!')
  mockGenerateRestCall.mockImplementation(async () => ({ endpointId: 'ep-1', query: {}, body: null, explanation: 'test' }))
  mockSmartRoute.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined }))
  mockPickBestIntegrationByKeywords.mockImplementation(async () => null)
  mockPickBestIntegration.mockImplementation(async () => null)
  mockGetPromptSettings.mockImplementation(async () => ({
    systemPrompt: '',
    tools: { rag: true, sql: true, restApi: true },
  }))
  mockExecuteQuery.mockImplementation(async () => ({
    rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    rowCount: 2,
    executionMs: 10,
  }))
  mockGetConnector.mockImplementation(() => ({ executeQuery: mockExecuteQuery }))
  mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT * FROM users LIMIT 10' }))
  mockGetAvailableTools.mockImplementation(async () => [
    { id: 'sql', description: 'Query DB', paramDescription: '{}', requiresDataSource: 'integration' as const },
    { id: 'chat', description: 'General chat', paramDescription: '{}', requiresDataSource: 'none' as const },
  ])
  mockPlanQuery.mockImplementation(async () => ({
    steps: [
      { id: 's1', tool: 'sql', input: { question: 'sales' } },
      { id: 's2', tool: 'chat', input: {}, dependsOn: ['s1'] },
    ],
    needsSynthesis: true,
  }))
  mockExecutePlan.mockImplementation(async () => [
    { stepId: 's1', tool: 'sql', ok: true, output: 'sales data', latencyMs: 10 },
    { stepId: 's2', tool: 'chat', ok: true, output: 'chat result', latencyMs: 5 },
  ])
  mockSynthesizeAnswer.mockImplementation(async () => 'Combined answer from multiple steps')
})

// --- Pure helper tests (existing) ---

describe('tool router helpers', () => {
  test('falls back to CHAT when the selected route has no available data source', () => {
    expect(
      chooseAvailableDecision('SQL', {
        hasIntegrations: false,
        hasDocuments: true,
        hasRestApis: true,
      }),
    ).toBe('CHAT')

    expect(
      chooseAvailableDecision('REST', {
        hasIntegrations: true,
        hasDocuments: true,
        hasRestApis: false,
      }),
    ).toBe('CHAT')
  })

  test('builds a bar chart from label and numeric rows', () => {
    const chart = buildChartDataFromRows([
      { category: 'Accessories', total: 12 },
      { category: 'Electronics', total: 8 },
    ])

    expect(chart).toEqual({
      type: 'bar',
      data: [
        { category: 'Accessories', total: 12 },
        { category: 'Electronics', total: 8 },
      ],
      xKey: 'category',
      yKeys: ['total'],
    })
  })

  test('parses REST call selection JSON without markdown fences', () => {
    const parsed = parseRestCallJson(
      '```json\n{"endpointId":"ep_1","query":{"limit":5},"body":null,"explanation":"get customers"}\n```',
    )

    expect(parsed).toEqual({
      endpointId: 'ep_1',
      query: { limit: 5 },
      body: null,
      explanation: 'get customers',
    })
  })

  test('builds document citations with chunk index and snippet', () => {
    const citation = buildDocumentCitation({
      documentName: 'SOP.md',
      chunkIndex: 3,
      content: 'SLA payment invoice maximum 14 days.',
      score: 8,
    })

    expect(citation.source).toBe('SOP.md')
    expect(citation.query_used).toBe('chunk #3')
    expect(citation.snippet).toContain('SLA payment')
    expect(citation.score).toBe(8)
  })
})

// --- buildChartDataFromRows additional tests ---

describe('buildChartDataFromRows', () => {
  test('empty rows returns null', () => {
    expect(buildChartDataFromRows([])).toBeNull()
  })

  test('single row returns null (needs at least 2)', () => {
    expect(buildChartDataFromRows([{ a: 1, b: 2 }])).toBeNull()
  })

  test('two rows with one column returns null (needs at least 2 columns)', () => {
    expect(buildChartDataFromRows([{ a: 1 }, { a: 2 }])).toBeNull()
  })

  test('date-like x-axis produces line chart', () => {
    const chart = buildChartDataFromRows([
      { date: '2024-01-01', value: 10 },
      { date: '2024-02-01', value: 20 },
    ])
    expect(chart).not.toBeNull()
    expect(chart!.type).toBe('line')
    expect(chart!.xKey).toBe('date')
    expect(chart!.yKeys).toEqual(['value'])
  })

  test('mixed numeric and string columns: string becomes xKey, numeric becomes yKey', () => {
    const chart = buildChartDataFromRows([
      { name: 'Alice', score: 90, grade: 'A' },
      { name: 'Bob', score: 85, grade: 'B' },
    ])
    expect(chart).not.toBeNull()
    expect(chart!.xKey).toBe('name')
    expect(chart!.yKeys).toContain('score')
  })

  test('all-numeric columns: no string xKey available → returns null', () => {
    const chart = buildChartDataFromRows([
      { id: 1, value: 10 },
      { id: 2, value: 20 },
    ])
    // Both columns are numeric → both go to yKeys, xKey stays null → returns null
    expect(chart).toBeNull()
  })

  test('numeric strings treated as numeric yKeys', () => {
    const chart = buildChartDataFromRows([
      { label: 'A', count: '10' },
      { label: 'B', count: '20' },
    ])
    expect(chart).not.toBeNull()
    expect(chart!.yKeys).toContain('count')
  })
})

// --- summarize tests ---

describe('summarize', () => {
  test('short text returned as-is', () => {
    expect(summarize('hello world')).toBe('hello world')
  })

  test('empty string returned as-is', () => {
    expect(summarize('')).toBe('')
  })

  test('long text truncated to 1000 chars with ellipsis', () => {
    const long = 'x'.repeat(1500)
    const result = summarize(long)
    expect(result.length).toBe(1003) // 1000 + '...'
    expect(result.endsWith('...')).toBe(true)
  })

  test('exactly 1000 chars returned as-is (no truncation)', () => {
    const exact = 'x'.repeat(1000)
    expect(summarize(exact)).toBe(exact)
  })

  test('1001 chars truncated', () => {
    const over = 'x'.repeat(1001)
    const result = summarize(over)
    expect(result.length).toBe(1003)
    expect(result.endsWith('...')).toBe(true)
  })
})

// --- sanitizeSqlError tests ---

describe('sanitizeSqlError', () => {
  test('removes postgres connection string credentials', () => {
    const input = 'Connection failed: postgres://user:pass@host:5432/db'
    expect(sanitizeSqlError(input)).toBe('Connection failed: postgres://***')
  })

  test('removes mysql connection string credentials', () => {
    const input = 'Error: mysql://admin:secret@localhost/db'
    expect(sanitizeSqlError(input)).toBe('Error: mysql://***')
  })

  test('removes password= from connection params', () => {
    const input = 'connect: password=mysecret user=admin'
    expect(sanitizeSqlError(input)).not.toContain('mysecret')
    expect(sanitizeSqlError(input)).toContain('password=***')
  })

  test('removes user= from connection params', () => {
    const input = 'connect: user=myuser password=mypass'
    expect(sanitizeSqlError(input)).not.toContain('myuser')
    expect(sanitizeSqlError(input)).toContain('user=***')
  })

  test('truncates to 300 characters', () => {
    const long = 'x'.repeat(500)
    expect(sanitizeSqlError(long).length).toBe(300)
  })

  test('safe error with no credentials passes through (up to 300 chars)', () => {
    const input = 'relation "users" does not exist'
    expect(sanitizeSqlError(input)).toBe(input)
  })
})

// --- withSqlConcurrency tests ---

describe('withSqlConcurrency', () => {
  test('limits concurrent calls to 3 per integration', async () => {
    let running = 0
    let maxRunning = 0
    const fn = async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 50))
      running -= 1
      return 'done'
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, () => withSqlConcurrency('test-concurrency-1', fn)),
    )

    expect(results).toHaveLength(6)
    expect(maxRunning).toBeLessThanOrEqual(3)
  })

  test('different integrations have independent semaphores', async () => {
    let running = 0
    let maxRunning = 0
    const fn = async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 50))
      running -= 1
    }

    await Promise.all([
      withSqlConcurrency('test-concurrency-2a', fn),
      withSqlConcurrency('test-concurrency-2b', fn),
      withSqlConcurrency('test-concurrency-2c', fn),
      withSqlConcurrency('test-concurrency-2d', fn),
    ])

    // 4 different integrations → all run concurrently
    expect(maxRunning).toBe(4)
  })

  test('returns the result of the wrapped function', async () => {
    const result = await withSqlConcurrency('test-concurrency-3', async () => 42)
    expect(result).toBe(42)
  })

  test('propagates errors', async () => {
    await expect(
      withSqlConcurrency('test-concurrency-4', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})

// --- runNonStreamingChatCompletion tests ---

describe('runNonStreamingChatCompletion', () => {
  test('CHAT branch: returns chat answer when no data sources', async () => {
    mockIntegrationCount.mockImplementation(async () => 0)
    mockDocumentCount.mockImplementation(async () => 0)
    mockRestEndpointCount.mockImplementation(async () => 0)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined }))
    mockGenerateChat.mockImplementation(async () => 'Hello from chat!')

    const result = await runNonStreamingChatCompletion({
      question: 'Hello',
      userId: 'user-1',
    })

    expect(result.answer).toBe('Hello from chat!')
    expect(result.toolRuns).toHaveLength(1)
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(result.toolRuns[0].status).toBe('success')
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
  })

  test('SQL branch: returns answer with query results and citation', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockDocumentCount.mockImplementation(async () => 0)
    mockRestEndpointCount.mockImplementation(async () => 0)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: 'int-1' }))
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      name: 'Test DB',
      provider: 'POSTGRESQL',
      encryptedConfig: 'encrypted',
      schemas: [{ tableName: 'users', columns: '[]', rowCount: 10, sampleRow: null }],
    }))
    mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT * FROM users LIMIT 10', explanation: 'all users' }))
    mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT * FROM users LIMIT 10' }))
    mockExecuteQuery.mockImplementation(async () => ({
      rows: [{ id: 1, name: 'Alice' }],
      rowCount: 1,
      executionMs: 5,
    }))
    mockGenerateAnswer.mockImplementation(async () => 'Found 1 user named Alice.')

    const result = await runNonStreamingChatCompletion({
      question: 'Show me all users',
      userId: 'user-1',
    })

    expect(result.answer).toBe('Found 1 user named Alice.')
    expect(result.integrationId).toBe('int-1')
    expect(result.toolRuns).toHaveLength(1)
    expect(result.toolRuns[0].type).toBe('SQL')
    expect(result.toolRuns[0].status).toBe('success')
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0].type).toBe('DATABASE')
    expect(result.citations[0].query_used).toContain('SELECT * FROM users')
    expect(mockQueryHistoryCreate).toHaveBeenCalledTimes(1)
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
  })

  // ponytail: with the SQL repair loop, a guardrail rejection is retried
  // (SQL_REPAIR_ATTEMPTS) before giving up — the terminal status is 'error'
  // with the last guardrail reason. 'blocked' is reserved for rate limits.
  test('SQL branch: persistent guardrail rejection retries then returns error status', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: 'int-1' }))
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      name: 'Test DB',
      provider: 'POSTGRESQL',
      encryptedConfig: 'encrypted',
      schemas: [{ tableName: 'users', columns: '[]', rowCount: 10, sampleRow: null }],
    }))
    mockGenerateSql.mockImplementation(async () => ({ sql: 'DROP TABLE users', explanation: 'drop' }))
    mockValidateSql.mockImplementation(() => ({ ok: false, reason: 'DROP not allowed', detectedNodes: [] }))

    const result = await runNonStreamingChatCompletion({
      question: 'Delete all users',
      userId: 'user-1',
    })

    expect(result.toolRuns[0].type).toBe('SQL')
    expect(result.toolRuns[0].status).toBe('error')
    expect(result.toolRuns[0].errorMessage).toContain('DROP')
    // 1 initial + 2 repair attempts
    expect(mockGenerateSql).toHaveBeenCalledTimes(3)
  })

  test('SQL branch: guardrail rejection recovers on repair attempt', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: 'int-1' }))
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      name: 'Test DB',
      provider: 'POSTGRESQL',
      encryptedConfig: 'encrypted',
      schemas: [{ tableName: 'users', columns: '[]', rowCount: 10, sampleRow: null }],
    }))
    let call = 0
    mockGenerateSql.mockImplementation(async () => {
      call++
      return call === 1
        ? { sql: 'DELETE FROM users', explanation: 'bad' }
        : { sql: 'SELECT * FROM users LIMIT 10', explanation: 'fixed' }
    })
    let guardCall = 0
    mockValidateSql.mockImplementation(() => {
      guardCall++
      return guardCall === 1
        ? { ok: false, reason: 'DELETE not allowed', detectedNodes: [] }
        : { ok: true, sanitized: 'SELECT * FROM users LIMIT 10' }
    })
    mockExecuteQuery.mockImplementation(async () => ({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1, executionMs: 5 }))

    const result = await runNonStreamingChatCompletion({
      question: 'Show users',
      userId: 'user-1',
    })

    expect(result.toolRuns[0].status).toBe('success')
    expect(mockGenerateSql).toHaveBeenCalledTimes(2)
    // repair feedback reached the second generateSql call
    const secondCallArgs = (mockGenerateSql.mock.calls as unknown as Array<[{ repairFeedback?: string }]>)[1]?.[0]
    expect(secondCallArgs?.repairFeedback).toContain('DELETE not allowed')
  })

  test('SQL branch: execute error returns error status with sanitized message', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: 'int-1' }))
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      name: 'Test DB',
      provider: 'POSTGRESQL',
      encryptedConfig: 'encrypted',
      schemas: [{ tableName: 'users', columns: '[]', rowCount: 10, sampleRow: null }],
    }))
    mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT * FROM users LIMIT 10', explanation: 'test' }))
    mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT * FROM users LIMIT 10' }))
    mockExecuteQuery.mockImplementation(async () => {
      throw new Error('connect: postgres://admin:secret@host:5432/db failed')
    })

    const result = await runNonStreamingChatCompletion({
      question: 'Show users',
      userId: 'user-1',
    })

    expect(result.toolRuns[0].status).toBe('error')
    // errorMessage in toolRun is raw; sanitized version is in the answer
    expect(result.answer).toContain('postgres://***')
    expect(result.answer).not.toContain('secret')
    expect(result.answer).toContain('database query failed')
  })

  test('RAG branch: returns answer with citations from retrieved chunks', async () => {
    mockIntegrationCount.mockImplementation(async () => 0)
    mockDocumentCount.mockImplementation(async () => 1)
    mockRestEndpointCount.mockImplementation(async () => 0)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'RAG' as RouteDecision, integrationId: undefined }))
    // Set up FTS + chunk data for real retrieveRelevantChunks
    mockSearchFtsChunkIds.mockImplementation(async () => ['chunk-1'])
    mockDocChunkFindMany.mockImplementation(async () => [
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'The return policy allows 30 days for returns.',
        keywords: 'return,policy',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'policy.txt' },
      },
    ])
    mockGenerateAnswer.mockImplementation(async () => 'The return policy allows 30 days.')

    const result = await runNonStreamingChatCompletion({
      question: 'What is the return policy?',
      userId: 'user-1',
    })

    expect(result.answer).toBe('The return policy allows 30 days.')
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0].type).toBe('DOCUMENT')
    expect(result.citations[0].source).toBe('policy.txt')
    expect(result.toolRuns[0].type).toBe('RAG')
    expect(result.toolRuns[0].status).toBe('success')
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
  })

  test('RAG branch: no chunks found falls back to CHAT', async () => {
    mockDocumentCount.mockImplementation(async () => 1)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'RAG' as RouteDecision, integrationId: undefined }))
    // No FTS hits and no chunks → retrieveRelevantChunks returns empty
    mockSearchFtsChunkIds.mockImplementation(async () => [])
    mockDocChunkFindMany.mockImplementation(async () => [])
    mockDocumentFindMany.mockImplementation(async () => [])
    mockGenerateChat.mockImplementation(async () => 'No relevant documents found.')

    const result = await runNonStreamingChatCompletion({
      question: 'What is the return policy?',
      userId: 'user-1',
    })

    expect(result.answer).toBe('No relevant documents found.')
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('LLM not configured: error propagates from CHAT branch', async () => {
    mockIntegrationCount.mockImplementation(async () => 0)
    mockDocumentCount.mockImplementation(async () => 0)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined }))
    mockGenerateChat.mockImplementation(async () => {
      throw new Error('LLM is not configured')
    })

    await expect(
      runNonStreamingChatCompletion({
        question: 'Hello',
        userId: 'user-1',
      }),
    ).rejects.toThrow('LLM is not configured')
  })

  test('no integration available: SQL decision falls back to CHAT', async () => {
    mockIntegrationCount.mockImplementation(async () => 0)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: undefined }))
    mockGenerateChat.mockImplementation(async () => 'No data source available.')

    const result = await runNonStreamingChatCompletion({
      question: 'Show me sales data',
      userId: 'user-1',
    })

    // chooseAvailableDecision converts SQL→CHAT when hasIntegrations=false
    expect(result.answer).toBe('No data source available.')
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('SQL tool disabled by prompt settings: falls back to CHAT', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: 'int-1' }))
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: '',
      tools: { rag: true, sql: false, restApi: true },
    }))
    mockGenerateChat.mockImplementation(async () => 'SQL is disabled.')

    const result = await runNonStreamingChatCompletion({
      question: 'Show users',
      userId: 'user-1',
    })

    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(result.answer).toBe('SQL is disabled.')
  })

  test('allowMultiStepDag: uses planner for multi-step execution', async () => {
    mockGetAvailableTools.mockImplementation(async () => [
      { id: 'sql', description: 'Query DB', paramDescription: '{}', requiresDataSource: 'integration' as const },
      { id: 'chat', description: 'General chat', paramDescription: '{}', requiresDataSource: 'none' as const },
    ])
    mockPlanQuery.mockImplementation(async () => ({
      steps: [
        { id: 's1', tool: 'sql', input: { question: 'sales' } },
        { id: 's2', tool: 'chat', input: {}, dependsOn: ['s1'] },
      ],
      needsSynthesis: true,
    }))
    mockExecutePlan.mockImplementation(async () => [
      { stepId: 's1', tool: 'sql', ok: true, output: 'sales data', latencyMs: 10 },
      { stepId: 's2', tool: 'chat', ok: true, output: 'chat result', latencyMs: 5 },
    ])
    mockSynthesizeAnswer.mockImplementation(async () => 'Combined answer from multiple steps')

    const result = await runNonStreamingChatCompletion({
      question: 'Compare sales with the return policy',
      userId: 'user-1',
      allowMultiStepDag: true,
    })

    expect(result.answer).toBe('Combined answer from multiple steps')
    expect(mockPlanQuery).toHaveBeenCalledTimes(1)
    expect(mockExecutePlan).toHaveBeenCalledTimes(1)
    expect(mockSynthesizeAnswer).toHaveBeenCalledTimes(1)
  })

  test('allowMultiStepDag: single-step CHAT plan falls back to single-tool router', async () => {
    mockPlanQuery.mockImplementation(async () => ({
      steps: [{ id: 's1', tool: 'chat', input: {} }],
      needsSynthesis: false,
    }))
    mockSmartRoute.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined }))
    mockGenerateChat.mockImplementation(async () => 'Single-step chat answer')

    const result = await runNonStreamingChatCompletion({
      question: 'Hello',
      userId: 'user-1',
      allowMultiStepDag: true,
    })

    // Single-step CHAT plan = no benefit, falls back to single-tool router
    expect(result.answer).toBe('Single-step chat answer')
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('allowMultiStepDag: planner error falls back to single-tool router', async () => {
    mockPlanQuery.mockImplementation(async () => {
      throw new Error('Planner failed')
    })
    mockSmartRoute.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, integrationId: undefined }))
    mockGenerateChat.mockImplementation(async () => 'Fallback chat answer')

    const result = await runNonStreamingChatCompletion({
      question: 'Complex question',
      userId: 'user-1',
      allowMultiStepDag: true,
    })

    expect(result.answer).toBe('Fallback chat answer')
  })

  test('multi-turn with chat history uses LLM routeQuery instead of smartRoute', async () => {
    mockDocumentCount.mockImplementation(async () => 1)
    mockRouteQuery.mockImplementation(async () => ({ decision: 'CHAT' as RouteDecision, reason: 'contextual' }))
    mockGenerateChat.mockImplementation(async () => 'Contextual answer')

    const result = await runNonStreamingChatCompletion({
      question: 'What about last month?',
      userId: 'user-1',
      chatHistory: [{ role: 'user', content: 'Show me sales' }, { role: 'assistant', content: 'Sales were good.' }],
    })

    expect(result.answer).toBe('Contextual answer')
    expect(mockRouteQuery).toHaveBeenCalledTimes(1)
    expect(mockSmartRoute).not.toHaveBeenCalled()
  })

  test('CONTEXTUAL_CHAT branch: loads prior tool runs and generates contextual answer', async () => {
    mockDocumentCount.mockImplementation(async () => 1)
    mockRouteQuery.mockImplementation(async () => ({ decision: 'CONTEXTUAL_CHAT' as RouteDecision, reason: 'refers to prior' }))
    mockToolRunFindMany.mockImplementation(async () => [
      { type: 'SQL', inputSummary: 'show sales', outputSummary: 'Sales: $5000' },
    ])
    mockGenerateAnswer.mockImplementation(async () => 'Based on prior data, sales were $5000.')

    const result = await runNonStreamingChatCompletion({
      question: 'What did I ask about earlier?',
      userId: 'user-1',
      sessionId: 'session-1',
      chatHistory: [{ role: 'user', content: 'Show me sales' }, { role: 'assistant', content: 'Sales were $5000.' }],
    })

    expect(result.answer).toBe('Based on prior data, sales were $5000.')
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(mockToolRunFindMany).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The NON-STREAMING branches that the streaming twin had covered
//
// Adding the missing '@/lib/intent-pipeline' mock above is what made these
// reachable: without it analyzeIntent ran for real and needsClarification could
// not be driven from a test. Same class as 1.7aa — two parallel implementations,
// one of them untested.
// ---------------------------------------------------------------------------

describe('runNonStreamingChatCompletion — clarification', () => {
  test('a clarification question is returned as the answer and NO tool runs', async () => {
    intentState.value = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: true }
    const result = await runNonStreamingChatCompletion({ question: 'q', userId: 'u1' })
    // Asking is not answering: routing a tool here would answer a question the
    // router just decided it could not understand.
    expect(result.answer).toBe('Which database?')
    expect(result.toolRuns).toEqual([])
  })

  test('skipClarification suppresses the question and routes instead', async () => {
    intentState.value = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: false }
    const result = await runNonStreamingChatCompletion({ question: 'q', userId: 'u1', skipClarification: true })
    // The API path sets this when the caller already chose a source; a dead-end
    // question there is a bug the user sees as the bot ignoring them.
    expect(result.answer).not.toBe('Which database?')
  })

  test('a clarification with NO question text falls through instead of answering empty', async () => {
    intentState.value = { needsClarification: true, clarificationQuestion: '', needsRetrieval: false }
    const result = await runNonStreamingChatCompletion({ question: 'hello', userId: 'u1' })
    // Both flags are required; an empty question must not become an empty answer.
    expect(result.answer).not.toBe('')
    expect(result.answer).toBeTruthy()
  })
})

describe('formatDocForIntent — what the router is told a document IS', () => {
  test('renders name, category and description', () => {
    expect(formatDocForIntent({ name: 'sop.pdf', category: 'HR', description: 'Annual leave rules' }))
      .toBe('sop.pdf [HR] — Annual leave rules')
  })

  test('a missing category omits the bracket entirely', () => {
    expect(formatDocForIntent({ name: 'sop.pdf', category: null, description: 'Annual leave rules' }))
      .toBe('sop.pdf — Annual leave rules')
  })

  test('a missing description omits the dash entirely', () => {
    // A trailing " — " with nothing after it reads as a truncated name.
    expect(formatDocForIntent({ name: 'sop.pdf', category: 'HR', description: null }))
      .toBe('sop.pdf [HR]')
  })

  test('with neither category nor description only the name remains', () => {
    expect(formatDocForIntent({ name: 'sop.pdf', category: null, description: null })).toBe('sop.pdf')
  })

  test('the description is what distinguishes two similarly-named documents', () => {
    // The whole reason it is in the prompt: without it the router cannot tell
    // "annual leave SOP" from "Q3 invoice export" when both are called "doc.pdf".
    const a = formatDocForIntent({ name: 'doc.pdf', category: null, description: 'annual leave SOP' })
    const b = formatDocForIntent({ name: 'doc.pdf', category: null, description: 'Q3 invoice export' })
    expect(a).not.toBe(b)
  })
})


describe('runNonStreamingChatCompletion — the agentic hand-off', () => {
  test('a DAG request WITH history goes to runAgenticLoop, not the planner', async () => {
    const result = await runNonStreamingChatCompletion({
      question: 'and the total?',
      userId: 'u1',
      allowMultiStepDag: true,
      chatHistory: [
        { role: 'user', content: 'how many orders' },
        { role: 'assistant', content: '42' },
      ],
    })
    // A follow-up needs the loop, which can call the model repeatedly; the
    // planner path cannot see the prior turns at all.
    expect(agenticState.calls).toHaveLength(1)
    expect(result.answer).toBe('agentic answer')
    // MEASURED: the result is rebuilt field by field, so a new field on
    // CompletionResult would be dropped here without a failing test.
    expect(result.toolRuns).toEqual([])
  })

  test('the hand-off carries userId, sessionId, integrationId and skipClarification', async () => {
    await runNonStreamingChatCompletion({
      question: 'q',
      userId: 'user-99',
      sessionId: 'sess-7',
      integrationId: 'integ-3',
      skipClarification: true,
      systemPromptPrefix: 'Be terse.',
      allowMultiStepDag: true,
      chatHistory: [{ role: 'user', content: 'hi' }],
    })
    const sent = agenticState.calls[0]
    // A dropped field here is invisible at the call site but changes behaviour:
    // no session means no memory, no prefix means the operator's framing is lost.
    expect(sent.userId).toBe('user-99')
    expect(sent.sessionId).toBe('sess-7')
    expect(sent.integrationId).toBe('integ-3')
    expect(sent.skipClarification).toBe(true)
    expect(sent.systemPromptPrefix).toBe('Be terse.')
    expect(sent.question).toBe('q')
  })

  test('a DAG request with an EMPTY history does NOT take the agentic branch', async () => {
    await runNonStreamingChatCompletion({
      question: 'sales this month',
      userId: 'u1',
      allowMultiStepDag: true,
      chatHistory: [],
    })
    // There is no conversation to continue, so the single-tool router is cheaper
    // and more predictable than a multi-round loop.
    expect(agenticState.calls).toHaveLength(0)
  })

  test('without allowMultiStepDag the loop is never entered, history or not', async () => {
    await runNonStreamingChatCompletion({
      question: 'q',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'hi' }],
    })
    // The flag is the consent for multi-round spending on a BYOK key.
    expect(agenticState.calls).toHaveLength(0)
  })

  test('the loop receives the real completion function, not a placeholder', async () => {
    await runNonStreamingChatCompletion({
      question: 'q',
      userId: 'u1',
      allowMultiStepDag: true,
      chatHistory: [{ role: 'user', content: 'hi' }],
    })
    // The second argument is how the loop calls back for each round; passing a
    // no-op would make every agentic turn return an empty answer.
    expect(agenticState.calls).toHaveLength(1)
  })
})

describe('tool-router — an ambiguous data source', () => {
  test('the resolved integration is what reaches runSqlBranch', async () => {
    // Two integrations must EXIST for the ambiguity branch to be reachable: with
    // intCount 0, chooseAvailableDecision forces CHAT and the code never runs.
    mockIntegrationCount.mockImplementation(async () => 2)
    mockIntegrationFindMany.mockImplementation(async () => [
      { id: 'integ-low', name: 'Low', type: 'postgresql' },
      { id: 'integ-high', name: 'High', type: 'postgresql' },
      { id: 'integ-mid', name: 'Mid', type: 'postgresql' },
    ])
    mockSmartRoute.mockImplementation(async () => ({
      decision: 'SQL' as RouteDecision,
      integrationId: undefined,
      ambiguousIntegrations: [
        { integrationId: 'integ-low', score: 0.2 },
        { integrationId: 'integ-high', score: 0.9 },
        { integrationId: 'integ-mid', score: 0.5 },
      ],
    }))
    // This fixture is REQUIRED. Without it findFirst returns null (the default) and
    // runSqlBranch concludes the row does not exist and asks the user — a test that
    // then "passes" while measuring an unrelated path. I hit exactly that: my
    // rewritten version dropped this line and the assertion still went green,
    // because the question is also a valid-looking answer.
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'integ-high', name: 'High', provider: 'POSTGRESQL', encryptedConfig: 'enc',
      schemas: [{ tableName: 'orders', columns: [{ name: 'total', type: 'numeric' }] }],
    }))

    const r = await runNonStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    // MEASURED: the highest score wins, and the winning id is the one looked up —
    // not the first candidate in the array, whose order is whatever produced it.
    const looked = (mockIntegrationFindFirst.mock.calls as unknown[][])
      .map((c) => (c[0] as { where?: { id?: string } })?.where?.id)
      .filter(Boolean)
    expect(looked).toContain('integ-high')
    expect(looked).not.toContain('integ-low')
    // The last-resort strategies must not run: smartRoute already reported a set of
    // candidates, so there is nothing left to search for.
    expect(mockPickBestIntegrationByKeywords).toHaveBeenCalledTimes(0)
    expect(mockPickBestIntegration).toHaveBeenCalledTimes(0)
    expect(r).toBeTruthy()
  })

  test('a resolved id whose row is MISSING asks instead of guessing', async () => {
    // The integration list says 2 exist, but the row the router resolved cannot be
    // read (deleted between the count and the lookup). Answering from an arbitrary
    // surviving integration is how a Sales question gets HR numbers, silently, so
    // asking is the correct failure.
    mockIntegrationCount.mockImplementation(async () => 2)
    mockIntegrationFindMany.mockImplementation(async () => [
      { id: 'integ-a', name: 'A', type: 'postgresql' },
      { id: 'integ-b', name: 'B', type: 'postgresql' },
    ])
    mockSmartRoute.mockImplementation(async () => ({
      decision: 'SQL' as RouteDecision,
      integrationId: 'integ-gone',
      ambiguousIntegrations: [],
    }))
    mockIntegrationFindFirst.mockImplementation(async () => null)
    mockPickBestIntegrationByKeywords.mockImplementation(async () => null)
    mockPickBestIntegration.mockImplementation(async () => null)

    const r = await runNonStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    expect(r.toolRuns[0]?.status).toBe('blocked')
    expect(r.answer).toContain('could not tell which data source')
    // Candidate names are listed so one follow-up is enough.
    expect(r.answer).toContain('A')
  })

  test('with no resolvable source at all, both strategies run before asking', async () => {
    mockIntegrationCount.mockImplementation(async () => 2)
    mockIntegrationFindMany.mockImplementation(async () => [
      { id: 'integ-a', name: 'A', type: 'postgresql' },
      { id: 'integ-b', name: 'B', type: 'postgresql' },
    ])
    mockSmartRoute.mockImplementation(async () => ({
      decision: 'SQL' as RouteDecision,
      integrationId: undefined,
      ambiguousIntegrations: [],
    }))
    mockIntegrationFindFirst.mockImplementation(async () => null)
    mockPickBestIntegrationByKeywords.mockImplementation(async () => null)
    mockPickBestIntegration.mockImplementation(async () => null)

    await runNonStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    expect(mockPickBestIntegrationByKeywords).toHaveBeenCalledTimes(1)
    // Only reached because the keyword pass found nothing: pickBestIntegration calls
    // an embedding API, so it must be the fallback, never the first choice.
    expect(mockPickBestIntegration).toHaveBeenCalledTimes(1)
  })

  test('the keyword strategy short-circuits before the slow embedding one', async () => {
    // pickBestIntegration calls an embedding API; the keyword scan does not. The
    // keyword pass must win so a slow or unavailable embedding service cannot stall
    // a question the fast path could already route.
    mockIntegrationCount.mockImplementation(async () => 2)
    mockIntegrationFindMany.mockImplementation(async () => [
      { id: 'integ-kw', name: 'Warehouse', type: 'postgresql' },
      { id: 'integ-other', name: 'Other', type: 'postgresql' },
    ])
    mockSmartRoute.mockImplementation(async () => ({ decision: 'SQL' as RouteDecision, integrationId: undefined }))
    mockPickBestIntegrationByKeywords.mockImplementation(async () => 'integ-kw')
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'integ-kw', name: 'Warehouse', provider: 'POSTGRESQL', encryptedConfig: 'enc',
      schemas: [{ tableName: 'stock', columns: [{ name: 'qty', type: 'integer' }] }],
    }))

    await runNonStreamingChatCompletion({ question: 'warehouse stock', userId: 'u1' })
    expect(mockPickBestIntegrationByKeywords).toHaveBeenCalledTimes(1)
    expect(mockPickBestIntegration).toHaveBeenCalledTimes(0)
  })
})

describe('preflight DB load — a failing query surfaces, it is not swallowed', () => {
  // withTimeout's rejection handler (line 295). The preflight counts documents and
  // integrations to decide whether SQL/RAG/REST are even offerable. If a count
  // query REJECTS, the outer handler must surface a sanitized error rather than
  // hang: the timer is cleared and the rejection forwarded. A swallowed rejection
  // would leave the caller awaiting a promise that never settles -- a hung request
  // is strictly worse than a 500, because nothing is logged and the socket leaks.
  test('a rejecting preflight query forwards the error instead of hanging', async () => {
    mockDocumentCount.mockImplementationOnce(async () => {
      throw new Error('relation "Document" does not exist')
    })
    await expect(
      runNonStreamingChatCompletion({
        question: 'how many documents?',
        userId: 'user-1',
        allowMultiStepDag: true,
      }),
    ).rejects.toThrow('relation "Document" does not exist')
  })

  test('a HEALTHY preflight does not reject', async () => {
    // The inverse, so the test above cannot pass merely because this entry point
    // always rejects.
    mockDocumentCount.mockImplementation(async () => 3)
    const result = await runNonStreamingChatCompletion({
      question: 'Compare sales with the return policy',
      userId: 'user-1',
      allowMultiStepDag: true,
    })
    expect(result.answer).toBeTruthy()
  })
})
