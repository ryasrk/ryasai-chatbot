import { describe, expect, test, mock, beforeEach } from 'bun:test'

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

const mockGetActiveUser = mock(async () => ({ userId: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', organizationId: 'org-default' }))
const mockWriteAudit = mock(async (_a: Record<string, unknown>) => undefined)
// The cached schema row is TEXT in the DB, and rowCount/sampleRow are nullable --
// the previous annotation pinned sampleRow to the literal `null` and rowCount to
// `number`, which is narrower than the column the route actually reads.
interface MockSchemaRow {
  tableName: string
  columns: string
  rowCount: number | null
  sampleRow: string | null
}
interface MockIntegration {
  id: string
  provider: string
  status: string
  encryptedConfig: string
  schemas: MockSchemaRow[]
  businessContext?: string | null
}
const mockIntegrationFindFirst = mock(async (): Promise<MockIntegration | null> => null)
const mockQueryHistoryCreate = mock(async () => ({}))
const mockDecryptConfig = mock(() => ({}))
const mockGetConnector = mock(() => ({
  provider: 'POSTGRESQL',
  executeQuery: async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 5 }),
}))
const mockDescribeSchema = mock((_t: Array<Record<string, unknown>>) => 'schema text')
const mockValidateSql = mock(() => ({ ok: true, sanitized: 'SELECT 1 LIMIT 100' }))
const mockGenerateSql = mock(async (_a: Record<string, unknown>) => ({ sql: 'SELECT 1', explanation: 'test' }))

mock.module('@/lib/session', () => ({
  getActiveUser: mockGetActiveUser,
  writeAudit: mockWriteAudit,
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  UnauthorizedError: MockUnauthorizedError,
}))
mock.module('@/lib/db', () => ({
  db: {
    integration: { findFirst: mockIntegrationFindFirst },
    queryHistory: { create: mockQueryHistoryCreate },
  },
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: mockDecryptConfig }))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: mockGetConnector },
  describeSchema: mockDescribeSchema,
}))
mock.module('@/lib/guardrails', () => ({ validateAndSanitizeLlmSql: mockValidateSql }))
mock.module('@/lib/ai', () => ({ generateSql: mockGenerateSql }))

import { POST } from './route'

function makeCtx(id = 'int1') {
  return { params: Promise.resolve({ id }) }
}

