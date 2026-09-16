import { describe, expect, test, mock, beforeEach } from 'bun:test'

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

const mockRequireExternalApiKey = mock(async (req: Request) => {
  const raw = req.headers.get('authorization') ?? ''
  const token = raw.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) throw new MockUnauthorizedError('API key must be sent as Bearer token.')
  return { apiKeyId: 'key1', label: 'test', requestLimitPerMinute: 60 }
})
const mockRateLimit = mock(async (): Promise<{ allowed: boolean; remaining: number } | null> => null) // null = Redis down → DB fallback
const mockWriteAudit = mock(async () => undefined)
const mockUserFindFirst = mock(async () => ({ id: 'admin1' }))
const mockAgentRunCreate = mock(async () => ({ id: 'run1' }))
const mockAgentRunUpdate = mock(async () => ({}))
const mockApiRequestLogCreate = mock(async () => ({}))
const mockRunAgentOrchestrator = mock(async () => ({
  answer: 'final answer',
  toolRuns: [{ type: 'CHAT' as const, status: 'success' as const, latencyMs: 10 }],
  iterations: 1,
  citations: [],
}))
const mockRememberChatTurn = mock(async () => undefined)

mock.module('@/lib/api-keys', () => ({
  requireExternalApiKey: mockRequireExternalApiKey,
}))
mock.module('@/lib/redis', () => ({
  rateLimit: mockRateLimit,
}))
mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  writeAudit: mockWriteAudit,
  UnauthorizedError: MockUnauthorizedError,
}))
mock.module('@/lib/db', () => ({
  db: {
    user: { findFirst: mockUserFindFirst },
    agentRun: { create: mockAgentRunCreate, update: mockAgentRunUpdate },
    apiRequestLog: { create: mockApiRequestLogCreate },
  },
}))
mock.module('@/lib/agent-orchestrator', () => ({
  runAgentOrchestrator: mockRunAgentOrchestrator,
}))
mock.module('@/lib/cognee', () => ({
  rememberChatTurn: mockRememberChatTurn,
}))

import { POST } from './route'

beforeEach(() => {
  mockRequireExternalApiKey.mockClear()
  mockRateLimit.mockClear()
  mockWriteAudit.mockClear()
  mockUserFindFirst.mockClear()
  mockAgentRunCreate.mockClear()
  mockAgentRunUpdate.mockClear()
  mockApiRequestLogCreate.mockClear()
  mockRunAgentOrchestrator.mockClear()
  mockRememberChatTurn.mockClear()
  mockWriteAudit.mockImplementation(async () => undefined)
  mockAgentRunUpdate.mockImplementation(async () => ({}))
  mockApiRequestLogCreate.mockImplementation(async () => ({}))
  mockRememberChatTurn.mockImplementation(async () => undefined)
})

function makeReq(body: unknown, withAuth = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (withAuth) headers.Authorization = 'Bearer ryas_test_key'
  return new Request('http://localhost/api/v1/agent/run', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/v1/agent/run', () => {
  test('valid request → 200 with answer and iterations', async () => {
    const res = await POST(makeReq({ question: 'What is the weather?' }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.answer).toBe('final answer')
    expect(body.agentRunId).toBe('run1')
    expect(body.iterations).toBe(1)
    expect(body.stepResults).toHaveLength(1)
  })

  test('missing question → 400', async () => {
    const res = await POST(makeReq({}) as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('auth failure (no Bearer token) → 401', async () => {
    const res = await POST(makeReq({ question: 'test' }, false) as any)
    expect(res.status).toBe(401)
  })

  test('Redis rate limit exceeded → 429', async () => {
    mockRateLimit.mockImplementationOnce(async () => ({ allowed: false, remaining: 0 }))
    const res = await POST(makeReq({ question: 'test' }) as any)
    expect(res.status).toBe(429)
  })

  test('empty string question → 400', async () => {
    const res = await POST(makeReq({ question: '   ' }) as any)
    expect(res.status).toBe(400)
  })
})
