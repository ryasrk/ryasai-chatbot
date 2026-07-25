/**
 * scheduler — background worker that executes due scheduled runs (spec S5)
 * ===========================================================================
 * Independent Bun process (no HTTP port). Polls every N seconds for
 * ScheduledRun rows where isActive=true and nextRunAt <= now, executes the
 * prompt via the tool-router, and records the result.
 *
 * Start: `bun run mini-services/scheduler/index.ts`
 * Env:   SCHEDULER_POLL_INTERVAL_SEC (default 60)
 *
 * Imports parent libs via RELATIVE paths (the mini-service is a separate
 * process with its own PrismaClient connection — same pattern as chat-service).
 */
import { db } from '../../src/lib/db'
import { nextRun } from '../../src/lib/cron'
import { runNonStreamingChatCompletion } from '../../src/lib/tool-router'
import { sendNotification, type NotificationResult } from '../../src/lib/notifications'
import { serverConfig } from '../../src/lib/config'

const POLL_INTERVAL_SEC =
  Number.parseInt(process.env.SCHEDULER_POLL_INTERVAL_SEC ?? '60', 10) || 60

const RUN_TIMEOUT_MS = 60_000

let running = true
let pollCount = 0

// ---------------------------------------------------------------------------
// Timeout helper — races a promise against a timer, clears the timer on
// settle so the event loop doesn't hold lingering handles.
// ---------------------------------------------------------------------------

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(msg)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

// ---------------------------------------------------------------------------
// Log retention — prune observability tables older than LOG_RETENTION_DAYS.
// Runs once on startup (first poll) and every 24 polls thereafter.
// ---------------------------------------------------------------------------

