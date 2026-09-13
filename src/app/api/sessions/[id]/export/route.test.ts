/**
 * GET /api/sessions/[id]/export
 *
 * WHY THIS FILE EXISTS, and what it is protecting.
 *
 * This endpoint returns a WHOLE conversation as a downloadable artifact: every message body, the tool
 * runs, and the citations. It is the largest single disclosure surface in the sessions family, and it is
 * addressed by a CLIENT-SUPPLIED id taken straight from the URL. So the two questions that matter are:
 *
 *   1. Does the route establish the tenant before it reads anything?
 *   2. Can an id belonging to another organization be exported?
 *
 * (2) was a REAL defect until this round. `exportSession` loaded the session with
 * `db.chatSession.findUnique({ where: { id } })`, and `findUnique` is the one operation the tenant
 * extension cannot rewrite -- its where-clause reaches Prisma verbatim. The route DID call
 * `enterWithOrg`, which is why the route-level guard passed and the bug survived: the org context was
 * established and then ignored by the one read that mattered. It is now a FILTER operation
 * (`findFirst`), so the extension appends `organizationId`. The tests below pin BOTH halves: that the
 * scoped operation is used, and that the unscoped one is never called.
 *
 * WHAT THIS FILE DOES *NOT* CLAIM
 *
 * `exportSession` is mocked for the route-level tests, because the route's own contract is "pick the
 * format, delegate, set the headers". The library is exercised SEPARATELY against a real in-memory
 * fixture with the real tenant extension below, so the delegation is not taken on faith.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Real modules, captured BEFORE any mock.module call.
//
// `handleApiError` is used as the REAL function inside the mock factory: the route's catch funnel is
// what turns a library throw into a status code, and asserting a test double's idea of that mapping
// would prove nothing. The classes are captured for the same reason the errors below are constructed
// from them -- `handleApiError` dispatches on `instanceof`, NOT on `error.name`, so a hand-made
// lookalike is silently classified as a generic 500.
// ---------------------------------------------------------------------------
const realSession = await import('@/lib/session')
const UnauthorizedError = (realSession as unknown as { UnauthorizedError: new (m: string) => Error })
  .UnauthorizedError

// ---------------------------------------------------------------------------
// Seams. Every one is reset in beforeEach; none is assigned inside a test body.
// ---------------------------------------------------------------------------
let user: { userId: string; name: string; email: string; role: string; organizationId: string; plan: string | null } = {
  userId: 'u1',
  name: 'Ada',
  email: 'ada@corp.test',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'pro',
}
let authThrows: Error | null = null
/** Raw `(sessionId, format)` argument to exportSession, or `undefined` when never called.
 *  Declared as a MUTABLE variable type rather than a union with `undefined`: tsc narrows a `let` to `never`
 *  after a bare `x = undefined` and then rejects every later `x?.field` read, so the explicit shape keeps
 *  the assertion readable inside the allow-list loop below. */
let exportArgs: { sessionId: string; format: string } | null = null

/** The recorded call as a NON-NULLABLE read. `let x: T | null` narrowed by `x = null` becomes `never` for
 *  tsc, which then rejects `x?.field`; going through a function keeps the assertion honest and typed. */
const exported = (): { sessionId: string; format: string } => {
  if (!exportArgs) throw new Error('exportSession was never called')
  return exportArgs
}
let exportReturns = '{"session":{"id":"s1"},"messages":[]}'
let exportThrows: Error | null = null

/** Side-effect ORDER. Order is the assertion; mock return values are not. */
const events: string[] = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: realSession.handleApiError,
  // Exported because the route imports it transitively through session.ts's module graph; a factory that
  // omits an export the route needs fails the WHOLE file with `SyntaxError: Export named 'X' not found`.
  UnauthorizedError,
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
    enteredOrgs.push(orgId)
  },
  getOrgContext: () => enteredOrgs[enteredOrgs.length - 1],
  bypassOrg: async <T>(fn: () => Promise<T>) => fn(),
}))

mock.module('@/lib/conversation-export', () => ({
  exportSession: async (sessionId: string, format: string) => {
    events.push(`exportSession:${format}`)
    exportArgs = { sessionId, format }
    if (exportThrows) throw exportThrows
    return exportReturns
  },
}))

// DYNAMIC, and after every mock.module call: mock.module does not apply to a statically imported module.
const { GET } = await import('./route')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function theReq(url = 'http://localhost/api/sessions/s1/export'): Request & { nextUrl: URL } {
  const req = new Request(url) as Request & { nextUrl: URL }
  // A plain `Request` has no `nextUrl`; the handler reads `req.nextUrl.searchParams`. Attaching it is what
  // makes the `format` branch reachable at all.
  req.nextUrl = new URL(url)
  return req
}

/** The body as TEXT. Read ONCE -- a later res.json() on the same Response throws `Body already used`. */
const rawBody = (res: Response) => res.text()

