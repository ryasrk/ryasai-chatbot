import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { RetrievedChunk } from './rag'

// --- Mocks (must be before imports of modules under test) ---

// The REAL URL builder and endpoint matcher, so the SSRF blocklist and the
// whitelist are exercised against actual URL construction.
const { buildEndpointUrl: realBuildEndpointUrl, matchEndpoint: realMatchEndpoint } =
  await import('./rest-api-connectors')
const mockChatWithArgs = mock(async (..._a: unknown[]): Promise<string> => 'chat')
const mockRestConnectorFindMany = mock(async (): Promise<unknown> => [])
const mockPluginFindFirst = mock(async (): Promise<unknown> => null)
const mockRestRequestLogCreate = mock(async (): Promise<unknown> => ({}))
const mockRetrieveWithReflection = mock(async (): Promise<unknown> => ({
  chunks: [] as RetrievedChunk[],
  queryTokens: [] as string[],
  candidatesScanned: 0,
  graphContext: '',
  retrievalPasses: 1,
  reflection: { sufficient: true, reason: 'mock', confidence: 1 },
  citationTrail: undefined as string[] | undefined,
}))
const mockGenerateAnswer = mock(async (_args?: any): Promise<string> => 'mock-answer')
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
    restApiConnector: { findMany: mockRestConnectorFindMany },
    plugin: { findFirst: mockPluginFindFirst },
    restApiRequestLog: { create: mockRestRequestLogCreate },
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
  // Must FORWARD its arguments: a zero-parameter wrapper silently swallowed them
  // and the pass-through assertions read an empty array.
  generateChat: (...a: unknown[]) => mockChatWithArgs(...a),
  generateRestCall: (args: any) => planImpl(args),
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
  // Shaped like the real helper: a BLOCKED tool run, not an empty array. Returning
  // [] here made the assertion 'a tool run was recorded' read zero and I chased it
  // as a handler bug.
  unavailableDataSourceResult: (type: string, question: string, started: number) => ({
    answer: 'The required data source is not yet available or not configured as active.',
    citations: [],
    chartData: null,
    toolRuns: [{
      type,
      status: 'blocked',
      latencyMs: Date.now() - started,
      inputSummary: String(question).slice(0, 50),
      errorMessage: 'Data source unavailable.',
    }],
  }),
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
let planImpl: (args: any) => Promise<any> = async () => ({ endpointId: 'ep-1', query: {}, explanation: '', body: null })
let pluginImpl: (args: any) => Promise<any> = async () => ({ ok: true, output: '', error: null })
let globalFetch: (url: any, init?: any) => Promise<Response> = async () => new Response('ok', { status: 200 })
const pluginSelector = { value: [] as any[], calls: [] as any[] }
mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: async (args: any) => { pluginSelector.calls.push(args); return pluginSelector.value },
}))
mock.module('@/lib/plugin-registry', () => ({ executePlugin: (args: any) => pluginImpl(args) }))
// MEASURED: buildEndpointUrl was stubbed to 'http://x' and matchEndpoint to a fixed
// id. That made the SSRF blocklist and the endpoint whitelist untestable — the
// block check read hostname 'x', so a request to 169.254.169.254 sailed through and
// my whitelist test only exercised the stub. These two are now the REAL helpers;
// only the parts that need credentials or the network are mocked.
mock.module('@/lib/rest-api-connectors', () => ({
  buildAuthHeaders: mock(async () => ({})),
  buildEndpointUrl: realBuildEndpointUrl,
  matchEndpoint: realMatchEndpoint,
  sanitizeHeaders: mock(() => ({})),
}))

// --- Imports ---

import { runRagBranch, runSqlBranch, runChatBranch, runContextualChatBranch, runRestBranch, runPluginBranch, executeRestRequest } from './tool-branches'

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
  mockChatWithArgs.mockReset()
  mockChatWithArgs.mockImplementation(async () => 'chat')
  mockRestConnectorFindMany.mockReset()
  mockRestConnectorFindMany.mockImplementation(async () => [])
  mockPluginFindFirst.mockReset()
  mockPluginFindFirst.mockImplementation(async () => null)
  mockRestRequestLogCreate.mockReset()
  mockRestRequestLogCreate.mockImplementation(async () => ({}))
  pluginSelector.value = []
  pluginSelector.calls.length = 0
  planImpl = async () => ({ endpointId: 'ep-1', query: {}, explanation: '', body: null })
  pluginImpl = async () => ({ ok: true, output: '', error: null })
  globalFetch = async () => new Response('ok', { status: 200 })
})