async function cleanupOldLogs(): Promise<void> {
  const days = serverConfig.logRetentionDays
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  try {
    const result = await Promise.allSettled([
      db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.apiRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.restApiRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.toolRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.queryHistory.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.agentRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ])
    const totalDeleted = result.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value.count : 0),
      0,
    )
    if (totalDeleted > 0)
      console.log(`[scheduler] Cleaned up ${totalDeleted} old log rows (>${days}d)`)
  } catch (e) {
    console.warn('[scheduler] Log cleanup failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  if (pollCount % 24 === 0) await cleanupOldLogs()
  pollCount++
  const now = new Date()

  // 1) Execute runs that are due (nextRunAt <= now).
  let due: Awaited<ReturnType<typeof db.scheduledRun.findMany>>
  try {
    due = await db.scheduledRun.findMany({
      where: { isActive: true, nextRunAt: { lte: now } },
    })
  } catch (e) {
    console.error('[scheduler] failed to query due runs:', e)
    return
  }

  await Promise.allSettled(due.map((run) => executeRun(run)))

  if (!running) return

  // 2) Fix runs with null nextRunAt — compute and set without executing.
  //    This handles schedules created before the scheduler was running, or
  //    ones that lost their nextRunAt due to an error.
  let unscheduled: Awaited<ReturnType<typeof db.scheduledRun.findMany>>
  try {
    unscheduled = await db.scheduledRun.findMany({
      where: { isActive: true, nextRunAt: null },
    })
  } catch (e) {
    console.error('[scheduler] failed to query unscheduled runs:', e)
    return
  }

  for (const run of unscheduled) {
    const next = nextRun(run.cronExpr, now)
    try {
      await db.scheduledRun.update({
        where: { id: run.id },
        data: { nextRunAt: next },
      })
      console.log(
        `[scheduler] set nextRunAt for "${run.name}" → ${next?.toISOString() ?? 'null'}`,
      )
    } catch (e) {
      console.error(`[scheduler] failed to set nextRunAt for "${run.name}":`, e)
    }
  }
}

// ---------------------------------------------------------------------------
// Execute a single scheduled run
// ---------------------------------------------------------------------------

async function executeRun(run: {
  id: string
  name: string
  cronExpr: string
  prompt: string
  nextRunAt: Date | null
  notificationConfigId: string | null
}): Promise<void> {
  // ponytail: optimistic lock — only claim if nextRunAt hasn't changed since
  // findMany. Prevents double execution across scheduler processes. If claim
  // fails (count=0), another process already took it — skip.
  const claim = await db.scheduledRun.updateMany({
    where: { id: run.id, nextRunAt: run.nextRunAt },
    data: { nextRunAt: null },
  })
  if (claim.count === 0) return

  const now = new Date()
  console.log(`[scheduler] executing "${run.name}"`)

  const admin = await db.user.findFirst({
    where: { isActive: true },
    select: { id: true },
  })
  const userId = admin?.id ?? 'system'

  let resultSummary: string = ''
  let success = false
  let lastError: string | null = null

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withTimeout(
        runNonStreamingChatCompletion({
          question: run.prompt,
          userId,
        }),
        RUN_TIMEOUT_MS,
        'Scheduled run timeout (60s)',
      )

      success = true
      resultSummary = JSON.stringify({
        answer: result.answer,
        answerTruncated: result.answer.length > 8000,
        toolRuns: result.toolRuns,
        timestamp: now.toISOString(),
      })

      for (const tr of result.toolRuns) {
        void db.toolRun
          .create({
            data: {
              restApiEndpointId: tr.restApiEndpointId ?? null,
              type: tr.type,
              status: tr.status,
              latencyMs: tr.latencyMs ?? null,
              inputSummary: tr.inputSummary,
              outputSummary: tr.outputSummary ?? null,
              errorMessage: tr.errorMessage ?? null,
            },
          })
          .catch(() => {})
      }
      lastError = null
      break
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt === 0) {
        console.warn(`[scheduler] run "${run.name}" attempt 1 failed, retrying:`, lastError)
        continue
      }
      console.error(`[scheduler] run "${run.name}" failed after retry:`, lastError)
    }
  }

  if (!success && lastError) {
    resultSummary = JSON.stringify({
      error: lastError,
      timestamp: now.toISOString(),
    })
  }

  // If a notification channel is attached and the run produced an answer,
  // deliver it. Failures are recorded into lastResult but never abort the run.
  let notification: NotificationResult | null = null
  if (success && run.notificationConfigId) {
    try {
      const cfg = await db.notificationConfig.findFirst({
        where: { id: run.notificationConfigId },
        select: { id: true, encryptedConfig: true, isActive: true },
      })
      if (cfg?.isActive) {
        // resultSummary is a JSON string with {answer, ...}; pull answer out.
        let answer = ''
        try {
          answer = (JSON.parse(resultSummary).answer as string) ?? ''
        } catch {
          answer = ''
        }
        notification = await sendNotification({
          configEncrypted: cfg.encryptedConfig,
          message: answer || run.prompt,
          title: run.name,
        })
        // Stamp lastUsedAt best-effort.
        void db.notificationConfig
          .update({ where: { id: cfg.id }, data: { lastUsedAt: new Date() } })
          .catch(() => {})
      }
    } catch (e) {
      notification = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: 0,
      }
    }
    // Fold the notification outcome into lastResult.
    try {
      const parsed = JSON.parse(resultSummary) as Record<string, unknown>
      parsed.notification = notification
      resultSummary = JSON.stringify(parsed)
    } catch {
      // resultSummary wasn't JSON (error path) — leave as-is.
    }
  }

  // Always update lastRunAt, lastResult, and nextRunAt — even on error.
  const next = nextRun(run.cronExpr, now)
  try {
    await db.scheduledRun.update({
      where: { id: run.id },
      data: {
        lastRunAt: now,
        lastResult: resultSummary,
        nextRunAt: next,
      },
    })
  } catch (e) {
    console.error(`[scheduler] failed to update run "${run.name}":`, e)
    return
  }

  console.log(
    `[scheduler] completed "${run.name}" → next at ${next?.toISOString() ?? 'null'}`,
  )

  // Audit log — best-effort, never blocks.
  try {
    await db.auditLog.create({
      data: {
        userId: null,
        action: 'SCHEDULED_RUN',
        severity: 'info',
        detail: JSON.stringify({
          id: run.id,
          name: run.name,
          success,
          nextRunAt: next?.toISOString() ?? null,
          notification: notification
            ? { ok: notification.ok, error: notification.error ?? null }
            : null,
        }),
      },
    })
  } catch (e) {
    console.error('[scheduler] audit log failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Bootstrap + graceful shutdown
// ---------------------------------------------------------------------------

console.log(`[scheduler] polling every ${POLL_INTERVAL_SEC}s`)

// ponytail: polling flag prevents overlap — if a poll takes longer than the
// interval, the next tick is skipped instead of stacking.
let polling = false

async function guardedPoll(): Promise<void> {
  if (!running || polling) return
  polling = true
  try {
    await poll()
  } finally {
    polling = false
  }
}

// Run once immediately on startup, then on the interval.
void guardedPoll()
const timer = setInterval(() => void guardedPoll(), POLL_INTERVAL_SEC * 1000)

function shutdown(signal: string) {
  console.log(`[scheduler] received ${signal}, shutting down...`)
  running = false
  clearInterval(timer)
  // Give any in-flight run a moment to finish writing its result.
  setTimeout(() => {
    console.log('[scheduler] stopped')
    process.exit(0)
  }, 2000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
