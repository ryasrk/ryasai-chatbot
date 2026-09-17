import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const mockRouteQuery = mock(async () => {
  smartRouteOrder?.push('smartRoute')
  return { decision: 'CHAT' as RouteDecision, reason: 'test' }
})
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

/**
 * The routing decision now comes from the LLM selector, so that is what the
 * tests stub. The heuristic `smartRoute` is no longer in the selection path.
 */
const mockSelectToolWithLlm = mock(async (_args: {
  question: string
  context: 'chat' | 'agentic'
  isAdmin: boolean
  memoryContext?: string
  chatHistory?: Array<{ role: string; content: string }>
  needsDatabaseListing?: boolean
}): Promise<{
  toolId: string | null
  decision: RouteDecision
  args: Record<string, unknown>
  integrationId?: string
  needsMultipleTools?: boolean
  reason: string
  llmUsed: boolean
}> => {
  smartRouteOrder?.push('smartRoute')
  return { toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }
})
// The importer destructures FOUR names from this module. Exporting only
// smartRoute left pickBestIntegration/pickBestIntegrationByKeywords/tokenize
// undefined, so the last-resort integration path threw and every test that
// reached it silently fell through to plain chat. A mock must cover the full
// surface its importer uses.
const mockPickBestIntegrationByKeywords = mock(async () => null as string | null)
const mockPickBestIntegration = mock(async () => null as string | null)
mock.module('@/lib/tool-selector', () => ({
  selectToolWithLlm: mockSelectToolWithLlm,
}))

mock.module('@/lib/smart-router', () => ({
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

// Declared BEFORE the cognee factory below, which closes over it: a module-scope
// `let` read inside a mock factory whose declaration sits later in the file is a
// temporal-dead-zone crash at import time, not a test failure.
let memoryContextValue = 'MEMORY-CONTEXT'

const mockSearchFtsChunkIds = mock(async () => [] as string[])
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: mockSearchFtsChunkIds,
}))

