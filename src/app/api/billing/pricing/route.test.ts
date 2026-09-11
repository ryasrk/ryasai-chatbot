import { describe, expect, test, beforeEach, mock } from 'bun:test'

const mockUser = {
  userId: 'u1',
  name: 'Test',
  email: 't@t.com',
  role: 'viewer',
  organizationId: 'org-1',
  plan: null,
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) =>
    Response.json({ error: msg }, { status }),
}))

import { GET } from './route'

beforeEach(() => {
  delete process.env.BILLING_PACKS_JSON
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
