import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

// --- Mocks: session/db chain + metrics renderer, so the route module loads ---
const getActiveUserMock = mock(async (): Promise<unknown> => {
  throw new Error('getActiveUser not stubbed')
})
const requireRoleMock = mock((_user?: unknown, _role?: string) => {})
mock.module('@/lib/session', () => ({
  getActiveUser: getActiveUserMock,
  requireRole: requireRoleMock,
  enterWithOrg: mock(() => {}),
  handleApiError: (e: unknown, fallback: string) => {
    const status =
      e instanceof Error && e.name === 'ForbiddenError'
        ? 403
        : e instanceof Error && e.name === 'UnauthorizedError'
          ? 401
          : 500
    return Response.json({ error: { message: e instanceof Error ? e.message : fallback } }, { status })
  },
  UnauthorizedError: class UnauthorizedError extends Error {
    name = 'UnauthorizedError'
  },
  ForbiddenError: class ForbiddenError extends Error {
    name = 'ForbiddenError'
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: mock(() => {}),
  bypassOrg: mock(async (fn: () => unknown) => fn()),
  getOrgContext: mock(() => null),
}))
mock.module('@/lib/metrics', () => ({
  initMetrics: mock(() => {}),
  prometheusText: mock(() => '# HELP test_metric 1\n'),
}))

// Re-stub getActiveUser per scenario via the session mock above.
function stubActiveUser(impl: () => Promise<unknown>) {
  getActiveUserMock.mockImplementation(impl as never)
}

import { GET } from './route'

const ADMIN = { userId: 'u1', organizationId: 'org1', role: 'admin' }
const VIEWER = { userId: 'u2', organizationId: 'org1', role: 'viewer' }

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/metrics', { headers })
}

beforeEach(() => {
  delete process.env.METRICS_TOKEN
  getActiveUserMock.mockImplementation(async () => {
    throw new Error('not stubbed')
  })
})

afterEach(() => {
  delete process.env.METRICS_TOKEN
})

describe('GET /api/metrics — METRICS_TOKEN mode', () => {
  test('correct bearer token → 200 prometheus text', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    const res = await GET(req({ Authorization: 'Bearer secret-token' }) as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('test_metric')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('wrong bearer token → 401', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    const res = await GET(req({ Authorization: 'Bearer wrong' }) as never)
    expect(res.status).toBe(401)
  })

  test('missing Authorization header → 401', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    const res = await GET(req() as never)
    expect(res.status).toBe(401)
  })

  test('non-bearer Authorization scheme → 401', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    const res = await GET(req({ Authorization: 'Basic c2VjcmV0' }) as never)
    expect(res.status).toBe(401)
  })

  test('empty bearer value → 401', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    const res = await GET(req({ Authorization: 'Bearer ' }) as never)
    expect(res.status).toBe(401)
  })

  test('token set → admin session NOT required (scrape path)', async () => {
    process.env.METRICS_TOKEN = 'secret-token'
    let called = false
    getActiveUserMock.mockImplementation(async () => {
      called = true
      return ADMIN
    })
    await GET(req({ Authorization: 'Bearer secret-token' }) as never)
    expect(called).toBe(false)
  })
})

describe('GET /api/metrics — no token → admin session fallback', () => {
  test('admin session → 200 and requireRole called with admin', async () => {
    stubActiveUser(async () => ADMIN)
    const res = await GET(req() as never)
    expect(res.status).toBe(200)
    expect(requireRoleMock).toHaveBeenCalledWith(ADMIN, 'admin')
  })

  test('unauthenticated → 401 via getActiveUser throwing', async () => {
    stubActiveUser(async () => {
      throw Object.assign(new Error('No active session.'), { name: 'UnauthorizedError' })
    })
    const res = await GET(req() as never)
    expect(res.status).toBe(401)
  })

  test('viewer session → 403 (requireRole throws)', async () => {
    stubActiveUser(async () => VIEWER)
    requireRoleMock.mockImplementation((user: unknown) => {
      if (((user as { role?: string }).role ?? 'viewer') !== 'admin') {
        throw Object.assign(new Error('Requires admin role.'), { name: 'ForbiddenError' })
      }
    })
    const res = await GET(req() as never)
    expect(res.status).toBe(403)
    requireRoleMock.mockImplementation(() => {})
  })

  test('never anonymous: without token AND without session → not 200', async () => {
    stubActiveUser(async () => {
      throw Object.assign(new Error('No active session.'), { name: 'UnauthorizedError' })
    })
    const res = await GET(req() as never)
    expect(res.status).not.toBe(200)
  })
})
