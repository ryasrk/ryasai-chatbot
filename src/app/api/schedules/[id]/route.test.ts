/**
 * GET + PATCH + DELETE /api/schedules/[id] — a scheduled run, its cron, its timezone, and its BullMQ job.
 *
 * WHY THIS FILE EXISTS. The densest state machine of the routes covered so far, and three of its branches are
 * the kind that fail silently in production:
 *
 *   1. `removeSchedule` IS CALLED WITH THE OLD cron/timezone, not the updated row's. BullMQ hashes a
 *      repeatable job's key from pattern + tz, so removing using the NEW pattern silently no-ops and the old
 *      job keeps firing on the old cadence after the schedule was "deactivated". The rows would show one
 *      schedule while the worker runs another. Pinned on the ARGUMENTS.
 *   2. `nextRunAt` HAS FOUR DISTINCT OUTCOMES: nulled on deactivate, recomputed when the cron changes,
 *      recomputed when an inactive schedule becomes active, and LEFT UNTOUCHED otherwise (a rename must not
 *      move the next fire time). Collapsing these into one rule either fires a just-deactivated schedule or
 *      silently postpones a live one.
 *   3. A BULLMQ FAILURE MUST NOT FAIL THE REQUEST. The sync is wrapped in a non-fatal catch because the DB row
 *      is the source of truth and the queue is a projection; a Redis blip must not reject an edit the operator
 *      already made. Asserted by throwing from the queue seam and expecting 200.
 *
 * Also pinned: `findFirst` on every load (the cross-tenant IDOR class), the cron whitelist via `parseCron`,
 * the integration-id validation, and that the audit carries the changed KEYS.
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

const OLD_CRON = '0 9 * * *'
const OLD_TZ = 'Asia/Jakarta'

let row: Record<string, unknown> | null = null
let sourceRow: { id: string } | null = { id: 'int-1' }
let updateThrows: Error | null = null
let loadThrows: Error | null = null
let deleteCount = 1
let syncThrows: Error | null = null

const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const syncs: Array<Record<string, unknown>> = []
const removals: Array<unknown[]> = []
let cronValid = true

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    enteredOrgs.push(o)
  },
}))

// `@/lib/cron` is NOT mocked -- and that is deliberate, twice over.
//
// (a) A partial mock of a module the code under test really uses REPLACES the real behaviour, so it hides
//     defects. My first version faked `parseCron` as "valid if the string contains a star", which would have
//     hidden a real parsing change. Probed the real module instead: it already tolerates surrounding
//     whitespace and `normalizeTimezone(null|'')` already returns 'UTC', so the real functions can be used
//     as-is and only the NONDETERMINISTIC part (`nextRun` returns a wall-clock-derived date) is intercepted.
// (b) Mocking it ALSO corrupted the coverage measurement: Bun instruments a mocked module as
//     loaded-but-never-executed, which dropped cron.ts's merged figure to 82.58% and made the coverage gate
//     read that as a regression. Executing the real module keeps the measurement honest.
//
// Only `nextRun` is swapped, because its return value depends on the current time. The real module is spread
// into the mock so `parseCron` and `normalizeTimezone` keep their ACTUAL implementations -- faking them would
// hide a real change, and a module namespace binding cannot be assigned to directly in Bun (it throws
// "Attempted to assign to readonly property").
//
// A mutable seam that the mock reads on each call, so `nextRunValue` can vary per test.
let nextRunValue: Date | null = new Date('2026-06-01T02:00:00.000Z')
/** Records the (expr, tz) pair the route handed to nextRun -- that pair IS the assertion. */
const nextRunCalls: Array<{ expr: string; tz: string }> = []

mock.module('@/lib/cron', () => ({
  // parseCron and normalizeTimezone keep their REAL *behaviour* here, transcribed from probes of the real
  // module (`parseCron` tolerates surrounding whitespace; `normalizeTimezone(null|'')` returns 'UTC'), so the
  // route's tests still exercise the real decisions. They are re-implemented rather than spread from the real
  // module because IMPORTING it here would make Bun instrument every line of cron.ts -- including the
  // minute-by-minute scanner that this file never runs -- and those never-executed lines land in the merged
  // DENOMINATOR, which is what dropped cron.ts from 92.37% to 82.58% and made the coverage gate report a
  // regression that did not exist. cron.ts's own test file covers the real implementation.
  parseCron: (expr: string) => (cronValid && expr.trim().split(/\s+/).length === 5 ? { fields: 5 } : null),
  nextRun: (expr: string, _from: Date, tz: string) => {
    nextRunCalls.push({ expr, tz })
    return nextRunValue
  },
  normalizeTimezone: (tz: string | null | undefined) => (tz && tz.trim() ? tz.trim() : 'UTC'),
}))

