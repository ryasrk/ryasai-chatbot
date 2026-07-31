/**
 * scheduler — BullMQ worker process (production-grade job scheduling)
 * ===========================================================================
 * Replaces the manual polling scheduler with a BullMQ Worker.
 *
 * Improvements over the old polling scheduler:
 * - Cron scheduling via BullMQ repeatable jobs (no manual nextRunAt calculation)
 * - Retry with exponential backoff (5s, 10s, 20s — built into queue config)
 * - Stalled job detection + automatic re-queue (built-in, no more double-execution)
 * - Distributed lock via Redis atomic ops (safe across multiple worker processes)
 * - No more catch-up storms, no more stale runs, no more grace window hacks
 *
 * Start: `bun run mini-services/scheduler/index.ts`
 *
 * Imports parent libs via RELATIVE paths (the mini-service is a separate
 * process with its own PrismaClient connection — same pattern as chat-service).
 */
import { Worker } from 'bullmq'
import IORedis from 'ioredis'

// ponytail: disable cognee in the scheduler worker — ladybugdb graph database
// uses file-level locking and can't be shared across processes. The dev server
// already holds the lock. Cognee memory recall is not needed for scheduled prompts.
process.env.COGNEE_ENABLED = 'false'

import { db } from '../../src/lib/db'
import { runNonStreamingChatCompletion } from '../../src/lib/tool-router'
import { sendNotificationWithRetry, type NotificationResult } from '../../src/lib/notifications'
import { serverConfig } from '../../src/lib/config'
import { syncAllSchedules, type ScheduleJobData } from '../../src/lib/scheduler-queue'

const RUN_TIMEOUT_MS = 60_000
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

let lastCleanupDay = ''

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
// Runs once per day at the first poll after midnight (cron equivalent: 0 0 * * *).
// ---------------------------------------------------------------------------

