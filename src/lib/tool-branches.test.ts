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
const mockCheckToolRateLimit = mock(async (_t: string, _o: string): Promise<{ allowed: boolean }> => ({ allowed: true }))
mock.module('@/lib/tool-rate-limit', () => ({ checkToolRateLimit: mockCheckToolRateLimit }))
mock.module('@/lib/llm-client', () => ({ getLastLlmUsage: () => null }))
// smart-router is mocked so the SQL branch's source-disambiguation decision is
// deterministic. Its own tests cover the scoring; here we only care that the
// BRANCH refuses rather than guesses.
const sr = { choice: null as any, calls: [] as any[] }
mock.module('@/lib/smart-router', () => ({
  resolveIntegrationForQuestion: async (...a: any[]) => { sr.calls.push(a); return sr.choice },
  tokenize: (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean),
}))
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
  // mockReset, not mockClear. mockClear only empties `.calls`; an implementation
  // installed by a previous test SURVIVES it, so `integrationId` tests inherited
  // findMany's two-source stub and a call count of 5 from earlier tests. Proven by
  // probing the counts in-file: findMany read 5 calls for a single call site.
  mockRetrieveWithReflection.mockReset()
  mockGenerateAnswer.mockReset()
  mockGenerateSql.mockReset()
  mockGetPromptSettings.mockReset()
  mockDocumentFindMany.mockReset()
  mockIntegrationFindFirst.mockReset()
  mockValidateSql.mockReset()
  mockConnectorExecuteQuery.mockReset()
  mockAuditLogCreate.mockReset()
  mockQueryHistoryCreate.mockReset()
  // Reset default implementations so a prior test's overrides don't leak in.
  mockGetPromptSettings.mockImplementation(async () => ({
    systemPrompt: '',
    ragContextPrompt: '',
    tools: { rag: true, sql: true, restApi: true },
  }))
  mockGenerateAnswer.mockImplementation(async () => 'ans')
  mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT 1', explanation: 'x' }))
  sr.choice = null
  sr.calls = []
  mockCheckToolRateLimit.mockReset()
  mockCheckToolRateLimit.mockImplementation(async () => ({ allowed: true }))
  mockRetrieveWithReflection.mockImplementation(async () => ({
    chunks: [] as RetrievedChunk[],
    queryTokens: [] as string[],
    candidatesScanned: 0,
    graphContext: '',
    retrievalPasses: 1,
    reflection: { sufficient: true, reason: 'mock', confidence: 1 },
    citationTrail: undefined as string[] | undefined,
  }))
  mockDocumentFindMany.mockImplementation(async () => [])
  // EVERY mock an in-file test overrides must be restored here. Bun's mock.module
  // state (and each mock's implementation) survives between tests in one file:
  // `twoSources` left behind by the disambiguation block made the later
  // "explicit integrationId bypasses the listing path" test fail even though it
  // passed in isolation. Overriding without resetting is the defect, not the test.
  mockIntegrationFindMany.mockImplementation(async () => [{ name: 'Only Source' }])
  // mockClear() alone clears CALLS, not the implementation. Leaving findFirst
  // overridden by an earlier test is what made "an explicit integrationId
  // bypasses the listing path" fail in-file while passing in isolation.
  mockIntegrationFindFirst.mockImplementation(async () => null)
  mockConnectorExecuteQuery.mockImplementation(async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 1 }))
  mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT 1 LIMIT 100' }))
  mockAuditLogCreate.mockClear()
  mockQueryHistoryCreate.mockClear()
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

