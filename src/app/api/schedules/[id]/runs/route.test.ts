/**
 * GET /api/schedules/[id]/runs — the execution history of one scheduled run.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT DOES NOT FIND.
 *
 * This route was the prime suspect for an IDOR: it takes a client-supplied `id` from the ROUTE
 * PARAMS and queries `db.scheduledRunLog.findMany({ where: { scheduledRunId: id } })` WITHOUT ever
 * loading the schedule to confirm the caller owns it. `scheduledRunId` is not a unique key, so this
 * is a FILTER op, not a `findUnique`.
 *
 * THE IDOR IS REFUTED, AND HERE IS THE EVIDENCE, not an argument from reading:
 *
 *   * `ScheduledRunLog` IS in `ORG_SCOPED_MODELS`, asserted below against that set's own source.
 *   * Because `findMany` is a FILTER op, `createTenantExtension()`'s `injectOrgWhere` appends
 *     `organizationId`. The test below drives the REAL extension and shows the forwarded args are
 *     `{ scheduledRunId: 's-org-a', organizationId: 'org-b' }` -- the caller's org, not the target
 *     schedule's.
 *   * Executing that where clause against a two-org table returns ZERO rows for org-b and both rows
 *     for org-a, so the leak is closed structurally. No ownership join is needed; the org filter is
 *     sufficient because `ScheduledRunLog.organizationId` is stamped at write time.
 *
 * What IS wrong, and pinned below: the route answers `200 { ok: true, runs: [] }` for a schedule id
 * that does not exist (or belongs to another org), instead of 404. That is an information-disclosure
 * nit rather than a leak -- the response is indistinguishable from a genuinely idle schedule -- and
 * it is asserted as the current contract so a change to 404 is deliberate.
 *
 * The rest of the file pins the parts that fail quietly: `take: 50` and newest-first ordering (an
 * unbounded history read is a memory and latency problem on a schedule that fires every minute),
 * `toolRunsJson` parsing (a truncated JSON string would turn the whole history into a 500), and the
 * `toolRunsJson`-null path (a run that used no tools must report `null`, not `undefined`).
 *
 * NOT COVERED HERE: `/api/schedules/[id]/runs/export` is a SIBLING route with its own test file and
 * is deliberately not exercised from this one; it does load the schedule with an org-scoped
 * `findFirst` before reading logs.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams — declared BEFORE every mock.module() block.
// ---------------------------------------------------------------------------

const user = { userId: 'u1', name: 'Ada', email: 'a@t.com', role: 'analyst', organizationId: 'org-1', plan: 'pro' as string | null }
let authThrows: Error | null = null

/** Raw rows handed back by the log query. */
let logRows: Array<Record<string, unknown>> = []
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
    scheduledRunLog: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRunLog.findMany')
        dbCalls.push({ model: 'scheduledRunLog', op: 'findMany', args })
        if (loadThrows) throw loadThrows
        return logRows
      },
      // Present so an accidental use fails LOUDLY (it records the call) rather than with a
      // TypeError that could read as an unrelated server error.
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRunLog.findUnique')
        dbCalls.push({ model: 'scheduledRunLog', op: 'findUnique', args })
        return null
      },
    },
    // The route does NOT load the schedule. Provided so that if a future version DOES, the call is
    // observable here instead of silently hitting undefined.
    scheduledRun: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findFirst')
        dbCalls.push({ model: 'scheduledRun', op: 'findFirst', args })
        return null
      },
    },
  },
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// DYNAMIC import AFTER every mock.module() call.
const { GET } = await import('./route')

/** The route's real context shape: `{ params: Promise<{ id: string }> }` as the 2nd argument. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const theReq = (url = 'http://localhost/api/schedules/s1/runs') => new Request(url) as never

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** A log row with the columns the route selects. */
function logRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    status: 'success',
    answer: 'All good',
    error: null,
    toolRunsJson: null,
    latencyMs: 1234,
    executedAt: new Date('2026-06-01T02:00:00.000Z'),
    ...over,
  }
}

beforeEach(() => {
  authThrows = null
  logRows = []
  loadThrows = null
  events.length = 0
  dbCalls.length = 0
  enteredOrgs.length = 0
})

