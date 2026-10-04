import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
let role = 'admin'
let valid = true
let org: { id: string; slug: string; name: string } | null = null
const auth = mock(async (_opts?: unknown) => ({ userId: 'u', organizationId: 'org', role }))
const update = mock(async (_args: unknown) => ({}))
const validate = mock(async (_key: string, _machine: string) => ({ valid, plan: 'flat', expiresAt: '2027-01-01', message: 'invalid key' }))
mock.module('@/lib/session', () => ({
  getActiveUser: auth,
  requireRole: (user: { role: string }) => { if (user.role !== 'admin') throw Object.assign(new Error('admin required'), { status: 403 }) },
  handleApiError: (e: unknown) => Response.json({ error: 'Activation failed' }, { status: (e as {status?: number}).status ?? 500 }),
}))
mock.module('@/lib/prisma-tenant', () => ({ enterWithOrg: () => {}, bypassOrg: async (fn: () => Promise<unknown>) => await fn() }))
mock.module('@/lib/db', () => ({ db: { organization: { findUnique: async () => org, update } } }))
mock.module('@/lib/license-client', () => ({ validateLicense: validate, generateMachineId: (slug: string) => `machine:${slug}` }))
import { POST } from './route'
const req = (body: unknown) => new NextRequest('http://localhost/api/auth/activate-license', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => { role = 'admin'; valid = true; org = { id: 'org', slug: 'own-org', name: 'Own' }; auth.mockClear(); update.mockClear(); validate.mockClear() })
describe('license activation', () => {
  test('pending/expired admins can validate an entitlement without the ordinary license gate', async () => {
    const res = await POST(req({ licenseKey: ' K ', organizationName: ' Team ' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, license: { plan: 'flat', expiresAt: '2027-01-01' } })
    expect(auth).toHaveBeenCalledWith({ skipLicenseCheck: true })
    expect(validate).toHaveBeenCalledWith('K', 'machine:own-org')
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'org' }, data: { licenseStatus: 'valid', name: 'Team' } })
  })
  test('a viewer cannot change the organization entitlement', async () => {
    role = 'viewer'
    expect((await POST(req({ licenseKey: 'K' }))).status).toBe(403)
    expect(validate).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
  test('invalid or missing credentials never write an entitlement', async () => {
    for (const body of [{}, { licenseKey: 7 }, { licenseKey: ' ' }, { licenseKey: 'K', organizationName: {} }]) expect((await POST(req(body))).status).toBe(400)
    valid = false
    expect((await POST(req({ licenseKey: 'K' }))).status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })
  test('missing organization is a 404', async () => {
    org = null
    expect((await POST(req({ licenseKey: 'K' }))).status).toBe(404)
    expect(validate).not.toHaveBeenCalled()
  })
})
