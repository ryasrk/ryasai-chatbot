/**
 * GET + POST /api/schedules — the scheduled-run list and create.
 *
 * WHY THIS FILE EXISTS. POST is the most privileged write in this group: it creates a row that the
 * BullMQ worker will later execute UNATTENDED, against the customer's own LLM key and database. Four
 * things here fail quietly:
 *
 *   1. THE ROW CARRIES `organizationId` FROM THE SESSION. `ScheduledRun` is an org-scoped model, and
 *      the create passes `organizationId: user.organizationId` EXPLICITLY while the tenant extension
 *      would also inject it. An explicit value that disagrees with the session is the dangerous case,
 *      so the exact value is asserted (the extension does NOT override an explicit organizationId --
 *      verified in prisma-tenant.test.ts).
 *   2. `nextRunAt` IS COMPUTED, NOT LEFT NULL. A row with a null next fire time is picked up by
 *      nothing, so the schedule silently never runs -- and the UI would show a schedule that looks
 *      active forever. `nextRun` is called with the NORMALISED timezone, which is what makes
 *      "0 9 * * *" mean 09:00 wall-clock for that tenant.
 *   3. A BULLMQ FAILURE MUST NOT LOSE THE CREATE. The DB row is the source of truth and the queue is
 *      a projection; a Redis blip must still return 201, because rejecting would discard a schedule
 *      the operator deliberately created and leave them no way to know it half-existed.
 *   4. THE ROLE GATE IS `admin`, and it runs AFTER the org context is entered but BEFORE any row is
 *      read. A viewer who could create a schedule could make the worker run arbitrary prompts.
 *
 * Also pinned: the plan gate is checked BEFORE the body is validated (so a starter-plan caller learns
 * about the plan, not a validation message), the integration id is verified with an org-scoped
 * `findFirst` rather than trusted, and the audit records the CRON and the computed next fire time.
 *
 * A NOTE ON A VIEW/ROUTE MISMATCH, pinned below rather than fixed: `schedules-view.tsx` sends
 * `isActive` and this route hard-codes `isActive: true`, so a schedule created through the UI as
 * "inactive" is created ACTIVE and will fire. The behavior is asserted here so the discrepancy is
 * visible; the fix belongs in the route/view, not in this test.
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
  plan: 'pro' as string | null,
}
let user: typeof admin = admin
let authThrows: Error | null = null
/** Thrown by requireRole to model the real ForbiddenError path. */
let roleThrows: Error | null = null

/** Rows returned by the list query. */
let schedules: Array<Record<string, unknown>> = []
/** Literal source of truth for the integration lookup. */
let integrationRow: { id: string } | null = { id: 'int-1' }
/** Resolution results for the two ids that used to be stored unverified. `null` means "not in this org". */
let promptRow: { id: string } | null = null
let notificationRow: { id: string } | null = null
/** The row `create` resolves to; also becomes the argument for `syncSchedule`. */
let createdRow: Record<string, unknown> = {}
let createThrows: Error | null = null
let loadThrows: Error | null = null
let syncThrows: Error | null = null
let auditThrows: Error | null = null

/** Side-effect ORDER. Order is the assertion; mock return values are not. */
const events: string[] = []
/** Every Prisma call, with its raw args. */
const dbCalls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
/** Raw `syncSchedule(arg)` argument, or `undefined` when never called. */
let syncArgs: Record<string, unknown> | undefined
const audits: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
/** Raw `(expr, from, tz)` triples handed to nextRun. */
const nextRunCalls: Array<{ expr: string; tz: string }> = []
/** Raw `hasPlan(plan, min)` pairs. */
const hasPlanCalls: Array<{ plan: string | null; min: string }> = []

/**
 * `nextRun` returns a wall-clock-derived Date, so it is the one nondeterministic dependency.
 *
 * The REAL module is spread in and only `nextRun` is overridden -- NOT because spreading is tidier
 * but because the other two functions encode decisions this route depends on:
 *   * `parseCron` REJECTS `@daily`, 4-field and out-of-range expressions, and ACCEPTS surrounding
 *     whitespace. A hand-written "valid iff 5 fields" stand-in would have accepted `60 9 * * *`
 *     (which the real parser rejects) and this file would have gone green on a false premise.
 *   * `normalizeTimezone` uses `Intl.DateTimeFormat` to coerce `'Not/AZone'` to `'UTC'`. A stand-in
 *     that merely trimmed would have let an invalid zone through to the stored row.
 * Both were probed against the real implementation before this mock was written.
 *
 * The spread also keeps the coverage measurement honest: a bare partial mock marks every line of
 * cron.ts as instrumented-but-never-executed, which is what drags its own file's figure down.
 */