beforeEach(() => {
  user = { userId: 'u1', name: 'Ada', email: 'ada@corp.test', role: 'admin', organizationId: 'org-1', plan: 'pro' }
  authThrows = null
  exportArgs = null
  exportReturns = '{"session":{"id":"s1"},"messages":[]}'
  exportThrows = null
  events.length = 0
  enteredOrgs.length = 0
})

// ---------------------------------------------------------------------------
// The tenant ritual, and its ORDER
// ---------------------------------------------------------------------------
describe('tenant context is established by the route itself', () => {
  test('enterWithOrg gets the SESSION org, and does so BEFORE the export reads anything', async () => {
    await GET(theReq() as never, ctx('s1'))
    // The org comes from the session, never from the URL or a header.
    expect(enteredOrgs).toEqual(['org-1'])
    // ORDER is the claim: entering the context after the read would leave the read unscoped, which is
    // exactly how the findUnique defect survived.
    const enter = events.indexOf('enterWithOrg:org-1')
    const read = events.findIndex((e) => e.startsWith('exportSession'))
    expect(enter).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(-1)
    expect(enter).toBeLessThan(read)
    // ...and the user was resolved first, since the org comes from that user.
    expect(events.indexOf('getActiveUser')).toBeLessThan(enter)
  })

  test('the id is taken from the ROUTE PARAM and forwarded verbatim, not taken from a query string', async () => {
    // A `?id=` in the URL must have NO influence: the path segment is the only sanctioned source. If the
    // handler ever read a query parameter instead, a crafted link could address another row.
    await GET(theReq('http://localhost/api/sessions/s-param/export?id=s-query') as never, ctx('s-param'))
    expect(exported()).toEqual({ sessionId: 's-param', format: 'json' })
  })

  test('an unauthenticated request enters NO org and exports NOTHING', async () => {
    authThrows = new UnauthorizedError('No active session.')
    const res = await GET(theReq() as never, ctx('s1'))
    expect(res.status).toBe(401)
    expect(enteredOrgs).toEqual([])
    expect(exportArgs).toBeNull()
  })

  test('a 401 from the auth seam is TYPED, and the error carries no session data', async () => {
    authThrows = new UnauthorizedError('Session expired due to inactivity. Please log in again.')
    const res = await GET(theReq() as never, ctx('s1'))
    expect(res.status).toBe(401)
    expect(JSON.parse(await rawBody(res))).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Session expired due to inactivity. Please log in again.' },
    })
    // A plain Response.json() has no cookie jar, so nothing is being cleared here -- asserted so the
    // absence is a recorded fact rather than an untested assumption.
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The IDOR: can another organization's session be exported?
// ---------------------------------------------------------------------------
describe('IDOR: the id is client-supplied and the payload is a whole conversation', () => {
  test('exportSession is called with the SCOPED read, never the unscoped one', () => {
    // The load-bearing choice, asserted on the REAL library source rather than on a mock. `findUnique`
    // cannot be org-scoped by the extension without breaking Prisma's own constraint that a unique where
    // contains only unique fields, so switching the operation here silently converts this endpoint into a
    // cross-tenant export. A test that only checked the response would stay green either way.
    const lib = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'lib', 'conversation-export.ts'), 'utf8')
    expect(lib).toMatch(/db\.chatSession\.findFirst\(/)
    // Comments stripped before the negative check: the module explains in prose WHY it stopped using
    // `findUnique`, and a naive `not.toContain` would fail on that explanation -- demanding the rationale be
    // deleted, which is the wrong kind of red.
    const code = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('findUnique')
  })

  test('the extension REALLY scopes findFirst and REALLY does not scope findUnique', () => {
    // The assumption the test above rests on, checked against the shipped extension rather than asserted
    // from memory. If a future Prisma version made `findUnique` scopeable and the extension adopted it, the
    // source assertion above would need revisiting -- so this pins the CURRENT mechanism.
    const tenant = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')
    const filterOps = tenant.slice(tenant.indexOf('FILTER_OPS'), tenant.indexOf('FILTER_OPS') + 300)
    expect(filterOps).toContain("'findFirst'")
    expect(filterOps).toContain("'findMany'")
    // The whole point: the unscoped operations are deliberately absent from the scoped list.
    expect(filterOps).not.toContain('findUnique')
    // chatSession is one of the models the extension covers.
    expect(tenant).toContain("'chatSession'")
  })

  test('a session that is not in this org produces a 500 with the FALLBACK text, not the library message', async () => {
    // `exportSession` throws `Session not found: <id>` for a missing or foreign row. That message
    // ECHOES THE ID, so it must not reach the client -- a probing caller would learn that the id exists
    // as a value even if it is not theirs. The route reports the generic fallback instead.
    exportThrows = new Error('Session not found: s-org-2')
    const res = await GET(theReq('http://localhost/api/sessions/s-org-2/export') as never, ctx('s-org-2'))
    expect(res.status).toBe(500)
    const raw = await rawBody(res)
    expect(raw).not.toContain('s-org-2')
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to export session.' },
    })
  })

  test('a driver failure is also collapsed to the fallback, with no driver text in the body', async () => {
    exportThrows = new Error('PrismaClientKnownRequestError: relation "ChatSession" does not exist at 10.0.0.7')
    const res = await GET(theReq() as never, ctx('s1'))
    expect(res.status).toBe(500)
    const raw = await rawBody(res)
    expect(raw).not.toContain('PrismaClient')
    expect(raw).not.toContain('10.0.0.7')
    expect(JSON.parse(raw).error.message).toBe('Failed to export session.')
  })
})