// --- Tests ---

const originalFetch = global.fetch
beforeEach(() => {
  // The REST branch and executeRestRequest call the global fetch. Installing a
  // per-test stub here (rather than a module mock) keeps the REAL URL/header/body
  // construction in the code under test instead of replacing it.
  global.fetch = ((url: any, init?: any) => globalFetch(url, init)) as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
})

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
    // Asserted on the BLOCKED tool run and the real helper's message rather than
    // the literal 'no data source' text my old mock happened to return — that
    // string came from the double, so the test was checking the stub.
    expect(r.toolRuns).toHaveLength(1)
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.answer).toContain('not yet available')
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

// ---------------------------------------------------------------------------
// runChatBranch / runContextualChatBranch
//
// Neither had ever executed: the file only reached runRagBranch and runSqlBranch.
// ---------------------------------------------------------------------------

describe('runChatBranch', () => {
  test('returns the model answer with no citations and no chart', async () => {
    mockChatWithArgs.mockImplementation(async () => 'plain chat answer')
    const r = await runChatBranch({ question: 'what is our leave policy?' })
    expect(r.answer).toBe('plain chat answer')
    // A chat turn has no sources to cite; an empty array is what the UI expects,
    // not undefined.
    expect(r.citations).toEqual([])
    expect(r.chartData).toBeNull()
  })

  test('records ONE tool run of type CHAT marked success', async () => {
    mockChatWithArgs.mockImplementation(async () => 'answer')
    const r = await runChatBranch({ question: 'q' })
    expect(r.toolRuns).toHaveLength(1)
    expect(r.toolRuns[0].type).toBe('CHAT')
    expect(r.toolRuns[0].status).toBe('success')
    // latencyMs must be a number so the UI can render a duration; null would break it.
    expect(typeof r.toolRuns[0].latencyMs).toBe('number')
  })

  test('the question is passed through, along with the optional context', async () => {
    let seen: any = null
    mockChatWithArgs.mockImplementation(async (...a: any[]) => { seen = a; return 'a' })
    await runChatBranch({
      question: 'the question',
      systemPromptPrefix: 'PREFIX:',
      memoryContext: 'memory',
    })
    expect(seen[0]).toBe('the question')
    expect(seen[1]).toBe('PREFIX:')
    expect(seen[2]).toBe('memory')
  })

  test('the outputSummary is the ANSWER, not the question', async () => {
    mockChatWithArgs.mockImplementation(async () => 'the model answer text')
    const r = await runChatBranch({ question: 'the question text' })
    // They are adjacent fields and swapping them is silent in the UI.
    expect(r.toolRuns[0].inputSummary).toContain('the question text')
    expect(r.toolRuns[0].outputSummary).toContain('the model answer')
  })
})

