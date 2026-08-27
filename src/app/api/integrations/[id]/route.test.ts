import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let integrationExisting: Record<string, unknown> | null = { id: 'int-1', name: 'prod db', status: 'active', contextPrompt: null }

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => integrationExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'int-1',
        name: typeof data.name === 'string' ? data.name : 'prod db',
        status: typeof data.status === 'string' ? data.status : 'active',
        contextPrompt: typeof data.contextPrompt === 'string' ? data.contextPrompt : null,
        updatedAt: 't',
      }),
    },
  },
  isPrismaNotFound: (e: unknown) => e instanceof Error && /P2025/.test(e.message),
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
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}), maskConfig: () => ({}) }))
mock.module('@/lib/connectors', () => ({ connectorRegistry: { drop: () => {} } }))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))

const { PATCH } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/integrations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  integrationExisting = { id: 'int-1', name: 'prod db', status: 'active', contextPrompt: null }
})

describe('PATCH /api/integrations/[id] contextPrompt', () => {
  test('contextPrompt accepted alongside existing fields', async () => {
    const res = await patch('int-1', { contextPrompt: 'sales schema only', name: ' sales ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.name).toBe('sales')
    expect(json.data.contextPrompt).toBe('sales schema only')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('INTEGRATION_UPDATE')
  })

  test('>4000 chars → 400', async () => {
    const res = await patch('int-1', { contextPrompt: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  test('whitespace trimmed', async () => {
    const res = await patch('int-1', { contextPrompt: '   hi   ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.contextPrompt).toBe('hi')
  })

  test('404 for unknown id', async () => {
    integrationExisting = null
    const res = await patch('nope', { contextPrompt: 'x' })
    expect(res.status).toBe(404)
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('int-1', { contextPrompt: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('int-1', { contextPrompt: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})