function makeReq(body: unknown) {
  return new Request('http://localhost/api/integrations/int1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ACTIVE_INTEGRATION = {
  id: 'int1',
  provider: 'POSTGRESQL',
  status: 'active',
  encryptedConfig: 'enc',
  schemas: [{ tableName: 'demo_products', columns: '[]', rowCount: 10, sampleRow: null }],
}

beforeEach(() => {
  mockGetActiveUser.mockClear()
  mockWriteAudit.mockClear()
  mockIntegrationFindFirst.mockClear()
  mockQueryHistoryCreate.mockClear()
  mockDecryptConfig.mockClear()
  mockGetConnector.mockClear()
  mockDescribeSchema.mockClear()
  mockValidateSql.mockClear()
  mockGenerateSql.mockClear()
  mockGetActiveUser.mockImplementation(async () => ({ userId: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', organizationId: 'org-default' }))
  mockIntegrationFindFirst.mockImplementation(async () => null)
  mockValidateSql.mockImplementation(() => ({ ok: true, sanitized: 'SELECT 1 LIMIT 100' }))
  mockGenerateSql.mockImplementation(async () => ({ sql: 'SELECT 1', explanation: 'test' }))
  mockGetConnector.mockImplementation(() => ({
    provider: 'POSTGRESQL',
    executeQuery: async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 5 }),
  }))
  mockWriteAudit.mockImplementation(async () => undefined)
  mockQueryHistoryCreate.mockImplementation(async () => ({}))
})

describe('POST /api/integrations/[id]/query', () => {
  test('valid query → 200 with rows', async () => {
    mockIntegrationFindFirst.mockImplementationOnce(async () => ACTIVE_INTEGRATION)
    const res = await POST(makeReq({ naturalQuery: 'show me products' }) as any, makeCtx() as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rowCount).toBe(1)
    expect(mockQueryHistoryCreate).toHaveBeenCalledTimes(1)
  })

  test('guardrail block → 403 with reason', async () => {
    mockIntegrationFindFirst.mockImplementationOnce(async () => ACTIVE_INTEGRATION)
    mockGenerateSql.mockImplementationOnce(async () => ({ sql: 'DELETE FROM users', explanation: 'bad' }))
    mockValidateSql.mockImplementationOnce(() => ({ ok: false, sanitized: '', reason: 'mutation detected' }))
    const res = await POST(makeReq({ naturalQuery: 'delete everything' }) as any, makeCtx() as any)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('mutation')
  })

  test('SQL execute error → 502', async () => {
    mockIntegrationFindFirst.mockImplementationOnce(async () => ACTIVE_INTEGRATION)
    mockGetConnector.mockImplementationOnce(() => ({
      provider: 'POSTGRESQL',
      executeQuery: async () => { throw new Error('syntax error near FROM') },
    }))
    const res = await POST(makeReq({ naturalQuery: 'query' }) as any, makeCtx() as any)
    expect(res.status).toBe(502)
  })

  test('missing naturalQuery → 400', async () => {
    const res = await POST(makeReq({}) as any, makeCtx() as any)
    expect(res.status).toBe(400)
  })

  test('integration not found → 404', async () => {
    mockIntegrationFindFirst.mockImplementationOnce(async () => null)
    const res = await POST(makeReq({ naturalQuery: 'test' }) as any, makeCtx() as any)
    expect(res.status).toBe(404)
  })

  test('auth failure → 401', async () => {
    mockGetActiveUser.mockImplementationOnce(async () => { throw new MockUnauthorizedError() })
    const res = await POST(makeReq({ naturalQuery: 'test' }) as any, makeCtx() as any)
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // The two 409 preconditions and the LLM failure path
  // -------------------------------------------------------------------------

  test('an INACTIVE integration → 409 with an actionable message', async () => {
    // The operator-facing difference between 404 and 409: the integration EXISTS but
    // is disconnected, so the fix is "re-enable it", not "check the id". A 404 here
    // would send someone hunting for a row that is right in front of them.
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      status: 'disconnected',
    }))
    const res = await POST(makeReq({ naturalQuery: 'test' }) as any, makeCtx() as any)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('disconnected')
    expect(body.error).toContain('re-enable this integration')
    // Nothing downstream may have run: no LLM call, no audit of a query.
    expect(mockGenerateSql).not.toHaveBeenCalled()
    expect(mockQueryHistoryCreate).not.toHaveBeenCalled()
  })

  test('an integration with NO reflected schema → 409 telling the user to test the connection', async () => {
    // Without this guard the route builds an EMPTY schema prompt and the LLM guesses
    // table names, so the user sees a confusing SQL error instead of "run a
    // connection test first".
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      schemas: [],
    }))
    const res = await POST(makeReq({ naturalQuery: 'test' }) as any, makeCtx() as any)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('schema has not been reflected')
    expect(body.error).toContain('connection test')
    expect(mockGenerateSql).not.toHaveBeenCalled()
  })

  test('the schema guard runs AFTER the status guard (disconnected wins)', async () => {
    // Both preconditions are false at once; the DISCONNECTED message must be the one
    // shown, because re-enabling is a prerequisite for any schema to appear.
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      status: 'disconnected',
      schemas: [],
    }))
    const body = await (await POST(makeReq({ naturalQuery: 't' }) as any, makeCtx() as any)).json()
    expect(body.error).toContain('disconnected')
  })

  test('a THROWING generateSql → 502 with a calm message, and an audit row', async () => {
    // The LLM is the least reliable dependency in this path. The user must get a
    // retry-able sentence (not a stack trace), and the failure must be AUDITED, or a
    // provider outage looks like "nobody used the SQL playground today".
    mockIntegrationFindFirst.mockImplementationOnce(async () => ACTIVE_INTEGRATION)
    mockGenerateSql.mockImplementationOnce(async () => { throw new Error('provider 503 upstream') })

    const res = await POST(makeReq({ naturalQuery: 'show me products' }) as any, makeCtx() as any)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('AI service is currently unable')
    // The provider's raw message must NOT leak to the client.
    expect(body.error).not.toContain('provider 503 upstream')
    expect(mockWriteAudit).toHaveBeenCalledTimes(1)
    const auditArg = mockWriteAudit.mock.calls[0]![0] as Record<string, unknown>
    expect(auditArg.action).toBe('SQL_GENERATE_ERROR')
    expect(auditArg.severity).toBe('warning')
    expect(auditArg.userId).toBe('u1')
    expect((auditArg.detail as Record<string, unknown>).integrationId).toBe('int1')
    expect((auditArg.detail as Record<string, unknown>).error).toBe('provider 503 upstream')
    expect(mockQueryHistoryCreate).not.toHaveBeenCalled()
  })

  test('a NON-Error rejection from generateSql is stringified into the audit', async () => {
    // `e instanceof Error ? e.message : String(e)` -- a provider SDK rejecting with a
    // bare value would otherwise log `undefined` and leave nothing to diagnose.
    mockIntegrationFindFirst.mockImplementationOnce(async () => ACTIVE_INTEGRATION)
    mockGenerateSql.mockImplementationOnce(async () => { throw 'timeout' })

    const res = await POST(makeReq({ naturalQuery: 'q' }) as any, makeCtx() as any)
    expect(res.status).toBe(502)
    const detail = (mockWriteAudit.mock.calls[0]![0] as Record<string, unknown>).detail as Record<string, unknown>
    expect(detail.error).toBe('timeout')
  })

  test('the admin business context IS forwarded to generateSql', async () => {
    // The comment in the source records this as a real parity bug: the route used to
    // omit businessContext, so the SQL Playground generated weaker SQL than the chat
    // path for an identical question.
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      businessContext: 'Fiscal year starts in April.',
    }))
    const res = await POST(makeReq({ naturalQuery: 'q' }) as any, makeCtx() as any)
    expect(res.status).toBe(200)
    const arg = mockGenerateSql.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.businessContext).toBe('Fiscal year starts in April.')
    expect(arg.provider).toBe('POSTGRESQL')
    expect(arg.question).toBe('q')
  })

  // -------------------------------------------------------------------------
  // safeParseColumns / safeParseSampleRow — cached schema rows are TEXT
  // -------------------------------------------------------------------------

  /**
   * Runs the route with the given cached schema row and returns what the LLM saw.
   *
   * MUST read the LAST call, not calls[0]. My first version read calls[0], and these
   * tests still passed while a control proved the parser branch was NOT being
   * exercised: the recorded argument was `{tableName, columns, rowCount}` with NO
   * sampleRow at all. The mock is shared across the whole file, so calls[0] was a
   * leftover from an earlier test in this describe block. A helper that reads the
   * first call of a SHARED mock is a latent wrong-branch pass.
   */
  async function schemaSeen(columns: string, sampleRow: string | null) {
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      schemas: [{ tableName: 'demo_products', columns, rowCount: 10, sampleRow }],
    }))
    await POST(makeReq({ naturalQuery: 'q' }) as any, makeCtx() as any)
    const calls = mockDescribeSchema.mock.calls
    return calls[calls.length - 1]![0] as Array<Record<string, unknown>>
  }

  test('a column row is normalised and empty/absent flags become ABSENT', async () => {
    // `Boolean(x) || undefined` KEEPS the key with value undefined. Downstream a
    // `primaryKey: undefined` is falsy, which is what the prompt wants -- but the key
    // existing is what this test pins, since a change to `? :` would alter the shape.
    const seen = await schemaSeen(JSON.stringify([
      { name: 'id', type: 'int', primaryKey: true, notNull: true, foreignKey: 'demo_orders.id', distinctValues: [1, 2] },
      { name: 'label', type: 'text', primaryKey: false, notNull: false },
    ]), null)
    expect(seen[0]!.tableName).toBe('demo_products')
    const cols = seen[0]!.columns as Array<Record<string, unknown>>
    expect(cols[0]).toEqual({
      name: 'id', type: 'int', primaryKey: true, notNull: true,
      foreignKey: 'demo_orders.id', distinctValues: ['1', '2'],
    })
    expect(cols[1]).toMatchObject({ name: 'label', type: 'text', primaryKey: undefined, notNull: undefined })
    // distinctValues values are STRINGIFIED -- a numeric list must not reach the prompt
    // as numbers, or the model can emit `WHERE x = 1` from a text column.
    expect(cols[0]!.distinctValues).toEqual(['1', '2'])
  })

  test('a MALFORMED column blob degrades to an empty list, not a throw', async () => {
    // Lines 259-260. The column cache is a TEXT column that older rows may hold as
    // invalid JSON; the route must still answer with whatever else it has.
    const seen = await schemaSeen('{not json', null)
    expect((seen[0]!.columns as unknown[])).toEqual([])
  })

  test('a column blob that parses to a NON-ARRAY degrades to an empty list', async () => {
    // An object (or a string/number) is valid JSON but not a column list; returning it
    // would make the LLM prompt contain an object where columns belong.
    expect(((await schemaSeen('{"name":"id"}', null))[0]!.columns as unknown[])).toEqual([])
    expect(((await schemaSeen('"just a string"', null))[0]!.columns as unknown[])).toEqual([])
  })

  test('a PRESENT sample row is passed through as an object', async () => {
    const seen = await schemaSeen('[]', JSON.stringify({ id: 1, label: 'alpha' }))
    expect(seen[0]!.sampleRow).toEqual({ id: 1, label: 'alpha' })
  })

  test('a MALFORMED or mis-shaped sample row yields undefined, never a throw', async () => {
    // Lines 267-272. A sample row is a convenience for the prompt; a bad one must not
    // take down a query that would otherwise work.
    expect((await schemaSeen('[]', '{oops'))[0]!.sampleRow).toBeUndefined()
    const probe = await schemaSeen('[]', '[1,2,3]')
    await Bun.write('/tmp/probe1.txt', 'calls=' + mockDescribeSchema.mock.calls.length + ' arg=' + JSON.stringify(probe))
    expect((await schemaSeen('[]', '[1,2,3]'))[0]!.sampleRow).toBeUndefined()
    expect((await schemaSeen('[]', '"text"'))[0]!.sampleRow).toBeUndefined()
    expect((await schemaSeen('[]', null))[0]!.sampleRow).toBeUndefined()
  })

  test('a null rowCount becomes undefined rather than 0', async () => {
    // `s.rowCount ?? undefined` -- a 0 would tell the LLM the table is EMPTY, which is
    // a very different claim from "row count unknown".
    mockIntegrationFindFirst.mockImplementationOnce(async () => ({
      ...ACTIVE_INTEGRATION,
      schemas: [{ tableName: 't', columns: '[]', rowCount: null, sampleRow: null }],
    }))
    await POST(makeReq({ naturalQuery: 'q' }) as any, makeCtx() as any)
    const seen = mockDescribeSchema.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(seen[0]!.rowCount).toBeUndefined()
  })
})
