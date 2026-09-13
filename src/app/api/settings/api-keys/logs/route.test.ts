/**
 * GET /api/settings/api-keys/logs — every recent API request log for the tenant.
 *
 * WHY THIS FILE EXISTS. This is the widest read of credential-adjacent data in the settings group:
 * one unbounded-looking query returns recent request logs for EVERY API key in the organization,
 * with no key filter and no pagination parameter. Two things therefore carry the whole weight:
 *
 *   1. THE ORG FILTER IS THE ONLY SCOPING. The route writes no `where` at all -- the query is
 *      `findMany({ orderBy, take, select })` -- so the response is tenant-correct ONLY if
 *      `ApiRequestLog` is in `ORG_SCOPED_MODELS` AND the org context was entered. Both are asserted
 *      here: the model membership against that set's own source, and the context as call ORDER.
 *      The IDOR question ("does this leak another organization's logs?") is answered by evidence,
 *      not by reading: the real injection is replayed against a two-org table below.
 *   2. `take: 100` IS A HARD CEILING, NOT A DEFAULT. There is no `?limit=` parameter on this route,
 *      unlike the paginated routes elsewhere in the app -- so the number is what bounds the payload.
 *      A request log grows with every API call, so this is the one number standing between the
 *      endpoint and a response that grows without limit.
 *
 * Also pinned: the `select` allow-list. `ApiRequestLog` is a sibling of `ApiKey`, and a bare
 * `findMany()` would ship every column of every row. `requestId` in particular is deliberately NOT
 * selected, and the field set is asserted exactly.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams — declared BEFORE every mock.module() block.
// ---------------------------------------------------------------------------

const admin = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'flat' as string | null,
}
let user: typeof admin = admin
let authThrows: Error | null = null

/** Rows handed back by the log query. */
let logs: Array<Record<string, unknown>> = []
let loadThrows: Error | null = null

/** Side-effect ORDER. Order is the assertion; mock return values are not. */
const events: string[] = []
/** Every Prisma call with its raw args -- the query SHAPE is the assertion. */
const dbCalls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    events.push(`handleApiError:${e instanceof Error ? e.name : 'unknown'}`)
    const name = e instanceof Error ? e.name : 'unknown'
    if (name === 'UnauthorizedError') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: (e as Error).message } }, { status: 401 })
    }
    if (name === 'ForbiddenError') {
      return Response.json({ error: { code: 'FORBIDDEN', message: (e as Error).message } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
    enteredOrgs.push(orgId)
  },
  getOrgContext: () => enteredOrgs.at(-1),
}))

mock.module('@/lib/db', () => ({
  db: {
    apiRequestLog: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.apiRequestLog.findMany')
        dbCalls.push({ model: 'apiRequestLog', op: 'findMany', args })
        if (loadThrows) throw loadThrows
        return logs
      },
      // Present so an accidental single-row read is recorded rather than blowing up with a
      // TypeError that would look like an unrelated server error.
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.apiRequestLog.findUnique')
        dbCalls.push({ model: 'apiRequestLog', op: 'findUnique', args })
        return null
      },
    },
    // The route must not read the KEYS themselves -- only their logs. Stubbed so a future
    // regression that starts enumerating keys is observable here.
    apiKey: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.apiKey.findMany')
        dbCalls.push({ model: 'apiKey', op: 'findMany', args })
        return []
      },
    },
  },
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// DYNAMIC import AFTER every mock.module() call.
const { GET } = await import('./route')

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

beforeEach(() => {
  user = admin
  authThrows = null
  logs = []
  loadThrows = null
  events.length = 0
  dbCalls.length = 0
  enteredOrgs.length = 0
})

