import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks (must be before imports of modules under test) ---

type RouteDecision = 'CHAT' | 'SQL' | 'RAG' | 'REST' | 'PLUGIN' | 'CONTEXTUAL_CHAT'

const mockIntegrationCount = mock(async () => 0)
const mockDocumentCount = mock(async () => 0)
const mockDocumentFindMany = mock(async () => [] as unknown[])
const mockRestEndpointCount = mock(async () => 0)
const mockIntegrationFindFirst = mock(async () => null as unknown)
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
    integration: { count: mockIntegrationCount, findFirst: mockIntegrationFindFirst },
    document: { count: mockDocumentCount, findMany: mockDocumentFindMany },
    documentChunk: { findMany: mockDocChunkFindMany },
    restApiEndpoint: { count: mockRestEndpointCount },
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
mock.module('@/lib/smart-router', () => ({
  smartRoute: mockSmartRoute,
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

const mockGetPromptSettings = mock(async () => ({
  systemPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}))
mock.module('@/lib/prompt-settings', () => ({
  getPromptSettings: mockGetPromptSettings,
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
  parseRestCallJson,
  runNonStreamingChatCompletion,
  sanitizeSqlError,
  summarize,
  withSqlConcurrency,
} from './tool-router'
import { invalidateRagCache } from './rag'

// --- Setup / teardown ---

beforeEach(() => {
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

  test('SQL branch: guardrail block returns blocked status', async () => {
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
    expect(result.toolRuns[0].status).toBe('blocked')
    expect(result.toolRuns[0].errorMessage).toContain('DROP')
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
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
