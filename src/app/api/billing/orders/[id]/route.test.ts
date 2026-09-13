import { describe, expect, test, beforeEach, mock } from 'bun:test'

const mockUser = {
  userId: 'u1',
  name: 'Test',
  email: 't@t.com',
  role: 'viewer',
  organizationId: 'org-1',
  plan: null,
}
let orderRow: Record<string, unknown> | null
let findFirstArgs: Record<string, unknown> | null
/** When set, the DB call rejects with this -- to exercise the route's catch block. */
let dbError: Error | null = null
const handleApiErrorCalls: Array<{ message: string }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) => {
    // Recorded so a test can prove the route routed its failure through the typed error mapper
    // rather than letting the exception escape as an unhandled 500.
    handleApiErrorCalls.push({ message: msg })
    void e
    return Response.json({ error: msg }, { status })
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    order: {
      findFirst: async (args: Record<string, unknown>) => {
        findFirstArgs = args
        if (dbError) throw dbError
        return orderRow
      },
    },
  },
}))

import { GET } from './route'

beforeEach(() => {
  orderRow = null
  findFirstArgs = null
  dbError = null
  handleApiErrorCalls.length = 0
})

describe('GET /api/billing/orders/[id]', () => {
  test('returns own-org order status for polling', async () => {
    orderRow = { status: 'settlement', months: 12, amountIdr: 840000, licenseKeyIssued: 'K-1' }
    const res = await GET(
      new Request('http://localhost/api/billing/orders/order-9') as never,
      { params: Promise.resolve({ id: 'order-9' }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.order).toEqual({
      status: 'settlement',
      months: 12,
      amountIdr: 840000,
      licenseIssued: true,
    })
  })

  test('order from another org → 404 (findFirst is org-scoped)', async () => {
    // Tenant extension injects organizationId into the where clause; the mock
    // asserts the route relies on scoped findFirst (never findUnique by id).
    const res = await GET(
      new Request('http://localhost/api/billing/orders/other') as never,
      { params: Promise.resolve({ id: 'other' }) },
    )
    expect(res.status).toBe(404)
    expect(findFirstArgs).not.toBeNull()
  })
})

describe('GET /api/billing/orders/[id] — failure handling', () => {
  test('a DB failure is routed through handleApiError, not left to escape', async () => {
    // The catch had never executed: both existing tests produced a successful query or a null row.
    // Without it the route's own failure message is lost and the client sees a bare 500 -- for a
    // checkout polling endpoint that means the buy dialog spins with no explanation.
    dbError = new Error('connection terminated unexpectedly')
    const res = await GET(
      new Request('http://localhost/api/billing/orders/order-9') as never,
      { params: Promise.resolve({ id: 'order-9' }) },
    )

    expect(handleApiErrorCalls).toHaveLength(1)
    expect(handleApiErrorCalls[0]!.message).toBe('Failed to load billing order.')
    expect(res.status).toBe(500)
  })

  test('the failure body does NOT leak the database error text', async () => {
    // The raw driver message can contain host, port and user. handleApiError maps it; the route
    // must not pass it through itself.
    dbError = new Error('password authentication failed for user "ryasai"')
    const res = await GET(
      new Request('http://localhost/api/billing/orders/order-9') as never,
      { params: Promise.resolve({ id: 'order-9' }) },
    )
    const body = (await res.json()) as { error?: string }
    expect(body.error).not.toContain('password')
    expect(body.error).not.toContain('ryasai')
  })
})