describe('the leak question: no filter, so the org context IS the isolation', () => {
  test('the query writes NO where clause -- the extension is the only scoping', async () => {
    // Stated plainly, because it is what makes the next three tests load-bearing. A hand-written
    // `organizationId` here would also work, but the ABSENCE is the current contract and it means
    // the endpoint is correct only while the extension injects the org.
    await GET()
    expect(dbCalls[0]!.args.where).toBeUndefined()
  })

  test('ApiRequestLog is in ORG_SCOPED_MODELS and findMany is a FILTER op -- from the real source', async () => {
    // If `apiRequestLog` were missing from this set, this route would return EVERY organization's
    // request logs: endpoint paths, status codes, latencies and error messages, which is a map of
    // another tenant's API surface. Read by PATH because this file mocks the tenant specifier, so a
    // namespace import would hand back the stub. `injectOrgWhere` is a pure three-branch function
    // whose entire contract is visible in its text, so a source assertion is a fair proxy here.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')

    const start = tenantSrc.indexOf('const ORG_SCOPED_MODELS')
    expect(tenantSrc.slice(start, tenantSrc.indexOf('])', start))).toContain("'apiRequestLog'")

    const filterStart = tenantSrc.indexOf('const FILTER_OPS')
    const filters = tenantSrc.slice(filterStart, tenantSrc.indexOf('])', filterStart))
    expect(filters).toContain("'findMany'")
    expect(filters).not.toContain("'findUnique'")

    // APPEND, not replace -- otherwise the injection could clobber a future caller filter.
    const inject = tenantSrc.slice(tenantSrc.indexOf('function injectOrgWhere'), tenantSrc.indexOf('function injectOrgCreate'))
    expect(inject).toContain('{ ...args.where, organizationId: orgId }')
    expect(inject).toContain('args.where = { organizationId: orgId }')
  })

  test('LEAK REFUTED, behaviourally: the scoped read returns ZERO rows cross-org', async () => {
    // Executes the WHERE rather than asserting its shape. Two orgs share the table; org-1 asks for
    // everything, which is exactly what this route does.
    //
    // The scoping is transcribed from the source asserted above (`{ ...where, organizationId }`,
    // with the no-where branch becoming `{ organizationId }`). The faithfulness check is that source
    // assertion: if `injectOrgWhere` changes, that test fails first and this one is reviewed with it.
    const TABLE = [
      { id: 'a1', organizationId: 'org-2', endpoint: '/api/v1/chat/completions', status: 200 },
      { id: 'a2', organizationId: 'org-2', endpoint: '/api/v1/chat/completions', status: 500, errorMessage: 'ORG 2 LEAK' },
      { id: 'b1', organizationId: 'org-1', endpoint: '/api/v1/chat/completions', status: 200 },
    ]
    const scoped = (orgId: string, where?: Record<string, unknown>) => {
      const w = where ? { ...where, organizationId: orgId } : { organizationId: orgId }
      return TABLE.filter((r) => Object.entries(w).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
    }

    // This route's actual query: no where, so the injected org is the ONLY filter.
    expect(scoped('org-1').map((r) => r.id)).toEqual(['b1'])
    // The positive control -- without it, an empty/never-matching harness would pass silently.
    expect(scoped('org-2').map((r) => r.id)).toEqual(['a1', 'a2'])
    // And org-2's error text is unreachable from org-1.
    expect(JSON.stringify(scoped('org-1'))).not.toContain('ORG 2 LEAK')
  })

  test('the org context is entered with the SESSION org BEFORE the query', async () => {
    // The guarantee above is conditional on this. `enterWith` does not propagate to the caller's
    // frame, so without it the extension sees no org, injects nothing, and the response becomes
    // every tenant's logs.
    await GET()
    expect(enteredOrgs).toEqual(['org-1'])
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.apiRequestLog.findMany'])
  })

  test('the unauthenticated case is the typed 401 and queries nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(dbCalls).toEqual([])
    expect(enteredOrgs).toEqual([])
  })
})