let nextRunValue: Date | null = new Date('2026-06-01T02:00:00.000Z')

// Imported for the spread only. This is the one place the REAL module is loaded, and it is loaded
// before `mock.module` below replaces the specifier for the route under test.
const realCron = await import('@/lib/cron')

mock.module('@/lib/cron', () => ({
  ...realCron,
  nextRun: (expr: string, _from: Date, tz: string) => {
    events.push('nextRun')
    nextRunCalls.push({ expr, tz })
    return nextRunValue
  },
}))

mock.module('@/lib/plan-gating', () => ({
  // The real module is not spread in because `hasPlan` is a pure rank comparison this file must be
  // able to vary per test; the ranks are transcribed from plan-gating.ts (starter 0 < pro 1 <
  // enterprise 2 < flat 3, with a null plan falling back to `starter`).
  hasPlan: (plan: string | null, min: string) => {
    events.push('hasPlan')
    hasPlanCalls.push({ plan, min })
    const RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2, flat: 3 }
    return (RANK[plan ?? 'starter'] ?? 0) >= (RANK[min] ?? 0)
  },
}))

mock.module('@/lib/scheduler-queue', () => ({
  syncSchedule: async (s: Record<string, unknown>) => {
    events.push('syncSchedule')
    syncArgs = s
    if (syncThrows) throw syncThrows
  },
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  requireRole: (u: { role: string }, min: string) => {
    events.push(`requireRole:${min}`)
    if (roleThrows) throw roleThrows
    const RANK: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }
    if ((RANK[u.role] ?? 0) < (RANK[min] ?? 0)) {
      const e = new Error(`Requires ${min} role. You have ${u.role}.`)
      e.name = 'ForbiddenError'
      throw e
    }
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
  writeAudit: async (args: Record<string, unknown>) => {
    events.push('writeAudit')
    audits.push(args)
    if (auditThrows) throw auditThrows
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
    scheduledRun: {
      findMany: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findMany')
        dbCalls.push({ model: 'scheduledRun', op: 'findMany', args })
        if (loadThrows) throw loadThrows
        return schedules
      },
      create: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.create')
        dbCalls.push({ model: 'scheduledRun', op: 'create', args })
        if (createThrows) throw createThrows
        return { ...(args.data as Record<string, unknown>), ...createdRow, id: createdRow.id ?? 's-new' }
      },
      // The route must not use these: no id is in play, and an update/delete here would be a bug.
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findFirst')
        dbCalls.push({ model: 'scheduledRun', op: 'findFirst', args })
        return null
      },
    },
    integration: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.integration.findFirst')
        dbCalls.push({ model: 'integration', op: 'findFirst', args })
        return integrationRow
      },
    },
    // The route now resolves BOTH ids through an org-scoped findFirst, so the mock must expose them. A mock that
    // omitted these would have crashed the route rather than pinned a defect -- which is why the assertion was
    // rewritten to check the LOOKUP instead of its absence.
    savedPrompt: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.savedPrompt.findFirst')
        dbCalls.push({ model: 'prompt', op: 'findFirst', args })
        return promptRow
      },
    },
    notificationConfig: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.notificationConfig.findFirst')
        dbCalls.push({ model: 'notificationConfig', op: 'findFirst', args })
        return notificationRow
      },
    },
  },
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// DYNAMIC import AFTER every mock.module() call.
const { GET, POST } = await import('./route')

