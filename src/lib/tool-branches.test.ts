import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { RetrievedChunk } from './rag'

// --- Mocks (must be before imports of modules under test) ---

const mockRetrieveWithReflection = mock(async (): Promise<unknown> => ({
  chunks: [] as RetrievedChunk[],
  queryTokens: [] as string[],
  candidatesScanned: 0,
  graphContext: '',
  retrievalPasses: 1,
  reflection: { sufficient: true, reason: 'mock', confidence: 1 },
  citationTrail: undefined as string[] | undefined,
}))
const mockGenerateAnswer = mock(async (): Promise<string> => 'mock-answer')
const mockGenerateSql = mock(async (): Promise<{ sql: string; explanation: string }> => ({ sql: 'SELECT 1 LIMIT 100', explanation: 'x' }))
const mockGetPromptSettings = mock(async (): Promise<unknown> => ({
  systemPrompt: '',
  ragContextPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}))
const mockDocumentFindMany = mock(async (): Promise<unknown> => [])
const mockIntegrationFindFirst = mock(async (): Promise<unknown> => null)
// Single active integration keeps the disambiguation path out of these tests;
// the ambiguity behaviour has its own tests in integration-selection.test.ts.
const mockIntegrationFindMany = mock(async (): Promise<unknown> => [{ name: 'Only Source' }])
const mockConnectorExecuteQuery = mock(async (): Promise<unknown> => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 1 }))
const mockValidateSql = mock((): unknown => ({ ok: true, sanitized: 'SELECT 1 LIMIT 100' }))
const mockAuditLogCreate = mock(async () => ({}))
const mockQueryHistoryCreate = mock(async () => ({}))

mock.module('@/lib/db', () => ({
  db: {
    document: { findMany: mockDocumentFindMany },
    integration: { findFirst: mockIntegrationFindFirst, findMany: mockIntegrationFindMany },
    auditLog: { create: mockAuditLogCreate },
    queryHistory: { create: mockQueryHistoryCreate },
  },
}))
mock.module('@/lib/intent-pipeline', () => ({ retrieveWithReflection: mockRetrieveWithReflection }))
mock.module('@/lib/prompt-settings', () => ({ getPromptSettings: mockGetPromptSettings }))
mock.module('@/lib/ai', () => ({
  generateAnswer: mockGenerateAnswer,
  generateSql: mockGenerateSql,
  generateChat: mock(async () => 'chat'),
  generateRestCall: mock(async () => ({ endpointId: 'x', query: {}, explanation: '', body: null })),
}))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: () => ({ executeQuery: mockConnectorExecuteQuery }) },
  describeSchema: mock(() => 'schema'),
}))
mock.module('@/lib/guardrails', () => ({ validateAndSanitizeLlmSql: mockValidateSql }))
mock.module('@/lib/crypto', () => ({ decryptConfig: mock(() => ({})) }))
mock.module('@/lib/tool-utils', () => ({
  withSqlConcurrency: async (_id: string, fn: () => Promise<unknown>) => fn(),
  buildChartDataFromRows: () => null,
  buildDocumentCitation: (a: { documentName: string }) => ({ type: 'RAG', source: a.documentName, query_used: '' }),
  sanitizeSqlError: (s: string) => s,
  summarize: (s: string) => s.slice(0, 50),
  unavailableDataSourceResult: () => ({ answer: 'no data source', citations: [], chartData: null, toolRuns: [] }),
  safeParseColumns: () => [],
  safeParseSampleRow: () => null,
  extractTableName: () => 't',
  jsonRowsToChart: () => null,
  safeJson: () => null,
}))
mock.module('@/lib/tool-sandbox', () => ({ withToolSandbox: async (_k: string, fn: () => Promise<unknown>) => fn() }))
mock.module('@/lib/tool-rate-limit', () => ({ checkToolRateLimit: async () => ({ allowed: true }) }))
mock.module('@/lib/llm-client', () => ({ getLastLlmUsage: () => null }))
mock.module('@/lib/prisma-tenant', () => ({ getOrgContext: () => 'org-1' }))
mock.module('@/lib/plugin-selector', () => ({ selectRelevantPlugins: mock(async () => []) }))
mock.module('@/lib/plugin-registry', () => ({ executePlugin: mock(async () => ({ ok: true, output: '', error: null })) }))
mock.module('@/lib/rest-api-connectors', () => ({
  buildAuthHeaders: mock(async () => ({})),
  buildEndpointUrl: mock(() => 'http://x'),
  matchEndpoint: mock(() => ({ id: 'ep-1' })),
  sanitizeHeaders: mock(() => ({})),
}))

