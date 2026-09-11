import { describe, expect, test, beforeEach, mock } from 'bun:test'

const mockUser = {
  userId: 'u1',
  name: 'Test',
  email: 't@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}

let orgRecord: { slug: string } | null
let createdOrder: Record<string, unknown> | null
let orderRow: Record<string, unknown> | null

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) =>
    Response.json({ error: msg }, { status }),
  writeAudit: async () => {},
}))

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findUnique: async () => orgRecord,
    },
    order: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdOrder = data
        return { id: 'order-new', ...data }
      },
      findFirst: async () => orderRow,
    },
  },
}))

mock.module('@/lib/midtrans', () => ({
  createSnapTransaction: async (params: { orderId: string; grossAmount: number; itemName: string }) => {
    snapCalls.push(params)
    return { token: `tok-${params.orderId}`, redirectUrl: `https://snap.app/${params.orderId}` }
  },
}))

const snapCalls: Array<{ orderId: string; grossAmount: number; itemName: string }> = []

import { POST } from './route'

beforeEach(() => {
  orgRecord = { slug: 'acme' }
  createdOrder = null
  orderRow = null
  snapCalls.length = 0
})

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/billing/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/billing/orders', () => {
  test('creates a pending order priced from the table, ignoring client amount', async () => {
    const res = await POST(makeRequest({ months: 3, amountIdr: 1 }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.orderId).toBe('order-new')
    expect(body.token).toContain('tok-ord-acme')
    expect(body.redirectUrl).toBeTruthy()

    // Amount comes from the pricing TABLE, not the request body.
    expect(createdOrder!.amountIdr).toBe(270_000)
    expect(createdOrder!.months).toBe(3)
    expect(createdOrder!.status).toBe('pending')
    expect(createdOrder!.currency).toBe('IDR')
    expect(createdOrder!.organizationId).toBe('org-1')

    const midtransOrderId = createdOrder!.midtransOrderId as string
    expect(midtransOrderId.startsWith('ord-acme-')).toBe(true)

    expect(snapCalls.length).toBe(1)
    expect(snapCalls[0].grossAmount).toBe(270_000)
    expect(snapCalls[0].itemName).toBe('ryasai subscription 3 months')
    expect(createdOrder!.snapToken).toBe(`tok-${midtransOrderId}`)
  })

  test('invalid pack months → 400', async () => {
    for (const months of [2, 5, 0, -1, 'abc', undefined]) {
      const res = await POST(makeRequest({ months }) as never)
      expect(res.status).toBe(400)
    }
    expect(createdOrder).toBeNull()
    expect(snapCalls.length).toBe(0)
  })

  test('missing organization → 404', async () => {
    orgRecord = null
    const res = await POST(makeRequest({ months: 1 }) as never)
    expect(res.status).toBe(404)
    expect(createdOrder).toBeNull()
  })
})
