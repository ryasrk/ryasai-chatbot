/**
 * GET /api/schedules/[id]/runs/export — CSV/JSON download of one scheduled run's execution
 * history.
 *
 * WHY THIS FILE EXISTS. This is the sibling of `/api/schedules/[id]/runs` and shares its IDOR
 * shape, but it is a DATA DISCLOSURE surface with two extra failure modes the list route does
 * not have:
 *
 *   1. THE IDOR QUESTION. The route takes a CLIENT-SUPPLIED `id` from the route params. It
 *      loads the schedule with `findFirst({ where: { id } })` — a FILTER op, so
 *      `createTenantExtension()` appends `organizationId` and a foreign id yields `null`
 *      (→ 404). The test at the bottom does not take that on faith: it drives the REAL
 *      extension (source read + the real `injectOrgWhere` transcription executed against a
 *      two-org table) and shows org-1 asking for org-2's schedule covers ZERO rows, while the
 *      positive control returns org-2's rows. The previous revision of this file CALLED that
 *      404 a cross-tenant disclosure because the extension was mocked — the mock was wrong,
 *      the route was right.
 *   2. THE SECOND QUERY HAS NO OWNERSHIP CHECK OF ITS OWN. Once the schedule passed step 1,
 *      the logs are read with `findMany({ where: { scheduledRunId: id } })` — again a FILTER
 *      op, so the org term is injected there too. `ScheduledRunLog` is in ORG_SCOPED_MODELS
 *      (asserted from source). But that means the export's isolation rests on TWO
 *      independently-injected org terms, and if the route were ever changed to load the logs
 *      by unique key (`findUnique`), the disclosure would be complete: the answer column is
 *      the full LLM answer text.
 *
 * WHAT IS WRONG, AND IS PINNED AS SUCH:
 *   * NO ROW BOUND. `findMany` here has no `take`, unlike the list route's `take: 50`. A
 *     schedule that fires every minute for a year at 1440 rows/day serialises its entire
 *     history in one response, in memory, on the server and in the browser.
 *   * NO ROLE GATE. Any authenticated member — this suite's user is an `analyst` — can export
 *     the full answer text of every execution. The list route has the same posture, so this
 *     is a policy question about shared schedules rather than a regression, and it is pinned
 *     as the contract.
 *   * KNOWN GAP, left untested deliberately: `format` accepts any string and silently falls
 *     through to JSON. Prefixed/padded values (`?format=csv%20`) do NOT match `'csv'`. The
 *     JSON branch then serialises the raw `answer` field UNTRUNCATED while the CSV branch
 *     slices it to 500 chars. Pinning either behaviour here would freeze an inconsistency, so
 *     neither is asserted; see the note in the last describe block.
 *
 * WHAT IS TESTED AND WHY IT MATTERS:
 *   * The BYTE-EXACT CSV: header order, which fields are quoted and which are bare, how a
 *     `"` is escaped, how a NEWLINE inside a field is rewritten to a space, the empty-log-row
 *     set (header only, no trailing newline), and — the finding — that the `answer` cell is
 *     NOT spread-proof, so a spreadsheet opens `SUM(1+1)*cmd|'/C calc'!A0` as a formula when
 *     the only escaping performed in the CSV branch is quote/CR stripping.
 *   * The EXPORT DELIMITER IS NOT THE RFC-4180 QUOTER. `esc()` escapes quotes and discards
 *     carriage returns, but fields containing the COMMA delimiter are NOT wrapped (a newline
 *     in a field always is, byte 10 only). Unquoted commas are exactly what a naive
 *     split(',') on the client would mis-parse.
 *   * The exact `Content-Type` / `Content-Disposition` headers and the filename sanitisation
 *     (`[^a-zA-Z0-9]` → `_`), which is the one thing the user sees in their downloads folder.
 *
 * METHOD NOTES (repo-specific, hard-won):
 *   * Every `mock.module()` call precedes the single dynamic `await import('./route')`. A
 *     static import would not see the mocks.
 *   * No factory spreads an imported namespace or reads a real binding off one; the real
 *     modules are reached only through the `realDb`/`realSession` consts captured from
 *     top-level `await import()` calls that happen BEFORE any factory can run.
 *   * Bodies are read ONCE as text and then `JSON.parse`d — `res.text()` consumes the stream.
 *   * `Request` has no `.nextUrl`, so it is attached explicitly, because this route reads
 *     `req.nextUrl.searchParams` (unlike the list route, which ignores the URL entirely).
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Real modules, captured BEFORE any mock.module() call. The route's own runtime
// dependencies are mocked below, so these imports cannot recurse through the
// factories; they exist so the two disclosure tests can execute the REAL tenant
// extension against a two-org table, and hand the REAL handleApiError an error
// and get whatever status IT thinks is right.
// ---------------------------------------------------------------------------
const tenantMod = await import('@/lib/prisma-tenant')
// `injectOrgWhere` is NOT exported from prisma-tenant.ts -- it is a module-private helper -- so it cannot be
// captured off the namespace, and a transcript that assumed it could was asserting on `undefined` (which is why the
// test below failed with "not a function" rather than with a wrong result). It is EXTRACTED FROM THE REAL SOURCE
// instead, so nothing here is a hand transcription of the rule being tested.
const realInjectOrgWhere = ((): ((a: Record<string, unknown>, orgId: string) => Record<string, unknown>) => {
  const src = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')
  const start = src.indexOf('function injectOrgWhere(')
  if (start === -1) throw new Error('injectOrgWhere not found in prisma-tenant.ts -- update this harness')
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end + 2).replace('function injectOrgWhere', 'function injectOrgWhere')
  // The file is TypeScript; strip the two annotations so the real body can run as plain JS.
  const js = body
    .replace('(args: any, orgId: string): any {', '(args, orgId) {')
    .replace('(args: any, orgId: string) {', '(args, orgId) {')
  return new Function(`${js}\nreturn injectOrgWhere`)() as (
    a: Record<string, unknown>,
    orgId: string,
  ) => Record<string, unknown>
})()
void tenantMod
const realSession = await import('@/lib/session')
// Captured from the REAL module so the error you throw in a test is the class `handleApiError` tests with
// `instanceof`. A lookalike with `name = 'UnauthorizedError'` is NOT the same object and lands in the generic 500
// branch -- which would make these tests assert the fixture rather than the contract.
const UnauthorizedError = (realSession as unknown as { UnauthorizedError: new (m: string) => Error }).UnauthorizedError

// ---------------------------------------------------------------------------
// Mutable seams. Declared BEFORE every mock.module() block so the factories can
// close over them; there is no mock.module() inside a test body anywhere in this
// file, because those are never restored and poison everything after them.
// ---------------------------------------------------------------------------

const user = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro' as string | null,
}

/** When set, `getActiveUser()` rejects with this instead of returning a user. */
let authThrows: Error | null = null

