import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let docExisting: Record<string, unknown> | null = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findFirst: async () => docExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'doc-1',
        isEnabled: data.isEnabled ?? true,
        contextPrompt: typeof data.contextPrompt === 'string' ? data.contextPrompt : '',
        updatedAt: 't',
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
      JSON.stringify({ error: { code: e instanceof Error && 'name' in e ? 'FORBIDDEN' : 'INTERNAL', message: e instanceof Error ? e.message : fallback } }),
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 },
    ),
}))
mock.module('@/lib/cognee', () => ({
  forgetKnowledgeGraph: async () => {},
  cognifyDocument: async () => {},
}))
mock.module('@/lib/rag', () => ({ invalidateRagCache: async () => {} }))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => {} }))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))

const { PATCH } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }
})

describe('PATCH /api/documents/[id] contextPrompt', () => {
  test('admin can set contextPrompt', async () => {
    const res = await patch('doc-1', { contextPrompt: 'use SOP-7 for billing' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.contextPrompt).toBe('use SOP-7 for billing')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('DOC_UPDATE')
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('doc-1', { contextPrompt: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('>4000 chars → 400', async () => {
    const res = await patch('doc-1', { contextPrompt: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  test('whitespace is trimmed before length check & persistence', async () => {
    const res = await patch('doc-1', { contextPrompt: '   hi   ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.contextPrompt).toBe('hi')
  })

  test('404 for unknown id', async () => {
    docExisting = null
    const res = await patch('nope', { contextPrompt: 'x' })
    expect(res.status).toBe(404)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('doc-1', { contextPrompt: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})