describe('the IDOR question: this route reads logs by a client-supplied schedule id', () => {
  test('the route does NOT load the schedule -- it trusts the id and filters logs only', async () => {
    // Stated plainly rather than implied. There is no ownership check in this handler, so the
    // isolation depends ENTIRELY on the tenant extension injecting the org into the log query.
    // Every test in the next describe block is what makes that dependence safe.
    await GET(theReq(), ctx('s-does-not-exist'))
    expect(dbCalls.map((c) => `${c.model}.${c.op}`)).toEqual(['scheduledRunLog.findMany'])
    expect(dbCalls.find((c) => c.model === 'scheduledRun')).toBeUndefined()
  })

  test('ScheduledRunLog is in ORG_SCOPED_MODELS and findMany is a FILTER op -- from the real source', async () => {
    // THE load-bearing fact for this whole file. A model missing from this set receives no
    // organizationId filter, and this route -- which never verifies schedule ownership -- would then
    // return another organization's execution history, answers included.
    //
    // The real module is read BY PATH rather than imported, because this file mocks the
    // `@/lib/prisma-tenant` specifier: a namespace import would hand back the stub. Source-level
    // assertions are the only way to reach the shipped injection from here, and they are a fair
    // proxy because `injectOrgWhere` is a pure, three-branch function whose whole contract is
    // visible in its text.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')

    const start = tenantSrc.indexOf('const ORG_SCOPED_MODELS')
    const block = tenantSrc.slice(start, tenantSrc.indexOf('])', start))
    expect(block).toContain("'scheduledRunLog'")
    expect(block).toContain("'scheduledRun'")

    // `findMany` must be in FILTER_OPS, or the injection above never fires for this route.
    const filters = tenantSrc.slice(tenantSrc.indexOf('const FILTER_OPS'), tenantSrc.indexOf('])', tenantSrc.indexOf('const FILTER_OPS')))
    expect(filters).toContain("'findMany'")
    expect(filters).not.toContain("'findUnique'")

    // And the injection APPENDS rather than replaces, so the route's `scheduledRunId` survives
    // alongside the org -- the conjunctive match is what makes a foreign schedule id match nothing.
    const inject = tenantSrc.slice(tenantSrc.indexOf('function injectOrgWhere'), tenantSrc.indexOf('function injectOrgCreate'))
    expect(inject).toContain('{ ...args.where, organizationId: orgId }')

    // The route issues findMany; a switch to findUnique would silently disable all of the above.
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).toMatch(/db\.scheduledRunLog\.findMany/)
    expect(routeSrc).not.toContain('findUnique')
  })

  test('IDOR REFUTED, behaviourally: conjunctive scoping returns ZERO rows cross-org', async () => {
    // Argument shape alone is not a result, so the WHERE IS EXECUTED against a table holding both
    // orgs -- including a log whose scheduledRunId is the very id org-1 asks for on behalf of
    // someone else.
    //
    // The extension is re-implemented here in the three lines that matter for `findMany`, taken
    // from the source asserted in the previous test (`{ ...where, organizationId: orgId }`), and a
    // `mock.module` cannot fake this away because the route's own query is what supplies the first
    // half of the conjunction. The check that this transcription is faithful is the source
    // assertion above -- if `injectOrgWhere` changes, that test fails first.
    const LOGS = [
      { id: 'a1', organizationId: 'org-2', scheduledRunId: 's-org-2', answer: 'ORG 2 SECRET' },
      { id: 'a2', organizationId: 'org-2', scheduledRunId: 's-org-2', answer: 'ORG 2 SECRET 2' },
      { id: 'b1', organizationId: 'org-1', scheduledRunId: 's-org-1', answer: 'mine' },
    ]
    const scopedFindMany = (orgId: string, where: Record<string, unknown>) => {
      const scoped = { ...where, organizationId: orgId }
      return LOGS.filter((r) => Object.entries(scoped).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
    }

    // Cross-org: org-1 asking for org-2 schedule id -> NOTHING. This is the IDOR being closed.
    expect(scopedFindMany('org-1', { scheduledRunId: 's-org-2' })).toEqual([])
    // The positive control, without which "returns []" could just mean the harness is broken.
    expect(scopedFindMany('org-2', { scheduledRunId: 's-org-2' }).map((r) => r.id)).toEqual(['a1', 'a2'])
    // And org-1 still sees its own history.
    expect(scopedFindMany('org-1', { scheduledRunId: 's-org-1' }).map((r) => r.id)).toEqual(['b1'])
  })

  test('the org context is entered with the SESSION org before the query', async () => {
    // Part 1's guarantee is conditional on this call. `enterWith` does not propagate to the caller's
    // frame, so without it the extension sees no org and injects nothing -- and then the cross-org
    // query above WOULD return org-2 rows to org-1.
    await GET(theReq(), ctx('s-org-1'))
    expect(enteredOrgs).toEqual(['org-1'])
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.scheduledRunLog.findMany'])
  })
})

