import { describe, expect, test, mock, beforeEach } from 'bun:test'

const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let user: typeof admin = admin

let integration: Record<string, unknown> | null = null
let policyRows: Array<{ role: string; tableName: string; allowedColumns: string | null }> = []
const events: string[] = []
let created: Array<Record<string, unknown>> = []
let updatedMode: unknown = null
const audits: Array<Record<string, unknown>> = []

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => integration,
      update: async (q: { data: { accessMode: unknown } }) => {
        events.push('integration.update')
        updatedMode = q.data.accessMode
        return {}
      },
    },
    dataAccessPolicy: {
      findMany: async () => policyRows,
      deleteMany: async () => {
        events.push('policy.deleteMany')
        return { count: policyRows.length }
      },
      createMany: async (q: { data: Array<Record<string, unknown>> }) => {
        events.push('policy.createMany')
        created = q.data
        return { count: q.data.length }
      },
    },
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => events.push(`enterWithOrg:${o}`),
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role: string }, role: string) => {
    if (role === 'admin' && u.role !== 'admin') {
      const e = new Error('forbidden')
      e.name = 'ForbiddenError'
      throw e
    }
  },
  writeAudit: async (a: Record<string, unknown>) => {
    audits.push(a)
  },
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ ok: false, error: msg }, { status: (e as Error)?.name === 'ForbiddenError' ? 403 : 500 }),
}))

const { GET, PUT } = await import('./route')

const ctx = { params: Promise.resolve({ id: 'int-1' }) }
const put = (body: unknown) =>
  PUT(new Request('http://x/api/integrations/int-1/access-policy', { method: 'PUT', body: JSON.stringify(body) }) as never, ctx)

beforeEach(() => {
  user = admin
  integration = {
    id: 'int-1',
    name: 'HR',
    accessMode: 'open',
    schemas: [
      { tableName: 'employees', columns: '[{"name":"id"},{"name":"name"},{"name":"salary"}]' },
      { tableName: 'departments', columns: '[{"name":"id"},{"name":"name"}]' },
    ],
  }
  policyRows = []
  events.length = 0
  created = []
  updatedMode = null
  audits.length = 0
})

describe('GET access-policy', () => {
  test('returns the mode, the reflected tables and the grants per role', async () => {
    policyRows = [
      { role: 'viewer', tableName: 'employees', allowedColumns: '["id","name"]' },
      { role: 'analyst', tableName: 'departments', allowedColumns: null },
    ]
    const res = await GET(new Request('http://x') as never, ctx)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(res.status).toBe(200)
    expect(body.data.accessMode).toBe('open')
    expect(body.data.tables).toEqual([
      { tableName: 'employees', columns: ['id', 'name', 'salary'] },
      { tableName: 'departments', columns: ['id', 'name'] },
    ])
    expect(body.data.grants).toEqual({ analyst: { departments: null }, viewer: { employees: ['id', 'name'] } })
  })

  test('is admin-only', async () => {
    user = viewer
    const res = await GET(new Request('http://x') as never, ctx)
    expect(res.status).toBe(403)
  })

  test('enters the session org before reading', async () => {
    await GET(new Request('http://x') as never, ctx)
    expect(events[0]).toBe('enterWithOrg:org-1')
  })
})

describe('PUT access-policy', () => {
  test('replaces the grants, sets the mode and audits the change', async () => {
    const res = await put({ accessMode: 'restricted', grants: { viewer: { employees: ['id', 'name'] }, analyst: { employees: null } } })
    expect(res.status).toBe(200)
    expect(events).toEqual(['enterWithOrg:org-1', 'policy.deleteMany', 'policy.createMany', 'integration.update'])
    expect(created).toEqual([
      { role: 'viewer', tableName: 'employees', allowedColumns: '["id","name"]', organizationId: 'org-1', integrationId: 'int-1' },
      { role: 'analyst', tableName: 'employees', allowedColumns: null, organizationId: 'org-1', integrationId: 'int-1' },
    ])
    expect(updatedMode).toBe('restricted')
    expect(audits[0].action).toBe('ACCESS_POLICY_UPDATE')
  })

  test('is admin-only and writes nothing for a viewer', async () => {
    user = viewer
    const res = await put({ accessMode: 'open', grants: {} })
    expect(res.status).toBe(403)
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test.each([
    [{ accessMode: 'closed', grants: {} }, 'accessMode'],
    [{ accessMode: 'restricted', grants: { admin: { employees: null } } }, 'admin is never restricted'],
    [{ accessMode: 'restricted', grants: { viewer: { payroll: null } } }, 'Unknown table'],
    [{ accessMode: 'restricted', grants: { viewer: { employees: ['ssn'] } } }, 'Unknown column'],
    [{ accessMode: 'restricted', grants: { viewer: { employees: [] } } }, 'non-empty array'],
  ])('an invalid body is refused with nothing written: %j', async (body, message) => {
    const res = await put(body)
    expect(res.status).toBe(400)
    expect(String(((await res.json()) as { error: string }).error)).toContain(message)
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test('an unknown integration is 404', async () => {
    integration = null
    const res = await put({ accessMode: 'open', grants: {} })
    expect(res.status).toBe(404)
  })
})
