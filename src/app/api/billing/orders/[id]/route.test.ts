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

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) =>
    Response.json({ error: msg }, { status }),
}))

mock.module('@/lib/db', () => ({
  db: {
    order: {
      findFirst: async (args: Record<string, unknown>) => {
        findFirstArgs = args
        return orderRow
      },
    },
  },
}))

import { GET } from './route'

beforeEach(() => {
  orderRow = null
  findFirstArgs = null
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