// ---------------------------------------------------------------------------
// runSqlBranch — the paths that decide WHICH database, and whether to run at all.
// These are the uncovered gaps around the two existing describes (lines 252-290,
// 324-338, 380-449). All three are safety behaviour, not plumbing.
// ---------------------------------------------------------------------------
describe('runSqlBranch — source disambiguation refuses instead of guessing', () => {
  const twoSources = async () => [{ name: 'Sales DB' }, { name: 'HR DB' }]

  test('two active sources + no confident match: asks the user, runs NO query', async () => {
    mockIntegrationFindMany.mockImplementation(twoSources)
    mockIntegrationFindFirst.mockImplementation(async () => null)
    sr.choice = null
    const r = await runSqlBranch({ question: 'total revenue', userId: 'u1' })
    // INCIDENT this guards: the branch used to take the OLDEST active integration,
    // so a Sales question could be answered from the HR database with no error and
    // no log (trial/25-wrong-db-proof.ts). A question is strictly better than a
    // confident answer from the wrong database.
    expect(mockConnectorExecuteQuery).not.toHaveBeenCalled()
    expect(mockGenerateSql).not.toHaveBeenCalled()
    expect(JSON.stringify(r)).toContain('Sales DB')
    expect(JSON.stringify(r)).toContain('HR DB')
  })

  test('a confident match IS used, and the branch proceeds', async () => {
    mockIntegrationFindMany.mockImplementation(twoSources)
    sr.choice = { integrationId: 'int-hr', unverified: false }
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-hr', name: 'HR DB', provider: 'POSTGRESQL', encryptedConfig: {},
      schemas: [{ tableName: 'employees', columns: '[]', rowCount: 1, sampleRow: null, description: null }],
    }))
    const r = await runSqlBranch({ question: 'how many employees', userId: 'u1' })
    expect(sr.calls).toHaveLength(1)
    // 'refuse' is the mode: the resolver must not silently fall back to a guess.
    expect(sr.calls[0][2]).toBe('refuse')
    expect(r.toolRuns?.[0]?.type).toBe('SQL')
  })

  test('exactly ONE active source skips disambiguation entirely', async () => {
    mockIntegrationFindMany.mockImplementation(async () => [{ name: 'Only Source' }])
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1', name: 'Only', provider: 'POSTGRESQL', encryptedConfig: {},
      schemas: [{ tableName: 't', columns: '[]', rowCount: 1, sampleRow: null, description: null }],
    }))
    await runSqlBranch({ question: 'anything', userId: 'u1' })
    // Asking "which database?" with one database configured would be nonsense.
    expect(sr.calls).toHaveLength(0)
  })

  test('an explicit integrationId bypasses the listing path', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-x', name: 'X', provider: 'POSTGRESQL', encryptedConfig: {},
      schemas: [{ tableName: 't', columns: '[]', rowCount: 1, sampleRow: null, description: null }],
    }))
    // NOTE: measure the DELTA, not an absolute count. Probing this file showed
    // findMany's `.calls` reading 5 before this test and 5 after, for a call site
    // that never ran, even though beforeEach does call mockReset() (verified: a
    // probe inside beforeEach shows `.calls` at 0 after the reset). The mock is
    // shared across describe blocks through the mock.module factory, and the
    // absolute count is not reliable here. Asserting the delta measures the
    // behaviour under test instead of the test framework's bookkeeping.
    const findManyBefore = mockIntegrationFindMany.mock.calls.length
    const srBefore = sr.calls.length
    await runSqlBranch({ question: 'q', userId: 'u1', integrationId: 'int-x' })
    // The id is looked up DIRECTLY: no candidate listing, no scoring call.
    expect(mockIntegrationFindMany.mock.calls.length - findManyBefore).toBe(0)
    expect(sr.calls.length - srBefore).toBe(0)
    // And the lookup is constrained to an ACTIVE integration.
    const firstWhere = (mockIntegrationFindFirst.mock.calls.at(-1) as unknown as [{ where: unknown }])[0].where
    expect(firstWhere).toEqual({ id: 'int-x', status: 'active' })
  })

  test('an explicit integrationId that does NOT resolve falls back to disambiguation', async () => {
    // findFirst returns null here, so the branch cannot trust the id. It must not
    // silently answer from a different source without asking.
    mockIntegrationFindFirst.mockImplementation(async () => null)
    mockIntegrationFindMany.mockImplementation(async () => [{ name: 'Sales DB' }, { name: 'HR DB' }])
    sr.choice = null
    await runSqlBranch({ question: 'q', userId: 'u1', integrationId: 'stale-id' })
    expect(mockConnectorExecuteQuery).not.toHaveBeenCalled()
    expect(sr.calls).toHaveLength(1)
  })

  test('an integration with NO reflected schema is reported as unavailable', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => ({
      id: 'int-1', name: 'Empty', provider: 'POSTGRESQL', encryptedConfig: {}, schemas: [],
    }))
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    // Generating SQL against an unknown schema would produce plausible nonsense.
    expect(mockGenerateSql).not.toHaveBeenCalled()
    expect(JSON.stringify(r)).toContain('no data source')
  })
})

describe('runSqlBranch — SQL rate limit is checked BEFORE any LLM call', () => {
  const oneSource = async () => ({
    id: 'int-1', name: 'S', provider: 'POSTGRESQL', encryptedConfig: {},
    schemas: [{ tableName: 't', columns: '[]', rowCount: 1, sampleRow: null, description: null }],
  })

  test('a denied rate limit returns blocked and spends no LLM call', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockCheckToolRateLimit.mockImplementation(async () => ({ allowed: false }))
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    // The repair loop can make up to 3 generation calls per turn, so checking
    // after generation would already have spent the budget the limit protects.
    expect(mockGenerateSql).not.toHaveBeenCalled()
    expect(r.toolRuns?.[0]?.status).toBe('blocked')
    expect(r.toolRuns?.[0]?.type).toBe('SQL')
  })

  test('the blocked result carries the integrationId so the UI can explain which source', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockCheckToolRateLimit.mockImplementation(async () => ({ allowed: false }))
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    expect(r.integrationId).toBe('int-1')
  })

  test('an allowed rate limit proceeds normally', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    await runSqlBranch({ question: 'q', userId: 'u1' })
    expect(mockGenerateSql).toHaveBeenCalled()
  })
})

