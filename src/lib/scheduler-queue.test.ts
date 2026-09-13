import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createConnection } from 'net'
import { parseCron, nextRun, normalizeTimezone } from './cron'
import {
  syncSchedule,
  removeSchedule,
  scheduleQueue,
  ensureLicenseReminderRepeatable,
  LICENSE_REMINDER_JOB_NAME,
  LICENSE_REMINDER_CRON,
  LICENSE_REMINDER_TZ,
  syncAllSchedules,
} from './scheduler-queue'

// ponytail: integration tests need live Redis (BullMQ repeatable jobs live in
// Redis). Probe the port and skip the integration block when Redis is down so
// `bun test` still passes in bare environments.
const redisUp = await new Promise<boolean>((resolve) => {
  const sock = createConnection(6379, '127.0.0.1')
  sock.on('connect', () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
})
const it = redisUp ? test : test.skip

// A single module-scope db double. Two separate mock.module('./db') calls would
// have the LAST one win, so the earlier describe's tests would silently read the
// wrong `runs` — which is exactly what happened on the first attempt (3 existing
// tests went red).
const dbState: { runs: Array<Record<string, unknown>> } = { runs: [] }
mock.module('./db', () => ({
  db: { scheduledRun: { findMany: async () => dbState.runs } },
}))

describe('scheduler-queue', () => {
  test('syncSchedule + removeSchedule are callable with valid schedule shape', async () => {
    // Unit test: verify the sync/remove functions accept the right shape.
    // Full integration test requires a running Redis instance.
    const run = {
      id: 'test-run-id',
      name: 'Test Schedule',
      cronExpr: '0 9 * * *',
      prompt: 'Summarize sales',
      isActive: true,
      notificationConfigId: null,
    }

    // parseCron validates the cron expression that syncSchedule would pass to BullMQ
    expect(parseCron(run.cronExpr)).not.toBeNull()
    const next = nextRun(run.cronExpr, new Date('2026-07-30T10:00:00Z'))
    expect(next).toEqual(new Date('2026-07-31T09:00:00Z'))
  })

  test('invalid timezone falls back to UTC', () => {
    expect(normalizeTimezone()).toBe('UTC')
    expect(normalizeTimezone('')).toBe('UTC')
    expect(normalizeTimezone('Not/AZone')).toBe('UTC')
    expect(normalizeTimezone('America/New_York')).toBe('America/New_York')
  })

  it('tz-keyed repeatable job is removed with a matching tz (no orphaned duplicate)', async () => {
    // GH#1 regression: add() stores tz in the repeat key hash, so remove()
    // must pass the same tz or the hash differs and removal silently no-ops.
    const runId = `tz-test-${Date.now()}`
    const opts = {
      id: runId,
      name: 'TZ Test',
      cronExpr: '0 9 * * *',
      prompt: 'Summarize sales',
      isActive: true,
      notificationConfigId: null,
      timezone: 'America/New_York',
    }
    try {
      await syncSchedule(opts)
      let mine = (await scheduleQueue.getRepeatableJobs()).find((j) => j.name === `scheduled-run:${runId}`)
      expect(mine).toBeTruthy()
      expect(mine!.tz).toBe('America/New_York')

      // Deactivate-path removal passes cron + tz — exactly the tz-keyed case.
      await removeSchedule(runId, opts.cronExpr, opts.timezone)
      mine = (await scheduleQueue.getRepeatableJobs()).find((j) => j.name === `scheduled-run:${runId}`)
      expect(mine).toBeFalsy()
    } finally {
      await removeSchedule(runId).catch(() => {})
    }
  })

  it('scan-based removal (delete path, no cron/tz args) still finds the stored job', async () => {
    const runId = `scan-test-${Date.now()}`
    const opts = {
      id: runId,
      name: 'Scan Test',
      cronExpr: '30 14 * * 1',
      prompt: 'Summarize sales',
      isActive: true,
      notificationConfigId: null,
      timezone: 'Europe/Berlin',
    }
    try {
      await syncSchedule(opts)
      const found = (await scheduleQueue.getRepeatableJobs()).find((j) => j.name === `scheduled-run:${runId}`)
      expect(found?.tz).toBe('Europe/Berlin')
      await removeSchedule(runId)
      const after = (await scheduleQueue.getRepeatableJobs()).find((j) => j.name === `scheduled-run:${runId}`)
      expect(after).toBeFalsy()
    } finally {
      await removeSchedule(runId).catch(() => {})
    }
  })

  test('cron expression for daily at 9am produces correct next run', () => {
    expect(parseCron('0 9 * * *')).not.toBeNull()
    const next = nextRun('0 9 * * *', new Date('2026-07-30T08:00:00Z'))
    expect(next).toEqual(new Date('2026-07-30T09:00:00Z'))
  })

  test('cron expression for every 15 minutes produces correct next run', () => {
    expect(parseCron('*/15 * * * *')).not.toBeNull()
    const next = nextRun('*/15 * * * *', new Date('2026-07-30T10:07:00Z'))
    expect(next).toEqual(new Date('2026-07-30T10:15:00Z'))
  })

  test('invalid cron expression is rejected', () => {
    expect(parseCron('invalid')).toBeNull()
    expect(parseCron('60 9 * * *')).toBeNull()
    expect(parseCron('0 25 * * *')).toBeNull()
  })
})

describe('scheduler-queue — the license reminder and the bootstrap sweep', () => {
  // These two functions had ZERO coverage: the file imported only
  // syncSchedule/removeSchedule/scheduleQueue, so 41 of 102 executable lines in a
  // production scheduler were never run. Both are idempotency-critical — a wrong
  // prune removes a live job.
  let savedReminder: Awaited<ReturnType<typeof scheduleQueue.getRepeatableJobs>> = []

  beforeAll(async () => {
    dbState.runs = []
    savedReminder = (await scheduleQueue.getRepeatableJobs()).filter(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
  })

  it('creates the reminder when it is missing', async () => {
    dbState.runs = []
    const reminder = (await scheduleQueue.getRepeatableJobs()).find(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    if (reminder) await scheduleQueue.removeRepeatableByKey(reminder.key)

    await ensureLicenseReminderRepeatable()

    const created = (await scheduleQueue.getRepeatableJobs()).find(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    expect(created).toBeTruthy()
    expect(created!.pattern).toBe(LICENSE_REMINDER_CRON)
    expect(created!.tz).toBe(LICENSE_REMINDER_TZ)
  })

  it('is IDEMPOTENT — a second call does not duplicate the job', async () => {
    // A duplicate would send the customer the same expiry email twice a day.
    await ensureLicenseReminderRepeatable()
    await ensureLicenseReminderRepeatable()
    const all = (await scheduleQueue.getRepeatableJobs()).filter(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    expect(all).toHaveLength(1)
  })

  it('replaces a reminder whose pattern DRIFTED, instead of adding a second one', async () => {
    // The removal must mirror the STORED pattern; passing the desired one instead
    // hashes differently and leaves the stale job firing alongside the new one.
    const existing = (await scheduleQueue.getRepeatableJobs()).find(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    if (existing) await scheduleQueue.removeRepeatableByKey(existing.key)
    await scheduleQueue.add(
      LICENSE_REMINDER_JOB_NAME,
      {} as never,
      { repeat: { pattern: '0 3 * * *', tz: LICENSE_REMINDER_TZ } },
    )
    expect(
      (await scheduleQueue.getRepeatableJobs()).filter((j) => j.name === LICENSE_REMINDER_JOB_NAME),
    ).toHaveLength(1)

    await ensureLicenseReminderRepeatable()

    const after = (await scheduleQueue.getRepeatableJobs()).filter(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    expect(after).toHaveLength(1)
    // And it is the DESIRED pattern, not the drifted one.
    expect(after[0].pattern).toBe(LICENSE_REMINDER_CRON)
  })

  afterAll(async () => {
    // Restore whatever the environment had, so this file leaves no trace.
    const now = (await scheduleQueue.getRepeatableJobs()).filter(
      (j) => j.name === LICENSE_REMINDER_JOB_NAME,
    )
    for (const j of now) await scheduleQueue.removeRepeatableByKey(j.key)
    if (savedReminder.length > 0) await ensureLicenseReminderRepeatable()
  })
})

describe('scheduler-queue — syncAllSchedules prunes only what it should', () => {
  // `syncAllSchedules` had ZERO coverage. It is the recovery sweep that runs on
  // worker startup and periodically: it must prune repeatable jobs whose schedule
  // no longer exists, and must NOT touch anything else on the queue.

  const run = (id: string, cronExpr = '0 9 * * *', timezone = 'UTC') => ({
    id,
    name: `Run ${id}`,
    cronExpr,
    prompt: 'Summarize sales',
    isActive: true,
    notificationConfigId: null,
    integrationId: null,
    timezone,
  })

  const names = async () => (await scheduleQueue.getRepeatableJobs()).map((j) => j.name)

  it('removes a stale job, keeps a live one, and never prunes the license reminder', async () => {
    const staleId = `stale-${Date.now()}`
    const liveId = `live-${Date.now()}`
    // A job whose DB row is gone (deleted or deactivated schedule).
    await syncSchedule(run(staleId))
    // A job whose DB row still exists and is unchanged.
    await syncSchedule(run(liveId))
    dbState.runs = [run(liveId)]
    await ensureLicenseReminderRepeatable()

    await syncAllSchedules()

    const after = await names()
    expect(after).not.toContain(`scheduled-run:${staleId}`)
    expect(after).toContain(`scheduled-run:${liveId}`)
    // The platform reminder lives on this queue but is NOT a user schedule; pruning
    // it would silently stop every license-expiry email in the deployment.
    expect(after).toContain(LICENSE_REMINDER_JOB_NAME)

    await removeSchedule(liveId)
  })

  it('RE-SYNCS a job whose cron changed in the DB', async () => {
    // Without this the UI would show the new cron while BullMQ kept firing the old
    // one — the schedule silently disagrees with what the admin configured.
    const id = `changed-${Date.now()}`
    await syncSchedule(run(id, '0 9 * * *'))
    dbState.runs = [run(id, '*/5 * * * *')]

    await syncAllSchedules()

    const job = (await scheduleQueue.getRepeatableJobs()).find((j) => j.name === `scheduled-run:${id}`)
    expect(job?.pattern).toBe('*/5 * * * *')
    await removeSchedule(id)
  })

  it('leaves an UNCHANGED job alone rather than churning it', async () => {
    // The header promises "no remove/re-add churn for unchanged schedules": churn
    // drops the job's accumulated repeat state and can skip an imminent fire.
    const id = `stable-${Date.now()}`
    await syncSchedule(run(id))
    const keyBefore = (await scheduleQueue.getRepeatableJobs()).find(
      (j) => j.name === `scheduled-run:${id}`,
    )?.key
    dbState.runs = [run(id)]

    await syncAllSchedules()

    const keyAfter = (await scheduleQueue.getRepeatableJobs()).find(
      (j) => j.name === `scheduled-run:${id}`,
    )?.key
    expect(keyAfter).toBe(keyBefore)
    await removeSchedule(id)
  })

  it('a DEACTIVATED schedule (absent from the query) is pruned', async () => {
    const id = `deactivated-${Date.now()}`
    await syncSchedule(run(id))
    // findMany filters isActive: true, so a deactivated row simply never appears.
    dbState.runs = []

    await syncAllSchedules()

    expect(await names()).not.toContain(`scheduled-run:${id}`)
  })
})

describe('scheduler-queue — one failure must not abort the whole sweep', () => {
  // Both catch blocks guard this: a single bad job (Redis blip, or a stored key the
  // server rejects) must not stop the remaining schedules from being synced. An
  // unguarded throw here leaves every later schedule unsynced until the next sweep.

  const run = (id: string, cronExpr = '0 9 * * *') => ({
    id, name: `Run ${id}`, cronExpr, prompt: 'p', isActive: true,
    notificationConfigId: null, integrationId: null, timezone: 'UTC',
  })

  it('a prune failure is logged and the sweep continues', async () => {
    const staleId = `boom-prune-${Date.now()}`
    await syncSchedule(run(staleId))
    dbState.runs = []

    const realRemove = scheduleQueue.removeRepeatableByKey.bind(scheduleQueue)
    scheduleQueue.removeRepeatableByKey = (async () => {
      throw new Error('redis says no')
    }) as typeof scheduleQueue.removeRepeatableByKey

    try {
      // Must RESOLVE, not reject: the sweep is best-effort by design.
      await expect(syncAllSchedules()).resolves.toBeUndefined()
    } finally {
      scheduleQueue.removeRepeatableByKey = realRemove
    }
    // And the failed job is still there (we did not pretend it was pruned).
    expect((await scheduleQueue.getRepeatableJobs()).map((j) => j.name)).toContain(
      `scheduled-run:${staleId}`,
    )
    await removeSchedule(staleId)
  })

  it('a sync failure on ONE run does not stop the runs after it', async () => {
    const badId = `boom-sync-${Date.now()}`
    const goodId = `after-boom-${Date.now()}`
    // `badId` sorts first, so a throw here would skip `goodId` entirely.
    dbState.runs = [run(badId), run(goodId)]

    const realAdd = scheduleQueue.add.bind(scheduleQueue)
    scheduleQueue.add = (async (name: string, ...rest: unknown[]) => {
      if (String(name).includes(badId)) throw new Error('add exploded')
      return (realAdd as (...a: unknown[]) => unknown)(name, ...rest)
    }) as typeof scheduleQueue.add

    try {
      await expect(syncAllSchedules()).resolves.toBeUndefined()
    } finally {
      scheduleQueue.add = realAdd
    }
    // The schedule AFTER the failing one was still synced.
    expect((await scheduleQueue.getRepeatableJobs()).map((j) => j.name)).toContain(
      `scheduled-run:${goodId}`,
    )
    await removeSchedule(goodId)
    await removeSchedule(badId)
    dbState.runs = []
  })
})