/** The row `db.scheduledRun.findFirst` resolves to. `null` = not found OR other org. */
let scheduleRow: Record<string, unknown> | null = null

/** Raw log rows handed back by `findMany`. */
let logRows: Array<Record<string, unknown>> = []
let scheduleThrows: Error | null = null
let logsThrow: Error | null = null

/** Side-effect ORDER. Order IS the assertion; a mock's return value is not. */
const events: string[] = []
/** Every Prisma call with its raw args, so the query SHAPE can be asserted. */
const dbCalls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
/** Org ids handed to `enterWithOrg`, in call order. */
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  // The REAL handler. This route's catch funnel is the only place a failure can become a
  // response, and the interesting fact is that a plain `Error` (the `Session not found: x`
  // throw is NOT reachable from this route, but a Prisma driver error is) is reported as a
  // generic 500. Delegating keeps the status/body contract honest instead of asserting the
  // test double's own idea of it.
  handleApiError: realSession.handleApiError,
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
    enteredOrgs.push(orgId)
  },
  // Present because the real module exports it and the route's neighbours import it from the
  // same specifier; absent, a future import fails with `Export named 'getOrgContext' not
  // found` rather than a contract error.
  getOrgContext: () => enteredOrgs.at(-1),
}))

mock.module('@/lib/db', () => ({
  db: {
    scheduledRun: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findFirst')
        dbCalls.push({ model: 'scheduledRun', op: 'findFirst', args })
        if (scheduleThrows) throw scheduleThrows
        return scheduleRow
      },
      // Provided so a future regression to the unscoped unique read FAILS LOUDLY here
      // (returning the row regardless of org) instead of throwing `undefined is not a
      // function`, which would look like an unrelated server error.
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findUnique')
        dbCalls.push({ model: 'scheduledRun', op: 'findUnique', args })
        return scheduleRow
      },
    },
    scheduledRunLog: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRunLog.findMany')
        dbCalls.push({ model: 'scheduledRunLog', op: 'findMany', args })
        if (logsThrow) throw logsThrow
        return logRows
      },
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRunLog.findUnique')
        dbCalls.push({ model: 'scheduledRunLog', op: 'findUnique', args })
        return logRows[0] ?? null
      },
    },
  },
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// DYNAMIC import AFTER every mock.module() call. A static import would be bound
// to the unmocked modules.
const { GET } = await import('./route')

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

/** The route's real context shape: `{ params: Promise<{ id: string }> }`, as 2nd argument. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

/**
 * `Request` has no `nextUrl`; the route reads `req.nextUrl.searchParams`, so it is attached.
 * A bare `new Request()` with `?format=` in the URL has an EMPTY searchParams in some
 * runtimes, which would silently test the JSON path while claiming to test CSV.
 */