// --- Imports ---

import { runRagBranch, runSqlBranch } from './tool-branches'

// --- Helpers ---

function makeChunk(overrides: Partial<RetrievedChunk> & { chunkId: string }): RetrievedChunk {
  return {
    documentId: 'doc-1',
    documentName: 'doc.txt',
    chunkIndex: 0,
    content: 'C',
    score: 1,
    scoreBreakdown: { total: 1, lexicalTotal: 1, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 },
    ...overrides,
  }
}

// --- Setup ---

beforeEach(() => {
  mockRetrieveWithReflection.mockClear()
  mockGenerateAnswer.mockClear()
  mockGenerateSql.mockClear()
  mockGetPromptSettings.mockClear()
  mockDocumentFindMany.mockClear()
  mockIntegrationFindFirst.mockClear()
  mockValidateSql.mockClear()
  mockConnectorExecuteQuery.mockClear()
  mockAuditLogCreate.mockClear()
  mockQueryHistoryCreate.mockClear()
  // Reset default implementations so a prior test's overrides don't leak in.
  mockGetPromptSettings.mockImplementation(async () => ({
    systemPrompt: '',
    ragContextPrompt: '',
    tools: { rag: true, sql: true, restApi: true },
  }))
  mockGenerateAnswer.mockImplementation(async () => 'ans')
  mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT 1', explanation: 'x' }))
})

// --- Tests ---

describe('runRagBranch — source guidance injection', () => {
  test('prepends [Source guidance] when a contributing doc has a contextPrompt', async () => {
    mockRetrieveWithReflection.mockImplementation(async () => ({
      chunks: [makeChunk({ chunkId: 'c1', documentId: 'doc-a', documentName: 'doc-a.txt', score: 0.9 })],
      queryTokens: [],
      candidatesScanned: 1,
      graphContext: '',
      retrievalPasses: 1,
      reflection: { sufficient: true, reason: '', confidence: 1 },
      citationTrail: undefined,
    }))
    mockDocumentFindMany.mockImplementation(async () => [
      { id: 'doc-a', name: 'policy.pdf', contextPrompt: 'Treat figures as confidential.' },
    ])
    mockGenerateAnswer.mockImplementation(async () => 'ans')

    await runRagBranch({ question: 'q' })

    const ctxArg = (mockGenerateAnswer.mock.calls[0] as unknown as [{ context: string }])[0]
    expect(ctxArg.context).toContain('[Source guidance]')
    expect(ctxArg.context).toContain('Document "policy.pdf": Treat figures as confidential.')
  })

  test('injects org ragContextPrompt', async () => {
    mockRetrieveWithReflection.mockImplementation(async () => ({
      chunks: [makeChunk({ chunkId: 'c1', documentId: 'doc-a', score: 0.9 })],
      queryTokens: [],
      candidatesScanned: 1,
      graphContext: '',
      retrievalPasses: 1,
      reflection: { sufficient: true, reason: '', confidence: 1 },
      citationTrail: undefined,
    }))
    mockDocumentFindMany.mockImplementation(async () => [
      { id: 'doc-a', name: 'doc.txt', contextPrompt: null },
    ])
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: '',
      ragContextPrompt: 'Answer only from the cited documents.',
      tools: { rag: true, sql: true, restApi: true },
    }))
    await runRagBranch({ question: 'q' })

    const ctxArg = (mockGenerateAnswer.mock.calls[0] as unknown as [{ context: string }])[0]
    expect(ctxArg.context).toContain('[Source guidance]')
    expect(ctxArg.context).toContain('Answer only from the cited documents.')
  })

  test('injects nothing when no doc contextPrompts and no org prompt are set', async () => {
    mockRetrieveWithReflection.mockImplementation(async () => ({
      chunks: [makeChunk({ chunkId: 'c1', documentId: 'doc-a', score: 0.9 })],
      queryTokens: [],
      candidatesScanned: 1,
      graphContext: '',
      retrievalPasses: 1,
      reflection: { sufficient: true, reason: '', confidence: 1 },
      citationTrail: undefined,
    }))
    mockDocumentFindMany.mockImplementation(async () => [
      { id: 'doc-a', name: 'doc.txt', contextPrompt: '' },
    ])
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: '',
      ragContextPrompt: '',
      tools: { rag: true, sql: true, restApi: true },
    }))
    await runRagBranch({ question: 'q' })

    const ctxArg = (mockGenerateAnswer.mock.calls[0] as unknown as [{ context: string }])[0]
    expect(ctxArg.context).not.toContain('[Source guidance]')
  })
})

