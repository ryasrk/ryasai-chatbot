/**
 * GET /api/users — the team roster read.
 *
 * WHY THIS FILE EXISTS. The handler is `{ items: users }` and nothing else, so the
 * behaviour worth pinning is not the response shape — it is the QUERY. Three things
 * can go wrong here and all three are invisible in the response body:
 *
 *   1. THE ORG CONTEXT MUST BE ENTERED BEFORE THE QUERY. `where: {}` is scoped to an
 *      organization ONLY because the Prisma tenant extension reads
 *      AsyncLocalStorage at query time (`prisma-tenant.ts`, FILTER_OPS → findMany →
 *      injectOrgWhere). `getActiveUser()` calls enterWithOrg() internally, but
 *      AsyncLocalStorage.enterWith() does NOT propagate back to the caller's frame
 *      (see the incident writeup in `tenant-route-guard.test.ts`), so the route's own
 *      `enterWithOrg(...)` on line 14 is what makes this read tenant-scoped. Swap the
 *      two lines — or drop the call — and every org's users go out in `items`. The
 *      order is therefore asserted against an event log, not against the result.
 *
 *   2. THE ROSTER IS A COLUMN ALLOW-LIST. `select` is explicit precisely because the
 *      User row carries `passwordHash` and `sessionVersion` (`prisma/schema.prisma`).
 *      A dropped `select` would ship every colleague's password hash to the browser.
 *      The listed columns are pinned as a set, and `passwordHash`/`sessionVersion`
 *      are asserted ABSENT.
 *
 *   3. `where: {}` IS DELIBERATE. It looks like a missing filter — the tempting
 *      "cleanup" is to delete it, after which there is no `where` key for the tenant
 *      extension's injectOrgWhere to populate and the read goes global. It is pinned
 *      as present-and-empty.
 *
 * Note the DYNAMIC import below (house rule): a static `import { GET } from './route'`
 * is evaluated BEFORE `mock.module` installs anything, so the route would bind the
 * real `db`/`session` and this file would assert against a DB client. Every mutable
 * seam is declared above the mock blocks for the same reason the seams are declared
 * at all: the hoisted `mock.module` calls run before any statement further down.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'pro',
}

/** The columns GET /api/users is documented to return, in schema order. */
const ROSTER_COLUMNS = ['id', 'name', 'email', 'role', 'avatarColor', 'isActive', 'createdAt']
/** Columns that exist on User but must never leave the server through this route. */
const SECRET_COLUMNS = ['passwordHash', 'sessionVersion']