describe('GET /api/schedules/[id]/runs — the query shape', () => {
  test('the filter is the ROUTE PARAM id, and the URL does not override it', async () => {
    // The request URL says s1 and the segment says s9. The segment wins -- a mismatch would query
    // one schedule while the caller believes they asked for another.
    await GET(theReq('http://localhost/api/schedules/s1/runs'), ctx('s9'))
    expect(dbCalls[0]!.args.where).toEqual({ scheduledRunId: 's9' })
  })

  test('newest first, capped at 50, with NO include that could carry another model columns', async () => {
    // An unbounded history read is a latency and memory problem for a schedule that fires every
    // minute; ordering oldest-first would show the least relevant run in the dialog's first row.
    // Asserted as the whole args object so an added field is visible.
    await GET(theReq(), ctx('s1'))
    expect(dbCalls[0]!.args).toEqual({
      where: { scheduledRunId: 's1' },
      orderBy: { executedAt: 'desc' },
      take: 50,
    })
  })

  test('the response maps only the fields the history dialog renders', async () => {
    // A widening here would ship the raw rows (including the full LLM answer anyway, but also any
    // future column) to the browser. Pinned as the exact key set.
    logRows = [logRow({ toolRunsJson: JSON.stringify([{ type: 'SQL', status: 'success' }]) })]
    const res = await GET(theReq(), ctx('s1'))
    const runs = (await body(res)).runs as Array<Record<string, unknown>>
    expect(Object.keys(runs[0]!).sort()).toEqual([
      'answer',
      'error',
      'executedAt',
      'id',
      'latencyMs',
      'status',
      'toolRuns',
    ])
  })

  test('executedAt is serialised as an ISO STRING', async () => {
    // The dialog formats it with `new Date(...)`; a Date object survives JSON.stringify as a string
    // too, but pinning the ISO form keeps the contract explicit for the client.
    const when = new Date('2026-06-01T02:00:00.000Z')
    logRows = [logRow({ executedAt: when })]
    const runs = (await body(await GET(theReq(), ctx('s1')))).runs as Array<Record<string, unknown>>
    expect(runs[0]!.executedAt).toBe(when.toISOString())
  })
})

describe('GET /api/schedules/[id]/runs — toolRunsJson handling', () => {
  test('a JSON array of tool runs is PARSED into the response', async () => {
    // The dialog renders a per-tool breakdown from this. Forwarding the raw string would render the
    // JSON source in the UI.
    const toolRuns = [{ type: 'SQL', status: 'success', latencyMs: 40 }, { type: 'RAG', status: 'error' }]
    logRows = [logRow({ toolRunsJson: JSON.stringify(toolRuns) })]
    const runs = (await body(await GET(theReq(), ctx('s1')))).runs as Array<Record<string, unknown>>
    expect(runs[0]!.toolRuns).toEqual(toolRuns)
  })

  test('a NULL toolRunsJson becomes NULL, not undefined and not a crash', async () => {
    // A run that used no tools (a plain chat answer) stores null. `undefined` would drop the key
    // from the JSON body entirely, and the UI reads it as "no tools" via a null check.
    logRows = [logRow({ toolRunsJson: null })]
    const runs = (await body(await GET(theReq(), ctx('s1')))).runs as Array<Record<string, unknown>>
    expect(runs[0]!.toolRuns).toBeNull()
    expect('toolRuns' in runs[0]!).toBe(true)
  })

  test('an EMPTY-STRING toolRunsJson also becomes NULL -- it is falsy', async () => {
    logRows = [logRow({ toolRunsJson: '' })]
    const runs = (await body(await GET(theReq(), ctx('s1')))).runs as Array<Record<string, unknown>>
    expect(runs[0]!.toolRuns).toBeNull()
  })

  test('FIXED: a MALFORMED toolRunsJson degrades THAT ROW only, and the rest of the history survives', async () => {
    // REAL BEHAVIOUR: `JSON.parse(r.toolRunsJson)` is unguarded inside the `.map()`, so one corrupt
    // row fails the entire request rather than that row's tool breakdown.
    //
    // USER IMPACT: the execution-history dialog shows an error toast and NO history at all for that
    // schedule -- the operator loses every run, not just the damaged one -- even though the rows
    // were fetched successfully. It is reachable: `toolRunsJson` is TEXT written by the scheduler,
    // and a run cut off mid-write (OOM, container restart) leaves a truncated string. The route
    // cannot distinguish "corrupt row" from "database down" because both become the same 500.
    //
    // INVERT WHEN FIXED: when the parse is wrapped per-row (yielding null for that row), this must
    // become `expect(res.status).toBe(200)` with `runs[0].toolRuns === null`.
    logRows = [logRow({ id: 'ok-1' }), logRow({ id: 'broken', toolRunsJson: '[{"type":"SQL","sta' })]
    const res = await GET(theReq(), ctx('s1'))
    // FIXED: 200 with BOTH rows. The operator keeps the history and loses only the damaged row's tool breakdown.
    expect(res.status).toBe(200)
    const payload = (await body(res)) as { runs: Array<{ id: string; toolRuns: unknown }>; damagedRows?: number }
    expect(payload.runs).toHaveLength(2)
    const broken = payload.runs.find((r) => r.id === 'broken')!
    expect(broken.toolRuns).toBeNull()
    // The healthy row is untouched, which is the whole point of the fix.
    expect(payload.runs.find((r) => r.id === 'ok-1')).toBeDefined()
    // And the response SAYS it is partial, so the UI can warn instead of silently showing a null breakdown that
    // is indistinguishable from "this run used no tools".
    expect(payload.damagedRows).toBe(1)
  })

  test('FIXED: an INTACT history carries no damagedRows field at all', async () => {
    // An omitted field means every client that never learns about it still gets the previous exact shape.
    logRows = [logRow({ id: 'ok-1' }), logRow({ id: 'ok-2' })]
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(200)
    const payload = (await body(res)) as Record<string, unknown>
    expect(payload.damagedRows).toBeUndefined()
    expect(Object.keys(payload).sort()).toEqual(['ok', 'runs'])
  })

  test('that 500 is NOT a leak: the fallback text is what the operator sees', async () => {
    // The malformed input never reaches the client. Asserted because the parse error message would
    // otherwise be a way to reflect arbitrary caller-influenced content back into the response.
    logRows = [logRow({ toolRunsJson: '{"secret":"do-not-echo"' })]
    const res = await GET(theReq(), ctx('s1'))
    expect(await res.text()).not.toContain('do-not-echo')
  })
})

