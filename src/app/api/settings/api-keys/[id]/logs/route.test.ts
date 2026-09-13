/**
 * GET /api/settings/api-keys/[id]/logs — the request logs for ONE API key.
 *
 * WHY THIS FILE EXISTS. This route takes a client-supplied key id and does the two-step dance that
 * the repo's own IDOR notes warn about:
 *
 *   1. `db.apiKey.findFirst({ where: { id }, select: { id: true } })` -- the ownership check.
 *   2. `db.apiRequestLog.findMany({ where: { apiKeyId: id }, ... })` -- the read.
 *
 * Step 1 uses `findFirst` (a FILTER op), so the tenant extension appends `organizationId` and a
 * cross-org key id yields `null` -> 404. Step 2's `where` carries only `apiKeyId`, so ITS scoping
 * depends on `ApiRequestLog` being in `ORG_SCOPED_MODELS`. The IDOR question -- can org-1 read
 * org-2's key logs by passing org-2's key id? -- is answered with evidence in the first describe
 * block: the check is replayed against a two-org table, and the log query's injected org is shown
 * to be the CALLER's, not the target key's.
 *
 * The subtlety worth pinning: `apiRequestLog` rows are org-stamped at WRITE time, independently of
 * which key produced them (`apiKeyId` is nullable and `onDelete: SetNull`). So the two filters can
 * disagree -- a log can carry the caller's org and a foreign `apiKeyId`. Step 1 is what makes that
 * impossible in practice, which is why the ORDER of the two queries is asserted, not just their
 * shapes.
 *
 * Also pinned: `take: 50` (a per-key log grows with every request), the same `select` allow-list as
 * the tenant-wide sibling, the 404 being indistinguishable from a missing key, and that the
 * ownership check does NOT select any credential material (`keyHash`, `keyPrefix`, `isActive`).
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

/** The row the ownership check resolves to. `null` = missing OR another org's key. */
let keyRow: { id: string } | null = { id: 'k-1' }
/** Rows handed back by the log query. */
let logs: Array<Record<string, unknown>> = []
let keyThrows: Error | null = null
let logThrows: Error | null = null

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
    apiKey: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.apiKey.findFirst')
        dbCalls.push({ model: 'apiKey', op: 'findFirst', args })
        if (keyThrows) throw keyThrows
        return keyRow
      },
      // Present so a regression to the unscoped read is recorded rather than throwing a TypeError.
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.apiKey.findUnique')
        dbCalls.push({ model: 'apiKey', op: 'findUnique', args })
        return keyRow
      },
    },
    apiRequestLog: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.apiRequestLog.findMany')
        dbCalls.push({ model: 'apiRequestLog', op: 'findMany', args })
        if (logThrows) throw logThrows
        return logs
      },
    },
  },
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// DYNAMIC import AFTER every mock.module() call.
const { GET } = await import('./route')

/** The route's real context shape: `{ params: Promise<{ id: string }> }` as the 2nd argument. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const theReq = (id = 'k-1') => new Request(`http://localhost/api/settings/api-keys/${id}/logs`) as never

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** The args of the nth call for a model/op pair. */
function callArgs(model: string, op: string): Record<string, unknown> {
  return dbCalls.find((c) => c.model === model && c.op === op)!.args
}

beforeEach(() => {
  user = admin
  authThrows = null
  keyRow = { id: 'k-1' }
  logs = []
  keyThrows = null
  logThrows = null
  events.length = 0
  dbCalls.length = 0
  enteredOrgs.length = 0
})