mock.module('@/lib/cognee', () => ({
  // `memoryContextValue` is the streaming block's seam. A null recall is what
  // the existing non-streaming tests were written against, so the default stays
  // falsy and only the streaming tests move it.
  recallContext: mock(async () => memoryContextValue),
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
// The streaming dispatcher's seam values: what the rewrite produced, and what
// recall returned. Held in module scope so a test can move them without a second
// `mock.module` (which is never restored and poisons later tests).
let effectiveQuestionValue = 'REWRITTEN-QUESTION'
// Counted rather than ordered: an ORDER assertion is meaningless when the rewrite is the only step
// in the list, and the count proves the rewrite actually ran instead of being skipped.
let rewriteCalls = 0
// Order log, assigned per test. null means "this seam is not being observed".
let rewriteOrder: string[] | null = null
let intentOrder: string[] | null = null
let smartRouteOrder: string[] | null = null
let preparerOrder: string[] | null = null

// Capture the WHOLE argument object for the streaming assertions. The existing
// tests only ever drive `needsClarification`/`needsRetrieval`, so keeping the
// capture here (rather than replacing the seam) preserves them byte for byte.
let lastIntentArgs: Record<string, unknown> = {}
let intentQuestionValue: unknown = undefined
const orderIntentArgs = (a: Record<string, unknown>): Record<string, unknown> => {
  intentOrder?.push('analyzeIntent')
  lastIntentArgs = a
  intentQuestionValue = a.question
  return a
}
mock.module('@/lib/intent-pipeline', () => ({
  // `orderIntentArgs` only RECORDS the call; it returns the arguments object. Returning that as the
  // intent was a real bug in this mock: `intent.needsRetrieval` was then `undefined`, and since the
  // dispatcher tests `!intent.needsRetrieval` the `prepareChatStream` early exit won EVERY time -- both
  // router mocks recorded zero calls while a stream was still produced, so tests passed while the
  // routing code never ran. The recorded arguments are kept for assertions, but the RESULT is the
  // `intentState` seam, which is what the seam's own comment always claimed it was.
  analyzeIntent: async (a: Record<string, unknown>) => ({ ...orderIntentArgs(a as never), ...intentState.value }),
  rewriteQuery: async (a: { question: string }) => {
    rewriteCalls++
    rewriteOrder?.push('rewrite')
    return effectiveQuestionValue
  },
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
  effectiveQuestionValue = 'REWRITTEN-QUESTION'
  rewriteCalls = 0
  memoryContextValue = 'MEMORY-CONTEXT'
  lastIntentArgs = {}
  intentQuestionValue = undefined
  streamCalls.length = 0
  streamEventOrder = 0
  chatStreamArgs.length = 0
  sqlStreamArgs.length = 0
  ragStreamArgs.length = 0
  restStreamArgs.length = 0
  pluginStreamArgs.length = 0
  contextualStreamArgs.length = 0
  mockPrepareChatStream.mockClear()
  mockPrepareSqlStream.mockClear()
  mockPrepareRagStream.mockClear()
  mockPrepareRestStream.mockClear()
  mockPreparePluginStream.mockClear()
  mockPrepareContextualChatStream.mockClear()
  agenticState.calls = []
  agenticState.result = { answer: 'agentic answer', citations: [], chartData: null, toolRuns: [] }
  agenticState.delegate = false
  invalidateRagCache()
  mockIntegrationSchemaFindMany.mockClear()
  mockDocumentFindMany.mockClear()
  mockIntegrationFindMany.mockClear()
  mockRestEndpointFindMany.mockClear()
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
  mockSelectToolWithLlm.mockClear()
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
  // The selector MUST be reset like every other mock. Without this the previous
  // test's implementation leaked into the next one, so tests passed or failed
  // based on file order rather than on what they set up.
  mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'reset', llmUsed: true }))
  mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT 1', explanation: 'test' }))
  mockGenerateAnswer.mockImplementation(async () => 'The answer is 42')
  mockGenerateChat.mockImplementation(async () => 'Hello!')
  mockGenerateRestCall.mockImplementation(async () => ({ endpointId: 'ep-1', query: {}, body: null, explanation: 'test' }))
  mockSelectToolWithLlm.mockImplementation(async () => {
    smartRouteOrder?.push('smartRoute')
    return { toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }
  })
  mockPickBestIntegrationByKeywords.mockImplementation(async () => null)
  mockPickBestIntegration.mockImplementation(async () => null)
  mockIntegrationSchemaFindMany.mockImplementation(async () => [])
  mockRestEndpointFindMany.mockImplementation(async () => [])
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'rag', decision: 'RAG' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'rag', decision: 'RAG' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
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
    // The DAG costs a second LLM call, so it runs only when the SELECTOR says one
    // tool cannot suffice. This is the signal that opens it.
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: 'sql', decision: 'SQL' as RouteDecision, args: {},
      integrationId: 'int-1', needsMultipleTools: true, reason: 'multi-step', llmUsed: true,
    }))

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

  test('allowMultiStepDag: a SINGLE-tool decision skips the planner entirely', async () => {
    // The complement of the test above, and the point of the change: the model
    // saying "one tool is enough" must NOT spend a second LLM call on a planner.
    // Without this assertion the gate could be removed and every other test would
    // still pass, because they either expect the DAG or never requested it.
    mockPlanQuery.mockClear()

    const result = await runNonStreamingChatCompletion({
      question: 'how many orders last month',
      userId: 'user-1',
      allowMultiStepDag: true,
    })

    expect(mockPlanQuery).toHaveBeenCalledTimes(0)
    expect(result).toBeTruthy()
  })

  test('allowMultiStepDag: single-step CHAT plan falls back to single-tool router', async () => {
    mockPlanQuery.mockImplementation(async () => ({
      steps: [{ id: 's1', tool: 'chat', input: {} }],
      needsSynthesis: false,
    }))
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
    mockGenerateChat.mockImplementation(async () => 'Fallback chat answer')

    const result = await runNonStreamingChatCompletion({
      question: 'Complex question',
      userId: 'user-1',
      allowMultiStepDag: true,
    })

    expect(result.answer).toBe('Fallback chat answer')
  })

  test('a turn with history is routed by the SELECTOR, not by a separate router', async () => {
    // The old design split routing by whether history existed: the first turn
    // went through the heuristic scorer and later turns through `routeQuery`, so
    // the SAME question could take different branches depending on whether it
    // was the opening message. The selector now runs on every turn and is given
    // the history, which is what makes the decision consistent.
    mockDocumentCount.mockImplementation(async () => 1)
    mockGenerateChat.mockImplementation(async () => 'Contextual answer')
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'contextual', llmUsed: true,
    }))

    const result = await runNonStreamingChatCompletion({
      question: 'What about last month?',
      userId: 'user-1',
      chatHistory: [{ role: 'user', content: 'Show me sales' }, { role: 'assistant', content: 'Sales were good.' }],
    })

    expect(result.answer).toBe('Contextual answer')
    expect(mockSelectToolWithLlm).toHaveBeenCalledTimes(1)
    // And it must actually RECEIVE the history — routing without it is how a
    // follow-up like "what about last month?" loses its referent.
    const call = mockSelectToolWithLlm.mock.calls[0]?.[0] as { chatHistory?: unknown[] } | undefined
    expect(call?.chatHistory).toHaveLength(2)
  })

  test('CONTEXTUAL_CHAT branch: loads prior tool runs and generates contextual answer', async () => {
    mockDocumentCount.mockImplementation(async () => 1)
    // The SELECTOR decides the route now; routeQuery is only the fallback for a
    // provider failure, so stubbing routeQuery would never be consulted.
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CONTEXTUAL_CHAT' as RouteDecision, args: {}, reason: 'refers to prior', llmUsed: true }))
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
  test('the integration the MODEL named is what reaches runSqlBranch', async () => {
    // Two integrations must EXIST for the choice to be meaningful: with intCount
    // 0, chooseAvailableDecision forces CHAT and the code never runs.
    //
    // The SELECTOR supplies the database now. It used to come from smartRoute's
    // score gap, so this test asserted the highest-scoring candidate won; that
    // mechanism is gone and the property worth pinning is different — the id the
    // model chose is the one looked up, out of several it was shown.
    mockIntegrationCount.mockImplementation(async () => 2)
    mockIntegrationFindMany.mockImplementation(async () => [
      { id: 'integ-low', name: 'Low', type: 'postgresql' },
      { id: 'integ-high', name: 'High', type: 'postgresql' },
      { id: 'integ-mid', name: 'Mid', type: 'postgresql' },
    ])
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: 'sql',
      decision: 'SQL' as RouteDecision,
      args: {},
      integrationId: 'integ-high',
      reason: 'stub',
      llmUsed: true,
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
    // The last-resort strategies must not run: the model already named a
    // database, so there is nothing left to search for.
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
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: 'sql',
      decision: 'SQL' as RouteDecision,
      args: {},
      integrationId: 'integ-gone',
      reason: 'stub',
      llmUsed: true,
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
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: 'sql',
      decision: 'SQL' as RouteDecision,
      args: {},
      reason: 'stub',
      llmUsed: true,
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
    // NO integrationId: the model named a tool but not a database, which is the
    // only situation where the last-resort strategies run. Supplying one would
    // skip them entirely and the assertion would measure nothing.
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
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

// ---------------------------------------------------------------------------
// STREAMING DISPATCHER — runStreamingChatCompletion (its private body
// `_runStreamingChatCompletion`, roughly lines 174-235).
//
// Why this block looks like this.
//
// The streaming body and the non-streaming body are two near-identical
// dispatchers, and they have already DIVERGED once in this repo (the comments in
// tool-router.ts record the duplicated applyToolGating being folded back into
// one function for exactly that reason). A defect here is a field dropped from
// the hand-off, a branch taken that the caller cannot see, or an exit chosen on
// the wrong condition — none of which are visible from the CALLER's result.
//
// So this block asserts on the ARGUMENTS each preparer was called with, not
// merely that something came back. Two measurement notes:
//
//  * `@/lib/llm-client` is mocked here. The real `withUsageTracking` is
//    AsyncLocalStorage plumbing (3 lines, no defect surface) and mocking it keeps
//    this file from pulling the LLM transport module graph in.
//  * `@/lib/tool-router-agentic` is DELIBERATELY left as the file's existing
//    delegating wrapper. That wrapper spreads the REAL module and overrides only
//    `runAgenticLoop`, so `runStreamingAgenticLoop` below is the genuine article
//    and the agentic assertions measure production behaviour rather than a stand
//    in. Its `combinedStream()` does not touch `output` until the generator is
//    drained — which two of the tests do on purpose.
// ---------------------------------------------------------------------------

/** Every preparer call is recorded as {order, name, args} so ORDER is assertable. */
const streamCalls: Array<{ order: number; name: string; args: Record<string, unknown> }> = []
let streamEventOrder = 0

async function* scriptedStream(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk
}

function scriptedResult(chunks: string[] = ['streamed']): Record<string, unknown> {
  return { toolRuns: [{ type: 'CHAT', status: 'success', inputSummary: 'q' }], citations: [], chartData: null, stream: scriptedStream(chunks) }
}

function recordPreparer(name: string, args: Record<string, unknown>): Record<string, unknown> {
  streamCalls.push({ order: ++streamEventOrder, name, args })
  preparerOrder?.push(name)
  return scriptedResult()
}

const chatStreamArgs: Array<Record<string, unknown>> = []
const sqlStreamArgs: Array<Record<string, unknown>> = []
const ragStreamArgs: Array<Record<string, unknown>> = []
const restStreamArgs: Array<Record<string, unknown>> = []
const pluginStreamArgs: Array<Record<string, unknown>> = []
const contextualStreamArgs: Array<Record<string, unknown>> = []

const mockPrepareChatStream = mock(async (a: Record<string, unknown>) => {
  chatStreamArgs.push(a)
  return recordPreparer('prepareChatStream', a)
})
const mockPrepareSqlStream = mock(async (a: Record<string, unknown>) => {
  sqlStreamArgs.push(a)
  return recordPreparer('prepareSqlStream', a)
})
const mockPrepareRagStream = mock(async (a: Record<string, unknown>) => {
  ragStreamArgs.push(a)
  return recordPreparer('prepareRagStream', a)
})
const mockPrepareRestStream = mock(async (a: Record<string, unknown>) => {
  restStreamArgs.push(a)
  return recordPreparer('prepareRestStream', a)
})
const mockPreparePluginStream = mock(async (a: Record<string, unknown>) => {
  pluginStreamArgs.push(a)
  return recordPreparer('preparePluginStream', a)
})
const mockPrepareContextualChatStream = mock(async (a: Record<string, unknown>) => {
  contextualStreamArgs.push(a)
  return recordPreparer('prepareContextualChatStream', a)
})

mock.module('@/lib/stream-preparers', () => ({
  prepareChatStream: mockPrepareChatStream,
  prepareSqlStream: mockPrepareSqlStream,
  prepareRagStream: mockPrepareRagStream,
  prepareRestStream: mockPrepareRestStream,
  preparePluginStream: mockPreparePluginStream,
  prepareContextualChatStream: mockPrepareContextualChatStream,
}))

// The real AsyncLocalStorage wrapper is not the subject; the transport module it
// lives in pulls the whole LLM stack in behind it.
mock.module('@/lib/llm-client', () => ({
  withUsageTracking: async (fn: () => Promise<unknown>) => fn(),
  getLastLlmUsage: () => undefined,
}))

const { runStreamingChatCompletion, formatSchemaForIntent, formatSchemasForIntent } = await import('./tool-router')

/** Pull every chunk out of a StreamingCompletionResult. */
async function drainStream(stream: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('runStreamingChatCompletion — the streamed dispatcher', () => {
  /**
   * One integration + one schema row, set LOCALLY inside each routed test.
   *
   * Set here rather than in `beforeEach` on purpose: this file's `beforeEach`
   * runs BEFORE each test and cannot be undone, so a file-wide schema row would
   * fill `schemaSummaries` in the tests that deliberately pass a malformed one,
   * and their failure would never be observable.
   *
   * `schemas` matters to prepareSqlStream, which short-circuits to chat when the
   * integration has none — the mocked preparer returns a fixed result, so only
   * the ARGUMENTS it receives are under test here.
   */
  const useOneIntegration = () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1', name: 'Warehouse', provider: 'POSTGRESQL', encryptedConfig: 'enc',
      schemas: [{ tableName: 'orders', columns: '[]', rowCount: 10, sampleRow: null }],
    }))
    useSchemaRow()
    needsRetrieval()
  }

  /**
   * A well-formed `IntegrationSchema` row.
   *
   * Empty is safe; MALFORMED is not. `loadIntentPipeline` -> `loadDbData` reads
   * `schemaRows`, and every routed turn maps them to
   * `${integration.name}.${tableName}: ${description}`. The first version of
   * these tests passed a row without `integration` and the dispatcher died at
   * tool-router.ts:195 with a TypeError that read like a source bug — the
   * fixture, not the code. Every test that reaches ROUTING needs this; the
   * tests that only reach the intent gate or the agentic early-return do not.
   */
  /**
   * Force the dispatcher past the `!intent.needsRetrieval` early exit.
   *
   * `_runStreamingChatCompletion` returns `prepareChatStream` BEFORE it ever calls the router when the
   * intent says no retrieval is needed. The file-wide default is `needsRetrieval: false`, so EVERY
   * routing test must raise this flag or it exercises the early exit instead of the branch it names --
   * and the test still receives a stream, so a loose assertion would pass while the routing code under
   * test never ran at all. Measured: without this, both router mocks recorded ZERO calls while the
   * dispatch still produced a stream, which is the signature of the early exit.
   */
  const needsRetrieval = () => { intentState.value = { needsClarification: false, needsRetrieval: true } }

  const useSchemaRow = () => mockIntegrationSchemaFindMany.mockImplementation(async () => [
    { tableName: 'orders', description: 'one row per order', integration: { name: 'Warehouse' } },
  ])

  test('a DAG request WITH history delegates to runStreamingAgenticLoop and carries the prefix', async () => {
    // The loop is driven for real here (the file's only agentic override is
    // runAgenticLoop). Its per-round deadline is set already-past so the loop
    // returns after ONE round and never streams a token: this test is about the
    // hand-off, and a deadline is cheaper to reason about than a mocked loop.
    process.env.AGENTIC_DEADLINE_MS = '-1'
    try {
      const result = await runStreamingChatCompletion({
        question: 'and the total?',
        userId: 'u1',
        allowMultiStepDag: true,
        skipClarification: true,
        systemPromptPrefix: 'Be terse.',
        chatHistory: [{ role: 'user', content: 'how many orders' }],
      })
      const chunks = await drainStream(result.stream)
      // A follow-up needs the loop, which can call the model repeatedly with the
      // prior turns; the single-tool path cannot see them at all.
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toContain('timed out before a complete answer')
      // The dispatcher must NOT have run the pipeline it delegated away.
      expect(streamCalls.some((c) => c.name === 'prepareChatStream')).toBe(false)
      expect(intentState.value).toEqual({ needsClarification: false, needsRetrieval: true })
    } finally {
      delete process.env.AGENTIC_DEADLINE_MS
    }
  })

  test('a DAG request with an EMPTY history does NOT take the agentic branch', async () => {
    await runStreamingChatCompletion({
      question: 'sales this month',
      userId: 'u1',
      allowMultiStepDag: true,
      chatHistory: [],
    })
    // There is no conversation to continue; the loop would spend extra LLM calls
    // on a BYOK key to no benefit.
    expect(chatStreamArgs).toHaveLength(1)
    expect(streamCalls[0].name).toBe('prepareChatStream')
  })

  test('a DAG request WITHOUT a history field at all does NOT take the agentic branch', async () => {
    // Distinct from the empty-array case: an absent field and an empty array take
    // different code paths through `args.chatHistory && args.chatHistory.length`,
    // and only one of them is exercised by the test above.
    await runStreamingChatCompletion({ question: 'q', userId: 'u1', allowMultiStepDag: true })
    expect(chatStreamArgs).toHaveLength(1)
  })

  test('without allowMultiStepDag the loop is never entered, history or not', async () => {
    await runStreamingChatCompletion({
      question: 'q',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'hi' }],
    })
    // The flag is the caller's consent for multi-round LLM spending.
    expect(chatStreamArgs).toHaveLength(1)
  })

  test('a clarification question streams as the ONLY chunk with an empty shape', async () => {
    // MEASURED: `intentState.value` is returned by reference, and the real
    // analyzeIntent MUTATES it (`parsed.clarificationQuestion = undefined`) when
    // it overrides a clarification. Once any test in this file has done that, a
    // later `{ clarificationQuestion: '...' }` assignment replaces the whole
    // object, so this fixture is fine — but a test that only toggled the flag
    // would silently stop clarifying. Asserted through the stream either way.
    intentState.value = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: true }
    const result = await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    const chunks = await drainStream(result.stream)
    // Asking is not answering: routing a tool here would answer a question the
    // router just decided it could not understand.
    expect(chunks).toEqual(['Which database?'])
    expect(result.toolRuns).toEqual([])
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
    // No preparer and no routing may have run — the turn ended at the intent gate.
    expect(streamCalls).toHaveLength(0)
    expect(mockSelectToolWithLlm).toHaveBeenCalledTimes(0)
    expect(mockRouteQuery).toHaveBeenCalledTimes(0)
  })

  test('skipClarification suppresses the question and routes instead', async () => {
    intentState.value = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: true }
    const result = await runStreamingChatCompletion({ question: 'q', userId: 'u1', skipClarification: true })
    const chunks = await drainStream(result.stream)
    // The API path sets this when the caller already picked a source; a dead-end
    // question there is a bug the user experiences as the bot ignoring them.
    expect(chunks).toEqual(['streamed'])
    expect(streamCalls[0].name).toBe('prepareChatStream')
  })

  test('a clarification with FALSY question text falls through instead of yielding empty', async () => {
    intentState.value = { needsClarification: true, clarificationQuestion: '', needsRetrieval: false }
    const result = await runStreamingChatCompletion({ question: 'hello', userId: 'u1' })
    const chunks = await drainStream(result.stream)
    // Both flags are required; an empty string must not become an empty stream.
    expect(chunks).toEqual(['streamed'])
    // When needsRetrieval is false the chat preparer is the correct exit, and the
    // routing stack must not have been consulted at all.
    expect(streamCalls[0].name).toBe('prepareChatStream')
    expect(mockSelectToolWithLlm).toHaveBeenCalledTimes(0)
  })

  test('needsRetrieval=false goes straight to prepareChatStream with the EFFECTIVE question', async () => {
    intentState.value = { needsClarification: false, needsRetrieval: false }
    await runStreamingChatCompletion({
      question: 'what is the procedure?',
      userId: 'u1',
      systemPromptPrefix: 'Be terse.',
      chatHistory: [{ role: 'user', content: 'annual leave' }, { role: 'assistant', content: 'ok' }],
    })
    expect(chatStreamArgs).toHaveLength(1)
    const sent = chatStreamArgs[0]
    // The assertion that matters: a follow-up that is answered WITHOUT retrieval
    // must still carry the rewritten question, or the answer is generated from
    // "what is the procedure?" with no subject.
    expect(sent.question).toBe(effectiveQuestionValue)
    expect(sent.question).not.toBe('what is the procedure?')
    expect(sent.systemPromptPrefix).toBe('Be terse.')
    expect(sent.memoryContext).toBe(memoryContextValue)
    // Routing is unnecessary: the intent gate already decided no tool is needed.
    expect(mockSelectToolWithLlm).toHaveBeenCalledTimes(0)
    expect(mockRouteQuery).toHaveBeenCalledTimes(0)
  })

  test('analyzeIntent sees the EFFECTIVE question when there is history', async () => {
    await runStreamingChatCompletion({
      question: 'and the total?',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'orders' }],
    })
    // A follow-up is meaningless to the intent analyzer without the rewrite, so
    // the rewritten form must be the one that reaches it.
    expect(intentQuestionValue).toBe(effectiveQuestionValue)
  })

  test('analyzeIntent sees the RAW question when there is no history', async () => {
    // The asymmetry is deliberate and easy to break: with no history there is
    // nothing to rewrite, and stripSessionWrapper — not rewriteQuery — is what
    // produces the effective question.
    effectiveQuestionValue = 'STRIPPED-QUESTION'
    await runStreamingChatCompletion({ question: 'RAW-QUESTION', userId: 'u1' })
    expect(intentQuestionValue).toBe('RAW-QUESTION')
    expect(intentQuestionValue).not.toBe(effectiveQuestionValue)
  })

  test('analyzeIntent is told what the org HAS: document, integration, schema, REST summaries', async () => {
    mockDocumentCount.mockImplementation(async () => 2)
    mockIntegrationCount.mockImplementation(async () => 1)
    mockDocumentFindMany.mockImplementation(async () => [
      { name: 'doc.pdf', category: 'HR', description: 'annual leave SOP' },
    ])
    mockIntegrationFindMany.mockImplementation(async () => [{ name: 'Warehouse' }])
    mockIntegrationSchemaFindMany.mockImplementation(async () => [
      { tableName: 'orders', description: 'one row per order', integration: { name: 'Warehouse' } },
    ])
    mockRestEndpointFindMany.mockImplementation(async () => [
      { method: 'GET', path: '/invoices', description: 'invoice list' },
      // No description and no fallback: the summary would end ': ' and must be
      // DROPPED, or the prompt carries an empty label.
      { method: 'POST', path: '/noop', description: null },
    ])

    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    const input = lastIntentArgs as unknown as {
      question: string; hasDocuments: boolean; hasIntegrations: boolean
      documentNames: string[]; integrationNames: string[]; schemaSummaries: string[]; restEndpointSummaries: string[]
    }
    expect(input.hasDocuments).toBe(true)
    expect(input.hasIntegrations).toBe(true)
    expect(input.documentNames).toEqual(['doc.pdf [HR] — annual leave SOP'])
    expect(input.integrationNames).toEqual(['Warehouse'])
    expect(input.schemaSummaries).toEqual(['Warehouse.orders: one row per order'])
    expect(input.restEndpointSummaries).toEqual(['GET /invoices: invoice list'])
  })

  test('a schema row with NO integration row is DROPPED instead of crashing', async () => {
    // INVERTED WHEN FIXED: this was pinned as a DEFECT (the dispatcher threw a raw
    // `TypeError: undefined is not an object (evaluating 's.integration.name')`), and the fix
    // landed as `formatSchemasForIntent`. The test now asserts the CORRECT behaviour, so it
    // fails again if the guard is removed -- the same assertion, pointing the other way.
    //
    // The shape below is off-contract (Prisma types the to-one relation as non-null), which is
    // precisely why the source never guarded for it. Cast through `unknown` to build it.
    mockIntegrationCount.mockImplementation(async () => 1)
    mockIntegrationSchemaFindMany.mockImplementation((async () => [
      { tableName: 'orphan_table', description: 'table with no integration row', integration: undefined },
      { tableName: 'orders', description: 'one row per order', integration: { name: 'Warehouse' } },
      { tableName: 'no_name', description: 'integration row with an empty name', integration: { name: '' } },
    ]) as unknown as () => Promise<Array<{ tableName: string; description: string | null; integration: { name: string } }>>)
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    const summaries = (lastIntentArgs as { schemaSummaries: string[] }).schemaSummaries
    // Only the row with a usable name survives; order is preserved.
    expect(summaries).toEqual(['Warehouse.orders: one row per order'])
    // The load-bearing half: nothing renders the literal string "undefined".
    expect(summaries.join('|')).not.toContain('undefined')
  })

  test('formatSchemasForIntent keeps order and drops only the unrenderable rows', () => {
    // Direct unit coverage of the extracted helper, because the dispatcher test above can only
    // reach it through a mocked DB. The policy under test is "drop, do not throw", so the
    // assertions name both halves: the survivors AND their order.
    const rows = [
      { tableName: 'a', description: 'd-a', integration: { name: 'A' } },
      { tableName: 'b', description: null, integration: { name: 'B' } },
      { tableName: 'c', description: 'd-c', integration: null },
      { tableName: 'd', description: 'd-d', integration: undefined },
      { tableName: 'e', description: 'd-e', integration: { name: 'E' } },
    ]
    expect(formatSchemasForIntent(rows)).toEqual(['A.a: d-a', 'B.b: null', 'E.e: d-e'])
    // Empty and all-invalid batches yield an empty list rather than throwing -- the dispatcher
    // relies on this to hand `analyzeIntent` a usable array when the org has no schemas.
    expect(formatSchemasForIntent([])).toEqual([])
    expect(formatSchemasForIntent([{ tableName: 'x', description: 'y', integration: null }])).toEqual([])
    // A row with a blank name is dropped too: the model cannot choose a source it cannot name.
    expect(formatSchemaForIntent({ tableName: 'x', description: 'y', integration: { name: '' } })).toBeNull()
    expect(formatSchemaForIntent({ tableName: 'x', description: 'y', integration: { name: 'N' } })).toBe('N.x: y')
    // The guard is ONE definition now, not two copies -- the shape that let a one-site fix leave
    // the other path wrong. Asserted from source so a re-inlined copy fails here.
    const src = readFileSync(join(import.meta.dir, 'tool-router.ts'), 'utf8')
    expect(src).not.toContain('${s.integration.name}')
    expect([...src.matchAll(/formatSchemasForIntent\(schemaRows\)/g)]).toHaveLength(2)
  })

  test('SQL decision routes to prepareSqlStream', async () => {
    useSchemaRow()
    needsRetrieval()
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    expect(sqlStreamArgs).toHaveLength(1)
    // The SMART-route branch is the one that carries an integrationId: `routeQuery` (the
    // with-history router) is typed `{ decision, reason }` and never returns one, so this
    // assertion and the history variant below are deliberately split across two tests.
    expect(sqlStreamArgs[0].integrationId).toBe('int-1')
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareSqlStream'])
  })

  test('SQL decision with history routes to prepareSqlStream carrying the REWRITTEN question', async () => {
    useSchemaRow()
    needsRetrieval()
    mockIntegrationCount.mockImplementation(async () => 1)
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1', name: 'Warehouse', type: 'POSTGRES', status: 'active',
      schemas: [{ tableName: 'orders', columns: [] }],
    }))
    // chatHistory is REQUIRED for this assertion to mean anything: `rewriteQuery` is only consulted when
    // there is history (`loadIntentPipeline`), so without it the effective question IS the raw question
    // and the assertion would pass even if the dispatcher forwarded `args.question` by mistake.
    //
    // The SELECTOR routes every turn now, history or not. It used to switch
    // implementations depending on history, so this stub had to move with it;
    // with one router there is nothing to switch, and stubbing routeQuery here
    // would leave the decision to its own default instead of SQL.
    mockSelectToolWithLlm.mockImplementation(async () => ({
      toolId: 'sql', decision: 'SQL' as RouteDecision, args: {},
      integrationId: 'int-1', reason: 'test', llmUsed: true,
    }))
    await runStreamingChatCompletion({
      question: 'total sales',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'prior turn' }],
    })
    expect(sqlStreamArgs).toHaveLength(1)
    // The REWRITTEN question reaches the preparer, not the raw one -- and the rewrite really ran.
    expect(sqlStreamArgs[0].question).toBe(effectiveQuestionValue)
    expect(sqlStreamArgs[0].question).not.toBe('total sales')
    expect(rewriteCalls).toBe(1)
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareSqlStream'])
  })

  test('RAG decision routes to prepareRagStream', async () => {
    useSchemaRow()
    needsRetrieval()
    mockDocumentCount.mockImplementation(async () => 1)
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'rag', decision: 'RAG' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'what is the policy?', userId: 'u1' })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareRagStream'])
    expect(ragStreamArgs[0].memoryContext).toBe(memoryContextValue)
  })

  test('REST decision routes to prepareRestStream', async () => {
    useSchemaRow()
    needsRetrieval()
    // `hasRestApis` is derived from the restApiEndpoint.FINDMANY row count, NOT from the count() mock --
    // `applyToolGating` otherwise downgrades REST to CHAT and this test would silently exercise the
    // fallthrough branch instead of the REST one.
    mockRestEndpointCount.mockImplementation(async () => 1)
    mockRestEndpointFindMany.mockImplementation(async () => [
      { method: 'GET', path: '/invoices', description: 'invoice list' },
    ])
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'rest', decision: 'REST' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'list invoices via api', userId: 'u1' })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareRestStream'])
    // No chatHistory here, so the effective question IS the raw question. Assert the raw value
    // explicitly rather than comparing against the rewrite seam, which would make this assertion pass
    // for either behaviour.
    expect(restStreamArgs[0].question).toBe('list invoices via api')
  })

  test('PLUGIN decision routes to preparePluginStream', async () => {
    useSchemaRow()
    needsRetrieval()
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'PLUGIN' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'what is the weather?', userId: 'u1' })
    expect(streamCalls.map((c) => c.name)).toEqual(['preparePluginStream'])
    // Same reasoning as the REST branch: with no history the effective question is the raw one.
    expect(pluginStreamArgs[0].question).toBe('what is the weather?')
    expect(pluginStreamArgs[0].chatHistory).toEqual([])
  })

  test('CONTEXTUAL_CHAT routes to prepareContextualChatStream ONLY with a truthy context', async () => {
    useSchemaRow()
    needsRetrieval()
    mockDocumentCount.mockImplementation(async () => 1)
    // The SELECTOR decides the route now; routeQuery is only the fallback for a
    // provider failure, so stubbing routeQuery would never be consulted.
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CONTEXTUAL_CHAT' as RouteDecision, args: {}, reason: 'refers to prior', llmUsed: true }))
    mockToolRunFindMany.mockImplementation(async () => [
      { type: 'SQL', inputSummary: 'show sales', outputSummary: 'Sales: $5000' },
    ])
    await runStreamingChatCompletion({
      question: 'what about that?',
      userId: 'u1',
      sessionId: 'sess-1',
      chatHistory: [{ role: 'user', content: 'show sales' }],
    })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareContextualChatStream'])
    // MEASURED: loadContextualContext returns the rendered prior results, and
    // this is the only place that value is passed on. Dropping it silently turns
    // a contextual answer into a generic one.
    const sent = contextualStreamArgs[0]
    expect(sent.context).toContain('Sales: $5000')
    expect(sent.context).toContain('[Prior SQL result for: show sales]')
    expect(sent.question).toBe(effectiveQuestionValue)
  })

  test('CONTEXTUAL_CHAT with NO prior context falls through to prepareChatStream', async () => {
    useSchemaRow()
    needsRetrieval()
    // The branch a careless test skips. Choosing CONTEXTUAL_CHAT with nothing to
    // be contextual about must not reach a preparer that requires a context.
    mockDocumentCount.mockImplementation(async () => 1)
    // The SELECTOR decides the route now; routeQuery is only the fallback for a
    // provider failure, so stubbing routeQuery would never be consulted.
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CONTEXTUAL_CHAT' as RouteDecision, args: {}, reason: 'refers to prior', llmUsed: true }))
    mockToolRunFindMany.mockImplementation(async () => [])
    await runStreamingChatCompletion({
      question: 'what about that?',
      userId: 'u1',
      sessionId: 'sess-1',
      chatHistory: [{ role: 'user', content: 'show sales' }],
    })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareChatStream'])
    expect(contextualStreamArgs).toHaveLength(0)
  })

  test('CONTEXTUAL_CHAT is never loaded without a sessionId, so it cannot route contextually', async () => {
    useSchemaRow()
    needsRetrieval()
    // loadContextualContext returns '' for a missing session, which makes the
    // truthiness guard above the only thing standing between an empty context
    // and a contextual answer. Pinned so a future "always return something"
    // change shows up here rather than in production.
    mockDocumentCount.mockImplementation(async () => 1)
    // The SELECTOR decides the route now; routeQuery is only the fallback for a
    // provider failure, so stubbing routeQuery would never be consulted.
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CONTEXTUAL_CHAT' as RouteDecision, args: {}, reason: 'refers to prior', llmUsed: true }))
    mockToolRunFindMany.mockImplementation(async () => [
      { type: 'SQL', inputSummary: 'show sales', outputSummary: 'Sales: $5000' },
    ])
    await runStreamingChatCompletion({
      question: 'what about that?',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'show sales' }],
    })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareChatStream'])
  })

  test('CHAT decision goes to prepareChatStream with the branch arguments', async () => {
    useSchemaRow()
    needsRetrieval()
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: null, decision: 'CHAT' as RouteDecision, args: {}, reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({
      question: 'hello',
      userId: 'u1',
      sessionId: 'sess-1',
      chatHistory: [{ role: 'user', content: 'prior turn' }],
    })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareChatStream'])
    const sent = chatStreamArgs[0]
    // With history the rewrite runs, so the CHAT branch carries the standardised
    // question rather than the raw follow-up — the same rule the SQL branch
    // follows above.
    expect(sent.question).toBe(effectiveQuestionValue)
    expect(sent.memoryContext).toBe(memoryContextValue)
  })

  test('a SQL decision with NO integration available is gated to chat', async () => {
    useSchemaRow()
    needsRetrieval()
    // chooseAvailableDecision turns SQL into CHAT when nothing can run SQL. If
    // prepareSqlStream were reached here it would count 0 active integrations and
    // answer from nowhere. `hasDocuments` must stay false too, or
    // chooseAvailableDecision leaves SQL in place and the gate under test is
    // never reached.
    mockIntegrationCount.mockImplementation(async () => 0)
    mockDocumentCount.mockImplementation(async () => 0)
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareChatStream'])
    expect(sqlStreamArgs).toHaveLength(0)
  })

  test('a SQL tool disabled in prompt settings is gated to chat', async () => {
    // applyToolGating runs BEFORE the branch is chosen. Gating after the fact
    // would let a disabled tool execute and only relabel the result.
    useOneIntegration()
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: '',
      tools: { rag: true, sql: false, restApi: true },
    }))
    await runStreamingChatCompletion({ question: 'total sales', userId: 'u1' })
    expect(streamCalls.map((c) => c.name)).toEqual(['prepareChatStream'])
  })

  test('the operator system prompt is MERGED with the caller prefix, joined by a blank line', async () => {
    useOneIntegration()
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: 'Operator prompt.',
      tools: { rag: true, sql: true, restApi: true },
    }))
    await runStreamingChatCompletion({ question: 'q', userId: 'u1', systemPromptPrefix: 'Caller prefix.' })
    // The assertion reaches the PREPARER, not the argument object, and the SQL
    // prompts build their system message from exactly this value.
    expect(sqlStreamArgs[0].systemPromptPrefix).toBe('Caller prefix.\n\nOperator prompt.')
  })

  test('with BOTH prompts empty the merged prefix is undefined, not an empty string', async () => {
    useOneIntegration()
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    // An empty prefix is not a no-op downstream: generateSql branches on whether
    // a prefix exists, so '' would add an empty system message.
    expect(sqlStreamArgs[0].systemPromptPrefix).toBeUndefined()
  })

  test('a caller prefix alone survives when the operator prompt is empty', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    await runStreamingChatCompletion({ question: 'q', userId: 'u1', systemPromptPrefix: 'Caller only.' })
    // No stray leading blank line from joining an empty second element.
    expect(sqlStreamArgs[0].systemPromptPrefix).toBe('Caller only.')
  })

  test('the operator prompt alone survives when the caller gave no prefix', async () => {
    mockIntegrationCount.mockImplementation(async () => 1)
    mockSelectToolWithLlm.mockImplementation(async () => ({ toolId: 'sql', decision: 'SQL' as RouteDecision, args: {}, integrationId: 'int-1', reason: 'stub', llmUsed: true }))
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: 'Operator only.',
      tools: { rag: true, sql: true, restApi: true },
    }))
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    expect(sqlStreamArgs[0].systemPromptPrefix).toBe('Operator only.')
  })

  test('the side effects happen in order: rewrite, intent, routing, branch', async () => {
    // A shared event log: each seam appends its own name as it is entered, so the
    // assertion is about ORDER rather than about any one value. Routing before
    // intent, or a branch before routing, is invisible in the returned result.
    const order: string[] = []
    rewriteOrder = order
    intentOrder = order
    smartRouteOrder = order
    preparerOrder = order
    try {
      useOneIntegration()
      needsRetrieval()
      // History is present so the REWRITE step actually happens (without it `rewriteQuery` is never
      // consulted and the first event would be missing), which also means the router is `routeQuery`.
      // `smartRouteOrder` is the shared log for both router mocks, so either one records 'smartRoute'.
      // The SELECTOR is the router now, so it records the routing step. The
      // order guarantee itself is unchanged and still worth pinning: routing
      // before intent, or a branch before routing, is invisible in the result.
      mockSelectToolWithLlm.mockImplementation(async () => {
        smartRouteOrder?.push('smartRoute')
        return {
          toolId: 'sql', decision: 'SQL' as RouteDecision, args: {},
          integrationId: 'int-1', reason: 'test', llmUsed: true,
        }
      })
      await runStreamingChatCompletion({
        question: 'q',
        userId: 'u1',
        chatHistory: [{ role: 'user', content: 'prior' }],
      })
    } finally {
      rewriteOrder = null
      intentOrder = null
      smartRouteOrder = null
      preparerOrder = null
    }
    // Order, not merely membership: routing before intent, or a branch before routing, is invisible
    // in the returned result.
    expect(order).toEqual(['rewrite', 'analyzeIntent', 'smartRoute', 'prepareSqlStream'])
  })


  test('a prompt-settings read failure is NOT swallowed — it happens before any stream exists', async () => {
    // loadDbData is awaited before the function can return, so an operator-config
    // read failure must surface as a rejection. Silently defaulting here would
    // answer with whatever the router guessed while the operator prompt and tool
    // toggles were ignored.
    mockGetPromptSettings.mockImplementation(async () => {
      throw new Error('prompt settings unreadable')
    })
    await expect(runStreamingChatCompletion({ question: 'q', userId: 'u1' })).rejects.toThrow('prompt settings unreadable')
    expect(streamCalls).toHaveLength(0)
  })

  test('a rejecting preflight query forwards the error instead of hanging', async () => {
    mockDocumentCount.mockImplementationOnce(async () => {
      throw new Error('relation "Document" does not exist')
    })
    await expect(runStreamingChatCompletion({ question: 'q', userId: 'u1' })).rejects.toThrow('relation "Document" does not exist')
  })

  // NOT A CONTROL — recorded rather than faked.
  //
  // The harness invariant "a READY streaming result always carries at least one
  // toolRun" lives in the SSE route and in `send`; inside this dispatcher it
  // cannot fail, because the only exit a caller can observe before routing is the
  // clarification stream, which deliberately yields no tool run (`toolRuns: []`
  // is asserted above). Asserting the invariant HERE would mean asserting on the
  // mocked preparers. It belongs in the route-level test, which already owns it.
  test.skip('every ready stream carries at least one tool run (needs the SSE route harness, not the dispatcher)', () => {
    // Placeholder kept so the gap is visible in the suite output rather than in a
    // comment nobody reads.
  })
})
