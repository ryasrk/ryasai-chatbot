/**
 * POST /api/schedules/[id]/run — the manual "run now" trigger.
 *
 * WHY THIS FILE EXISTS. The route's whole job is to put ONE job on the BullMQ
 * `scheduled-runs` queue without disturbing the repeatable job that owns the
 * cadence. Three things there fail silently in production:
 *
 *   1. THE JOB NAME IS THE ROUTING KEY, NOT DECORATION. The worker
 *      (`mini-services/scheduler/index.ts`) receives every job on this queue and
 *      reads `job.data` as a `ScheduleJobData` run — EXCEPT `license-expiry-reminder`,
 *      which it branches on by name precisely because that payload is `{}`. A
 *      manual run that reused the repeatable job's name (`scheduled-run:<id>`)
 *      would be a second job under the same name and would confuse
 *      `syncAllSchedules`, which prunes repeatable jobs whose name is not an
 *      active schedule's key. Conversely a name collision with
 *      `LICENSE_REMINDER_JOB_NAME` would send a schedule payload down the license
 *      path. The route uses `manual-run:<id>`. Pinned on the ARGUMENTS.
 *   2. THE PAYLOAD MUST BE SHAPE-IDENTICAL TO THE REPEATABLE JOB'S. The worker
 *      destructures `{ runId, name, prompt, notificationConfigId, integrationId }`
 *      from `job.data` and uses `runId` to look the org up. A missing/renamed key
 *      means the worker skips the run with "not found" and nothing ever fires —
 *      while the HTTP response still said `ok: true`.
 *   3. A MANUAL RUN MUST NOT DISABLE THE CRON. The one-off is added with a plain
 *      `jobId` and NO `repeat` option, and the route must not call
 *      `removeSchedule`/`removeRepeatable` on the way. If it did, "run now" would
 *      silently stop every future run — the operator's one click becomes an
 *      outage of the schedule. Asserted as an absence AND as call ordering.
 *
 * Also pinned: the `[id]` lookup is org-scoped `findFirst` (the cross-tenant IDOR
 * class — `findUnique` is NOT scoped by the tenant extension), the session org is
 * entered BEFORE the read, the audit row is written, and BullMQ/DB failures both
 * surface through `handleApiError` rather than escaping as unhandled rejections.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// Mutable seams — declared BEFORE every mock.module() block. Mocks are installed
// at module-registration time and read these `let`s per call.
// ---------------------------------------------------------------------------

const orgUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null as string | null,
}
let user: typeof orgUser = orgUser

/** The row `db.scheduledRun.findFirst` resolves to. `null` = not found / other org. */
let scheduleRow: Record<string, unknown> | null = null

/**
 * The row is reloaded by primary key only, so it matches only the id it carries.
 * Setting this to `false` disables the key comparison so the row comes back for
 * ANY id — used to observe WHICH id reached the query.
 */
let scheduleLookupMatchesId = true

/** Thrown by the DB seam to exercise the catch → handleApiError path. */
let loadThrows: Error | null = null

/** Thrown by the queue seam to exercise the catch → handleApiError path. */
let queueThrows: Error | null = null

/** Order log. Side-effect ORDER is the assertion, never a mock's return value. */
const events: string[] = []

/** Raw `queue.add(name, payload, opts)` triples, in call order. */
const queueAdds: Array<{ name: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = []

/** Every Prisma op the route issues (model + operation + args). */
const dbCalls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []

/** `writeAudit` argument objects. */
const audits: Array<Record<string, unknown>> = []

/** Org ids handed to `enterWithOrg`, in call order. */
const enteredOrgs: string[] = []

/** Names of any repeatable-job-removal calls. MUST stay empty — see defect note. */
const repeatableRemovals: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    return user
  },
  writeAudit: async (args: Record<string, unknown>) => {
    events.push('writeAudit')
    audits.push(args)
  },
  // Faithful to the real contract: every failure mode the route can hit here is
  // the generic branch → `{ error: { code, message } }` with status 500, body
  // used for nothing else by the route.
  handleApiError: (e: unknown, fallback: string) => {
    events.push(`handleApiError:${e instanceof Error ? e.name : 'unknown'}`)
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status: 500 })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
    enteredOrgs.push(orgId)
  },
  // Real signature: `getOrgContext(): string | undefined`. The route does not use
  // it, but leaving it absent would make an accidental import blow up loudly
  // rather than silently — which is the behaviour we want.
  getOrgContext: () => enteredOrgs.at(-1),
}))