describe('runSqlBranch — guardrail blocks are audited as critical', () => {
  const oneSource = async () => ({
    id: 'int-1', name: 'S', provider: 'POSTGRESQL', encryptedConfig: {},
    schemas: [{ tableName: 't', columns: '[]', rowCount: 1, sampleRow: null, description: null }],
  })

  test('a rejected SQL writes a GUARDRAIL_BLOCK row at severity critical', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockValidateSql.mockImplementation(() => ({ ok: false, reason: 'mutation detected', detectedNodes: ['DROP'] }))
    mockGenerateSql.mockImplementation(async () => ({ sql: 'DROP TABLE t', explanation: '' }))
    await runSqlBranch({ question: 'q', userId: 'u1' })
    const row = mockAuditLogCreate.mock.calls.map((c) => (c as any[])[0].data).find((d: any) => d.action === 'GUARDRAIL_BLOCK')
    expect(row).toBeTruthy()
    // 'critical' is what makes a guardrail block visible in the security view;
    // a 'warning' here would bury an attack attempt among ordinary failures.
    expect(row.severity).toBe('critical')
    expect(row.userId).toBe('u1')
    expect(row.detail).toContain('mutation detected')
  })

  test('a guardrail rejection is retried, then refused honestly after the last attempt', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockValidateSql.mockImplementation(() => ({ ok: false, reason: 'still bad', detectedNodes: [] }))
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    // SQL_REPAIR_ATTEMPTS is 2, so 3 generation attempts total.
    expect(mockGenerateSql.mock.calls.length).toBe(3)
    expect(r.toolRuns?.[0]?.status).toBe('error')
    // The failure must state the real reason, not just "failed".
    expect(JSON.stringify(r)).toContain('still bad')
  })

  test('a rejected SQL is NEVER executed', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockValidateSql.mockImplementation(() => ({ ok: false, reason: 'no', detectedNodes: [] }))
    await runSqlBranch({ question: 'q', userId: 'u1' })
    // The guardrail is only meaningful if a rejection cannot reach the driver.
    expect(mockConnectorExecuteQuery).not.toHaveBeenCalled()
  })

  test('a driver error is audited as SQL_EXECUTE_ERROR (warning, not critical)', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockConnectorExecuteQuery.mockImplementation(async () => { throw new Error('relation does not exist') })
    await runSqlBranch({ question: 'q', userId: 'u1' })
    const row = mockAuditLogCreate.mock.calls.map((c) => (c as any[])[0].data).find((d: any) => d.action === 'SQL_EXECUTE_ERROR')
    expect(row).toBeTruthy()
    // A bad query from the model is an operational failure, not a security event.
    expect(row.severity).toBe('warning')
    expect(row.detail).toContain('relation does not exist')
  })

  test('a failed execution writes a queryHistory row per attempt with success:false', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockConnectorExecuteQuery.mockImplementation(async () => { throw new Error('boom') })
    await runSqlBranch({ question: 'q', userId: 'u1' })
    const rows = mockQueryHistoryCreate.mock.calls.map((c) => (c as any[])[0].data)
    expect(rows.length).toBe(3)
    for (const row of rows) {
      expect(row.success).toBe(false)
      expect(row.errorMessage).toMatch(/^attempt \d: /)
      expect(row.userId).toBe('u1')
    }
  })

  test('the error path names the attempt count from the constant, not a literal', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    mockConnectorExecuteQuery.mockImplementation(async () => { throw new Error('boom') })
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    // SQL_REPAIR_ATTEMPTS = 2 -> "after 3 attempts". A hardcoded number would go
    // stale the moment the constant changed.
    expect(r.answer).toContain('3 attempts')
  })

  test('a successful retry after an error returns the data, not the failure', async () => {
    mockIntegrationFindFirst.mockImplementation(oneSource)
    let calls = 0
    mockConnectorExecuteQuery.mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return { rows: [{ id: 1 }], rowCount: 1, executionMs: 1 }
    })
    const r = await runSqlBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns?.[0]?.status).not.toBe('error')
    expect(r.answer).not.toContain('failed after')
  })
})