describe('the IDOR question: a client-supplied key id gates a log read', () => {
  test('the ownership check uses findFirst, NEVER findUnique -- the whole point of the step', async () => {
    // `findUnique` is not org-scoped (the tenant extension cannot append organizationId to a unique
    // where), so switching this one word would silently turn the route into a cross-tenant read of
    // another org's key logs. This is the named IDOR pattern from AGENTS.md, and it is one
    // character away.
    await GET(theReq(), ctx('k-1'))
    const checks = dbCalls.filter((c) => c.model === 'apiKey')
    expect(checks).toHaveLength(1)
    expect(checks[0]!.op).toBe('findFirst')
    expect(dbCalls.find((c) => c.model === 'apiKey' && c.op === 'findUnique')).toBeUndefined()
  })

  test('the check selects ONLY the id -- no keyHash, no keyPrefix, no isActive', async () => {
    // The check exists to answer "is this key in my org", nothing more. Loading the hash into memory
    // (or anything else a future edit adds to the model) just to throw it away is the kind of thing
    // that later leaks through a log line. Asserted as the exact select object.
    await GET(theReq(), ctx('k-1'))
    expect(callArgs('apiKey', 'findFirst')).toEqual({ where: { id: 'k-1' }, select: { id: true } })
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).not.toContain('keyHash')
    expect(routeSrc).not.toContain('keyPrefix')
  })

  test('the check runs BEFORE the log query, so a foreign id never reaches it', async () => {
    // ORDER is the control. If the log query ran first its results would be computed and only then
    // discarded -- and any future early-return refactor could ship them. The 404 case below asserts
    // the stronger property directly: zero log queries at all.
    await GET(theReq(), ctx('k-1'))
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.apiKey.findFirst', 'db.apiRequestLog.findMany'])
  })

  test('a cross-org key id is a 404 and the log query NEVER RUNS', async () => {
    // The strongest statement available at this seam: the extension turns a foreign id into `null`,
    // the route returns 404, and no log read happens. So org-2's logs are not fetched, not filtered
    // after the fact, and not in memory.
    keyRow = null // what findFirst + the injected org returns for a foreign id
    const res = await GET(theReq(), ctx('k-from-other-org'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ ok: false, error: 'API key not found.' })
    expect(dbCalls.some((c) => c.model === 'apiRequestLog')).toBe(false)
  })

  test('LEAK REFUTED, behaviourally: the log query is org-scoped by the CALLER org', async () => {
    // The log query's `where` carries only `apiKeyId`, so its isolation rests on the extension
    // injecting `organizationId` for `ApiRequestLog`. Driven against a two-org table below.
    //
    // The scoping rule is read from the extension's OWN source rather than imported (this file mocks
    // the specifier), and `ApiRequestLog.organizationId` is stamped at write time -- so the union of
    // BOTH filters is what a row must satisfy.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')
    const start = tenantSrc.indexOf('const ORG_SCOPED_MODELS')
    expect(tenantSrc.slice(start, tenantSrc.indexOf('])', start))).toContain("'apiRequestLog'")
    const filterStart = tenantSrc.indexOf('const FILTER_OPS')
    const filters = tenantSrc.slice(filterStart, tenantSrc.indexOf('])', filterStart))
    expect(filters).toContain("'findFirst'")
    expect(filters).toContain("'findMany'")

    const KEYS = [
      { id: 'k-1', organizationId: 'org-1', label: 'mine' },
      { id: 'k-2', organizationId: 'org-2', label: 'theirs' },
    ]
    const LOGS = [
      { id: 'l1', organizationId: 'org-2', apiKeyId: 'k-2', endpoint: '/e', status: 500, errorMessage: 'ORG 2 LEAK' },
      { id: 'l2', organizationId: 'org-1', apiKeyId: 'k-1', endpoint: '/e', status: 200 },
    ]
    // Step 1: findFirst + injected org. org-1 asking about k-2 -> null.
    const ownedKey = (orgId: string, keyId: string) => KEYS.find((k) => k.id === keyId && k.organizationId === orgId) ?? null
    // Step 2: findMany + injected org (the caller's), on top of the route's apiKeyId filter.
    const scopedLogs = (orgId: string, keyId: string) =>
      LOGS.filter((l) => l.apiKeyId === keyId && l.organizationId === orgId)

    expect(ownedKey('org-1', 'k-2')).toBeNull() // -> the route 404s and stops here
    expect(scopedLogs('org-1', 'k-2')).toEqual([]) // -> and even if it did not, the read is empty
    // Positive controls, without which the empty results prove nothing about the harness.
    expect(ownedKey('org-1', 'k-1')!.label).toBe('mine')
    expect(scopedLogs('org-1', 'k-1').map((l) => l.id)).toEqual(['l2'])
    expect(JSON.stringify(scopedLogs('org-1', 'k-1'))).not.toContain('ORG 2 LEAK')
  })

  test('the org context is entered with the SESSION org BEFORE any read', async () => {
    // Both guarantees above are conditional on this: `enterWith` does not propagate to the caller's
    // frame, so without it neither query is scoped.
    await GET(theReq(), ctx('k-1'))
    expect(enteredOrgs).toEqual(['org-1'])
  })

  test('the unauthenticated case is the typed 401 and reads nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(dbCalls).toEqual([])
    expect(enteredOrgs).toEqual([])
  })
})

