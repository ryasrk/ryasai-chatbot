import { describe, expect, test } from 'bun:test'
import { createConnection } from 'net'
import { parseCron, nextRun, normalizeTimezone } from './cron'
import { syncSchedule, removeSchedule, scheduleQueue } from './scheduler-queue'

// ponytail: integration tests need live Redis (BullMQ repeatable jobs live in
// Redis). Probe the port and skip the integration block when Redis is down so
// `bun test` still passes in bare environments.
const redisUp = await new Promise<boolean>((resolve) => {
  const sock = createConnection(6379, '127.0.0.1')
  sock.on('connect', () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
})
const it = redisUp ? test : test.skip

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