function postReq(body?: unknown): Request {
  return new Request('http://localhost/api/schedules', {
    method: 'POST',
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** The valid create payload the UI sends, so each test varies ONE field. */
function validBody(over: Record<string, unknown> = {}) {
  return { name: 'Morning digest', cronExpr: '0 9 * * *', prompt: 'summarise yesterday', ...over }
}

/** The `data` object handed to `db.scheduledRun.create`. */
function createdData(): Record<string, unknown> {
  const c = dbCalls.find((x) => x.model === 'scheduledRun' && x.op === 'create')
  return (c?.args.data ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  user = admin
  authThrows = null
  roleThrows = null
  schedules = []
  integrationRow = { id: 'int-1' }
  promptRow = null
  notificationRow = null
  promptRow = null
  notificationRow = null
  createdRow = {}
  createThrows = null
  loadThrows = null
  syncThrows = null
  auditThrows = null
  events.length = 0
  dbCalls.length = 0
  syncArgs = undefined
  audits.length = 0
  enteredOrgs.length = 0
  nextRunCalls.length = 0
  hasPlanCalls.length = 0
  nextRunValue = new Date('2026-06-01T02:00:00.000Z')
})

describe('GET /api/schedules', () => {
  test('the org context is entered with the SESSION org BEFORE the query', async () => {
    // `enterWith` does not propagate to the caller's frame, so omitting this runs findMany with no
    // org context -- and the response would be every organization's schedules, prompts included.
    const res = await GET()
    expect(res.status).toBe(200)
    expect(enteredOrgs).toEqual(['org-1'])
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'db.scheduledRun.findMany'])
  })

  test('the query is UNFILTERED and org scoping is left to the extension', async () => {
    // No hand-written `where`. `scheduledRun` IS in ORG_SCOPED_MODELS, asserted below against the
    // extension's own source, so the extension is the only scoping -- and a hand-written
    // organizationId here would double-filter and silently hide rows if the extension changed.
    await GET()
    const args = dbCalls[0]!.args
    expect(args.where).toBeUndefined()
    expect(args).toEqual({ orderBy: { createdAt: 'desc' } })
  })

  test('the model is in the ORG_SCOPED_MODELS set, read from its source', async () => {
    // The leak this guards: a model missing from the set receives no organizationId filter, so the
    // list silently spans every tenant. Asserted against the extension file rather than a copy of
    // the list, so the two cannot drift.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')
    const block = tenantSrc.slice(
      tenantSrc.indexOf('const ORG_SCOPED_MODELS'),
      tenantSrc.indexOf('])', tenantSrc.indexOf('const ORG_SCOPED_MODELS')),
    )
    expect(block).toContain("'scheduledRun'")
  })

  test('the newest schedules come first', async () => {
    // A schedule list ordered oldest-first buries the one just created.
    await GET()
    expect(dbCalls[0]!.args.orderBy).toEqual({ createdAt: 'desc' })
  })

  test('the rows come back under ok, including an empty list as an ARRAY', async () => {
    const res = await GET()
    expect(await body(res)).toEqual({ ok: true, schedules: [] })
    schedules = [{ id: 's1', name: 'Nightly' }]
    expect(await body(await GET())).toEqual({ ok: true, schedules: [{ id: 's1', name: 'Nightly' }] })
  })

  test('an unauthenticated GET is the typed 401 and queries nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET()
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(dbCalls).toEqual([])
  })

  test('a query failure is 500 with the fallback, never the driver text', async () => {
    loadThrows = new Error('column ScheduledRun.cronExpr does not exist')
    const res = await GET()
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load scheduled runs.' } })
    expect(JSON.stringify(payload)).not.toContain('cronExpr does not exist')
  })

  test('a GET is available to a NON-admin -- viewing is not the privileged half', async () => {
    // DECLARED NON-CONTROL for privilege: GET never calls requireRole, so a viewer sees every
    // schedule in the org (including prompts). Asserted as the current contract so adding a gate is
    // a visible change. The privileged surface is POST, tested below.
    user = { ...admin, role: 'viewer' }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(events).not.toContain('requireRole:admin')
  })
})

