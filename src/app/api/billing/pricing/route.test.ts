import { describe, expect, test, beforeEach, mock } from 'bun:test'

const mockUser = {
  userId: 'u1',
  name: 'Test',
  email: 't@t.com',
  role: 'viewer',
  organizationId: 'org-1',
  plan: null,
}

/** When true the session lookup THROWS, exercising the route's catch. */
let sessionThrows = false

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (sessionThrows) throw new Error('session store unavailable')
    return mockUser
  },
  handleApiError: (e: unknown, msg: string, status = 500) =>
    Response.json({ error: msg }, { status }),
}))

import { GET } from './route'

beforeEach(() => {
  delete process.env.BILLING_PACKS_JSON
  sessionThrows = false
})

describe('GET /api/billing/pricing', () => {
  test('returns default pack list', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.packs).toEqual([
      { months: 1, amountIdr: 100_000 },
      { months: 3, amountIdr: 270_000 },
      { months: 6, amountIdr: 480_000 },
      { months: 12, amountIdr: 840_000 },
    ])
  })

  test('honours BILLING_PACKS_JSON override', async () => {
    process.env.BILLING_PACKS_JSON =
      '[{"months":1,"amountIdr":150000},{"months":3,"amountIdr":400000}]'
    const res = await GET()
    const body = await res.json()
    expect(body.packs).toEqual([
      { months: 1, amountIdr: 150_000 },
      { months: 3, amountIdr: 400_000 },
    ])
  })
})

describe('GET /api/billing/pricing — the error path', () => {
  test('a failing session lookup answers through handleApiError, not a 500 crash', async () => {
    // The route wraps everything in try/catch and delegates to handleApiError, which
    // is what turns an arbitrary throw into a well-formed JSON error with a stable
    // message. Without it the framework would emit a generic 500 with no `error` field,
    // and this screen ("Buy License") would fail with nothing the user can act on.
    sessionThrows = true
    const res = await GET()
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Failed to load pricing.')
  })

  test('the error message is the route\'s own, never the raw internal error', async () => {
    // A raw message such as "session store unavailable" would leak infrastructure
    // detail to an unauthenticated-ish endpoint. The route passes a FIXED string.
    sessionThrows = true
    const res = await GET()
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain('session store unavailable')
  })
})