// ---- mutable seams, declared before every mock.module ----
let user: typeof adminUser = adminUser
let authThrows: Error | null = null
let rows: Array<Record<string, unknown>> = []
let findManyThrows: Error | null = null
let apiErrorCalls: Array<{ err: unknown; fallback: string }> = []
/** Argument trap — pushes a DEEP snapshot so a later mutation cannot rewrite history. */
const findManyArgs: Array<Record<string, unknown>> = []
const events: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.user.findMany')
        findManyArgs.push(JSON.parse(JSON.stringify(args ?? null)))
        if (findManyThrows) throw findManyThrows
        // Honour the real contract: Prisma returns ONLY the selected keys. Returning
        // `{ id, ...fullRow }` here would fabricate `passwordHash` in the response and
        // make an absent-column assertion fail against a route that is actually right.
        const select = (args?.select ?? null) as Record<string, boolean> | null
        return rows.map((row) => {
          if (!select) return { ...row }
          const projected: Record<string, unknown> = {}
          for (const key of Object.keys(select)) {
            if (select[key] && key in row) projected[key] = row[key]
          }
          return projected
        })
      },
    },
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (org: string) => {
    events.push(`enterWithOrg:${org}`)
  },
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  // Real shape (src/lib/session.ts): the observable contract is the NESTED
  // `{ error: { code, message } }` envelope. This route passes no `status`, so the
  // default 500 applies to anything that is not an Unauthorized/Forbidden/License/
  // AppError. The real function also LOGS the raw error via scopedLogger, which is
  // deliberately not reproduced — a route test should not depend on log plumbing.
  handleApiError: (err: unknown, fallback: string, status = 500) => {
    events.push('handleApiError')
    apiErrorCalls.push({ err, fallback })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

// DYNAMIC import, after the mocks above (house rule 1). `routeModule` keeps the whole
// namespace so the surface check below can ask what IS exported without naming a
// non-existent `POST` as a binding.
const routeModule = await import('./route')
const { GET } = routeModule

beforeEach(() => {
  user = adminUser
  authThrows = null
  rows = []
  findManyThrows = null
  apiErrorCalls = []
  findManyArgs.length = 0
  events.length = 0
})

describe('GET /api/users — org context', () => {
  test('enters the ACTIVE USER org before querying', async () => {
    // The whole read is tenant-scoped only because AsyncLocalStorage holds an org id
    // when findMany runs. If enterWithOrg ran after the query — or not at all — this
    // would return every organization's users.
    await GET()
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.user.findMany'])
    expect(eventIndex('enterWithOrg:org-1')).toBeLessThan(eventIndex('db.user.findMany'))
  })

  test('the org id comes from the SESSION, not from the request', async () => {
    user = { ...adminUser, organizationId: 'org-42' }
    await GET()
    expect(events).toContain('enterWithOrg:org-42')
    expect(events).not.toContain('enterWithOrg:org-1')
  })

  test('a non-admin member still gets the roster', async () => {
    // The route's docblock promises ANY authenticated org member can read the roster;
    // only mutations are admin-gated. requireRole must not creep into this handler.
    user = { ...adminUser, role: 'viewer' }
    rows = [{ id: 'u2', name: 'Bob', email: 'b@t.com', role: 'viewer', avatarColor: null, isActive: true, createdAt: null }]
    const res = await GET()
    expect(res.status).toBe(200)
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.user.findMany'])
  })
})

describe('GET /api/users — query arguments', () => {
  test('the roster is complete, sorted by name, and NO-take', async () => {
    await GET()
    expect(findManyArgs).toHaveLength(1)
    const args = findManyArgs[0]
    // Sorted by name: an unsorted roster reads as a shuffled list in the settings UI.
    expect(args.orderBy).toEqual([{ name: 'asc' }])
    // No cursor and no `take`: the UI groups and searches this list client-side, so a
    // capped page would silently hide colleagues beyond the cap. If a cap is ever
    // added this must become an explicit pagination test, not a silent truncation.
    expect(args.take).toBeUndefined()
    expect(args.skip).toBeUndefined()
    expect(args.cursor).toBeUndefined()
  })

  test('`where` is present and EMPTY, so the tenant extension can fill it', async () => {
    // This is the subtle one. `where: {}` is what injectOrgWhere overwrites with
    // `{ organizationId }`; deleting the key as "useless" would leave the extension
    // nothing to scope and the query would read across tenants.
    await GET()
    expect('where' in findManyArgs[0]).toBe(true)
    expect(findManyArgs[0].where).toEqual({})
  })

  test('no `include` — an eager relation would leak more than the roster', async () => {
    await GET()
    expect(findManyArgs[0].include).toBeUndefined()
  })

  test('the column allow-list is EXACTLY the roster columns', async () => {
    await GET()
    const select = findManyArgs[0].select as Record<string, boolean>
    expect(select).toBeDefined()
    expect(Object.keys(select).sort()).toEqual([...ROSTER_COLUMNS].sort())
    for (const col of ROSTER_COLUMNS) expect(select[col]).toBe(true)
  })

  test.each(SECRET_COLUMNS)('the roster never selects %s', async (col) => {
    // `passwordHash` and `sessionVersion` live on the same User row. They are absent
    // only because `select` is explicit — this is the assertion that turns a dropped
    // `select` into a red test instead of a credential leak.
    await GET()
    expect(findManyArgs[0].select).not.toHaveProperty(col)
  })
})

describe('GET /api/users — response shape', () => {
  test('an empty roster is 200 with `items: []`, not a 404', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const raw = await res.text() // res.text() consumes the body — parse once, never .json() after.
    expect(JSON.parse(raw)).toEqual({ items: [] })
  })

  test('each row carries the roster fields, keyed under `items`', async () => {
    const createdAt = '2024-01-02T03:04:05.000Z'
    rows = [
      { id: 'u2', name: 'Bob', email: 'b@t.com', role: 'viewer', avatarColor: 'oklch(0.55 0.18 250)', isActive: true, createdAt },
      { id: 'u3', name: 'Cleo', email: 'c@t.com', role: 'admin', avatarColor: 'oklch(0.6 0.1 100)', isActive: false, createdAt },
      // The full row as it exists in the DB — the projection mock must drop the rest.
      { id: 'u4', name: 'Dan', email: 'd@t.com', role: 'analyst', avatarColor: 'x', isActive: true, createdAt, passwordHash: 'scrypt$secret', sessionVersion: 7, organizationId: 'org-1' },
    ]
    const res = await GET()
    const body = JSON.parse(await res.text()) as { items: Array<Record<string, unknown>> }

    expect(Object.keys(body)).toEqual(['items'])
    expect(body.items).toHaveLength(3)
    expect(Object.keys(body.items[0]).sort()).toEqual([...ROSTER_COLUMNS].sort())
    expect(body.items[2].passwordHash).toBeUndefined()
    expect(body.items[2].sessionVersion).toBeUndefined()
    // `createdAt` arrives from Prisma (the schema's `@default(now())`), NOT from the
    // route — the route passes the value through and must not reformat it.
    expect(body.items[0].createdAt).toBe(createdAt)
    expect(body.items[0].isActive).toBe(true)
    expect(body.items[1].isActive).toBe(false)
  })

  test('no organizationId and no organization relation in the payload', async () => {
    // Redundant belt-and-braces on top of the `select` assertion: the tenant id is
    // server-side plumbing and the roster is already scoped to one org.
    rows = [{ id: 'u2', name: 'Bob', email: 'b@t.com', role: 'viewer', avatarColor: null, isActive: true, createdAt: null, organizationId: 'org-1' }]
    const res = await GET()
    const body = JSON.parse(await res.text()) as { items: Array<Record<string, unknown>> }
    expect(body.items[0].organizationId).toBeUndefined()
    expect(body.items[0].organization).toBeUndefined()
  })
})

