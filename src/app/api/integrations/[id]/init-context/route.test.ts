import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
let role = 'admin'
let profile = 'Retail orders and customers'
let reads = 0
let integration: { id: string; name: string; provider: string; organizationId: string } | null
let schemas: Array<{ tableName: string; columns: string; rowCount: number; sampleRow: string }>
const update = mock(async (_args: unknown) => ({}))
const enrich = mock(async (_id: string, _name: string) => {})
const audit = mock(async () => {})
mock.module('@/lib/prisma-tenant', () => ({ enterWithOrg: () => {} }))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => ({ userId: 'u', organizationId: 'own', role }),
  requireRole: (user: { role: string }) => { if (user.role !== 'admin') throw Object.assign(new Error('admin required'), { status: 403 }) },
  writeAudit: audit,
  handleApiError: (e: unknown) => Response.json({ ok: false }, { status: (e as {status?: number}).status ?? 500 }),
}))
mock.module('@/lib/db', () => ({ db: { integration: { findFirst: async () => ++reads === 1 ? integration : { ...integration, schemas }, update } } }))
mock.module('@/lib/schema-enrichment', () => ({ enrichSchemaDescriptions: enrich, safeParseColumns: JSON.parse, safeParseSampleRow: JSON.parse }))
mock.module('@/lib/ai', () => ({ generateDatabaseProfile: async () => profile }))
import { POST } from './route'
const call = () => POST(new NextRequest('http://localhost/api/integrations/id/init-context', { method: 'POST' }), { params: Promise.resolve({ id: 'id' }) })
beforeEach(() => { role = 'admin'; profile = 'Retail orders and customers'; reads = 0; integration = { id: 'id', name: 'Retail', provider: 'POSTGRESQL', organizationId: 'own' }; schemas = [{ tableName: 'orders', columns: '[]', rowCount: 3, sampleRow: '{}' }]; update.mockClear(); enrich.mockClear(); audit.mockClear() })
describe('initialize integration context', () => {
  test('returns the generated context only after it is persisted', async () => {
    const res = await call()
    expect(await res.json()).toMatchObject({ ok: true, data: { id: 'id', businessContext: profile, contextLength: profile.length, tableCount: 1 } })
    expect(update.mock.calls[0][0]).toEqual({ where: { id: 'id' }, data: { businessContext: profile } })
  })
  test('foreign or absent integration is refused before enrichment', async () => {
    integration = null
    expect((await call()).status).toBe(404)
    expect(enrich).not.toHaveBeenCalled()
  })
  test('viewer cannot trigger provider work', async () => {
    role = 'viewer'
    expect((await call()).status).toBe(403)
    expect(enrich).not.toHaveBeenCalled()
  })
  test('missing schema does not fabricate a context', async () => {
    schemas = []
    expect((await call()).status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })
  test('an empty provider answer is failure, not a successful no-op', async () => {
    profile = ' '
    const res = await call()
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false })
    expect(update).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
