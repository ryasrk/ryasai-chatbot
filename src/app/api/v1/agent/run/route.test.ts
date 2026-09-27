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
  /*
   * `organizationId` and `scope` are BOTH required by the real identity shape, and omitting either produced a
   * bare 500 rather than a failure naming the cause.
   *
   * `organizationId` — the route now calls `enterWithOrg(identity.organizationId)` itself, because
   * `AsyncLocalStorage.enterWith()` inside `requireExternalApiKey` does NOT propagate to the caller's frame.
   * Without that call every DB query in the handler ran with no org context, which was a measured
   * cross-tenant read.
   *
   * `scope` — the route passes `resolveScope(identity.scope).tools` so the key's tool restriction is ENFORCED
   * instead of only stored. `resolveScope(undefined)` throws.
   *
   * Empty arrays on every axis mean UNRESTRICTED, so these tests keep their original behaviour.
   */
  return {
    apiKeyId: 'key1',
    label: 'test',
    organizationId: 'org1',
    requestLimitPerMinute: 60,
    scope: { allowedIntegrationIds: [], allowedDocumentIds: [], allowedTools: [] },
  }
})
const mockRateLimit = mock(async (): Promise<{ allowed: boolean; remaining: number } | null> => null) // null = Redis down → DB fallback
const mockWriteAudit = mock(async () => undefined)
const mockUserFindFirst = mock(async () => ({ id: 'admin1' }))
const mockAgentRunCreate = mock(async () => ({ id: 'run1' }))
const mockAgentRunUpdate = mock(async () => ({}))
const mockApiRequestLogCreate = mock(async () => ({}))
/**
 * The parameter is DECLARED, because a mock that takes none makes its call arguments unobservable: `tsc`
 * rejected `mock.calls.at(-1)?.[0]` with "Tuple type '[]' of length '0' has no element at index '0'".
 *
 * Recording the args is the point — the route's tool scope reaches the orchestrator through this call, and a
 * test that cannot see the arguments cannot prove it was forwarded.
 */
const mockRunAgentOrchestrator = mock(async (_opts: { allowedTools?: string[] | null }) => ({
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

describe('POST /api/v1/agent/run — the key tool scope is ENFORCED, not just stored', () => {
  /**
   * CLOSES THE GAP the api-key audit measured: this route read neither `identity.scope` nor
   * `validateKeyScopeSources`, so a key created with `allowedTools: ['RAG']` was stored, validated and
   * DISPLAYED in the admin UI while enforcing nothing on the agentic path.
   *
   * The assertion is on what reaches the ORCHESTRATOR, because that is the call that decides which tools the
   * model may choose from. A test on the route's own variables would pass while the value went no further.
   */
  test('the scope reachable from the identity is forwarded as allowedTools', async () => {
    mockRunAgentOrchestrator.mockClear()
    mockRequireExternalApiKey.mockImplementationOnce(async (req: Request) => {
      const raw = req.headers.get('authorization') ?? ''
      if (!/^Bearer\s+.+$/i.test(raw)) throw new MockUnauthorizedError('API key must be sent as Bearer token.')
      return {
        apiKeyId: 'key-scoped',
        label: 'rag only',
        organizationId: 'org1',
        requestLimitPerMinute: 60,
        scope: { allowedIntegrationIds: [], allowedDocumentIds: [], allowedTools: ['RAG'] },
      } as never
    })

    const res = await POST(makeReq({ question: 'What does the policy say?' }) as never)
    expect(res.status).toBe(200)

    const args = mockRunAgentOrchestrator.mock.calls.at(-1)?.[0] as { allowedTools?: string[] | null }
    // `resolveScope` returns the key's list; the ROUTE must pass it on or the filter never sees it.
    expect(args.allowedTools).toEqual(['RAG'])
  })

  test('an unrestricted key forwards null, so the filter leaves the surface alone', async () => {
    // The opposite direction: empty arrays mean "all tools", and a route that turned that into `[]` would make
    // the filter remove EVERY family — locking out every key created before scoping existed.
    mockRunAgentOrchestrator.mockClear()
    const res = await POST(makeReq({ question: 'hello' }) as never)
    expect(res.status).toBe(200)
    const args = mockRunAgentOrchestrator.mock.calls.at(-1)?.[0] as { allowedTools?: string[] | null }
    expect(args.allowedTools).toBeNull()
  })
})