describe('runSqlBranch — integration contextPrompt injection', () => {
  test('appends Context guidance to generateSql and generateAnswer', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      organizationId: 'org-1',
      name: 'MyDB',
      type: 'DATABASE',
      provider: 'POSTGRESQL',
      encryptedConfig: 'cfg',
      status: 'active',
      businessContext: null,
      contextPrompt: 'All amounts are in IDR.',
      schemas: [{ id: 's1', tableName: 'users', columns: '[]', rowCount: 1, sampleRow: null, description: null, manualDescription: false }],
    }))
    mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT 1' }) as { ok: true; sanitized: string } | { ok: false; reason: string; detectedNodes: unknown[] })
    mockConnectorExecuteQuery.mockImplementation(async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 1 }))

    await runSqlBranch({ question: 'q', userId: 'u-1' })

    const sqlArg = (mockGenerateSql.mock.calls[0] as unknown as [{ systemPromptPrefix?: string }])[0]
    expect(sqlArg.systemPromptPrefix).toContain('Context guidance:')
    expect(sqlArg.systemPromptPrefix).toContain('All amounts are in IDR.')

    const answerArg = (mockGenerateAnswer.mock.calls[0] as unknown as [{ systemPromptPrefix?: string }])[0]
    expect(answerArg.systemPromptPrefix).toContain('Context guidance:')
    expect(answerArg.systemPromptPrefix).toContain('All amounts are in IDR.')
  })

  test('leaves prefix untouched when integration.contextPrompt is empty', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1',
      organizationId: 'org-1',
      name: 'MyDB',
      type: 'DATABASE',
      provider: 'POSTGRESQL',
      encryptedConfig: 'cfg',
      status: 'active',
      businessContext: null,
      contextPrompt: null,
      schemas: [{ id: 's1', tableName: 'users', columns: '[]', rowCount: 1, sampleRow: null, description: null, manualDescription: false }],
    }))
    mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT 1' }) as { ok: true; sanitized: string } | { ok: false; reason: string; detectedNodes: unknown[] })
    mockConnectorExecuteQuery.mockImplementation(async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 1 }))

    await runSqlBranch({ question: 'q', userId: 'u-1', systemPromptPrefix: 'base-prefix' })

    const sqlArg = (mockGenerateSql.mock.calls[0] as unknown as [{ systemPromptPrefix?: string }])[0]
    expect(sqlArg.systemPromptPrefix).toBe('base-prefix')
    expect(sqlArg.systemPromptPrefix).not.toContain('Context guidance:')
  })
})
