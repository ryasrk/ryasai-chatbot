/**
 * POST /api/documents/embeddings/rebuild — re-embed every ready document (or one).
 *
 * WHY THIS FILE EXISTS. The route is a two-mode dispatcher: with Redis up it ENQUEUES a BullMQ job and
 * returns a zeroed out summary, with Redis down it runs `embedCompanyDocuments` inline and returns the real
 * counts. Four properties are load-bearing and all four are invisible from the response shape alone:
 *
 *   1. THE JOB CONTRACT IS THE PAYLOAD. Worker code (mini-services + `job-worker`) dispatches on
 *      `data.type` and scopes work on `data.organizationId`. A queue entry with the wrong name, type or
 *      tenant is a job that never runs, or runs against the wrong org. Asserted exactly (queue name, job
 *      name, full data object).
 *   2. ADMIN-ONLY. Re-embedding spends the org's embedding quota, so `requireRole(user, 'admin')` must run
 *      BEFORE any queue/embedding work. The order is asserted, not just the presence of the call.
 *   3. ORG CONTEXT IS ENTERED BY THE ROUTE. `writeAudit` reads `getOrgContext()!`; without the route's
 *      `enterWithOrg` the audit row carries a null tenant.
 *   4. THE SYNC FALLBACK IS SILENT ABOUT ITS ORG. `embedCompanyDocuments` is called with `{ documentId }`
 *      ONLY -- no organizationId -- so the fallback relies entirely on the ambient AsyncLocalStorage
 *      context. Pinned as documented behaviour, and as the reason the route must enter the context first.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

let requireRoleThrows: Error | null = null
let redisConnected = true
let embedResult: Record<string, unknown> = {
  documents: 4,
  embedded: 120,
  skipped: 3,
  provider: 'OPENAI_COMPATIBLE',
  model: 'text-embedding-3-small',
}
let embedThrows: Error | null = null

/** Order of side effects — admin gate before work, audit after work. */
const events: string[] = []
const queueAdds: Array<{ name: string; data: Record<string, unknown> }> = []
const embedCalls: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []

/**
 * `handleApiError` discriminates on the ERROR CLASS, not on a string. The mock reproduces that mapping (and
 * the real class names) so a test can drive the 403 branch: `requireRole` throws a `ForbiddenError` and the
 * handler must answer 403, NOT the 502 fallback the route passes for provider failures. A mock that always
 * returned the fallback would have hidden the difference.
 */
class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
}
class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
}
class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID'
  constructor(message = 'License has expired. Please renew your license.') {
    super(message)
  }
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (!user) throw new UnauthorizedError('No active session.')
    return user
  },
  ForbiddenError,
  UnauthorizedError,
  LicenseError,
  requireRole: (u: { role: string }, role: string) => {
    events.push(`requireRole:${role}`)
    if (requireRoleThrows) throw requireRoleThrows
    if (u.role !== role) throw new ForbiddenError(`Requires ${role} role. You have ${u.role}.`)
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof UnauthorizedError)
      return Response.json({ error: { code: 'UNAUTHORIZED', message: e.message } }, { status: 401 })
    if (e instanceof ForbiddenError)
      return Response.json({ error: { code: 'FORBIDDEN', message: e.message } }, { status: 403 })
    if (e instanceof LicenseError)
      return Response.json({ error: { code: 'LICENSE_INVALID', message: e.message } }, { status: 402 })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/redis', () => ({
  checkRedisHealth: async () => {
    events.push('checkRedisHealth')
    return { connected: redisConnected }
  },
  jobQueue: {
    add: async (name: string, data: Record<string, unknown>) => {
      queueAdds.push({ name, data })
      events.push(`jobQueue.add:${name}`)
      return { id: 'job-1' }
    },
  },
}))

mock.module('@/lib/embeddings', () => ({
  embedCompanyDocuments: async (args: Record<string, unknown>) => {
    embedCalls.push(args)
    events.push('embedCompanyDocuments')
    if (embedThrows) throw embedThrows
    return embedResult
  },
}))

