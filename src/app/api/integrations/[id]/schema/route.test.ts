import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let integrationExisting: Record<string, unknown> | null = { id: 'int-1' }
let schemaRow: Record<string, unknown> | null = {
  id: 'sch-1',
  tableName: 'orders',
  description: 'auto desc',
  manualDescription: false,
}

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => integrationExisting,
    },
    integrationSchema: {
      findFirst: async () => schemaRow,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'sch-1',
        tableName: schemaRow?.tableName ?? 'orders',
        description: data.description ?? null,
        manualDescription: data.manualDescription ?? false,
      }),
    },
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => getActiveUserImpl(),
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) throw new Error('Forbidden')
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditCalls.push(args)
  },
  handleApiError: (e: unknown, fallback: string) =>
    new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: e instanceof Error ? e.message : fallback } }),
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 },
    ),
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}) }))
mock.module('@/lib/connectors', () => ({ connectorRegistry: { getConnector: () => ({ fetchSchema: async () => [] }) } }))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => {} }))

const { PATCH } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/integrations/${id}/schema`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  integrationExisting = { id: 'int-1' }
  schemaRow = { id: 'sch-1', tableName: 'orders', description: 'auto desc', manualDescription: false }
})

describe('PATCH /api/integrations/[id]/schema', () => {
  test('set description → manualDescription=true', async () => {
    const res = await patch('int-1', { table: 'orders', description: 'manual override' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.schema.manualDescription).toBe(true)
    expect(json.schema.description).toBe('manual override')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('SCHEMA_DESC_UPDATE')
  })

  test('null description → manualDescription=false + description null', async () => {
    const res = await patch('int-1', { table: 'orders', description: null })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.schema.manualDescription).toBe(false)
    expect(json.schema.description).toBeNull()
  })

  test('unknown table → 404', async () => {
    schemaRow = null
    const res = await patch('int-1', { table: 'nope', description: 'x' })
    expect(res.status).toBe(404)
  })

  test('unknown integration → 404', async () => {
    integrationExisting = null
    const res = await patch('nope', { table: 'orders', description: 'x' })
    expect(res.status).toBe(404)
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('int-1', { table: 'orders', description: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('>500 chars → 400', async () => {
    const res = await patch('int-1', { table: 'orders', description: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('int-1', { table: 'orders', description: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})