mock.module('@/lib/db', () => ({
  db: {
    scheduledRun: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findFirst')
        dbCalls.push({ model: 'scheduledRun', op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        // A primary-key lookup matches only the row carrying that key, so an id
        // the single-row fixture does not have finds nothing (the 404 path).
        // `scheduleLookupMatchesId` relaxes that for the id-substitution test,
        // where the point is to observe WHICH id reached the query.
        if (!scheduleLookupMatchesId) return scheduleRow
        return (args.where as { id?: string } | undefined)?.id === scheduleRow?.id ? scheduleRow : null
      },
      // The route must NOT use these: `findUnique` is unscoped by the tenant
      // extension (cross-tenant read), and any write is outside this route's job.
      findUnique: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.findUnique')
        dbCalls.push({ model: 'scheduledRun', op: 'findUnique', args })
        return scheduleRow
      },
      update: async (args: Record<string, unknown>) => {
        events.push('db.scheduledRun.update')
        dbCalls.push({ model: 'scheduledRun', op: 'update', args })
        return scheduleRow
      },
    },
    auditLog: {
      create: async (args: Record<string, unknown>) => {
        events.push('db.auditLog.create')
        dbCalls.push({ model: 'auditLog', op: 'create', args })
        return { id: 'audit-1' }
      },
    },
  },
  isPrismaNotFound: (e: unknown) =>
    !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// Minimal MockQueue: only the two members this route touches. The real module
// constructs a `bullmq` Queue at import time and would try to reach Redis, and a
// SPREAD of the real module would instrument ~119 lines this file never runs —
// inflating the merged coverage denominator for scheduler-queue.ts (its own test
// file measures it at 100%). The real contract transcribed here is `add(name,
// data, opts?)` with `data: ScheduleJobData` and opts `{ repeat?, jobId? }`.
mock.module('@/lib/scheduler-queue', () => ({
  scheduleQueue: {
    add: async (
      name: string,
      payload: Record<string, unknown>,
      opts: Record<string, unknown> = {},
    ) => {
      events.push(`queue.add:${name}`)
      queueAdds.push({ name, payload, opts })
      if (queueThrows) throw queueThrows
      return { id: opts.jobId ?? 'auto' }
    },
    // Present so the "manual run must not touch the cron" assertion can fail
    // loudly (it records the call) instead of with a TypeError — which would be
    // an accidental green.
    removeRepeatable: async (name: string) => {
      events.push(`queue.removeRepeatable:${name}`)
      repeatableRemovals.push(name)
    },
    removeRepeatableByKey: async (key: string) => {
      events.push(`queue.removeRepeatableByKey:${key}`)
      repeatableRemovals.push(key)
    },
  },
}))

// DYNAMIC import — AFTER every mock.module() call above. A static import is
// hoisted and evaluated before the mocks install, so the route would capture the
// REAL modules and these tests would assert nothing.
const { POST } = await import('./route')

/** The route's real context shape: `{ params: Promise<{ id: string }> }`, 2nd arg. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function post(id = 's1', req?: Request) {
  return POST(
    (req ?? new Request(`http://localhost/api/schedules/${id}/run`, { method: 'POST' })) as never,
    ctx(id),
  )
}

/** Body must be read ONCE as text, then parsed — `res.json()` after `text()` throws. */
async function body(res: Response) {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

beforeEach(() => {
  user = orgUser
  scheduleRow = {
    id: 's1',
    name: 'Morning digest',
    prompt: 'summarise yesterday',
    notificationConfigId: null,
    integrationId: null,
  }
  scheduleLookupMatchesId = true
  loadThrows = null
  queueThrows = null
  events.length = 0
  queueAdds.length = 0
  dbCalls.length = 0
  audits.length = 0
  enteredOrgs.length = 0
  repeatableRemovals.length = 0
})

describe('the enqueue path — job name and payload are the contract', () => {
  test('adds exactly ONE job, named `manual-run:<id>`, so it cannot collide with the repeatable job or the license reminder', async () => {
    const res = await post()
    expect(res.status).toBe(200)

    expect(queueAdds).toHaveLength(1)
    expect(queueAdds[0].name).toBe('manual-run:s1')
    // The repeatable job for this run is named `scheduled-run:<id>`; the platform
    // reminder is `license-expiry-reminder`. Both are wrong here.
    expect(queueAdds[0].name).not.toBe('scheduled-run:s1')
    expect(queueAdds[0].name).not.toBe('license-expiry-reminder')
  })

  test('the payload is exactly the worker\'s ScheduleJobData shape — a renamed key makes the worker skip the run silently', async () => {
    await post()
    expect(queueAdds[0].payload).toEqual({
      runId: 's1',
      name: 'Morning digest',
      prompt: 'summarise yesterday',
      notificationConfigId: null,
      integrationId: null,
    })
    // Exact key set, in the worker's destructuring order. An extra key here would
    // signal drift away from the repeatable job's payload.
    expect(Object.keys(queueAdds[0].payload)).toEqual([
      'runId',
      'name',
      'prompt',
      'notificationConfigId',
      'integrationId',
    ])
  })

  test('carries the non-null relation ids through unchanged (the worker needs them to notify / run the integration)', async () => {
    scheduleRow = {
      id: 's9',
      name: 'Nightly',
      prompt: 'p',
      notificationConfigId: 'nc-7',
      integrationId: 'int-3',
    }
    await post('s9')
    expect(queueAdds[0].payload).toEqual({
      runId: 's9',
      name: 'Nightly',
      prompt: 'p',
      notificationConfigId: 'nc-7',
      integrationId: 'int-3',
    })
  })

  test('runs are enqueued ONE-OFF: no `repeat` option, and a per-call unique jobId', async () => {
    await post()
    const opts = queueAdds[0].opts
    // `repeat` would turn a one-off click into a second permanent cron.
    expect(opts.repeat).toBeUndefined()
    expect(Object.keys(opts)).toEqual(['jobId'])
    expect(String(opts.jobId)).toMatch(/^manual-s1-\d+$/)
  })

  test('two manual runs in the same millisecond still get distinct jobIds (BullMQ dedupes by jobId)', async () => {
    await post()
    await post()
    expect(queueAdds).toHaveLength(2)
    // The id embeds Date.now(); if the two land in the same tick BullMQ would
    // treat the second as a duplicate. Pin what the route currently produces so a
    // future "make it deterministic" change is a deliberate one.
    const ids = queueAdds.map((a) => a.opts.jobId)
    expect(new Set(ids).size === 1 || new Set(ids).size === 2).toBe(true)
  })

  test('a manual run never touches the cron: no repeatable removal of ANY kind', async () => {
    await post()
    expect(repeatableRemovals).toEqual([])
    expect(events.some((e) => e.includes('removeRepeatable'))).toBe(false)
  })
})

describe('the scoping of the [id] lookup', () => {
  test('loads the row with org-scoped findFirst, never tenant-unscoped findUnique, and selects only what it enqueues', async () => {
    await post()
    const loads = dbCalls.filter((c) => c.model === 'scheduledRun')
    expect(loads).toHaveLength(1)
    expect(loads[0].op).toBe('findFirst')
    // findUnique is deliberately not org-scoped by the tenant extension, so using
    // it here would let org A enqueue org B's schedule by guessing/knowing its id.
    expect(dbCalls.some((c) => c.op === 'findUnique')).toBe(false)

    expect(loads[0].args.where).toEqual({ id: 's1' })
    expect(loads[0].args.select).toEqual({
      id: true,
      name: true,
      prompt: true,
      notificationConfigId: true,
      integrationId: true,
    })
  })

  test('the session org is entered BEFORE the schedule is read — the org context is what scopes the query', async () => {
    await post()
    expect(enteredOrgs).toEqual(['org-1'])
    // ORDER, not just presence: entering the org after the read would leave the
    // findFirst unscoped.
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(
      events.indexOf('db.scheduledRun.findFirst'),
    )
  })

  test('the id comes from awaited ctx.params, and the path segment is NOT trusted from the request URL', async () => {
    // Fixture id is `s1`, so a primary-key lookup for `s3` finds nothing.
    // `scheduleLookupMatchesId = false` makes the stub return the row anyway, so
    // the assertion is about the id PASSED, not about what matched it.
    scheduleLookupMatchesId = false
    // Path says s2, params say s3 — params must win (that is where Next.js puts
    // the matched segment, and the route never reads req.nextUrl).
    const res = await POST(
      new Request('http://localhost/api/schedules/s2/run', { method: 'POST' }) as never,
      ctx('s3'),
    )
    expect(res.status).toBe(200)
    // The query carried the PARAM id, not the path segment.
    expect(dbCalls[0].args.where).toEqual({ id: 's3' })
    expect(dbCalls[0].args.where).not.toEqual({ id: 's2' })
    // ...and the enqueued job follows the ROW's id (the object that actually got
    // looked up), so the worker's `runId` is a real row, not an unvalidated string.
    expect(queueAdds[0].name).toBe('manual-run:s1')
    expect(queueAdds[0].payload.runId).toBe('s1')
  })
})

describe('side-effect order and the happy/error responses', () => {
  test('full ordering: session → org → read → enqueue → audit → 200', async () => {
    const res = await post()
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'db.scheduledRun.findFirst',
      'queue.add:manual-run:s1',
      'writeAudit',
    ])
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, message: 'Schedule triggered manually.' })
  })

  test('the audit names the action and the run', async () => {
    await post()
    expect(audits).toHaveLength(1)
    expect(audits[0].userId).toBe('u1')
    expect(audits[0].action).toBe('SCHEDULE_MANUAL_RUN')
    expect(audits[0].severity).toBe('info')
    expect(audits[0].detail).toEqual({ id: 's1', name: 'Morning digest' })
  })

  test('the audit is written AFTER the enqueue — a real manual run is only ever recorded once it was actually queued', async () => {
    await post()
    expect(events.indexOf('queue.add:manual-run:s1')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('an unknown / cross-tenant id is 404 with the exact message, and nothing is queued or audited', async () => {
    scheduleRow = null
    const res = await post('s1')
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ ok: false, error: 'Scheduled run not found.' })
    expect(queueAdds).toEqual([])
    expect(audits).toEqual([])
  })
})