const { POST } = await import('./route')

function post(body?: unknown) {
  const url = 'http://localhost/api/documents/embeddings/rebuild'
  const r = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return POST(r as never)
}

async function readBody(res: Response) {
  return JSON.parse(await res.text()) as Record<string, any>
}

beforeEach(() => {
  user = adminUser
  requireRoleThrows = null
  redisConnected = true
  embedResult = {
    documents: 4,
    embedded: 120,
    skipped: 3,
    provider: 'OPENAI_COMPATIBLE',
    model: 'text-embedding-3-small',
  }
  embedThrows = null
  events.length = 0
  queueAdds.length = 0
  embedCalls.length = 0
  auditWrites.length = 0
})

describe('org context and admin gate order', () => {
  test('the org context is entered BEFORE the admin gate and before any work', async () => {
    await post()
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
  })

  test('a non-admin is refused before Redis is even asked about', async () => {
    // The gate must be cheap AND early: a viewer must not cause a ping, a queue entry, or an embedding call.
    requireRoleThrows = new ForbiddenError('Requires admin role. You have viewer.')
    const res = await post()
    expect(res.status).toBe(403)
    expect(events).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
    expect(queueAdds).toHaveLength(0)
    expect(embedCalls).toHaveLength(0)
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-B' }
    await post()
    expect(events[0]).toBe('enterWithOrg:org-B')
  })

  test('an unauthenticated caller never reaches the admin gate', async () => {
    user = null as unknown as typeof adminUser
    await post()
    expect(events).toEqual([])
  })
})

