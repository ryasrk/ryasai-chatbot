/**
 * POST /api/documents/fts/rebuild — rebuild the full-text search index for the calling org.
 *
 * WHY THIS FILE EXISTS. Same two-mode dispatcher shape as the embedding rebuild, with two differences that
 * matter more than the plumbing:
 *
 *   1. THE SYNC FALLBACK TAKES NO ARGUMENTS AT ALL. `rebuildFts()` reads the ambient org context from
 *      AsyncLocalStorage, so the route's `enterWithOrg` is the ONLY tenant boundary for the whole operation.
 *      The route itself carries no documentId and no filter, so a lost context means an index rebuild over
 *      every org's chunks. Asserted as a property of the call (zero arguments, no org passed).
 *   2. THE FALLBACK'S FALLBACK STATUS IS 500, NOT 502. `rebuildFts` writes to OUR Postgres (the app's own
 *      tsvector index), unlike the embedding path which calls the customer's provider. A failure here is our
 *      fault and pages us; the two routes deliberately disagree on this and both are pinned.
 *
 * The queue payload has NO documentId field: an FTS rebuild is always corpus-wide, and the `organizationId`
 * in the payload is what the worker scopes the tsvector UPDATE by.
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
let ftsResult: { indexed: number } = { indexed: 812 }
let ftsThrows: Error | null = null

const events: string[] = []
const queueAdds: Array<{ name: string; data: Record<string, unknown> }> = []
const ftsCalls: unknown[][] = []
const auditWrites: Array<Record<string, unknown>> = []

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

let healthImpl: () => Promise<{ connected: boolean }> = async () => {
  events.push('checkRedisHealth')
  return { connected: redisConnected }
}

mock.module('@/lib/redis', () => ({
  checkRedisHealth: () => healthImpl(),
  jobQueue: {
    add: async (name: string, data: Record<string, unknown>) => {
      queueAdds.push({ name, data })
      events.push(`jobQueue.add:${name}`)
      return { id: 'job-1' }
    },
  },
}))

mock.module('@/lib/rag-fts', () => ({
  rebuildFts: async (...args: unknown[]) => {
    ftsCalls.push(args)
    events.push('rebuildFts')
    if (ftsThrows) throw ftsThrows
    return ftsResult
  },
}))

const { POST } = await import('./route')

function post() {
  const url = 'http://localhost/api/documents/fts/rebuild'
  const r = new Request(url, { method: 'POST' }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return POST()
}

async function readBody(res: Response) {
  return JSON.parse(await res.text()) as Record<string, any>
}

beforeEach(() => {
  user = adminUser
  requireRoleThrows = null
  redisConnected = true
  ftsResult = { indexed: 812 }
  ftsThrows = null
  healthImpl = async () => {
    events.push('checkRedisHealth')
    return { connected: redisConnected }
  }
  events.length = 0
  queueAdds.length = 0
  ftsCalls.length = 0
  auditWrites.length = 0
})

describe('org context and admin gate order', () => {
  test('the org context is entered BEFORE the admin gate', async () => {
    await post()
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
  })

  test('a non-admin is 403 and touches neither Redis nor the index', async () => {
    requireRoleThrows = new ForbiddenError('Requires admin role. You have viewer.')
    const res = await post()
    expect(res.status).toBe(403)
    expect(queueAdds).toHaveLength(0)
    expect(ftsCalls).toHaveLength(0)
  })

  test('it is admin-only even though it takes no arguments from the caller', async () => {
    // A POST with an empty body still rebuilds a production index; the gate is the authorization, not a body.
    user = { ...adminUser, role: 'analyst' }
    const res = await post()
    expect(res.status).toBe(403)
    expect(events).not.toContain('checkRedisHealth')
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-Z' }
    await post()
    expect(events[0]).toBe('enterWithOrg:org-Z')
  })

  test('an unauthenticated caller never reaches the admin gate or Redis', async () => {
    user = null as unknown as typeof adminUser
    const res = await post()
    expect(res.status).toBe(401)
    expect(events).toEqual([])
  })
})

describe('queued mode (Redis up)', () => {
  test('the job goes out with the exact name, type and organizationId', async () => {
    await post()
    expect(queueAdds).toEqual([
      { name: 'fts-rebuild', data: { type: 'fts-rebuild', organizationId: 'org-1' } },
    ])
  })

  test('the payload has NO documentId — an FTS rebuild is always corpus-wide', async () => {
    // A documentId here would be silently ignored by the worker while the UI implied a scoped rebuild.
    await post()
    expect(queueAdds[0]!.data).toEqual({ type: 'fts-rebuild', organizationId: 'org-1' })
    expect('documentId' in queueAdds[0]!.data).toBe(false)
  })

  test('it never calls rebuildFts inline when Redis is up', async () => {
    await post()
    expect(ftsCalls).toHaveLength(0)
  })

  test('the queued response reports indexed 0, not a fabricated count', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: true,
      message: 'FTS rebuild queued',
      data: { indexed: 0 },
    })
  })

  test('the audit says queued:true with no per-document detail', async () => {
    await post()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'RAG_FTS_REBUILD',
      severity: 'info',
      detail: { queued: true },
    })
  })

  test('the audit is written AFTER the enqueue', async () => {
    await post()
    expect(events).toEqual([
      'enterWithOrg:org-1',
      'requireRole:admin',
      'checkRedisHealth',
      'jobQueue.add:fts-rebuild',
      'audit',
    ])
  })
})

describe('sync fallback (Redis down)', () => {
  test('it calls rebuildFts with ZERO arguments and returns the real count', async () => {
    // No documentId, and crucially no organizationId argument: the function reads the ambient org context.
    // If the route ever "helpfully" passed an org, this test documents that the signature changed.
    redisConnected = false
    const res = await post()
    expect(ftsCalls).toEqual([[]])
    expect(await readBody(res)).toEqual({
      ok: true,
      message: 'FTS rebuild completed',
      data: { indexed: 812 },
    })
  })

  test('DOCUMENTED: tenant isolation for the fallback is the ambient context only', async () => {
    // `rebuildFts()` runs `UPDATE "DocumentChunk" ... WHERE documentId = d.id AND d.status='ready'` with the
    // org term injected by the Prisma tenant extension from AsyncLocalStorage. The route enters that context
    // two lines earlier; remove it and this rebuild reindexes every org's chunks in one UPDATE.
    redisConnected = false
    await post()
    expect(ftsCalls[0]).toHaveLength(0)
    expect(events[0]).toBe('enterWithOrg:org-1')
  })

  test('the sync path does not enqueue', async () => {
    redisConnected = false
    await post()
    expect(queueAdds).toHaveLength(0)
  })

  test('an indexed count of zero is still a 200 success — an empty corpus is not an error', async () => {
    redisConnected = false
    ftsResult = { indexed: 0 }
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: true,
      message: 'FTS rebuild completed',
      data: { indexed: 0 },
    })
  })

  test('the sync audit records the raw result object', async () => {
    redisConnected = false
    ftsResult = { indexed: 55 }
    await post()
    expect(auditWrites[0]).toMatchObject({
      action: 'RAG_FTS_REBUILD',
      severity: 'info',
      detail: { indexed: 55 },
    })
  })

  test('a rebuildFts failure is 500, NOT 502 — this writes to our own Postgres', async () => {
    // Deliberately different from /embeddings/rebuild (502) because the dependency is our own DB, not the
    // customer's provider. Pinned so a copy-paste unification of the two routes has to be intentional.
    redisConnected = false
    ftsThrows = new Error('relation "DocumentChunk" does not exist')
    const res = await post()
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })

  test('the DB error text never reaches the client', async () => {
    redisConnected = false
    ftsThrows = new Error('permission denied for table DocumentChunk in org secret-schema')
    const res = await post()
    expect(await res.text()).not.toContain('secret-schema')
  })
})

describe('redis health probe', () => {
  test('the health probe is consulted exactly once per request', async () => {
    await post()
    expect(events.filter((e) => e === 'checkRedisHealth')).toHaveLength(1)
  })

  test('a probe that throws is handled as an error rather than silently rebuilding', async () => {
    // The route awaits checkRedisHealth outside its own try/catch-free zone — it IS inside the handler try, so
    // a probe crash becomes a handled 500. Recorded because "Redis down" must fall back, while "probe broken"
    // must not be indistinguishable from "connected:false" and silently run the expensive path.
    healthImpl = async () => {
      throw new Error('probe exploded')
    }
    const res = await post()
    expect(res.status).toBe(500)
    expect(ftsCalls).toHaveLength(0)
    expect(queueAdds).toHaveLength(0)
  })
})