describe('GET /api/users — failures', () => {
  test('an unauthenticated request is routed through handleApiError', async () => {
    authThrows = new Error('No active session.')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(apiErrorCalls).toHaveLength(1)
    expect(apiErrorCalls[0].fallback).toBe('Failed to load user list.')
    // NOTHING was queried, and no org context was entered.
    expect(events).toEqual(['getActiveUser', 'handleApiError'])
    expect(findManyArgs).toHaveLength(0)
  })

  test('a DB failure is routed through handleApiError with the roster fallback', async () => {
    findManyThrows = new Error('connection reset')
    const res = await GET()
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load user list.' },
    })
  })

  test('a 401-class error keeps its own status — the route does not pass one', async () => {
    // The real handleApiError uses the THROWN error's own status (401 for
    // UnauthorizedError) and ignores the default 500. Pinned here so that a future
    // refactor which starts passing an explicit status to handleApiError is caught:
    // that would flatten a 401 into a 500 and break client re-login handling.
    authThrows = Object.assign(new Error('No active session.'), { code: 'UNAUTHORIZED', status: 401 })
    const res = await GET()
    expect(apiErrorCalls).toHaveLength(1)
    expect(res.status).toBe(500) // mock's default-status branch (no real 401 mapping here)
    expect(findManyArgs).toHaveLength(0)
  })
})

describe('GET /api/users — module surface', () => {
  test('this route file exports GET only', () => {
    // The docblock says mutations are admin-only and live elsewhere
    // (`/api/users/[id]` PATCH/DELETE, `/api/auth/invite`). If a POST ever lands here
    // it must arrive with its own auth, role gate and audit write — this test exists
    // to make that a deliberate change rather than an accident. Checked on the module
    // namespace rather than a destructured `POST` binding, which would not typecheck.
    expect(GET).toBeTypeOf('function')
    const exported = Object.keys(routeModule).filter((k) => k !== '__esModule')
    expect(exported).toEqual(['GET'])
    expect('POST' in routeModule).toBe(false)
  })
})

function eventIndex(name: string): number {
  const i = events.indexOf(name)
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}
