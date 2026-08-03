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
 *
 * ponytail: BullMQ hashes the repeatable-job key from
 * `name:jobId:endDate:tz:pattern`, so removal must use the exact pattern AND
 * tz that were stored on add — otherwise the hash differs and removal silently
 * no-ops (orphaned jobs keep firing after cron changes / deactivate). We look
 * up the stored repeatable job before removing and mirror its pattern+tz.
 * This also matches legacy jobs created without a tz.
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
const DEFAULT_TZ = 'UTC'

/**
 * Find the stored repeatable job for a run (matched by job name = REPEAT_KEY).
 */
async function findRepeatableJob(runId: string) {
  const key = REPEAT_KEY(runId)
  const repeatableJobs = await scheduleQueue.getRepeatableJobs()
  return repeatableJobs.find((j) => j.name === key) ?? null
}

/**
 * Remove a run's repeatable job using the pattern+tz that were actually
 * stored at add time (fallback = caller's current cron/timezone). Matches the
 * exact key BullMQ computed on add, incl. legacy no-tz jobs.
 */
async function removeRepeatableFor(
  runId: string,
  fallback?: { pattern: string; timezone?: string | null },
): Promise<void> {
  const existing = await findRepeatableJob(runId)
  const pattern = existing?.pattern ?? fallback?.pattern
  if (!pattern) return
  const tz = existing?.tz ?? fallback?.timezone ?? null
  await scheduleQueue.removeRepeatable(REPEAT_KEY(runId), {
    pattern,
    ...(tz ? { tz } : {}),
  })
}

/**
 * Sync a ScheduledRun row to BullMQ as a repeatable job.
 * Call on create, update, or re-activate.
 *
 * Removes any existing repeatable job for the same run first (idempotent),
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
  const tz = run.timezone || DEFAULT_TZ

  // Remove existing repeatable job (idempotent — safe if none exists)
  try {
    await removeRepeatableFor(run.id, { pattern: run.cronExpr, timezone: run.timezone })
  } catch {
    // Redis down or no existing job — continue
  }

  if (!run.isActive) return

  // Add new repeatable job with cron pattern. tz is always stored (default
  // UTC) so add/remove hashes agree.
  await scheduleQueue.add(
    key,
    {
      runId: run.id,
      name: run.name,
      prompt: run.prompt,
      notificationConfigId: run.notificationConfigId,
    },
    {
      repeat: { pattern: run.cronExpr, tz },
      jobId: undefined,
    },
  )
}

/**
 * Remove a scheduled run from BullMQ (on delete or deactivate).
 * cronExpr/timezone are a fallback if the stored job is not found by name.
 */
export async function removeSchedule(runId: string, cronExpr?: string, timezone?: string | null): Promise<void> {
  try {
    await removeRepeatableFor(runId, cronExpr ? { pattern: cronExpr, timezone } : undefined)
  } catch {
    // Redis down or job doesn't exist — safe to ignore
  }
}

/**
 * Bootstrap/refresh: sync all active ScheduledRun rows to BullMQ.
 * Call on worker startup, and periodically (Redis restart recovery).
 *
 * ponytail: idempotent — repeated calls only re-add jobs that are missing or
 * whose pattern/tz changed, and prune repeatable jobs whose schedule no longer
 * exists. No remove/re-add churn for unchanged schedules.
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

  const repeatableJobs = await scheduleQueue.getRepeatableJobs()
  const activeKeys = new Set(runs.map((r) => REPEAT_KEY(r.id)))

  // Prune stale repeatable jobs (deleted/deactivated schedules).
  for (const j of repeatableJobs) {
    if (j.name && !activeKeys.has(j.name)) {
      try {
        await scheduleQueue.removeRepeatableByKey(j.key)
      } catch (e) {
        console.error(`[scheduler-queue] failed to prune stale job "${j.name}":`, e)
      }
    }
  }

  for (const run of runs) {
    try {
      const existing = repeatableJobs.find((j) => j.name === REPEAT_KEY(run.id))
      const needsSync =
        !existing ||
        existing.pattern !== run.cronExpr ||
        (existing.tz ?? '') !== (run.timezone ?? DEFAULT_TZ)
      if (needsSync) await syncSchedule(run)
    } catch (e) {
      console.error(`[scheduler-queue] failed to sync "${run.name}":`, e)
    }
  }

  console.log(`[scheduler-queue] synced ${runs.length} active schedules to BullMQ`)
}

export type ScheduleJob = Job<ScheduleJobData>