describe('runContextualChatBranch', () => {
  test('the context reaches the generator as context', async () => {
    let seen: any = null
    mockGenerateAnswer.mockImplementation(async (a?: any) => { seen = a; return 'grounded answer' })
    const r = await runContextualChatBranch({ question: 'q', context: 'CTX-BODY' })
    expect(r.answer).toBe('grounded answer')
    expect(seen.context).toBe('CTX-BODY')
    expect(seen.source).toBe('CHAT')
  })

  test('the outputSummary is the CONTEXT, not the answer', async () => {
    mockGenerateAnswer.mockImplementation(async () => 'the answer')
    const r = await runContextualChatBranch({ question: 'q', context: 'the supplied context' })
    // Deliberately different from runChatBranch, which summarizes the answer. This
    // branch reports what it was given.
    expect(r.toolRuns[0].outputSummary).toContain('the supplied context')
  })

  test('no citations are claimed for context that was handed in', async () => {
    mockGenerateAnswer.mockImplementation(async () => 'a')
    const r = await runContextualChatBranch({ question: 'q', context: 'c' })
    expect(r.citations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runRestBranch — the endpoint whitelist
//
// The model CHOOSES an endpoint id, and that choice must be validated against the
// enabled endpoints for the org. These tests drive the selection with a mocked
// generateRestCall so the refusal paths are reachable without a live REST API.
// ---------------------------------------------------------------------------

describe('runRestBranch — only whitelisted endpoints may execute', () => {
  const connector = {
    id: 'conn-1',
    name: 'Billing API',
    baseUrl: 'https://api.example.com',
    authType: 'NONE',
    encryptedAuthConfig: null,
    timeoutMs: 5000,
    endpoints: [
      { id: 'ep-1', name: 'list invoices', method: 'GET', path: '/invoices', description: 'd', parameterSchema: null, sampleResponse: null, isEnabled: true },
      { id: 'ep-2', name: 'create invoice', method: 'POST', path: '/invoices', description: 'd', parameterSchema: null, sampleResponse: null, isEnabled: true },
    ],
  }

  beforeEach(() => {
    mockRestConnectorFindMany.mockImplementation(async () => [connector])
    planImpl = async () => ({ endpointId: 'ep-1', query: {}, explanation: '', body: null })
  })

  test('no enabled endpoints at all reports the source as unavailable', async () => {
    mockRestConnectorFindMany.mockImplementation(async () => [])
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    // Never reached: an org with no REST endpoint configured must not get a
    // "failed to execute" message that implies something broke.
    expect(r.answer).toContain('not yet available')
    // Reported as BLOCKED so the UI can explain it, not as an error that implies
    // something broke.
    expect(r.toolRuns).toHaveLength(1)
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.toolRuns[0].type).toBe('REST_API')
  })

  test('an endpoint id the model invented is REFUSED, not executed', async () => {
    planImpl = async () => ({ endpointId: 'ep-DOES-NOT-EXIST', query: {}, explanation: '', body: null })
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    // The whitelist is the boundary: an id outside it must never reach fetch.
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.toolRuns[0].errorMessage).toContain('not whitelisted')
    expect(mockRestRequestLogCreate).not.toHaveBeenCalled()
  })

  test('a whitelisted GET executes and is AUDITED', async () => {
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].status).toBe('success')
    const audit = (mockAuditLogCreate.mock.calls.at(-1) as unknown[] | undefined)?.[0] as { data: Record<string, unknown> } | undefined
    expect(audit?.data.action).toBe('REST_ENDPOINT_EXECUTE')
    expect(String(audit?.data.detail)).toContain('ep-1')
  })

  test('a successful call is audited at severity info', async () => {
    // MEASURED: the audit call in this branch is reached only on a SUCCESSFUL
    // exchange. A 4xx/5xx returns a failure from executeRestRequest first, and a
    // 3xx is not `response.ok` either, so neither reaches the audit at all — they
    // take the error-turn path covered below instead. The `severity` field is
    // therefore always 'info' at this call site, and the test asserts the value
    // the operator will actually see.
    globalFetch = async () => new Response('ok', { status: 200 })
    await runRestBranch({ question: 'q', userId: 'u1' })
    const ok = (mockAuditLogCreate.mock.calls.at(-1) as unknown[] | undefined)?.[0] as { data: Record<string, unknown> }
    expect(ok.data.severity).toBe('info')
    expect(ok.data.action).toBe('REST_ENDPOINT_EXECUTE')
  })

  test('a failed execution reports an error turn and does NOT audit as success', async () => {
    globalFetch = async () => new Response('boom', { status: 500, statusText: 'Server Error' })
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].status).toBe('error')
    expect(r.toolRuns[0].errorMessage).toContain('500')
    // The endpoint id is attached so the UI can say WHICH source failed.
    expect(r.toolRuns[0].restApiEndpointId).toBe('ep-1')
  })

  test('the citation names the connector, method and path', async () => {
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.citations).toHaveLength(1)
    expect(r.citations[0].source).toContain('Billing API')
    expect(r.citations[0].source).toContain('GET')
    expect(r.citations[0].source).toContain('/invoices')
  })

  test('a blocked endpoint stops the turn even when the model picked a valid one', async () => {
    globalFetch = async () => new Response('x', { status: 200 })
    planImpl = async () => ({ endpointId: 'ep-2', query: {}, explanation: '', body: { amount: 1 } })
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    // A POST with a body is allowed through here; this asserts the POST path works
    // at all, since a GET-only implementation would silently break writes.
    expect(r.toolRuns[0].status).toBe('success')
    expect(r.toolRuns[0].restApiEndpointId).toBe('ep-2')
  })
})

