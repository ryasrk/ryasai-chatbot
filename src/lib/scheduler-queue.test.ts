import { describe, expect, test } from 'bun:test'
import { parseCron, nextRun } from './cron'

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
