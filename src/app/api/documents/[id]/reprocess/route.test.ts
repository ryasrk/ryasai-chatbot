import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const user = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
let getActiveUserImpl: () => Promise<typeof user> = async () => user

const auditCalls: Array<Record<string, unknown>> = []
const enqueueCalls: Array<{ type: string; data: Record<string, unknown> }> = []
let enqueueResult: 'queued' | 'sync' = 'queued'

let docResult: Record<string, unknown> | null = null

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findFirst: async () => docResult,
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
      JSON.stringify({ error: { code: 'INTERNAL', message: e instanceof Error ? e.message : fallback } }),
      { status: 401 },
    ),
}))
mock.module('@/lib/job-processor', () => ({
  enqueueOrSync: async (type: string, data: Record<string, unknown>) => {
    enqueueCalls.push({ type, data })
    return enqueueResult
  },
}))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => {} }))
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T,>(fn: () => T) => fn(),
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))
const enterCalls: string[] = []

const { POST } = await import('./route')

function post(id = 'doc-1'): Promise<Response> {
  const req = new Request(`http://localhost/api/documents/${id}/reprocess`, { method: 'POST' })
  return POST(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => user
  auditCalls.length = 0
  enqueueCalls.length = 0
  enterCalls.length = 0
  enqueueResult = 'queued'
  docResult = { id: 'doc-1', name: 'a.pdf', status: 'error', cognifyStatus: null }
})

describe('POST /api/documents/[id]/reprocess', () => {
  test('auth failure → handleApiError (no DB access)', async () => {
    getActiveUserImpl = async () => {
      throw new Error('Unauthorized')
    }
    const res = await post()
    expect(res.status).toBe(401)
    expect(enqueueCalls).toHaveLength(0)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await post()
    expect(enterCalls).toEqual(['org-1'])
  })

  test('missing document → 404', async () => {
    docResult = null
    const res = await post()
    expect(res.status).toBe(404)
    expect(enqueueCalls).toHaveLength(0)
  })

  test('non-failed document → 409, nothing enqueued', async () => {
    docResult = { id: 'doc-1', name: 'a.pdf', status: 'ready', cognifyStatus: 'completed' }
    const res = await post()
    expect(res.status).toBe(409)
    expect(enqueueCalls).toHaveLength(0)
  })

  test('failed document re-enqueues embed + cognify like the upload path', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(enqueueCalls.map((c) => c.type)).toEqual(['document-embed', 'document-cognify'])
    expect(enqueueCalls[0].data).toEqual({
      type: 'document-embed',
      documentId: 'doc-1',
      organizationId: 'org-1',
    })
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('DOC_REPROCESS')
  })

  test('cognifyStatus=failed alone also qualifies as failed', async () => {
    docResult = { id: 'doc-1', name: 'a.pdf', status: 'ready', cognifyStatus: 'failed' }
    const res = await post()
    expect(res.status).toBe(200)
    expect(enqueueCalls).toHaveLength(2)
  })
})