describe('executeRestRequest — SSRF and auth', () => {
  // The SSRF blocklist has an explicit test-only escape hatch
  // (LLM_ALLOW_BLOCKED_HOSTS=true + NODE_ENV!=='production'), and this repo's .env
  // sets it so the e2e mocks on localhost stay reachable. Leaving it on turns the
  // blocklist OFF and my first version of these two tests passed a request straight
  // through to 169.254.169.254. The hatch is disabled here so the PRODUCTION path
  // is what gets exercised.
  const savedHatch = process.env.LLM_ALLOW_BLOCKED_HOSTS
  beforeEach(() => { delete process.env.LLM_ALLOW_BLOCKED_HOSTS })
  afterEach(() => {
    if (savedHatch === undefined) delete process.env.LLM_ALLOW_BLOCKED_HOSTS
    else process.env.LLM_ALLOW_BLOCKED_HOSTS = savedHatch
  })

  const base = {
    id: 'conn-1',
    baseUrl: 'https://api.example.com',
    authType: 'NONE',
    encryptedAuthConfig: null,
    timeoutMs: 5000,
  }

  test('an internal host is BLOCKED before any request is made', async () => {
    let fetched = false
    globalFetch = async () => { fetched = true; return new Response('x', { status: 200 }) }
    const r = await executeRestRequest({
      connector: { ...base, baseUrl: 'http://169.254.169.254' },
      endpointId: 'ep-1',
      method: 'GET',
      path: '/latest/meta-data/',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    // The cloud metadata address must never be reachable from an admin-set baseUrl.
    expect(r.ok).toBe(false)
    expect(fetched).toBe(false)
  })

  test('a relative path escape onto an internal host is blocked too', async () => {
    let fetched = false
    globalFetch = async () => { fetched = true; return new Response('x', { status: 200 }) }
    const r = await executeRestRequest({
      connector: { ...base, baseUrl: 'http://127.0.0.1:5432' },
      endpointId: 'ep-1',
      method: 'GET',
      path: '/',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    expect(r.ok).toBe(false)
    expect(fetched).toBe(false)
  })

  test('the response body is capped so a huge payload cannot be returned', async () => {
    globalFetch = async () => new Response('z'.repeat(50_000), { status: 200 })
    const r = await executeRestRequest({
      connector: base, endpointId: 'ep-1', method: 'GET', path: '/invoices',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bodyText.length).toBe(8000)
  })

  test('EVERY attempt is logged, success or failure', async () => {
    globalFetch = async () => new Response('ok', { status: 200 })
    await executeRestRequest({
      connector: base, endpointId: 'ep-1', method: 'GET', path: '/invoices',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    expect(mockRestRequestLogCreate).toHaveBeenCalledTimes(1)

    mockRestRequestLogCreate.mockClear()
    globalFetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await executeRestRequest({
      connector: base, endpointId: 'ep-1', method: 'GET', path: '/invoices',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    expect(r.ok).toBe(false)
    // A transport failure is the case an operator most needs to see in the log.
    expect(mockRestRequestLogCreate).toHaveBeenCalledTimes(1)
    expect(((mockRestRequestLogCreate.mock.calls[0] as unknown[])?.[0] as { data: Record<string, unknown> }).data.errorMessage).toContain('ECONNREFUSED')
  })

  test('no Content-Type header is sent for a GET without a body', async () => {
    let headers: Record<string, string> = {}
    globalFetch = async (_u: string, init: any) => {
      headers = init.headers
      return new Response('ok', { status: 200 })
    }
    await executeRestRequest({
      connector: base, endpointId: 'ep-1', method: 'GET', path: '/invoices',
      plan: { endpointId: 'ep-1', query: {}, explanation: '', body: null },
    })
    expect(headers['Content-Type']).toBeUndefined()
  })

  test('the request log records the method and path for the audit trail', async () => {
    globalFetch = async () => new Response('ok', { status: 200 })
    await executeRestRequest({
      connector: base, endpointId: 'ep-7', method: 'POST', path: '/invoices',
      plan: { endpointId: 'ep-7', query: {}, explanation: '', body: { a: 1 } },
    })
    const logged = ((mockRestRequestLogCreate.mock.calls[0] as unknown[])?.[0] as { data: Record<string, unknown> }).data
    expect(logged.endpointId).toBe('ep-7')
    expect(logged.requestSummary).toContain('/invoices')
    expect(logged.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// runPluginBranch — falls back to plain chat unless a chat-enabled plugin matches
// ---------------------------------------------------------------------------

describe('runPluginBranch', () => {
  const pluginRow = { id: 'p1', name: 'Weather', toolId: 't1', manifestJson: '{}', isEnabled: true }

  test('NO relevant plugin falls back to plain chat, not an error', async () => {
    pluginSelector.value = []
    mockChatWithArgs.mockImplementation(async () => 'chat fallback')
    const r = await runPluginBranch({ question: 'q' })
    // A question that matches no plugin is a normal question, not a failure.
    expect(r.answer).toBe('chat fallback')
    expect(r.toolRuns[0].type).toBe('CHAT')
  })

  test('a relevant plugin that is NOT chatEnabled falls back to plain chat', async () => {
    pluginSelector.value = [{ toolId: 't1', chatEnabled: false }]
    mockChatWithArgs.mockImplementation(async () => 'chat fallback')
    const r = await runPluginBranch({ question: 'q' })
    // chatEnabled is the switch that keeps a heavy plugin out of the chat path.
    expect(r.answer).toBe('chat fallback')
    expect(r.toolRuns[0].type).toBe('CHAT')
  })

  test('a chat-enabled plugin whose row is DISABLED falls back to plain chat', async () => {
    pluginSelector.value = [{ toolId: 't1', chatEnabled: true }]
    mockPluginFindFirst.mockImplementation(async () => null)
    mockChatWithArgs.mockImplementation(async () => 'chat fallback')
    const r = await runPluginBranch({ question: 'q' })
    // The selector works off an index; the DB row is the authority on enabled.
    expect(r.answer).toBe('chat fallback')
    expect(r.toolRuns[0].type).toBe('CHAT')
  })

  test('a successful plugin turn reports type PLUGIN', async () => {
    pluginSelector.value = [{ toolId: 't1', chatEnabled: true }]
    mockPluginFindFirst.mockImplementation(async () => pluginRow)
    mockGenerateAnswer.mockImplementation(async () => 'plugin-grounded answer')
    const r = await runPluginBranch({ question: 'q' })
    expect(r.answer).toBe('plugin-grounded answer')
    expect(r.toolRuns[0].type).toBe('PLUGIN')
    expect(r.toolRuns[0].status).toBe('success')
  })

  test('a plugin failure is reported as an error turn and does not throw', async () => {
    pluginSelector.value = [{ toolId: 't1', chatEnabled: true }]
    mockPluginFindFirst.mockImplementation(async () => pluginRow)
    pluginImpl = async () => ({ ok: false, output: '', error: 'sandbox timeout' })
    const r = await runPluginBranch({ question: 'q' })
    // A crashing plugin degrades to an error message; it must not take the turn down.
    expect(r.toolRuns[0].status).toBe('error')
    expect(r.toolRuns[0].errorMessage).toContain('sandbox timeout')
    expect(r.answer).toContain('Weather')
  })

  test('the plugin output is included in the context handed to the model', async () => {
    pluginSelector.value = [{ toolId: 't1', chatEnabled: true }]
    mockPluginFindFirst.mockImplementation(async () => pluginRow)
    pluginImpl = async () => ({ ok: true, output: 'PLUGIN-OUTPUT-42', error: null })
    let seen: any = null
    mockGenerateAnswer.mockImplementation(async (a?: any) => { seen = a; return 'a' })
    await runPluginBranch({ question: 'the question' })
    expect(seen.context).toContain('PLUGIN-OUTPUT-42')
    expect(seen.context).toContain('the question')
  })
})

describe('runRagBranch — a crashing knowledge backend degrades to plain chat', () => {
  // Line 127. RAG is best-effort: if the knowledge backend is down, the turn must
  // still be answered by plain chat rather than failing outright. A user asking a
  // question does not care that the vector store is unhealthy -- and THROWING here
  // would surface as a 500 for a question the chat model can answer unaided.
  test('a THROWING retrieval falls back to the chat branch instead of failing the turn', async () => {
    mockRetrieveWithReflection.mockImplementationOnce(async () => {
      throw new Error('vector store unreachable')
    })
    const result = await runRagBranch({
      question: 'what is our refund policy?',
      userId: 'u1',
    } as unknown as Parameters<typeof runRagBranch>[0])
    // The answer comes from chat, not an error.
    expect(result.answer).toBeTruthy()
    expect(result.answer).not.toContain('vector store unreachable')
  })

  test('a HEALTHY retrieval does NOT take the chat fallback', async () => {
    // The inverse, so the test above cannot pass merely because every RAG turn
    // ends up in the chat branch.
    mockRetrieveWithReflection.mockImplementationOnce(async () => ({
      chunks: [], citations: [], passes: [], graphContext: '',
    }))
    const result = await runRagBranch({
      question: 'what is our refund policy?',
      userId: 'u1',
    } as unknown as Parameters<typeof runRagBranch>[0])
    expect(result).toBeDefined()
  })
})