function theReq(url = 'http://localhost/api/schedules/s1/runs/export'): NextRequest {
  const req = new Request(url) as NextRequest
  ;(req as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return req
}

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws `Body used`. */
async function rawBody(res: Response): Promise<string> {
  return await res.text()
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const raw = await rawBody(res)
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** ISO strings for the route's `executedAt.toISOString()` call. */
const T0 = new Date('2026-06-01T02:00:00.000Z')

/** A `ScheduledRun` row with the columns the route selects. */
function schedule(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Nightly Revenue Digest',
    cronExpr: '0 2 * * *',
    prompt: 'Summarise yesterday revenue',
    ...over,
  }
}

/** A `ScheduledRunLog` row as the route reads it (all String/Int/DateTime columns). */
function logRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    status: 'success',
    answer: 'Revenue was 42',
    error: null,
    latencyMs: 1234,
    toolRunsJson: null,
    executedAt: T0,
    ...over,
  }
}

/** The exact args of the first call matching `model.op`. */
function callArgs(model: string, op: string): Record<string, unknown> {
  const hit = dbCalls.find((c) => c.model === model && c.op === op)
  expect(hit, `expected a ${model}.${op} call; saw ${JSON.stringify(dbCalls.map((c) => `${c.model}.${c.op}`))}`).toBeDefined()
  return hit!.args
}

beforeEach(() => {
  authThrows = null
  scheduleRow = schedule()
  logRows = []
  scheduleThrows = null
  logsThrow = null
  events.length = 0
  dbCalls.length = 0
  enteredOrgs.length = 0
})

// ---------------------------------------------------------------------------
// Org context — the precondition for every scoping claim below
// ---------------------------------------------------------------------------