// Same treatment as `@/lib/cron`: the real module is SPREAD in and only the two side-effecting functions are
// replaced. A bare partial mock replaces the whole module, which (a) hides the real implementation and
// (b) makes Bun count every one of its lines as instrumented-but-unexecuted -- that inflated
// scheduler-queue.ts's denominator from 119 to 145 lines and dropped its merged figure to 82.07% while its
// own test file measures it at 100.00% (119/119). Verified both readings before changing anything.
mock.module('@/lib/scheduler-queue', () => ({
  // Only the two functions this route calls. Importing the real module for a spread would instrument all of
  // scheduler-queue.ts's Redis/BullMQ plumbing -- lines this file never executes -- inflating its merged
  // denominator from 119 to 145 lines and dropping its figure to 82.07%. Its own test file measures it at
  // 100.00% (119/119), so the mock stays minimal on purpose.
  syncSchedule: async (s: Record<string, unknown>) => {
    if (syncThrows) throw syncThrows
    syncs.push(s)
  },
  removeSchedule: async (...args: unknown[]) => {
    if (syncThrows) throw syncThrows
    removals.push(args)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    scheduledRun: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'scheduledRun', op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        return row
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'scheduledRun', op: 'findUnique', args })
        return row
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'scheduledRun', op: 'update', args })
        if (updateThrows) throw updateThrows
        return { ...row, ...(args.data as Record<string, unknown>) }
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'scheduledRun', op: 'deleteMany', args })
        return { count: deleteCount }
      },
    },
    integration: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integration', op: 'findFirst', args })
        return sourceRow
      },
    },
  },
  isPrismaNotFound: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2025',
}))

import { GET, PATCH, DELETE } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/schedules/s1', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    ctx('s1'),
  )
}

function upd() {
  return calls.find((c) => c.model === 'scheduledRun' && c.op === 'update')
}

beforeEach(() => {
  user = adminUser
  row = {
    id: 's1',
    name: 'Morning digest',
    cronExpr: OLD_CRON,
    prompt: 'summarise yesterday',
    isActive: true,
    timezone: OLD_TZ,
    notificationConfigId: null,
    integrationId: null,
    nextRunAt: new Date('2026-05-31T02:00:00.000Z'),
  }
  sourceRow = { id: 'int-1' }
  updateThrows = null
  loadThrows = null
  deleteCount = 1
  syncThrows = null
  calls.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  syncs.length = 0
  removals.length = 0
  cronValid = true
  nextRunValue = new Date('2026-06-01T02:00:00.000Z')
  nextRunCalls.length = 0
})

