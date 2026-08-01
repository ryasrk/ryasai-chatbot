import { describe, expect, test, mock, beforeEach } from 'bun:test'

let authThrows = false

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authThrows) throw new MockUnauthorizedError()
    return { userId: 'u1', name: 'Test', email: 't@t.com', role: 'admin', organizationId: 'org-default' }
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  UnauthorizedError: MockUnauthorizedError,
}))

mock.module('@/lib/llm-config', () => ({
  isBlockedHost: (hostname: string) => {
    const h = hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h === '::1' ||
      /^127\./.test(h) ||
      /^0\.0\.0\.0$/.test(h) ||
      /^169\.254\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
      /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h) ||
      /^fd[0-9a-f]/.test(h) ||
      /^fe[89ab][0-9a-f]/.test(h)
    )
  },
}))

import { POST } from './route'

beforeEach(() => {
  authThrows = false
})

describe('POST /api/fetch-url', () => {
  test('returns 401 when auth fails', async () => {
    authThrows = true
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  test('returns 400 when url is missing', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  test('returns 400 when url is invalid', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'not-a-url' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  test('returns 403 for blocked host 127.0.0.1', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(403)
  })
})