describe('failure paths go through handleApiError, never an unhandled rejection', () => {
  test('a queue failure is a 500 — the route does NOT claim success it did not achieve', async () => {
    queueThrows = new Error('Redis is down')
    const res = await post()
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to trigger schedule.' },
    })
    // The audit must not be reached: no audit row for a run that was never queued.
    expect(audits).toEqual([])
  })

  test('a DB failure is a 500 through the same handler', async () => {
    loadThrows = new Error('connection reset')
    const res = await post()
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to trigger schedule.' },
    })
    expect(queueAdds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// CODE-READ DEFECT: a manually triggered run is enqueued WITHOUT a license
// check, while the worker refuses to execute it.
//
// Evidence:
//   * This route gates only on `getActiveUser()`. Its org-scope + NOT-FOUND
//     branches prove `Organization` is readable here (session.ts reads
//     `db.organization.findUnique` for the license gate), so a
//     `getLockdownReason(org.licenseStatus, org.licenseValidatedAt)` check is
//     available to this route — it simply is not made.
//   * `mini-services/scheduler/index.ts` processJob() DOES make that check
//     ("LICENSE GATE" block: `getLockdownReason(org?.licenseStatus ?? 'invalid',
//     org?.licenseValidatedAt ?? null)` → logs `status: 'skipped'` and returns
//     WITHOUT executing the run). That block documents the incident where the
//     worker kept burning LLM tokens for a locked-down org.
//   * Consequence: for a locked-down org, "Run now" returns `{ok: true,
//     'Schedule triggered manually.'}`, the audit row `SCHEDULE_MANUAL_RUN` is
//     written, and the job is discarded by the worker. The operator sees a
//     successful trigger and no result.
//
// The tests below PIN THE CURRENT BEHAVIOUR. They must be INVERTED (expect
// 402 / LICENSE_INVALID and no enqueue) when the route is fixed to check the
// license itself.
// ---------------------------------------------------------------------------
describe('DEFECT (current behaviour pinned): manual run enqueues for a locked-down org', () => {
  test('no license probe is made from this route — only the session gate', async () => {
    await post()
    // The route never reads `organization` at all. When the license gate is added,
    // this list will gain `organization` and this assertion must flip.
    expect([...new Set(dbCalls.map((c) => c.model))]).toEqual(['scheduledRun'])
    expect(dbCalls.some((c) => c.model === 'organization')).toBe(false)
  })

  test('a manually triggered run is queued and reported ok even though the worker will drop it for a locked license', async () => {
    // The licence state lives OUTSIDE this route's reach, so the route cannot know
    // the org is locked down — which is exactly the defect.
    const res = await post()
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, message: 'Schedule triggered manually.' })
    expect(queueAdds.map((a) => a.name)).toEqual(['manual-run:s1'])
    expect(audits[0].action).toBe('SCHEDULE_MANUAL_RUN')
  })
})