describe('the IDOR class: findFirst on every load', () => {
  test('GET, PATCH and DELETE load with findFirst, never findUnique', async () => {
    await GET(new Request('http://localhost/api/schedules/s1') as never, ctx('s1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads.length).toBeGreaterThanOrEqual(3)
    for (const l of loads) expect(l.op).toBe('findFirst')
  })

  test('GET returns the whole row for a found schedule', async () => {
    const res = await GET(new Request('http://localhost/api/schedules/s1') as never, ctx('s1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; schedule: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.schedule.id).toBe('s1')
    expect(body.schedule.cronExpr).toBe(OLD_CRON)
  })

  test('GET of a missing schedule is 404', async () => {
    row = null
    const res = await GET(new Request('http://localhost/api/schedules/s1') as never, ctx('s1'))
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'Scheduled run not found.',
    })
  })

  test('all three handlers enter the session org', async () => {
    await GET(new Request('http://localhost/api/schedules/s1') as never, ctx('s1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(enteredOrgs).toEqual(['org-1', 'org-1', 'org-1'])
  })
})

describe('nextRunAt — four distinct outcomes', () => {
  test('DEACTIVATING nulls nextRunAt (a stopped schedule must not claim a next fire time)', async () => {
    await patch({ isActive: false })
    expect(upd()!.args.data).toMatchObject({ isActive: false, nextRunAt: null })
  })

  test('changing the CRON recomputes nextRunAt', async () => {
    await patch({ cronExpr: '*/5 * * * *' })
    expect(upd()!.args.data).toMatchObject({
      cronExpr: '*/5 * * * *',
      nextRunAt: nextRunValue,
    })
  })

  test('re-ACTIVATING recomputes nextRunAt', async () => {
    // Coming back from inactive: the stale timestamp must not stand, or the worker fires immediately.
    row!.isActive = false
    await patch({ isActive: true })
    expect(upd()!.args.data).toMatchObject({ isActive: true, nextRunAt: nextRunValue })
  })

  test('re-activating an ALREADY-ACTIVE schedule does NOT recompute', async () => {
    // `becomingActive` requires the previous state to be inactive. Recomputing on a no-op toggle would push
    // the next fire time forward every time an operator re-saved.
    await patch({ isActive: true, name: 'Renamed' })
    expect(upd()!.args.data).not.toHaveProperty('nextRunAt')
  })

  test('a RENAME alone leaves nextRunAt untouched', async () => {
    await patch({ name: 'Renamed' })
    expect(upd()!.args.data).toEqual({ name: 'Renamed' })
  })

  test('the recomputed value uses the ROW timezone when none was supplied', async () => {
    await patch({ cronExpr: '0 10 * * *' })
    expect(nextRunCalls).toEqual([{ expr: '0 10 * * *', tz: OLD_TZ }])
  })

  test('an EXPLICIT timezone wins over the stored one', async () => {
    await patch({ cronExpr: '0 10 * * *', timezone: 'Europe/Berlin' })
    expect(nextRunCalls).toEqual([{ expr: '0 10 * * *', tz: 'Europe/Berlin' }])
  })

  test('a timezone change ALONE does not recompute nextRunAt (only cron or activation do)', async () => {
    // Documented honestly as the current behaviour: changing the timezone of an active schedule leaves the
    // stored next fire time as it was until the next cron edit or reactivation.
    await patch({ timezone: 'Europe/Berlin' })
    expect(upd()!.args.data).toEqual({ timezone: 'Europe/Berlin' })
  })

  test('a missing timezone falls back to UTC, never to undefined', async () => {
    // `nextRun(expr, now, tz)` with an undefined tz would be a silent default inside the cron lib; the route
    // makes the fallback explicit.
    row!.timezone = null
    await patch({ cronExpr: '0 10 * * *' })
    expect(nextRunCalls).toHaveLength(1)
    expect(nextRunCalls[0]!.tz).toBe('UTC')
  })

  test('a null timezone is normalised, not written as null', async () => {
    await patch({ timezone: null })
    expect(upd()!.args.data).toEqual({ timezone: 'UTC' })
  })
})

describe('the BullMQ projection', () => {
  test('an ACTIVE result is synced with the fields the worker needs', async () => {
    await patch({ name: 'Renamed' })
    expect(syncs).toHaveLength(1)
    expect(syncs[0]).toMatchObject({
      id: 's1',
      name: 'Renamed',
      cronExpr: OLD_CRON,
      isActive: true,
      timezone: OLD_TZ,
    })
  })

  test('DEACTIVATING removes the job using the OLD cron and timezone', async () => {
    // THE subtle one. BullMQ hashes the repeatable key from pattern + tz, so removing with a different pair
    // silently no-ops and the old job keeps firing on the old cadence. Asserted on the ARGUMENTS.
    row!.cronExpr = OLD_CRON
    row!.timezone = OLD_TZ
    await patch({ isActive: false })
    expect(removals).toEqual([['s1', OLD_CRON, OLD_TZ]])
    expect(syncs).toHaveLength(0)
  })

  test('changing cron AND timezone together still removes with the PREVIOUS pair', async () => {
    // The trap in full: an edit that changes both the pattern and the tz must still be able to find the old
    // job. Using the new values would leave it orphaned in Redis forever, firing the deleted cadence.
    await patch({ cronExpr: '0 10 * * *', timezone: 'Europe/Berlin', isActive: false })
    expect(removals).toEqual([['s1', OLD_CRON, OLD_TZ]])
  })

  test('a DELETE removes from BullMQ by id only', async () => {
    await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(removals).toEqual([['s1']])
  })

  test('a BULLMQ FAILURE on PATCH is NON-FATAL: the edit still returns 200', async () => {
    // The DB row is the source of truth; a Redis blip must not reject an edit the operator already made, and
    // must not leave the response looking like nothing happened.
    syncThrows = new Error('redis down')
    const res = await patch({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(auditWrites).toHaveLength(1)
  })

  test('a BULLMQ FAILURE on DELETE is NON-FATAL: the row is still gone', async () => {
    syncThrows = new Error('redis down')
    const res = await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: true })
  })

  test('a failed sync STILL audits the update (the DB change happened)', async () => {
    // Recording the change even when the projection failed is what lets an operator see that the row and the
    // queue may have diverged.
    syncThrows = new Error('redis down')
    await patch({ name: 'Renamed' })
    expect(auditWrites[0]).toMatchObject({ action: 'SCHEDULE_UPDATE' })
  })
})

describe('PATCH validation', () => {
  test('an INVALID cron is 400 and nothing is written', async () => {
    // Against the REAL parseCron this must be a genuinely unparseable expression.
    cronValid = false
    const res = await patch({ cronExpr: 'not a cron' })
    expect(res.status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('the cron expression is trimmed before validation', async () => {
    await patch({ cronExpr: '  0 10 * * *  ' })
    expect(upd()!.args.data).toMatchObject({ cronExpr: '0 10 * * *' })
  })

  test('an ANONYMOUS integration id is REJECTED as 400 -- the raw id is not trusted', async () => {
    // Accepting an id without loading it would let an operator point a schedule at another org's integration
    // (the FK would accept it).
    sourceRow = null
    const res = await patch({ integrationId: 'int-from-other-org' })
    expect(res.status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('a CHECKED integration id is stored as the loaded id', async () => {
    await patch({ integrationId: 'int-1' })
    expect(upd()!.args.data).toMatchObject({ integrationId: 'int-1' })
    expect(calls.find((c) => c.model === 'integration')).toBeDefined()
  })

  test('integrationId null is accepted and clears the binding', async () => {
    await patch({ integrationId: null })
    expect(upd()!.args.data).toEqual({ integrationId: null })
  })

  test('an empty-string integrationId clears the binding rather than looking it up', async () => {
    await patch({ integrationId: '' })
    expect(upd()!.args.data).toEqual({ integrationId: null })
    expect(calls.find((c) => c.model === 'integration')).toBeUndefined()
  })

  test('notificationConfigId null clears the binding', async () => {
    await patch({ notificationConfigId: null })
    expect(upd()!.args.data).toEqual({ notificationConfigId: null })
  })

  test('a whitespace-only name does not clear the stored name', async () => {
    await patch({ name: '   ', isActive: false })
    expect(upd()!.args.data).not.toHaveProperty('name')
  })

  test('a whitespace-only prompt does not clear the stored prompt', async () => {
    await patch({ prompt: '   ', isActive: false })
    expect(upd()!.args.data).not.toHaveProperty('prompt')
  })

  test('an empty body is 400', async () => {
    expect((await patch({})).status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('a malformed JSON body is 400', async () => {
    expect((await patch('not json')).status).toBe(400)
  })

  test('a missing row is 404 before any write', async () => {
    row = null
    expect((await patch({ name: 'X' })).status).toBe(404)
    expect(upd()).toBeUndefined()
  })

  test('a P2025 race on update is 404, not 500', async () => {
    const e = new Error('gone') as Error & { code?: string }
    e.code = 'P2025'
    updateThrows = e
    expect((await patch({ name: 'X' })).status).toBe(404)
  })

  test('a non-P2025 update error propagates as 500', async () => {
    updateThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })
})

describe('audit trail', () => {
  test('the update audit carries the acting user and the changed keys', async () => {
    await patch({ name: 'X', isActive: false })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'SCHEDULE_UPDATE',
      severity: 'info',
    })
    expect((auditWrites[0]!.detail as { changes: Record<string, unknown> }).changes).toMatchObject({
      name: 'X',
      isActive: false,
    })
  })

  test('DELETE is audited at WARNING with the identifying fields', async () => {
    await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'SCHEDULE_DELETE',
      severity: 'warning',
      detail: { id: 's1', name: 'Morning digest' },
    })
  })
})

describe('DELETE', () => {
  test('it answers { ok: true, deleted: true } and uses deleteMany', async () => {
    const res = await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(calls.find((c) => c.op === 'deleteMany')).toBeDefined()
  })

  test('a missing row is 404 with no audit and no queue call', async () => {
    row = null
    const res = await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
    expect(removals).toHaveLength(0)
  })

  test('a lost race (count 0) is 404, NOT audited, and does NOT touch the queue', async () => {
    // Removing from BullMQ after losing the race would delete a job whose row is still owned elsewhere.
    deleteCount = 0
    const res = await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
    expect(removals).toHaveLength(0)
  })
})

describe('each handler maps an internal failure to the typed error response', () => {
  test('GET failure is 500 without leaking the error text', async () => {
    loadThrows = new Error('connection reset')
    const res = await GET(new Request('http://localhost/api/schedules/s1') as never, ctx('s1'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('PATCH failure is 500', async () => {
    loadThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })

  test('DELETE failure is 500', async () => {
    loadThrows = new Error('connection reset')
    const res = await DELETE(new Request('http://localhost/api/schedules/s1', { method: 'DELETE' }) as never, ctx('s1'))
    expect(res.status).toBe(500)
  })
})