async function cleanupOldLogs(): Promise<void> {
  const days = serverConfig.logRetentionDays
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const names = [
    'AuditLog',
    'ApiRequestLog',
    'RestApiRequestLog',
    'ToolRun',
    'QueryHistory',
    'LlmUsageLog',
    'AgentRun',
  ]
  try {
    const result = await Promise.allSettled([
      db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.apiRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.restApiRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.toolRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.queryHistory.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.llmUsageLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      db.agentRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ])
    for (let i = 0; i < result.length; i++) {
      const r = result[i]
      if (r.status === 'fulfilled' && r.value.count > 0)
        console.log(`[scheduler] cleanup ${names[i]}: ${r.value.count} rows (>${days}d)`)
    }
  } catch (e) {
    console.warn('[scheduler] Log cleanup failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Job processor — executes a single scheduled run
// ---------------------------------------------------------------------------

async function processJob(job: { data: ScheduleJobData }): Promise<void> {
  const { runId, name, prompt, notificationConfigId } = job.data
  const now = new Date()
  console.log(`[scheduler] executing "${name}"`)

  const admin = await db.user.findFirst({
    where: { isActive: true },
    select: { id: true },
  })
  const userId = admin?.id ?? 'system'

  let resultSummary: string = ''
  let success = false
  let lastError: string | null = null

  try {
    // Autonomy directive — scheduled runs are unattended, so the LLM
    // must make reasonable assumptions instead of asking clarifying questions.
    // Passed as systemPromptPrefix (not in the question) so it doesn't confuse
    // the intent analyzer.
    const autonomyPrefix = `This is an automated scheduled execution. No human is available to answer questions. Make reasonable assumptions, use the current date (${now.toISOString().split('T')[0]} UTC), pick the most relevant data source automatically, and provide the answer directly. Do NOT ask clarifying questions.`

    const result = await withTimeout(
      runNonStreamingChatCompletion({
        question: prompt,
        userId,
        skipClarification: true,
        systemPromptPrefix: autonomyPrefix,
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
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error(`[scheduler] run "${name}" failed:`, lastError)
    resultSummary = JSON.stringify({
      error: lastError,
      timestamp: now.toISOString(),
    })
    // Record failure to DB + send notification BEFORE throwing to BullMQ.
    // Without this, failed runs leave zero trace and users are never alerted.
    success = false
  }

  // If a notification channel is attached, deliver success or failure
  // notification. This runs for BOTH success and failure paths.
  let notification: NotificationResult | null = null
  if (notificationConfigId) {
    try {
      const cfg = await db.notificationConfig.findFirst({
        where: { id: notificationConfigId },
        select: { id: true, encryptedConfig: true, isActive: true },
      })
      if (cfg?.isActive) {
        if (success) {
          let answer = ''
          try {
            answer = (JSON.parse(resultSummary).answer as string) ?? ''
          } catch {
            answer = ''
          }
          notification = await sendNotificationWithRetry({
            configEncrypted: cfg.encryptedConfig,
            message: answer || prompt,
            title: name,
          })
        } else if (lastError) {
          notification = await sendNotificationWithRetry({
            configEncrypted: cfg.encryptedConfig,
            message: `Scheduled run "${name}" failed: ${lastError}`,
            title: name,
          })
        }
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

  // Always update lastRunAt + lastResult — even on error.
  try {
    await db.scheduledRun.update({
      where: { id: runId },
      data: {
        lastRunAt: now,
        lastResult: resultSummary,
      },
    })
  } catch (e) {
    console.error(`[scheduler] failed to update run "${name}":`, e)
  }

  // Persist execution log — full answer + tool runs for history + export.
  try {
    let answer: string | null = null
    let error: string | null = null
    let toolRunsJson: string | null = null
    try {
      const parsed = JSON.parse(resultSummary) as Record<string, unknown>
      answer = typeof parsed.answer === 'string' ? parsed.answer : null
      error = typeof parsed.error === 'string' ? parsed.error : null
      if (Array.isArray(parsed.toolRuns)) {
        toolRunsJson = JSON.stringify(parsed.toolRuns)
      }
    } catch {}
    await db.scheduledRunLog.create({
      data: {
        scheduledRunId: runId,
        status: success ? 'success' : 'error',
        answer,
        error,
        toolRunsJson,
        latencyMs: Date.now() - now.getTime(),
      },
    })
  } catch (e) {
    console.error(`[scheduler] failed to log execution for "${name}":`, e)
  }

  // Audit log — best-effort, never blocks.
  try {
    await db.auditLog.create({
      data: {
        userId: null,
        action: 'SCHEDULED_RUN',
        severity: 'info',
        detail: JSON.stringify({
          id: runId,
          name,
          success,
          notification: notification
            ? { ok: notification.ok, error: notification.error ?? null }
            : null,
        }),
      },
    })
  } catch (e) {
    console.error('[scheduler] audit log failed:', e)
  }

  console.log(`[scheduler] completed "${name}"`)
}

// ---------------------------------------------------------------------------
// Bootstrap + worker
// ---------------------------------------------------------------------------

const workerConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})
workerConnection.on('error', () => {})

let _worker: Worker<ScheduleJobData> | null = null

async function bootstrap(): Promise<void> {
  console.log('[scheduler] starting BullMQ worker...')

  try {
    await syncAllSchedules()
  } catch (e) {
    console.warn('[scheduler] failed to sync schedules on startup (non-fatal):', e)
  }

  _worker = new Worker<ScheduleJobData>(
    'scheduled-runs',
    async (job) => {
      const now = new Date()
      const today = now.toDateString()
      if (today !== lastCleanupDay) {
        lastCleanupDay = today
        void cleanupOldLogs()
      }
      await processJob(job)
    },
    {
      connection: workerConnection,
      concurrency: 5,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  )

  _worker.on('completed', (job) => {
    console.log(`[scheduler] job ${job.id} (${job.data.name}) completed`)
  })

  _worker.on('failed', (job, err) => {
    console.error(`[scheduler] job ${job?.id ?? 'unknown'} (${job?.data.name ?? 'unknown'}) failed: ${err.message}`)
  })

  _worker.on('stalled', (jobId) => {
    console.warn(`[scheduler] job ${jobId} stalled — will be re-queued automatically`)
  })

  _worker.on('error', (err) => {
    console.error('[scheduler] worker error:', err)
  })

  console.log('[scheduler] BullMQ worker ready — waiting for scheduled jobs')
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`[scheduler] received ${signal}, shutting down...`)
  // Close the worker first — waits for in-flight jobs to finish (bounded by lockDuration)
  if (_worker) {
    try {
      await _worker.close()
    } catch (e) {
      console.error('[scheduler] worker.close() error:', e)
    }
  }
  try {
    await workerConnection.quit()
  } catch {
    // best-effort
  }
  console.log('[scheduler] stopped')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

void bootstrap()
