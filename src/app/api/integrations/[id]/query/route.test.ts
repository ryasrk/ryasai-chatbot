import { describe, expect, test, mock, beforeEach } from 'bun:test'

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

const mockGetActiveUser = mock(async () => ({ userId: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', organizationId: 'org-default' }))
const mockWriteAudit = mock(async () => undefined)
const mockIntegrationFindFirst = mock(async (): Promise<{ id: string; provider: string; status: string; encryptedConfig: string; schemas: { tableName: string; columns: string; rowCount: number; sampleRow: null }[] } | null> => null)
const mockQueryHistoryCreate = mock(async () => ({}))
const mockDecryptConfig = mock(() => ({}))
const mockGetConnector = mock(() => ({
  provider: 'POSTGRESQL',
  executeQuery: async () => ({ rows: [{ id: 1 }], rowCount: 1, executionMs: 5 }),
}))
const mockDescribeSchema = mock(() => 'schema text')
const mockValidateSql = mock(() => ({ ok: true, sanitized: 'SELECT 1 LIMIT 100' }))
const mockGenerateSql = mock(async () => ({ sql: 'SELECT 1', explanation: 'test' }))

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
})