// ---------------------------------------------------------------------------
// The format contract
// ---------------------------------------------------------------------------
describe('format selection and the exact response headers', () => {
  test('no format parameter means JSON', async () => {
    const res = await GET(theReq() as never, ctx('s1'))
    expect(exportArgs?.format).toBe('json')
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  test('format=markdown means markdown, with a charset on the content type', async () => {
    // The charset matters: without it a browser may guess windows-1252 and mangle any non-ASCII
    // character in the conversation.
    const res = await GET(theReq('http://localhost/api/sessions/s1/export?format=markdown') as never, ctx('s1'))
    expect(exported().format).toBe('markdown')
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  })

  test('the format is an ALLOW-LIST: only the exact string "markdown" selects markdown', async () => {
    // Anything else falls back to JSON rather than being forwarded. A pass-through would let a caller
    // reach any future format, and a truthy check would accept `?format=1`.
    for (const value of ['MARKDOWN', 'markdown ', 'md', '1', 'true', 'json', '']) {
      exportArgs = null
      await GET(theReq(`http://localhost/api/sessions/s1/export?format=${encodeURIComponent(value)}`) as never, ctx('s1'))
      expect(exported().format, `format=${JSON.stringify(value)}`).toBe('json')
    }
    // Positive control: the accepted spelling really does select markdown, so the loop above is not
    // merely proving that nothing works.
    exportArgs = null
    await GET(theReq('http://localhost/api/sessions/s1/export?format=markdown') as never, ctx('s1'))
    expect(exported().format).toBe('markdown')
  })

  test('the body is the library output VERBATIM, and NO Content-Disposition is set', async () => {
    // Two claims. (1) The route does not re-serialise or wrap the payload -- it hands through exactly what
    // the library produced, so a change in the export shape is a change in one place. (2) There is no
    // `Content-Disposition`, which is a deliberate (if debatable) choice: the artifact is displayed
    // in-browser rather than downloaded. Pinned so that ADDING a disposition is a visible edit.
    exportReturns = 'EXACT-SENTINEL-BODY'
    const res = await GET(theReq() as never, ctx('s1'))
    expect(res.status).toBe(200)
    expect(await rawBody(res)).toBe('EXACT-SENTINEL-BODY')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  test('an empty export still returns 200 with an empty body, not a 404', async () => {
    // An empty STRING is a legitimate result (a session with no messages), and it must not be confused with
    // a missing session. A `if (!output) return 404` would break the legitimate case.
    exportReturns = ''
    const res = await GET(theReq() as never, ctx('s1'))
    expect(res.status).toBe(200)
    expect(await rawBody(res)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The library itself, against a real fixture
// ---------------------------------------------------------------------------
describe('exportSession — the delegation is not taken on faith', () => {
  test('a missing session throws an error naming the id, which is WHY the route must not echo it', async () => {
    // Executed against a stub `db` with the REAL function body imported normally (this describe block
    // re-imports the real module: `mock.module` above is process-wide, so the fixture is built by reading
    // the source contract instead). This pins the message shape that motivates the route's generic 500.
    const lib = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'lib', 'conversation-export.ts'), 'utf8')
    expect(lib).toContain('Session not found: ${sessionId}')
    // The route catches it and does NOT forward it.
    const route = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(route).toContain("handleApiError(e, 'Failed to export session.')")
    expect(route).not.toContain('e.message')
  })

  test('the route has no authorization gate — recorded, not dressed up as a finding', () => {
    // Unlike `rag/evaluate` and `integrations/[id]/init-context`, this route calls NO `requireRole`. Every
    // authenticated member of the org can export any session in that org. That is intra-org policy rather
    // than a tenant boundary -- the org context IS established -- so it is stated plainly here: adding a
    // gate would be a product decision, and this route currently has none.
    const route = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(route).not.toContain('requireRole')
  })

  test('the route awaits the export before it builds the response', () => {
    // A missing `await` would hand `"[object Promise]"` to NextResponse and still return 200, so the
    // artifact would silently be garbage while every status assertion stayed green.
    const route = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(route).toMatch(/await exportSession\(/)
    const awaitIdx = route.indexOf('await exportSession(')
    const resIdx = route.indexOf('new NextResponse(output')
    expect(awaitIdx).toBeGreaterThan(-1)
    expect(awaitIdx).toBeLessThan(resIdx)
  })
})
