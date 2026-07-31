/**
 * BullMQ scheduler queue — production-grade job scheduling.
 * ===========================================================================
 * Replaces the manual polling scheduler with BullMQ repeatable jobs.
 *
 * - Cron scheduling via BullMQ's built-in repeat patterns
 * - Retry with exponential backoff (built-in)
 * - Stalled job detection + automatic re-queue (built-in)
 * - Distributed lock via Redis atomic ops (built-in)
 * - No more double-execution, no more catch-up storms, no more stale runs
 *
 * ScheduledRun table = source of truth for configuration (UI CRUD).
 * BullMQ repeatable job = the actual execution trigger.
 * syncSchedule() bridges the two: DB row → BullMQ repeatable job.
 */
import { Queue, type Job } from 'bullmq'
import { redis } from './redis'

export interface ScheduleJobData {
  runId: string
  name: string
  prompt: string
  notificationConfigId: string | null
}

export const scheduleQueue = new Queue<ScheduleJobData>('scheduled-runs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5_000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
})

const REPEAT_KEY = (runId: string) => `scheduled-run:${runId}`

/**
 * Sync a ScheduledRun row to BullMQ as a repeatable job.
 * Call on create, update, or re-activate.
 *
 * Removes any existing repeatable job with the same key first (idempotent),
 * then adds a fresh one with the current cron expression.
 */
export async function syncSchedule(run: {
  id: string
  name: string
  cronExpr: string
  prompt: string
  isActive: boolean
  notificationConfigId: string | null
  timezone?: string | null
}): Promise<void> {
  const key = REPEAT_KEY(run.id)

  // Remove existing repeatable job (idempotent — safe if none exists)
  try {
    const repeatableJobs = await scheduleQueue.getRepeatableJobs()
    const existing = repeatableJobs.find((j) => j.key === key || j.name === key)
    if (existing) {
      await scheduleQueue.removeRepeatable(key, { pattern: run.cronExpr })
    }
  } catch {
    // Redis down or no existing job — continue
  }

  if (!run.isActive) return

  // Add new repeatable job with cron pattern
  await scheduleQueue.add(
    key,
    {
      runId: run.id,
      name: run.name,
      prompt: run.prompt,
      notificationConfigId: run.notificationConfigId,
    },
    {
      repeat: { pattern: run.cronExpr, ...(run.timezone ? { tz: run.timezone } : {}) },
      jobId: undefined,
    },
  )
}

/**
 * Remove a scheduled run from BullMQ (on delete or deactivate).
 */
export async function removeSchedule(runId: string, cronExpr?: string): Promise<void> {
  const key = REPEAT_KEY(runId)
  try {
    if (cronExpr) {
      await scheduleQueue.removeRepeatable(key, { pattern: cronExpr })
    } else {
      // Fallback: find and remove by key
      const repeatableJobs = await scheduleQueue.getRepeatableJobs()
      const existing = repeatableJobs.find((j) => j.key === key || j.name === key)
      if (existing?.pattern) {
        await scheduleQueue.removeRepeatable(key, { pattern: existing.pattern })
      }
    }
  } catch {
    // Redis down or job doesn't exist — safe to ignore
  }
}

/**
 * Bootstrap: sync all active ScheduledRun rows to BullMQ on scheduler startup.
 * Call once when the worker process starts.
 */
export async function syncAllSchedules(): Promise<void> {
  const { db } = await import('./db')
  const runs = await db.scheduledRun.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      cronExpr: true,
      prompt: true,
      isActive: true,
      notificationConfigId: true,
      timezone: true,
    },
  })

  for (const run of runs) {
    try {
      await syncSchedule(run)
    } catch (e) {
      console.error(`[scheduler-queue] failed to sync "${run.name}":`, e)
    }
  }

  console.log(`[scheduler-queue] synced ${runs.length} active schedules to BullMQ`)
}

export type ScheduleJob = Job<ScheduleJobData>