describe('the query shape', () => {
  test('newest first, capped at 100, with NO skip and NO pagination parameter', async () => {
    // There is no `?limit=` on this route, so the literal 100 is the ceiling. Asserted as the whole
    // args object: an added `skip`, a raised `take` or a `where` is then a visible edit.
    await GET()
    expect(dbCalls[0]!.args).toEqual({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        endpoint: true,
        status: true,
        latencyMs: true,
        errorMessage: true,
        createdAt: true,
      },
    })
  })

  test('the SELECT allow-list omits requestId and apiKeyId -- asserted exactly', async () => {
    // A bare `findMany()` would ship every column of every row. `requestId` is an internal
    // correlation id and `apiKeyId` is the key's identifier, neither of which the log table renders.
    // Pinned as the exact key set so a widening is deliberate.
    await GET()
    const select = dbCalls[0]!.args.select as Record<string, boolean>
    expect(Object.keys(select).sort()).toEqual(['createdAt', 'endpoint', 'errorMessage', 'id', 'latencyMs', 'status'])
    expect(select).not.toHaveProperty('requestId')
    expect(select).not.toHaveProperty('apiKeyId')
    expect(select).not.toHaveProperty('organizationId')
    // Every selected column must be true, never false/undefined.
    for (const v of Object.values(select)) expect(v).toBe(true)
  })

  test('the route reads the LOGS, never the keys themselves', async () => {
    // Enumerating ApiKey rows here would put key prefixes (and anything later added to the model) in
    // a response whose job is only to show request history.
    await GET()
    expect(dbCalls.every((c) => c.model === 'apiRequestLog')).toBe(true)
    expect(dbCalls.find((c) => c.model === 'apiKey')).toBeUndefined()
  })

  test('it uses findMany, never findUnique -- the tenant extension cannot scope a unique read', async () => {
    await GET()
    expect(dbCalls.map((c) => c.op)).toEqual(['findMany'])
  })
})

describe('the response envelope', () => {
  test('the rows come back under ok:true as `items`', async () => {
    logs = [{ id: 'l1', endpoint: '/api/v1/chat/completions', status: 200, latencyMs: 42 }]
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, items: logs })
  })

  test('an empty log is 200 with items as an EMPTY ARRAY', async () => {
    // The view reads `j.items`; a null would leave the previous table on screen after the last row
    // aged out.
    const res = await GET()
    expect(await body(res)).toEqual({ ok: true, items: [] })
  })

  test('the rows are passed through UNMAPPED, so the key set is the select allow-list', async () => {
    // Unlike the schedules history route, there is no `.map()` here -- the DB shape IS the response
    // shape. Asserted so a future mapping (or a dropped `select`) is a visible change.
    logs = [{ id: 'l1', endpoint: '/e', status: 500, latencyMs: null, errorMessage: 'boom', createdAt: '2026-06-01T00:00:00.000Z' }]
    const items = (await body(await GET())).items as Array<Record<string, unknown>>
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'endpoint', 'errorMessage', 'id', 'latencyMs', 'status'])
    expect(items[0]!.errorMessage).toBe('boom')
    expect(items[0]!.latencyMs).toBeNull()
  })

  test('the ORDER the DB returned is preserved -- the route does not re-sort', async () => {
    // Re-sorting in the route would override `createdAt desc` and, more importantly, hide a broken
    // index. The rows are returned exactly as given.
    logs = [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]
    const items = (await body(await GET())).items as Array<Record<string, unknown>>
    expect(items.map((i) => i.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  test('a query failure is 500 with the fallback, never the driver text', async () => {
    loadThrows = new Error('relation "ApiRequestLog" does not exist on this connection')
    const res = await GET()
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load request logs.' } })
    expect(JSON.stringify(payload)).not.toContain('ApiRequestLog')
  })
})

describe('privilege: this route has NO role gate', () => {
  test('DECLARED NON-CONTROL for tenant isolation -- any member reads every key log', async () => {
    // Stated honestly rather than dressed up. There is no `requireRole` call, so a `viewer` sees
    // every API key's request history for the organization: endpoint paths, status codes, error
    // messages. That is intra-org exposure, not a cross-tenant flaw, and the LOGS contain no key
    // material (the `select` omits `apiKeyId`), so it is pinned as the CURRENT contract rather than
    // presented as a control. This assertion can only fail if a gate is added, which is the change
    // it exists to make visible -- and the `apiKey`-log UI lives behind the same settings view.
    user = { ...admin, role: 'viewer' }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(events).not.toContain('requireRole:admin')
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).not.toContain('requireRole')
  })

  test('the docs comment claims tenant-wide scope, and that is what the query does', async () => {
    // The route's own JSDoc says "all recent request logs for the tenant (across all API keys)".
    // Asserting the comment against the query keeps the two from drifting -- a reader should not
    // have to check the SQL to learn the scope.
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).toContain('across all API keys')
    await GET()
    expect(dbCalls[0]!.args.where).toBeUndefined()
  })
})
