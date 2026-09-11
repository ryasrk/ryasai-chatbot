import { describe, expect, test, mock } from 'bun:test'

// ponytail: each *.test.ts runs in its own bun subprocess (mock.module leaks
// across files in one process). Mock the DB + license-issue deps so this test
// exercises the pure eligibility filter and the runner's summary accounting.
const issueCalls: string[] = []
let issueResults: Array<{ ok: boolean; reason?: string }> = []

// Mutable fake db — the runner reaches db.order.findMany through bypassOrg.
const fakeOrder = {
  findMany: async (): Promise<unknown[]> => [],
}
mock.module('./db', () => ({ db: { order: fakeOrder } }))
mock.module('./prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => T) => fn(),
  enterWithOrg: () => {},
}))
mock.module('./license-issue', () => ({
  issueLicenseForOrder: async (orderId: string) => {
    issueCalls.push(orderId)
    return issueResults.shift() ?? { ok: true }
  },
}))
mock.module('./logger', () => ({
  scopedLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

const { selectReconcilableOrders, runOrderReconciliation } = await import('./order-reconcile')

const NOW = new Date('2026-08-26T09:00:00.000Z')
const MIN_AGE = 2 * 60 * 1000

function order(overrides: Partial<{
  id: string
  status: string
  licenseKeyIssued: string | null
  paidAt: Date | null
  updatedAt: Date
}> = {}) {
  return {
    id: 'ord-1',
    status: 'settlement',
    licenseKeyIssued: null,
    paidAt: new Date(NOW.getTime() - 10 * MIN_AGE),
    updatedAt: new Date(NOW.getTime() - 10 * MIN_AGE),
    ...overrides,
  }
}

describe('selectReconcilableOrders — eligibility', () => {
  test('keeps settled orders without a key past the grace window', () => {
    const kept = selectReconcilableOrders(
      [
        order({ id: 'old-enough' }),
        // too fresh — the webhook's inline issuance may still be running
        order({ id: 'too-fresh', paidAt: new Date(NOW.getTime() - MIN_AGE / 2) }),
        // already issued — revalidation owns it
        order({ id: 'issued', licenseKeyIssued: 'LIC-1' }),
        // not settled (pending/failed) — money state not final
        order({ id: 'pending', status: 'pending' }),
      ],
      NOW,
    )
    expect(kept.map((o) => o.id)).toEqual(['old-enough'])
  })

  test('falls back to updatedAt when paidAt is null', () => {
    const kept = selectReconcilableOrders(
      [
        order({ id: 'via-updated-at', paidAt: null, updatedAt: new Date(NOW.getTime() - 30 * MIN_AGE) }),
        order({ id: 'updated-too-recently', paidAt: null, updatedAt: NOW }),
      ],
      NOW,
    )
    expect(kept.map((o) => o.id)).toEqual(['via-updated-at'])
  })

  test('boundary: exactly minAge is eligible', () => {
    const kept = selectReconcilableOrders(
      [order({ paidAt: new Date(NOW.getTime() - MIN_AGE) })],
      NOW,
    )
    expect(kept).toHaveLength(1)
  })
})

describe('runOrderReconciliation — summary accounting', () => {
  test('re-runs issuance per eligible order and counts outcomes', async () => {
    issueCalls.length = 0
    issueResults = [{ ok: true }, { ok: false, reason: 'generate returned 503' }]
    fakeOrder.findMany = async () => [
      order({ id: 'a' }),
      order({ id: 'b' }),
      order({ id: 'c', licenseKeyIssued: 'have-key' }),
      order({ id: 'd', status: 'expire' }),
    ]

    const summary = await runOrderReconciliation(NOW)
    expect(summary.scanned).toBe(4)
    expect(summary.eligible).toBe(2)
    expect(issueCalls.sort()).toEqual(['a', 'b'])
    expect(summary.issued).toBe(1)
    expect(summary.failed).toBe(1)
  })
})
