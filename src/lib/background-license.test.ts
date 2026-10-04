import { beforeEach, expect, mock, test } from 'bun:test'

let organization: { licenseStatus: string; licenseValidatedAt: Date | null } | null
const lookups: unknown[] = []
mock.module('@/lib/db', () => ({ db: { organization: { findUnique: async (args: unknown) => {
  lookups.push(args)
  return organization
} } } }))
mock.module('@/lib/prisma-tenant', () => ({ bypassOrg: async (fn: () => Promise<unknown>) => fn() }))
const { backgroundLockdownReason } = await import('./background-license')
beforeEach(() => { organization = { licenseStatus: 'valid', licenseValidatedAt: null }; lookups.length = 0 })

for (const [status, reason] of [['valid', null], ['none', 'unpaid'], ['unpaid', 'unpaid'], ['expired', 'expired'], ['invalid', 'expired'], ['suspended', 'deactivated'], ['unknown', 'expired']] as const) {
  test(`background entitlement ${status} resolves to ${reason}`, async () => {
    organization!.licenseStatus = status
    expect(await backgroundLockdownReason('owned-org')).toBe(reason)
    expect(lookups[0]).toEqual({ where: { id: 'owned-org' }, select: { licenseStatus: true, licenseValidatedAt: true } })
  })
}
test('missing org and empty payload cannot establish entitlement', async () => {
  organization = null
  expect(await backgroundLockdownReason('missing')).toBe('expired')
  lookups.length = 0
  expect(await backgroundLockdownReason('')).toBe('expired')
  expect(lookups).toHaveLength(0)
})
test('validator outage permits only the recorded grace period', async () => {
  organization = { licenseStatus: 'unreachable', licenseValidatedAt: new Date() }
  expect(await backgroundLockdownReason('owned-org')).toBeNull()
  organization.licenseValidatedAt = new Date(0)
  expect(await backgroundLockdownReason('owned-org')).toBe('unreachable')
})