describe('POST /api/schedules — gates run in a deliberate order', () => {
  test('ORDER: session -> org -> requireRole(admin) -> plan -> validate -> create', async () => {
    // The order is itself a decision. requireRole runs while the org context is already established
    // (so any audit a ForbiddenError triggers is attributed), and the plan gate runs BEFORE the
    // body is parsed -- so a starter-plan caller learns about the plan rather than a field error.
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(201)
    expect(events.slice(0, 6)).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'requireRole:admin',
      'hasPlan',
      'nextRun',
      'db.scheduledRun.create',
    ])
  })

  test('a NON-admin is 403 with the real FORBIDDEN envelope and writes nothing', async () => {
    const e = new Error('Requires admin role. You have viewer.')
    e.name = 'ForbiddenError'
    roleThrows = e
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: { code: 'FORBIDDEN', message: 'Requires admin role. You have viewer.' } })
    expect(dbCalls).toEqual([])
    expect(audits).toEqual([])
  })

  test('a STARTER-plan admin is 403 by the plan gate, and no row is created', async () => {
    // Scheduled runs are a paid feature. The refusal must happen before `nextRun`/`create`, and it
    // must NOT be a 500 -- losing the create to an exception would look like an outage.
    user = { ...admin, plan: 'starter' }
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'Scheduled runs require a Pro plan or higher.' })
    expect(dbCalls).toEqual([])
  })

  test('the plan gate is asked with the min plan the feature actually needs', async () => {
    await POST(postReq(validBody()) as never)
    expect(hasPlanCalls).toEqual([{ plan: 'pro', min: 'pro' }])
  })

  test('a NULL plan fails closed to 403', async () => {
    // `plan: null` is what getActiveUser returns when the org row has no licensePlan. Passing it
    // through to hasPlan must resolve to `starter` (the lowest tier), never to unlimited access.
    user = { ...admin, plan: null }
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(403)
  })

  test('an enterprise plan passes the gate', async () => {
    user = { ...admin, plan: 'enterprise' }
    expect((await POST(postReq(validBody()) as never)).status).toBe(201)
  })

  test('the plan gate runs BEFORE body validation', async () => {
    // A starter-plan caller sending a garbage body must be told about the PLAN, not about the name.
    // Reversing this makes the upgrade path unreachable: the user would fix field errors forever.
    user = { ...admin, plan: 'starter' }
    const res = await POST(postReq({}) as never)
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'Scheduled runs require a Pro plan or higher.' })
  })
})