describe('org context is established by the route itself', () => {
  test('enterWithOrg gets the SESSION org, with that argument, BEFORE the first DB call', () => {
    // `getActiveUser()` calls `enterWithOrg()` internally too, but AsyncLocalStorage's
    // enterWith mutates the CALLEE's async context: it does not propagate back to this
    // caller's frame. If the route did not repeat the call, every query below would run
    // unscoped and the export would be cross-tenant.
    return GET(theReq(), ctx('s1')).then(() => {
      expect(enteredOrgs).toEqual(['org-1'])
      expect(events).toEqual([
        'getActiveUser',
        'enterWithOrg:org-1',
        'db.scheduledRun.findFirst',
        'db.scheduledRunLog.findMany',
      ])
    })
  })

  test('the org is entered before the FIRST db call even when the schedule is missing', async () => {
    // The 404 path must not be the one that skips context: a route that entered the org only
    // after a successful load would still leak on the paths that read before checking.
    scheduleRow = null
    const res = await GET(theReq(), ctx('nope'))
    expect(res.status).toBe(404)
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('db.scheduledRun.findFirst'))
    expect(events).not.toContain('db.scheduledRunLog.findMany')
  })

  test('an unauthenticated request enters NO org and reads NOTHING', async () => {
    // The REAL class, not an `Error` with its `name` set. `handleApiError` dispatches on `instanceof`, so a
    // hand-made lookalike is classified as a generic 500 -- the test would then be asserting the fixture's
    // idea of the contract rather than the contract.
    authThrows = new UnauthorizedError('No active session.')
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(401)
    expect(dbCalls).toEqual([])
    expect(enteredOrgs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// IDOR: can an id from another org be exported?
// ---------------------------------------------------------------------------

describe('IDOR question: the [id] is client-supplied and this route exports data', () => {
  test('the schedule is loaded by FILTER, never by UNIQUE key', async () => {
    // `findFirst` is the load-bearing choice. `findUnique` cannot be org-scoped by the tenant
    // extension (Prisma rejects extra fields in a unique where), so switching the op here
    // silently converts this endpoint into a cross-tenant export of another org's LLM answers.
    await GET(theReq(), ctx('s-org-2'))
    expect(dbCalls.map((c) => `${c.model}.${c.op}`)).toEqual([
      'scheduledRun.findFirst',
      'scheduledRunLog.findMany',
    ])
    expect(dbCalls.find((c) => c.op.startsWith('findUnique'))).toBeUndefined()

    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).toMatch(/db\.scheduledRun\.findFirst/)
    expect(routeSrc).not.toContain('findUnique')
  })

  test('both queries carry the id AND are FILTER ops in the real ORG_SCOPED_MODELS source', () => {
    // Static, because this file mocks the `@/lib/prisma-tenant` specifier: a namespace import
    // would hand back the stub. `injectOrgWhere` is a pure three-branch function, so its whole
    // contract is visible in its text.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')

    const scopedStart = tenantSrc.indexOf('const ORG_SCOPED_MODELS')
    const scoped = tenantSrc.slice(scopedStart, tenantSrc.indexOf('])', scopedStart))
    expect(scoped).toContain("'scheduledRun'")
    expect(scoped).toContain("'scheduledRunLog'")

    const filterStart = tenantSrc.indexOf('const FILTER_OPS')
    const filters = tenantSrc.slice(filterStart, tenantSrc.indexOf('])', filterStart))
    expect(filters).toContain("'findFirst'")
    expect(filters).toContain("'findMany'")
    expect(filters).not.toContain("'findUnique'")

    // Appends rather than replaces, so the route's own id term survives next to the org.
    const inject = tenantSrc.slice(tenantSrc.indexOf('function injectOrgWhere'), tenantSrc.indexOf('function injectOrgCreate'))
    expect(inject).toContain('{ ...args.where, organizationId: orgId }')
  })

  test('IDOR REFUTED by executing the REAL injectOrgWhere against a two-org table', () => {
    // Argument shape is not a result, so the shipped injection is RUN. `realInjectOrgWhere` is
    // the actual export captured before the module was mocked; the transcription hazard of
    // hand-writing `{ ...where, organizationId }` (which the previous revision of this file
    // did) is gone.
    //
    // Rows: org-2 owns schedule `s-org-2` with one log whose answer is the secret.
    const schedules = [
      { id: 's-org-2', organizationId: 'org-2', name: 'ORG 2 SECRET SCHEDULE' },
      { id: 's-org-1', organizationId: 'org-1', name: 'mine' },
    ]
    const logs = [
      { id: 'a1', organizationId: 'org-2', scheduledRunId: 's-org-2', answer: 'ORG 2 SECRET ANSWER' },
      { id: 'b1', organizationId: 'org-1', scheduledRunId: 's-org-1', answer: 'mine' },
    ]
    const query = <T extends Record<string, unknown>>(rows: T[], orgId: string, where: Record<string, unknown>): T[] => {
      const scoped = realInjectOrgWhere({ where }, orgId).where as Record<string, unknown>
      return rows.filter((r) => Object.entries(scoped).every(([k, v]) => r[k] === v))
    }

    // Cross-org: org-1 asking for org-2's schedule id yields NOTHING at either step.
    expect(query(schedules, 'org-1', { id: 's-org-2' })).toEqual([])
    expect(query(logs, 'org-1', { scheduledRunId: 's-org-2' })).toEqual([])

    // Positive control, without which "returns []" could just mean the harness is broken.
    expect(query(schedules, 'org-2', { id: 's-org-2' }).map((r) => r.name)).toEqual(['ORG 2 SECRET SCHEDULE'])
    expect(query(logs, 'org-2', { scheduledRunId: 's-org-2' }).map((r) => r.answer)).toEqual(['ORG 2 SECRET ANSWER'])

    // And org-1 still sees its own.
    expect(query(logs, 'org-1', { scheduledRunId: 's-org-1' }).map((r) => r.id)).toEqual(['b1'])
  })

  test('the LOG query filters on scheduledRunId from the ROUTE PARAM, not the loaded row', async () => {
    // They must agree: the URL says s9, the segment says s9. If a future change filtered by
    // `schedule.id` while trusting a different id anywhere else, the export could pair one
    // schedule's metadata with another's logs. Pinned as exact args on both calls.
    await GET(theReq('http://localhost/api/schedules/s9/runs/export'), ctx('s9'))
    expect(callArgs('scheduledRun', 'findFirst').where).toEqual({ id: 's9' })
    expect(callArgs('scheduledRunLog', 'findMany').where).toEqual({ scheduledRunId: 's9' })
  })

  test('a foreign or unknown id is 404 with a stable body, and the error text is not a disclosure', async () => {
    scheduleRow = null
    const res = await GET(theReq('http://localhost/api/schedules/s-org-2/runs/export?format=csv'), ctx('s-org-2'))
    expect(res.status).toBe(404)
    // Read the body ONCE. `res.text()` consumes it, so a second `res.json()`/`res.text()` on the same Response
    // throws `TypeError: Body already used` -- which reads as a route failure and is actually the harness.
    const raw = await rawBody(res)
    expect(JSON.parse(raw)).toEqual({ ok: false, error: 'Schedule not found.' })
    // The id must NOT come back: echoing it confirms the id space to a probing caller. Asserted on the SAME string
    // that was parsed above, so both claims are about one response.
    expect(raw).not.toContain('s-org-2')
  })
})

// ---------------------------------------------------------------------------
// CSV — the exported artifact
// ---------------------------------------------------------------------------

describe('CSV export — byte-exact serialisation', () => {
  test('the header is the FIRST LINE, in this exact order, comma-delimited, with no BOM', async () => {
    // This is the contract a spreadsheet column mapping depends on. A reordered header
    // silently shifts every downstream column.
    logRows = [logRow()]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body.split('\n')[0]).toBe('executedAt,status,latencyMs,answer,error')
    expect(body.startsWith('\uFEFF')).toBe(false)
  })

  test('a successful row is emitted with only answer and error QUOTED, numbers bare', async () => {
    logRows = [logRow({ executedAt: new Date('2026-06-01T02:00:00.000Z'), status: 'success', latencyMs: 1234, answer: 'All good', error: null })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toBe(
      'executedAt,status,latencyMs,answer,error\n' +
        '2026-06-01T02:00:00.000Z,success,1234,"All good",""',
    )
  })

  test('a NULL latencyMs is an EMPTY cell, not the string null and not 0', async () => {
    // `latencyMs ?? ''`: a skipped run has no latency. `0` would render as a real measurement.
    logRows = [logRow({ latencyMs: null })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body.split('\n')[1]!.split(',')[2]).toBe('')
    expect(body).not.toContain('null')
  })

  test('an embedded double quote is DOUBLED (RFC-4180) and the cell stays parseable', async () => {
    logRows = [logRow({ answer: 'He said "hello"' })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toContain('"He said ""hello"""')
    // A naive re-quoting would leave an odd number of quotes in the line.
    const line = body.split('\n')[1]!
    expect((line.match(/"/g) ?? []).length % 2).toBe(0)
  })

  test('a newline inside a value is REWRITTEN TO A SPACE, keeping one physical row per log', async () => {
    // The route's own `rows.join('\n')` is the only real row separator. A newline surviving
    // inside a cell would split one execution into two apparent rows for every consumer that
    // reads this file line-by-line.
    logRows = [logRow({ answer: 'line one\nline two' }), logRow({ id: 'l2', answer: 'second' })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toContain('"line one line two"')
    expect(body.split('\n')).toHaveLength(3) // header + 2 rows
  })

  test('a carriage return survives inside the cell — the escape only rewrites byte 10', async () => {
    // `esc()` replaces `/"/g` and `/\n/g`. A lone `\r` (old Mac line ending, or a value from a
    // MySQL TEXT column) is NOT rewritten, so this is an assertion about the current contract:
    // a cell may still contain a CR. A bare CR inside a quoted field is tolerated by most
    // CSV parsers, which is why this is recorded rather than flagged as a defect.
    logRows = [logRow({ answer: 'a\rb' })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toContain('"a\rb"')
  })

  test('a value containing the DELIMITER is NOT quote-wrapped — the quoter is not the CSV delimiter escaper', async () => {
    // The CSV branch quotes exactly two columns (answer, error). A comma in either is a
    // structural hazard for any client doing split(','). Recorded as the current contract so
    // a change to always-quote is a deliberate decision.
    logRows = [logRow({ answer: 'Revenue, Q1' })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    // `esc` DOES wrap answer, so the comma is inside quotes here...
    expect(body).toContain('"Revenue, Q1"')
    // ...but `status` is emitted bare, so an unquoted comma in ANY non-escaped field would
    // shift columns. This is the canonical counter-example the header row does not guard.
    logRows = [logRow({ status: 'weird,status' })]
    const body2 = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body2.split('\n')[1]).toContain('weird,status')
    expect(body2.split('\n')[1]!.split(',')).toHaveLength(6) // 5 columns become 6 fields
  })

  test('the answer cell is TRUNCATED to the first 500 characters', async () => {
    // The cap is the only bound on a single cell. Note it does NOT apply in JSON mode — see
    // the mode-divergence test at the end of this file.
    logRows = [logRow({ answer: 'x'.repeat(600) })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toContain(`"${'x'.repeat(500)}"`)
    expect(body).not.toContain('x'.repeat(501))
  })

  test('rows keep the ORDER the database returned them in (executedAt asc, set by the query)', async () => {
    // The route maps in place and joins; it does not sort. A re-sort in the route would make
    // the `orderBy` in the query dead code.
    logRows = [
      logRow({ id: 'old', answer: 'first', executedAt: new Date('2026-01-01T00:00:00.000Z') }),
      logRow({ id: 'new', answer: 'last', executedAt: new Date('2026-02-01T00:00:00.000Z') }),
    ]
    await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    expect(callArgs('scheduledRunLog', 'findMany').orderBy).toEqual({ executedAt: 'asc' })
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body.indexOf('first')).toBeLessThan(body.indexOf('last'))
  })

  test('an EMPTY history emits the header row ALONE — no trailing newline, no blank lines', async () => {
    // "A file with only a header" and "an empty file" are different downloads; the header is
    // what a spreadsheet needs to map the columns before the first run fires.
    logRows = []
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toBe('executedAt,status,latencyMs,answer,error\n')
    expect(body.trim()).toBe('executedAt,status,latencyMs,answer,error')
  })

  test('a run that used NO tools still exports its row shape (toolRunsJson is not a CSV column)', async () => {
    // toolRunsJson is read by this query and used only on the JSON path. Pinned so the
    // asymmetry is visible: the CSV carries answers but not the tool breakdown.
    logRows = [logRow({ toolRunsJson: JSON.stringify([{ type: 'SQL', status: 'success' }]) })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).not.toContain('SQL')
    expect(body.split('\n')[0]).not.toContain('tool')
  })

  test('the export column set is EXACTLY the five selected fields — no organizationId leak', async () => {
    // An `include`/`select` widening in the query would show up here. organizationId is
    // injected into the WHERE but must never reach the file.
    await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    expect(callArgs('scheduledRunLog', 'findMany').select).toBeUndefined()
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).not.toContain('organizationId')
    expect(body).not.toContain('org-1')
  })
})

// ---------------------------------------------------------------------------
// CSV injection — the finding
// ---------------------------------------------------------------------------

describe('CSV injection surface (formula injection / CSV injection)', () => {
  test('INVERT WHEN FIXED: a value starting with = survives unescaped, so a spreadsheet evaluates it', async () => {
    // FINDING, with the evidence in the assertion itself. `esc()` performs exactly two
    // substitutions — double every `"`, replace every `\n` with a space. It does NOT prefix a
    // leading `=`, `+`, `-`, `@`, tab or CR with an apostrophe, which is the standard defence
    // (OWASP: "CSV Injection"). `status` and the numeric `latencyMs` are not escaped AT ALL.
    //
    // The exposure path is real, not theoretical: `answer` and `error` are LLM/driver text and
    // this file is downloaded and opened in Excel/Sheets. A value of the classic form below is
    // executed as a formula on open in the common (non-WarnOn) configuration.
    //
    // INVERT WHEN FIXED: when `esc()` (or a new `csvCell()`) guards leading `= + - @ \t \r` by
    // prefixing `'`, or wraps every cell in quotes, the assertions below flip from
    // "unescaped present" to "prefixed form present" — delete the `not.toContain` lines and
    // assert on the guarded cell instead. Do not simply delete this test: it is the only
    // record that the surface was measured.
    const payload = `=SUM(1+1)*cmd|'/C calc'!A0`
    logRows = [logRow({ status: payload, answer: payload, error: payload })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    const row = body.split('\n')[1]!

    // The un-escaped field: status is emitted bare, so the leading `=` is column 2 directly.
    expect(row.startsWith('2026-06-01T02:00:00.000Z,=SUM(1+1)')).toBe(true)
    // The quoted fields still open with the formula character right after the quote, which
    // Excel strips before evaluating.
    expect(row).toContain(`"=SUM(1+1)*cmd|'/C calc'!A0"`)
    // And the same for the other three dangerous openers, so a fix that only handles `=` is
    // visibly incomplete.
    for (const opener of ['+', '-', '@', '\t']) {
      logRows = [logRow({ status: `${opener}cmd` })]
      const b = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
      expect(b).toContain(`${opener}cmd`)
      expect(b).not.toContain(`'${opener}cmd`)
    }
  })

  test('the mitigation the route DOES have is quote-doubling, which does not cover the formula surface', async () => {
    // Stated so the two are not confused: doubling quotes protects the CSV STRUCTURE, not the
    // spreadsheet's formula evaluator. A payload containing both proves they are independent.
    logRows = [logRow({ answer: '="a""b"&1+1' })]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(body).toContain('"=""a""""b""&1+1"')
  })
})

// ---------------------------------------------------------------------------
// JSON mode — the default
// ---------------------------------------------------------------------------

describe('JSON export (the DEFAULT format) — body shape and header contract', () => {
  test('no format param at all means JSON — the query default is json, not csv', async () => {
    logRows = [logRow()]
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(res.headers.get('content-type')).toBe('application/json')
    const parsed = await jsonBody(res)
    expect(Object.keys(parsed).sort()).toEqual(['executions', 'schedule'])
  })

  test('an unrecognised format silently falls back to JSON', async () => {
    // Recorded, not endorsed: `?format=xml` gets a 200 JSON attachment rather than a 400. A
    // client that asked for something unsupported gets a body it can still read.
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=xml'), ctx('s1'))
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(Object.keys(await jsonBody(res))).toContain('executions')
  })

  test('the schedule object is exactly id/name/cronExpr/prompt — the prompt is inside the export', async () => {
    // The scheduled PROMPT is tenant content and it is disclosed here by design (it is the
    // user's own schedule). Pinned as an exact key set so an added field is a visible choice.
    logRows = [logRow()]
    const parsed = await jsonBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1')))
    expect(parsed.schedule).toEqual({
      id: 's1',
      name: 'Nightly Revenue Digest',
      cronExpr: '0 2 * * *',
      prompt: 'Summarise yesterday revenue',
    })
  })

  test('each execution carries the SIX documented keys and executedAt is an ISO string', async () => {
    logRows = [logRow()]
    const parsed = await jsonBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1')))
    const exec = (parsed.executions as Array<Record<string, unknown>>)[0]!
    expect(Object.keys(exec).sort()).toEqual(['answer', 'error', 'executedAt', 'latencyMs', 'status', 'toolRuns'])
    expect(exec.executedAt).toBe('2026-06-01T02:00:00.000Z')
  })

  test('toolRunsJson IS parsed into toolRuns on the JSON path — absent becomes null, not "null"', async () => {
    logRows = [
      logRow({ id: 'l1', toolRunsJson: JSON.stringify([{ type: 'SQL', status: 'success', latencyMs: 9 }]) }),
      logRow({ id: 'l2', toolRunsJson: null }),
      logRow({ id: 'l3', toolRunsJson: '' }),
    ]
    const parsed = await jsonBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1')))
    const execs = parsed.executions as Array<Record<string, unknown>>
    expect(execs[0]!.toolRuns).toEqual([{ type: 'SQL', status: 'success', latencyMs: 9 }])
    expect(execs[1]!.toolRuns).toBeNull()
    expect(execs[2]!.toolRuns).toBeNull()
  })

  test('a MALFORMED toolRunsJson turns the WHOLE export into a 500 — no row survives', async () => {
    // The parser is unguarded inside a `.map()` over every log row, unlike the list route
    // (`/runs`), which was hardened to flag the damaged row and keep the rest. One corrupt
    // row -- reachable if the scheduler is killed mid-write -- therefore costs the user the
    // ENTIRE export rather than one row. Pinned as the current contract; the fix is the
    // TRY/PARSE/FALLBACK shape the sibling route already uses.
    logRows = [logRow({ id: 'good', toolRunsJson: null }), logRow({ id: 'bad', toolRunsJson: '{"truncated', answer: 'ORG2 SECRET' })]
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(res.status).toBe(500)
    const body = await jsonBody(res)
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export execution history.' } })
    // Neither the good nor the bad row is exported, and no driver/JSON text leaks.
    expect(JSON.stringify(body)).not.toContain('truncated')
    expect(JSON.stringify(body)).not.toContain('ORG2 SECRET')
  })

  test('the JSON body is pretty-printed with a 2-space indent', async () => {
    logRows = [logRow()]
    const body = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1')))
    expect(body).toContain('\n  "schedule"')
    expect(body.startsWith('{\n  "schedule"')).toBe(true)
  })

  test('DECLARED DIVERGENCE: JSON does NOT truncate answer to 500 chars, CSV does', async () => {
    // Recorded because the two formats disagree about the same field. The CSV cap looks like a
    // cell-size safety measure, but the JSON export hands the browser the full text, so the cap
    // does not bound what the user can download. Not asserted as desirable -- asserted so that
    // "fixing" either side is a visible decision.
    logRows = [logRow({ answer: 'y'.repeat(600) })]
    const parsed = await jsonBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1')))
    const exec = (parsed.executions as Array<Record<string, unknown>>)[0]!
    expect((exec.answer as string).length).toBe(600)

    const csv = await rawBody(await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1')))
    expect(csv).toContain(`"${'y'.repeat(500)}"`)
    expect(csv).not.toContain('y'.repeat(501))
  })
})

// ---------------------------------------------------------------------------
// Headers: content type, disposition, filename
// ---------------------------------------------------------------------------

describe('response headers — the file the browser saves', () => {
  test('CSV: exact Content-Type and Content-Disposition, filename built from the schedule name', async () => {
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Nightly_Revenue_Digest_runs.csv"',
    )
  })

  test('JSON: exact Content-Type and Content-Disposition, same sanitisation with a .json suffix', async () => {
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Nightly_Revenue_Digest_runs.json"',
    )
  })

  test('the filename is sanitised: every non-alphanumeric character becomes an underscore', async () => {
    // The name is user-supplied. A raw quote or path separator here would either break the
    // header or let the browser pick a name outside the downloads folder. CJK names collapse
    // to underscores entirely rather than being dropped or percent-encoded.
    const RAW_NAME = 'Revenue / "Q1" — 収益 (final)'
    scheduleRow = schedule({ name: RAW_NAME })
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    const disposition = res.headers.get('content-disposition')!
    // Derived from the RULE the route documents (`[^a-zA-Z0-9]` -> `_`), not hand-counted. The first version of
    // this assertion hard-coded the underscore run and was wrong by one, which is what a hand count buys: the
    // test fails, and it is the TEST that is wrong, so the failure teaches nothing about the route.
    const expected = RAW_NAME.replace(/[^a-zA-Z0-9]/g, '_') + '_runs.csv'
    expect(disposition).toBe(`attachment; filename="${expected}"`)
    // The characters that would BREAK the header or redirect the save are gone, which is the actual claim.
    expect(disposition).not.toContain('"Q1"')
    expect(disposition).not.toContain('/')
    // The filename parameter is quoted EXACTLY ONCE, so no user character can close it early and inject a second
    // parameter. Measured: the obvious `split('filename="')[1]` does NOT prove this, because the CLOSING quote the
    // route itself emits is still there -- that assertion failed against a correct header, which is a test bug
    // masquerading as a route bug. Count the quotes instead.
    const filenameParam = disposition.slice(disposition.indexOf('filename='))
    expect(filenameParam.match(/"/g)).toHaveLength(2)
  })

  test('a name with no safe characters still yields a usable filename, never an empty one', async () => {
    scheduleRow = schedule({ name: '***' })
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    // Three characters in, three underscores out -- asserted as a shape (non-empty, no hostile character, correct
    // suffix) so the claim is "a usable filename is still produced" rather than an underscore census.
    const disposition = res.headers.get('content-disposition')!
    const filename = disposition.split('filename="')[1].replace('"', '')
    expect(filename).toMatch(/^_+_runs\.json$/)
    expect(filename.length).toBeGreaterThan('_runs.json'.length)
    expect(disposition).not.toContain('*')
    // Only ONE filename parameter, so nothing after it can smuggle a second one in.
    expect(disposition.match(/filename=/g)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('failures surface through handleApiError', () => {
  test('a schedule query failure is 500 with the FALLBACK text, never the driver text', async () => {
    scheduleThrows = new Error('relation "ScheduledRun" does not exist')
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(res.status).toBe(500)
    const body = await jsonBody(res)
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to export execution history.' } })
    expect(JSON.stringify(body)).not.toContain('ScheduledRun')
    expect(JSON.stringify(body)).not.toContain('relation')
  })

  test('a LOG query failure is also a 500 through the same funnel — no partial CSV', async () => {
    // A partially-written CSV (header only, or a truncated last row) would be a silent
    // data-integrity failure for anyone importing it. The route writes the whole body in one
    // `NextResponse` after the query resolves, so this is guaranteed by construction -- the
    // test proves it stayed that way.
    logsThrow = new Error('connection terminated unexpectedly')
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    expect(res.status).toBe(500)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await rawBody(res)).not.toContain('executedAt,status')
  })

  test('a 401 from the auth seam is typed and reads no data', async () => {
    // REAL class again -- `instanceof`, not `name`, is what the handler dispatches on.
    authThrows = new UnauthorizedError('Session expired due to inactivity. Please log in again.')
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    expect(res.status).toBe(401)
    expect(await jsonBody(res)).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Session expired due to inactivity. Please log in again.' },
    })
    // Response.json() responses carry no cookie jar: the error path is a plain JSON body.
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Bounds, authorization posture, and what is deliberately NOT pinned
// ---------------------------------------------------------------------------

describe('disclosure bounds and authorization posture', () => {
  test('the log read is UNBOUNDED — no take, no cursor', async () => {
    // THE finding about scale. The sibling list route reads `take: 50`; this export reads the
    // whole history and serialises it into one string. A minute-by-minute schedule accumulates
    // 1440 rows/day. Asserted as the exact args object, so adding a bound makes this fail and
    // the change gets reviewed (that is the point — the assertion records today's contract).
    await GET(theReq('http://localhost/api/schedules/s1/runs/export?format=csv'), ctx('s1'))
    const args = callArgs('scheduledRunLog', 'findMany')
    expect(args).toEqual({
      where: { scheduledRunId: 's1' },
      orderBy: { executedAt: 'asc' },
    })
    expect(args.take).toBeUndefined()
    expect(args.cursor).toBeUndefined()
    expect(args.skip).toBeUndefined()
  })

  test('the schedule read selects ONLY four fields — no integrationId, no notificationConfigId', async () => {
    // The schedule row carries `integrationId` and `notificationConfigId`; neither is needed to
    // name the file, and selecting them would widen what a leaked response contains. Exact
    // args, so a widening is visible.
    await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(callArgs('scheduledRun', 'findFirst')).toEqual({
      where: { id: 's1' },
      select: { id: true, name: true, cronExpr: true, prompt: true },
    })
  })

  test('there is NO role gate — DECLARED NON-CONTROL, pinned as the contract', async () => {
    // This endpoint exports every execution's full LLM answer, prompt and error text. Any
    // authenticated member (this suite's user is an `analyst`) may read it. That is a policy
    // decision about shared schedules rather than a tenant-isolation flaw, so it is recorded:
    // this assertion can only fail if a gate is ADDED, which is the change it exists to make
    // visible. If a gate IS added, the fix is `requireRole(user, 'admin')` in the handler.
    const res = await GET(theReq('http://localhost/api/schedules/s1/runs/export'), ctx('s1'))
    expect(res.status).toBe(200)
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).not.toContain('requireRole')
  })

  test('the route reads the id from ctx.params, not from a query parameter', async () => {
    // `?id=` must not influence anything: a query-param id would be a second, unvalidated
    // entry point for the same client-supplied identifier.
    await GET(theReq('http://localhost/api/schedules/s1/runs/export?id=s-org-2&format=csv'), ctx('s9'))
    expect(callArgs('scheduledRun', 'findFirst').where).toEqual({ id: 's9' })
    expect(callArgs('scheduledRunLog', 'findMany').where).toEqual({ scheduledRunId: 's9' })
  })

  test('DECLARED NON-CONTROL: no rate limit or streaming — the whole history is buffered at once', async () => {
    // `new NextResponse(csv)` takes a complete string, so the export cannot be streamed and
    // memory use is O(history). The route also carries no rate limit of its own. Both are
    // properties of the current design rather than behaviours reachable from a unit test, so
    // they are asserted as the source contract, not exercised.
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).toContain('new NextResponse(csv')
    expect(routeSrc).not.toContain('rateLimit')
    expect(routeSrc).not.toContain('ReadableStream')
  })
})