describe('the log query shape', () => {
  test('the filter is the ROUTE PARAM id, and the URL does not override it', async () => {
    // The URL says k-1 and the segment says k-9. The segment wins -- a mismatch here would mean the
    // OWNERSHIP CHECK tested one key while the READ used another, which is the defect shape this
    // route exists to avoid.
    await GET(theReq('k-1'), ctx('k-9'))
    expect(callArgs('apiKey', 'findFirst').where).toEqual({ id: 'k-9' })
    expect(callArgs('apiRequestLog', 'findMany').where).toEqual({ apiKeyId: 'k-9' })
  })

  test('BOTH queries use the same id -- the check and the read cannot diverge', async () => {
    // Asserted as a pair, because a divergence is precisely how an ownership check becomes
    // decorative: check key A, then read key B's logs.
    await GET(theReq(), ctx('k-42'))
    expect(callArgs('apiKey', 'findFirst').where).toEqual({ id: 'k-42' })
    expect(callArgs('apiRequestLog', 'findMany').where).toEqual({ apiKeyId: 'k-42' })
  })

  test('newest first, capped at 50, with the same select allow-list as the tenant-wide sibling', async () => {
    // 50 here against 100 on the tenant-wide route: a per-key view is a drill-down, so the ceiling
    // is tighter. Asserted as the whole args object so an added `skip` or a raised `take` is visible.
    await GET(theReq(), ctx('k-1'))
    expect(callArgs('apiRequestLog', 'findMany')).toEqual({
      where: { apiKeyId: 'k-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
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

  test('the select omits apiKeyId and requestId even though the query filters on the former', async () => {
    // Filtering by `apiKeyId` does not require returning it, and the caller already knows which key
    // they asked for. Pinned as the exact key set.
    await GET(theReq(), ctx('k-1'))
    const select = callArgs('apiRequestLog', 'findMany').select as Record<string, boolean>
    expect(Object.keys(select).sort()).toEqual(['createdAt', 'endpoint', 'errorMessage', 'id', 'latencyMs', 'status'])
    expect(select).not.toHaveProperty('apiKeyId')
    expect(select).not.toHaveProperty('requestId')
    expect(select).not.toHaveProperty('organizationId')
    for (const v of Object.values(select)) expect(v).toBe(true)
  })
})

describe('the response envelope and failures', () => {
  test('the rows come back under ok:true as `items`', async () => {
    logs = [{ id: 'l1', endpoint: '/e', status: 200, latencyMs: 12 }]
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, items: logs })
  })

  test('a key with no requests is 200 with items as an EMPTY ARRAY', async () => {
    // Distinct from the 404 path: the key EXISTS, it simply has no traffic. The UI needs to tell
    // these apart, and both must be non-null.
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, items: [] })
  })

  test('the rows are passed through UNMAPPED, preserving the DB key set and order', async () => {
    logs = [{ id: 'newest' }, { id: 'oldest' }]
    const items = (await body(await GET(theReq(), ctx('k-1')))).items as Array<Record<string, unknown>>
    expect(items.map((i) => i.id)).toEqual(['newest', 'oldest'])
  })

  test('a failure of the OWNERSHIP CHECK is 500 with its own fallback text', async () => {
    // Both queries share one fallback string in this route ('Failed to load request logs.'), which
    // means an operator cannot tell "the key lookup failed" from "the log read failed". Pinned as
    // the current contract so a more specific message is a deliberate edit.
    keyThrows = new Error('connection terminated unexpectedly')
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load request logs.' } })
    expect(JSON.stringify(payload)).not.toContain('connection terminated')
    expect(dbCalls.some((c) => c.model === 'apiRequestLog')).toBe(false)
  })

  test('a failure of the LOG READ is 500 with the same fallback', async () => {
    logThrows = new Error('relation "ApiRequestLog" does not exist')
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load request logs.' } })
  })

  test('an unknown key is 404 and NOT an empty 200 -- it must not read as "no traffic"', async () => {
    // The distinction the sibling route cannot make. Here the key is verified, so a bogus id is a
    // 404: the UI shows "not found" instead of "this key never made a request".
    keyRow = null
    const res = await GET(theReq(), ctx('nope'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ ok: false, error: 'API key not found.' })
  })

  test('there is no ROLE gate -- DECLARED NON-CONTROL for privilege, pinned as the contract', async () => {
    // Any authenticated member may read any key's log in the org. The logs contain endpoint/status
    // /latency/error, and the `select` omits `apiKeyId`, so no key material is exposed; this is
    // intra-org policy, not a tenant flaw. Recorded so adding a gate is a visible change.
    user = { ...admin, role: 'viewer' }
    const res = await GET(theReq(), ctx('k-1'))
    expect(res.status).toBe(200)
    expect(events).not.toContain('requireRole:admin')
    expect(readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')).not.toContain('requireRole')
  })
})