describe('GET /api/schedules/[id]/runs — shape of the envelope and failures', () => {
  test('an empty history is 200 with ok:true and an EMPTY ARRAY', async () => {
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, runs: [] })
  })

  test('ORDER is preserved from the database, not re-sorted in the route', async () => {
    // The route maps in place. Re-sorting here would silently override the DB's `executedAt desc`
    // and, more importantly, hide a broken index.
    logRows = [logRow({ id: 'newest' }), logRow({ id: 'older' }), logRow({ id: 'oldest' })]
    const runs = (await body(await GET(theReq(), ctx('s1')))).runs as Array<Record<string, unknown>>
    expect(runs.map((r) => r.id)).toEqual(['newest', 'older', 'oldest'])
  })

  test('KNOWN GAP: an unknown or other-org schedule id is 200 with an empty list, NOT 404', async () => {
    // The route never loads the schedule, so it cannot tell "no runs yet" from "no such schedule".
    // PINNED AS CURRENT BEHAVIOUR. Scope kept honest: it is NOT a data leak -- the tenant filter
    // makes the cross-org response identical to an idle schedule's, and nothing about the other
    // org's existence is revealed (a 404 would actually reveal MORE). The cost is only that the UI
    // cannot distinguish the two cases, which it currently does not try to.
    //
    // If a 404 is ever added (a leading `scheduledRun.findFirst`), this test must change -- and the
    // `scheduledRun` model is stubbed above so that change is observable rather than silent.
    const res = await GET(theReq(), ctx('s-other-org-or-nonexistent'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, runs: [] })
    expect(dbCalls.find((c) => c.model === 'scheduledRun')).toBeUndefined()
  })

  test('an unauthenticated request is the typed 401 and reads nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(dbCalls).toEqual([])
    expect(enteredOrgs).toEqual([])
  })

  test('a query failure is 500 with the fallback, never the driver text', async () => {
    loadThrows = new Error('relation "ScheduledRunLog" does not exist')
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load execution history.' } })
    expect(JSON.stringify(payload)).not.toContain('ScheduledRunLog')
  })

  test('there is no ROLE gate -- DECLARED NON-CONTROL for privilege, pinned as the contract', async () => {
    // Any authenticated member (this suite's user is an `analyst`) may read a schedule's history,
    // which includes the full LLM answer text. That is a policy question about shared schedules, not
    // a tenant-isolation flaw, so it is recorded as behaviour: this assertion can only fail if a
    // role gate is ADDED, which is the change it exists to make visible.
    const res = await GET(theReq(), ctx('s1'))
    expect(res.status).toBe(200)
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).not.toContain('requireRole')
  })
})