describe('POST /api/schedules — validation', () => {
  test('a missing name is 400 and nothing is created', async () => {
    const res = await POST(postReq(validBody({ name: undefined })) as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Name is required.' })
    expect(createdData()).toEqual({})
  })

  test('a whitespace-only name is 400, not a stored blank', async () => {
    const res = await POST(postReq(validBody({ name: '   ' })) as never)
    expect(res.status).toBe(400)
    expect(createdData()).toEqual({})
  })

  test('an invalid cron is 400 with the 5-field hint, and nextRun is never called', async () => {
    // `@daily`, 4 fields and out-of-range values are all missing from the supported grammar. The
    // hint is what tells the operator the format; without `parseCron` gating, a garbage expression
    // would reach BullMQ and the job would simply never fire.
    for (const bad of ['not a cron', '0 9 * *', '60 9 * * *', '@daily', '']) {
      events.length = 0
      const res = await POST(postReq(validBody({ cronExpr: bad })) as never)
      expect(res.status).toBe(400)
      expect(await body(res)).toEqual({
        ok: false,
        error: 'Invalid cron expression. Use 5-field format: min hour dom month dow.',
      })
      expect(nextRunCalls).toEqual([])
      expect(createdData()).toEqual({})
    }
  })

  test('a VALID cron in the supported grammar passes', async () => {
    for (const good of ['0 9 * * *', '*/5 * * * *', '0 9 * * 1-5', '0 9 1 1 *']) {
      expect((await POST(postReq(validBody({ cronExpr: good })) as never)).status).toBe(201)
    }
  })

  test('the cron expression is TRIMMED before validation and before storage', async () => {
    // The real `parseCron` tolerates surrounding whitespace, but storing the untrimmed string would
    // make the value the operator sees differ from the value BullMQ hashed.
    await POST(postReq(validBody({ cronExpr: '  0 9 * * *  ' })) as never)
    expect(createdData().cronExpr).toBe('0 9 * * *')
  })

  test('a missing prompt is 400 and nothing is created', async () => {
    const res = await POST(postReq(validBody({ prompt: undefined })) as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Prompt is required.' })
    expect(createdData()).toEqual({})
  })

  test('a whitespace-only prompt is 400 -- an empty unattended prompt must never be scheduled', async () => {
    // This one carries an LLM bill: the worker would fire on schedule and send an empty prompt.
    const res = await POST(postReq(validBody({ prompt: ' \n\t ' })) as never)
    expect(res.status).toBe(400)
    expect(createdData()).toEqual({})
  })

  test('a malformed JSON body is treated as EMPTY, so the name check reports it', async () => {
    const res = await POST(postReq('}{ not json') as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Name is required.' })
  })

  test('validation happens before the integration lookup', async () => {
    // Ordering matters for cost and for the error the user sees: with a bad name AND a bad
    // integration id, "Name is required" is the actionable one.
    integrationRow = null
    await POST(postReq(validBody({ name: '' })) as never)
    expect(dbCalls.find((c) => c.model === 'integration')).toBeUndefined()
  })
})

describe('POST /api/schedules — the integration binding is VERIFIED', () => {
  test('an integration id that does not resolve in this org is 400, not stored', async () => {
    // The FK would happily accept another org's integration id, which would let an operator point
    // their schedule at data they cannot read -- the query would run as the worker, not as them.
    integrationRow = null
    const res = await POST(postReq(validBody({ integrationId: 'int-from-other-org' })) as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Selected data source not found.' })
    expect(createdData()).toEqual({})
  })

  test('the lookup selects the ID ONLY and uses findFirst so the extension scopes it', async () => {
    // `select: { id: true }` keeps the integration's ENCRYPTED CONFIG out of memory, and `findFirst`
    // is what lets the tenant extension append the org. `findUnique` here would be a cross-tenant
    // read of another org's data-source row.
    await POST(postReq(validBody({ integrationId: 'int-1' })) as never)
    const call = dbCalls.find((c) => c.model === 'integration')!
    expect(call.op).toBe('findFirst')
    expect(call.args).toEqual({ where: { id: 'int-1' }, select: { id: true } })
  })

  test('the VERIFIED id is what is stored, not the raw request value', async () => {
    // Storing the request value would let a truthy-but-wrong id through whenever the lookup happened
    // to succeed for a different reason.
    await POST(postReq(validBody({ integrationId: 'int-1' })) as never)
    expect(createdData().integrationId).toBe('int-1')
  })

  test('an ABSENT integrationId is stored as NULL and triggers no lookup', async () => {
    await POST(postReq(validBody()) as never)
    expect(createdData().integrationId).toBeNull()
    expect(dbCalls.find((c) => c.model === 'integration')).toBeUndefined()
  })

  test('an EMPTY-STRING integrationId is falsy, so no lookup runs and null is stored', async () => {
    // The UI sends `integrationId: form.integrationId || null`, but a hand-rolled client can send
    // ''. The route treats it as absent, which is the harmless direction.
    await POST(postReq(validBody({ integrationId: '' })) as never)
    expect(createdData().integrationId).toBeNull()
    expect(dbCalls.find((c) => c.model === 'integration')).toBeUndefined()
  })

  test('FIXED: promptId and notificationConfigId ARE verified, so a foreign id is refused', async () => {
    // Only `integrationId` is loaded before being stored. `notificationConfigId` and `promptId` are
    // written straight through (`body.x || null`), so a caller can bind a schedule to another org's
    // notification config or prompt id. The worker then either fails to deliver or reads a prompt it
    // should not see. This is pinned rather than fixed: it is a real tenant-boundary gap, and the
    // fix (load both with findFirst, like integrationId) must make this test change.
    // FIXED. A supplied id is now resolved through an org-scoped findFirst, exactly like integrationId. An id
    // belonging to another organization resolves to null, so the request is REFUSED rather than stored.
    promptRow = null
    notificationRow = null
    const foreign = await POST(
      postReq(validBody({ promptId: 'p-from-other-org', notificationConfigId: 'nc-from-other-org' })) as never,
    )
    expect(foreign.status).toBe(400)
    // Nothing was written, so the worker can never run against a foreign prompt.
    expect(dbCalls.filter((c) => c.op === 'create')).toEqual([])
    // The lookup IS attempted, and it carries no organizationId of its own: the tenant extension appends the
    // caller's org, which is what makes a foreign row unresolvable in the first place.
    expect(dbCalls.filter((c) => c.model === 'prompt' && c.op === 'findFirst')).toHaveLength(1)
  })

  test('FIXED: an id that DOES resolve in this org is stored as the RESOLVED id', async () => {
    // The positive direction, pinned so the guard is not a blanket refusal of both fields.
    promptRow = { id: 'p-1' }
    notificationRow = { id: 'nc-1' }
    const res = await POST(postReq(validBody({ promptId: 'p-1', notificationConfigId: 'nc-1' })) as never)
    expect(res.status).toBe(201)
    expect(createdData().promptId).toBe('p-1')
    expect(createdData().notificationConfigId).toBe('nc-1')
  })

  test('FIXED: a prompt id that does not resolve is refused with 400, not silently stored', async () => {
    promptRow = null
    const res = await POST(postReq(validBody({ promptId: 'p-missing' })) as never)
    expect(res.status).toBe(400)
    expect((await res.text()).length).toBeGreaterThan(0)
    notificationRow = null
    const res2 = await POST(postReq(validBody({ notificationConfigId: 'nc-missing' })) as never)
    expect(res2.status).toBe(400)
  })
})

describe('POST /api/schedules — the row the worker will execute', () => {
  test('FIXED: organizationId is the SESSION org and isActive follows the request body', async () => {
    // `organizationId: user.organizationId` is explicit here. Asserted exactly because the tenant
    // extension does NOT override an explicit organizationId, so a wrong value would be stored as-is.
    //
    // FIXED: `isActive` used to be HARD-CODED `true` while the create form sends the user's toggle, so a schedule
    // created with the toggle OFF was created ACTIVE and it fired. It now follows the body.
    const res = await POST(postReq(validBody({ isActive: false })) as never)
    expect(res.status).toBe(201)
    const data = createdData()
    expect(data.organizationId).toBe('org-1')
    expect(data.isActive).toBe(false)
  })

  test('FIXED: the toggle ON is honoured, and an OMITTED field still means active', async () => {
    // Both directions, plus the compatibility case: a client that never sends the field must keep creating active
    // schedules, so the fix is `!== false` rather than a truthiness read.
    await POST(postReq(validBody({ isActive: true })) as never)
    expect(createdData().isActive).toBe(true)
    const omitted = validBody()
    delete (omitted as Record<string, unknown>).isActive
    await POST(postReq(omitted) as never)
    expect(createdData().isActive).toBe(true)
    // And anything that is not EXACTLY false stays active, so a JSON string does not silently disable a job.
    await POST(postReq(validBody({ isActive: 'false' as unknown as boolean })) as never)
    expect(createdData().isActive).toBe(true)
  })

  test('nextRunAt is the COMPUTED value, never null', async () => {
    // A null next fire time is picked up by nothing, so the schedule would never run while looking
    // active in the UI. This is the single most consequential field on the row.
    await POST(postReq(validBody()) as never)
    expect(createdData().nextRunAt).toBe(nextRunValue)
  })

  test('nextRun is called with the TRIMMED cron and the timezone the real normaliser returns', async () => {
    // The timezone is what makes "0 9 * * *" mean 09:00 wall-clock for this tenant instead of 09:00
    // UTC. Passing the raw value through would be a silent multi-hour drift. The cron IS trimmed by
    // the route; the timezone is trimmed only if `normalizeTimezone` does it (see the defect below).
    await POST(postReq(validBody({ cronExpr: ' 0 9 * * * ', timezone: 'Asia/Jakarta' })) as never)
    expect(nextRunCalls).toEqual([{ expr: '0 9 * * *', tz: 'Asia/Jakarta' }])
    expect(createdData().timezone).toBe('Asia/Jakarta')
  })

  test('FIXED: the name, cron and prompt are TRIMMED before they reach nextRun and the row', async () => {
    // Surrounding whitespace is how these fields actually arrive from a form. A padded CRON previously reached
    // `nextRun` untrimmed, which is a different expression to a cron parser.
    await POST(
      postReq(validBody({ name: '  Nightly  ', cronExpr: ' 0 9 * * * ', prompt: '  Summarise  ' })) as never,
    )
    const data = createdData()
    expect(data.name).toBe('Nightly')
    expect(data.cronExpr).toBe('0 9 * * *')
    expect(data.prompt).toBe('Summarise')
  })

  test('FIXED: a PADDED but valid timezone is TRIMMED and kept, not replaced by UTC', async () => {
    // REAL BEHAVIOUR, probed: `normalizeTimezone` checks the value with `Intl.DateTimeFormat` without
    // trimming first, so `' Asia/Jakarta '` FAILS that check and falls back to `'UTC'`. `nextRun`
    // then computes the fire time in UTC.
    //
    // USER IMPACT: a client that sends the timezone with surrounding whitespace (a form field with a
    // stray space, an import) gets a schedule that fires at 09:00 UTC -- 16:00 for this Jakarta
    // tenant -- while the UI shows the schedule as it was typed. The drift is exactly the UTC offset,
    // it is silent, and it only surfaces as "the report ran at the wrong time". The route DOES trim
    // the cron but relies on the normaliser for the zone.
    //
    // INVERT WHEN FIXED: when `normalizeTimezone` trims before probing `Intl`, `tz` becomes
    // 'Asia/Jakarta' and the stored row carries the real zone. Until then this test pins the defect.
    // FIXED: the zone is trimmed before the probe, so the tenant zone survives. Both halves are asserted -- what
    // `nextRun` is told AND what is stored -- because a fix that trimmed for one but not the other would leave the
    // worker and the displayed row disagreeing.
    await POST(postReq(validBody({ timezone: ' Asia/Jakarta ' })) as never)
    expect(nextRunCalls[0]!.tz).toBe('Asia/Jakarta')
    expect(createdData().timezone).toBe('Asia/Jakarta')

    // Static half, INVERTED with the fix: the real source TRIMS before probing `Intl`, and it exposes a predicate
    // so a caller can refuse a bogus zone instead of silently scheduling in UTC. A regression that drops the trim
    // fails here as well as behaviourally above.
    const cronSrc = readFileSync(join(import.meta.dir, '..', '..', '..', 'lib', 'cron.ts'), 'utf8')
    const start = cronSrc.indexOf('export function normalizeTimezone')
    const body = cronSrc.slice(start, start + 900)
    expect(body).toContain('new Intl.DateTimeFormat')
    expect(body).toContain('.trim()')
    // The fallback is still a REAL zone rather than a crash, and the predicate is what distinguishes the two.
    expect(body).toContain("return 'UTC'")
    expect(cronSrc).toContain('export function isTimezoneAccepted')
  })

  test('an ABSENT timezone normalises to UTC rather than to undefined', async () => {
    await POST(postReq(validBody()) as never)
    expect(nextRunCalls[0]!.tz).toBe('UTC')
    expect(createdData().timezone).toBe('UTC')
  })

  test('FIXED: an UNRECOGNISED timezone is REFUSED with 400 instead of silently becoming UTC', async () => {
    // Probed against the real module: 'Not/AZone' -> 'UTC'. A DST-unaware literal would have been
    // accepted here and produced a wrong fire time, so the coercion is asserted end-to-end.
    // FIXED: it is REFUSED. Previously `normalizeTimezone` fell back to 'UTC' and the request succeeded, so
    // "09:00" silently became "09:00 UTC" while the UI showed the zone the user picked. A zone that is not a zone
    // is now the caller's error, and nothing is written.
    const res = await POST(postReq(validBody({ timezone: 'Not/AZone' })) as never)
    expect(res.status).toBe(400)
    expect(dbCalls.filter((c) => c.op === 'create')).toEqual([])
    // And an ABSENT zone is still allowed -- the guard must not make the field mandatory.
    await POST(postReq(validBody({ timezone: null })) as never)
    expect(createdData().timezone).toBe('UTC')
  })

  test('the create carries exactly the fields the route owns -- no idle defaults', async () => {
    // Asserted as a whole object so an added field (or a dropped one) is a visible edit rather than
    // a silent widening of what a schedule row contains.
    await POST(postReq(validBody()) as never)
    expect(Object.keys(createdData()).sort()).toEqual([
      'cronExpr',
      'integrationId',
      'isActive',
      'name',
      'nextRunAt',
      'notificationConfigId',
      'organizationId',
      'prompt',
      'promptId',
      'timezone',
    ])
  })

  test('the response is 201 with ok and the created row', async () => {
    createdRow = { id: 's-77', name: 'Morning digest' }
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(201)
    const payload = await body(res)
    expect(payload.ok).toBe(true)
    expect((payload.schedule as Record<string, unknown>).id).toBe('s-77')
  })
})

describe('POST /api/schedules — the BullMQ projection', () => {
  test('syncSchedule receives the fields the worker destructures', async () => {
    // The worker reads `{ runId, name, prompt, notificationConfigId, integrationId }` from
    // `job.data`, and `syncSchedule` is what builds that payload. A renamed or missing key means the
    // job is enqueued and then skipped at run time while the HTTP response already said 201.
    createdRow = { id: 's-9', name: 'N', cronExpr: '0 9 * * *', prompt: 'P', isActive: true, timezone: 'UTC' }
    await POST(postReq(validBody()) as never)
    expect(syncArgs).toEqual({
      id: 's-9',
      name: 'N',
      cronExpr: '0 9 * * *',
      prompt: 'P',
      isActive: true,
      notificationConfigId: null,
      integrationId: null,
      timezone: 'UTC',
    })
  })

  test('the sync happens AFTER the create, using the CREATED row', async () => {
    // Syncing before the row exists, or from the request body, would enqueue a job whose runId does
    // not resolve -- the worker would fail with "not found" on every tick.
    await POST(postReq(validBody({ name: 'From body' })) as never)
    createdRow = { id: 's-9', name: 'From DB' }
    expect(events.indexOf('db.scheduledRun.create')).toBeLessThan(events.indexOf('syncSchedule'))
  })

  test('a BULLMQ failure is NON-FATAL: the schedule is still created and 201 is returned', async () => {
    // The DB row is the source of truth and the queue is a projection. Rejecting here would discard
    // a schedule the operator deliberately created, and leave them nothing to retry from.
    syncThrows = new Error('redis down')
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(201)
    expect((await body(res)).ok).toBe(true)
  })

  test('a BULLMQ failure STILL audits the create (the row exists in the DB)', async () => {
    // The audit is what lets an operator see that the row and the queue may have diverged.
    syncThrows = new Error('redis down')
    await POST(postReq(validBody()) as never)
    expect(audits).toHaveLength(1)
  })
})

describe('POST /api/schedules — the audit trail', () => {
  test('the audit names the actor, the row, the cron and the COMPUTED next fire time', async () => {
    createdRow = { id: 's-5' }
    await POST(postReq(validBody()) as never)
    expect(audits).toEqual([
      {
        userId: 'u1',
        action: 'SCHEDULE_CREATE',
        severity: 'info',
        detail: { id: 's-5', name: 'Morning digest', cronExpr: '0 9 * * *', nextRunAt: nextRunValue!.toISOString() },
      },
    ])
  })

  test('a null nextRun is audited as null rather than crashing on toISOString', async () => {
    // `nextRunAt?.toISOString() ?? null`. `nextRun` can legitimately return null (an unsatisfiable
    // expression), and an unguarded `.toISOString()` would turn a successful create into a 500 --
    // after the row was already written.
    nextRunValue = null
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(201)
    expect((audits[0]!.detail as Record<string, unknown>).nextRunAt).toBeNull()
    expect(createdData().nextRunAt).toBeNull()
  })

  test('ORDER: create -> sync -> audit (the audit describes a row that exists)', async () => {
    await POST(postReq(validBody()) as never)
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'requireRole:admin',
      'hasPlan',
      'nextRun',
      'db.scheduledRun.create',
      'syncSchedule',
      'writeAudit',
    ])
  })

  test('a failing audit is still 500 -- writeAudit errors reach handleApiError', async () => {
    // `writeAudit` swallows info-severity DB errors itself, so a throw here is unusual; what this
    // pins is that the route does not swallow it into a false 201.
    auditThrows = new Error('audit table gone')
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create scheduled run.' } })
  })

  test('a create failure is 500 with the fallback and NO audit and NO sync', async () => {
    createThrows = new Error('unique constraint violated on name')
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create scheduled run.' } })
    expect(JSON.stringify(payload)).not.toContain('unique constraint')
    expect(audits).toEqual([])
    expect(syncArgs).toBeUndefined()
  })

  test('an unauthenticated POST creates nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await POST(postReq(validBody()) as never)
    expect(res.status).toBe(401)
    expect(dbCalls).toEqual([])
  })
})