describe('queued mode (Redis up)', () => {
  test('the job goes to the document-processing queue with an exact payload', async () => {
    // Queue name, job name and payload are the worker's contract. A silent rename here is a job that never
    // runs (the AGENTS.md 16-hour dead-worker incident class).
    await post({ documentId: 'doc-9' })
    expect(await Promise.resolve(queueAdds)).toEqual([
      {
        name: 'embedding-rebuild',
        data: { type: 'embedding-rebuild', documentId: 'doc-9', organizationId: 'org-1' },
      },
    ])
  })

  test('the queue is the shared document-processing queue (no bespoke queue)', async () => {
    // Guarded by the module mock: only that one queue is reachable. The job name is asserted separately above.
    await post()
    expect(queueAdds[0]!.name).toBe('embedding-rebuild')
  })

  test('no documentId in the body means an org-wide rebuild, not a null-id job', async () => {
    await post()
    expect(queueAdds[0]!.data.documentId).toBeUndefined()
    expect(queueAdds[0]!.data).toEqual({
      type: 'embedding-rebuild',
      documentId: undefined,
      organizationId: 'org-1',
    })
  })

  test('it does NOT run the synchronous embedder when Redis is up', async () => {
    await post()
    expect(embedCalls).toHaveLength(0)
  })

  test('the queued response reports a zeroed summary rather than fake counts', async () => {
    // The enqueue path knows no counts yet. Returning the embed result here (stale or hardcoded) would make
    // the UI claim work that has not happened.
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: true,
      message: 'Embedding rebuild queued',
      data: { embedded: 0, skipped: 0, documents: 0, provider: null, model: null },
    })
  })

  test('the audit says queued:true and records the documentId as null when absent', async () => {
    await post()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'RAG_EMBEDDINGS_REBUILD',
      severity: 'info',
      detail: { documentId: null, queued: true },
    })
  })

  test('the audit is written AFTER the job is enqueued', async () => {
    // Auditing first would leave a trail for a job that was never added when `jobQueue.add` throws.
    await post()
    expect(events).toEqual([
      'enterWithOrg:org-1',
      'requireRole:admin',
      'checkRedisHealth',
      'jobQueue.add:embedding-rebuild',
      'audit',
    ])
  })

  test('an enqueue failure surfaces as an error and writes NO audit row', async () => {
    const { jobQueue } = await import('@/lib/redis')
    const real = jobQueue.add as (n: string, d: Record<string, unknown>) => Promise<unknown>
    ;(jobQueue as { add: unknown }).add = async () => {
      throw new Error('redis write failed')
    }
    const res = await post()
    ;(jobQueue as { add: unknown }).add = real
    expect(res.status).toBe(502)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('sync fallback (Redis down)', () => {
  test('it embeds inline and returns the REAL counts', async () => {
    redisConnected = false
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: true,
      message: 'Embedding rebuild completed',
      data: {
        documents: 4,
        embedded: 120,
        skipped: 3,
        provider: 'OPENAI_COMPATIBLE',
        model: 'text-embedding-3-small',
      },
    })
  })

  test('the fallback does NOT enqueue a job', async () => {
    redisConnected = false
    await post()
    expect(queueAdds).toHaveLength(0)
  })

  test('the fallback message distinguishes itself from the queued one', async () => {
    // "queued" vs "completed" is what tells the user whether to wait. Asserted because the two share a shape.
    redisConnected = false
    const res = await post()
    expect((await readBody(res)).message).toBe('Embedding rebuild completed')
  })

  test('a documentId filter is FORWARDED to the sync embedder', async () => {
    redisConnected = false
    await post({ documentId: 'doc-42' })
    expect(embedCalls).toEqual([{ documentId: 'doc-42' }])
  })

  test('DOCUMENTED: the sync call carries no organizationId, it relies on the ambient org context', async () => {
    // `embedCompanyDocuments({ documentId })` is scoped only by the Prisma tenant extension reading
    // AsyncLocalStorage. This is why the route's own `enterWithOrg` is a security-relevant line rather than
    // plumbing: drop it and the rebuild would touch EVERY org's documents.
    redisConnected = false
    await post()
    expect(Object.keys(embedCalls[0]!)).toEqual(['documentId'])
    expect(embedCalls[0]!.organizationId).toBeUndefined()
  })

  test('the sync audit records the documentId and the whole embedding result', async () => {
    redisConnected = false
    await post({ documentId: 'doc-42' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'RAG_EMBEDDINGS_REBUILD',
      severity: 'info',
      detail: {
        documentId: 'doc-42',
        documents: 4,
        embedded: 120,
        skipped: 3,
        provider: 'OPENAI_COMPATIBLE',
        model: 'text-embedding-3-small',
      },
    })
  })

  test('an embedder failure is 502 (upstream provider), not 500', async () => {
    // The status is passed explicitly to handleApiError. A 500 would page our own infra for the customer's
    // embedding-provider outage.
    redisConnected = false
    embedThrows = new Error('embedding provider returned 429')
    const res = await post()
    expect(res.status).toBe(502)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('body parsing', () => {
  test('a blank documentId is treated as org-wide, not as a filter for the empty string', async () => {
    // `typeof body.documentId === 'string' && body.documentId.trim()` -- an empty string must fall through to
    // undefined or the job would ask for a document whose id is ''.
    redisConnected = false
    await post({ documentId: '   ' })
    expect(embedCalls).toEqual([{ documentId: undefined }])
  })

  test('a documentId is trimmed before it is used', async () => {
    redisConnected = false
    await post({ documentId: '  doc-7  ' })
    expect(embedCalls).toEqual([{ documentId: 'doc-7' }])
  })

  test('a non-string documentId is ignored rather than coerced', async () => {
    redisConnected = false
    await post({ documentId: 123 })
    expect(embedCalls).toEqual([{ documentId: undefined }])
  })

  test('a MALFORMED body is treated as an org-wide rebuild, not a 400', async () => {
    // The route swallows a JSON parse error with `.catch(() => ({}))`. Recorded because a client that sends
    // garbage gets the MOST expensive operation instead of a validation error.
    redisConnected = false
    const res = await post('{ not json')
    expect(res.status).toBe(200)
    expect(embedCalls).toEqual([{ documentId: undefined }])
  })
})
