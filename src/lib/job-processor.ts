import { Worker, type Job } from 'bullmq'
import { redis, jobQueue, checkRedisHealth } from '@/lib/redis'
import { embedDocumentChunks, embedCompanyDocuments } from '@/lib/embeddings'
import { cognifyDocument } from '@/lib/cognee'
import { rebuildFts } from '@/lib/rag-fts'
import {
  issueLicenseForOrder,
  LICENSE_ISSUE_BACKOFF_TYPE,
  licenseIssueBackoffDelayMs,
} from '@/lib/license-issue'
import {
  runOrderReconciliation,
  ORDER_RECONCILE_JOB_NAME,
  ORDER_RECONCILE_CRON,
} from '@/lib/order-reconcile'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

export type JobType =
  | 'document-embed'
  | 'document-cognify'
  | 'fts-rebuild'
  | 'embedding-rebuild'
  | 'license-issue'
  | 'order-reconcile'

export interface JobData {
  type: JobType
  documentId?: string
  organizationId?: string
  [key: string]: unknown
}

type JobHandler = (data: JobData) => Promise<void>

const handlers: Partial<Record<JobType, JobHandler>> = {}

// ponytail: BullMQ workers run outside request AsyncLocalStorage, so org context is
// empty there — every Prisma query would be globally unscoped (cross-org quota/embed
// blowups). Enter the job's org before any DB work, mirroring mini-services/scheduler.
// Falls back to resolving the org from the document so jobs enqueued before this fix
// (which lack organizationId in their payload) stay scoped too.
async function resolveJobOrg(data: JobData): Promise<string | undefined> {
  if (data.organizationId) return data.organizationId
  if (!data.documentId) return undefined
  const doc = await bypassOrg(() =>
    db.document.findUnique({
      where: { id: data.documentId },
      select: { organizationId: true },
    }),
  )
  return doc?.organizationId ?? undefined
}

/**
 * Enter the job's org and run `fn` inside it.
 *
 * BUG (found by measurement; the MEASURED cause is narrower than it first looked). The previous
 * code entered the org from inside `enterJobOrg`, i.e. AFTER `await bypassOrg(...)`. `bypassOrg`
 * is `orgStorage.run(undefined, fn)`, and an inner `run()` RESTORES the outer store when its
 * callback settles, so an `enterWith` issued after that await lands in a context that the caller
 * never observes. Measured against the original code:
 *   - payload path (`data.organizationId`, enter BEFORE any await) -> handler saw the org  OK
 *   - document-fallback path (enter AFTER `await bypassOrg`)       -> handler saw `undefined`  BROKEN
 * So a job enqueued without `organizationId` ran with NO org context at all -- exactly the
 * unscoped-query incident the comment above claims to prevent -- while the payload path, and
 * therefore every test anyone had written, looked fine.
 *
 * I initially blamed `enterWith` after ANY await. A direct probe disproved that: a plain
 * `await Promise.resolve()` before `enterWith` DOES propagate, in the same frame and through
 * `return fn()`. The offender is specifically the `run()`-scoped callback in `bypassOrg`
 * restoring its parent context. The fix is the same either way and does not depend on which
 * reading is right: return the org and let the CALLER -- the frame the handler actually runs in
 * -- enter it synchronously before awaiting anything.
 */
async function runWithJobOrg<T>(data: JobData, fn: () => Promise<T>): Promise<T> {
  const orgId = await resolveJobOrg(data)
  // Synchronous enter in the CALLER's frame, before the handler is awaited.
  if (orgId) enterWithOrg(orgId)
  return fn()
}

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers[type] = handler
}

// ponytail: default handlers registered at module load — wired to existing lib functions.

registerJobHandler('document-embed', async (data) => {
  if (!data.documentId) return
  await embedDocumentChunks({ documentId: data.documentId })
})

registerJobHandler('document-cognify', async (data) => {
  if (!data.documentId) return
  // findFirst, NOT findUnique. This handler runs inside `runWithJobOrg`, so the org IS entered before it is
  // reached and an unscoped read would today return this tenant's row -- but that is a property of the CALLER, not
  // of this line, and the two cross-tenant IDORs found this round were both exactly that mistake (an unscoped read
  // whose safety depended on a caller doing the right thing). With a FILTER op the extension appends the org
  // unconditionally, so the safety no longer relies on the wiring above staying correct.
  const doc = await db.document.findFirst({
    where: { id: data.documentId },
    select: { id: true, name: true },
  })
  if (!doc) return
  const chunks = await db.documentChunk.findMany({
    where: { documentId: doc.id },
    select: { content: true, chunkIndex: true },
    orderBy: { chunkIndex: 'asc' },
  })
  await cognifyDocument({ documentId: doc.id, documentName: doc.name, chunks })
})

registerJobHandler('fts-rebuild', async () => {
  await rebuildFts()
})

registerJobHandler('embedding-rebuild', async (data) => {
  await embedCompanyDocuments({ documentId: data.documentId })
})

// ponytail: bounded retry for license issuance after a settled QRIS order.
// Money state is already safe (order settled) — throwing here only triggers
// BullMQ's attempts/backoff so the validator gets re-polled.
registerJobHandler('license-issue', async (data) => {
  const orderId = data.orderId as string | undefined
  if (!orderId) return
  const outcome = await issueLicenseForOrder(orderId)
  if (!outcome.ok) throw new Error(`license-issue retry needed for order ${orderId}: ${outcome.reason}`)
})

// ponytail: hourly safety net — settled orders whose license never got issued
// (crash between the 200-to-Midtrans and the retry enqueue, or exhausted
// retries during a validator outage). issueLicenseForOrder is idempotent.
registerJobHandler('order-reconcile', async () => {
  await runOrderReconciliation()
})

let worker: Worker<JobData> | null = null

/**
 * ponytail: ensure the hourly 'order-reconcile' repeatable job exists (and
 * matches the current pattern). Repeatable jobs live only in Redis, so
 * re-ensuring on every worker boot heals a Redis restart — same pattern as
 * ensureLicenseReminderRepeatable in scheduler-queue.ts.
 */
async function ensureOrderReconcileRepeatable(): Promise<void> {
  const jobs = await jobQueue.getRepeatableJobs()
  const existing = jobs.find((j) => j.name === ORDER_RECONCILE_JOB_NAME)
  if (existing?.pattern === ORDER_RECONCILE_CRON) return
  if (existing?.pattern) {
    await jobQueue.removeRepeatable(ORDER_RECONCILE_JOB_NAME, {
      pattern: existing.pattern,
      ...(existing.tz ? { tz: existing.tz } : {}),
    })
  }
  // No payload — the handler ignores job data entirely. Cast keeps the
  // Queue<JobData> generic intact.
  await jobQueue.add(
    ORDER_RECONCILE_JOB_NAME,
    { type: 'order-reconcile' },
    { repeat: { pattern: ORDER_RECONCILE_CRON } },
  )
}

// ponytail: start worker once on server boot (via instrumentation.ts).
// BullMQ auto-reconnects when Redis comes up, so starting without Redis is safe.
/**
 * Test seam: drop the cached worker so `startJobWorker()` can be exercised again in the same
 * process. The real singleton behaviour is what the idempotency test pins, and a module-level
 * cache cannot be cleared from outside without this. Mirrors `resetJwksCache` /
 * `resetEnsuredCollections` elsewhere in the repo.
 */
export function resetJobWorkerForTest(): void {
  worker = null
}

export function startJobWorker(): Worker<JobData> {
  if (worker) return worker
  worker = new Worker<JobData>(
    'document-processing',
    async (job: Job<JobData>) => {
      const handler = handlers[job.data.type]
      if (!handler) throw new Error(`No handler for job type: ${job.data.type}`)
      await runWithJobOrg(job.data, () => handler(job.data))
    },
    {
      connection: redis,
      concurrency: 3,
      lockDuration: 300_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
      // Custom capped exponential backoff for license-issue retries
      // (30s → ~15min over 10 attempts). Other types use their own declared
      // backoff; this strategy is only consulted for LICENSE_ISSUE_BACKOFF_TYPE.
      settings: {
        backoffStrategy: (attemptsMade, type) =>
          type === LICENSE_ISSUE_BACKOFF_TYPE ? licenseIssueBackoffDelayMs(attemptsMade) : 30_000,
      },
    },
  )
  worker.on('failed', (job, err) => console.error('[worker] job failed:', job?.data.type, err.message))
  // Ensure the reconciliation repeatable AFTER the worker exists so an hourly
  // tick always has a consumer. Non-fatal when Redis is briefly down.
  void ensureOrderReconcileRepeatable().catch((e) =>
    console.warn('[worker] failed to ensure order-reconcile repeatable:', e),
  )
  // Startup diagnostics — NOT a recovery mechanism. See the doc comment on
  // `reportQueuedJobsOnStartup` for what actually recovers orphaned jobs (the worker's own
  // stalled checker, plus a live worker for `wait`) and why a queue inspected while the app
  // is down still shows orphans.
  void reportQueuedJobsOnStartup().catch(() => null)
  return worker
}

/** Log the queue depth the moment a worker first attaches — makes backlog visible. */
/**
 * Report what is already waiting, so a restart is visible in the logs.
 *
 * RENAMED FROM `adoptStuckJobs`, which promised something it did not do. It never adopted
 * anything: it counted `wait` and logged. That is worth keeping (a restart with a backlog
 * should say so), but a function named "adopt" that only reports is how a real gap stays
 * invisible — a reader assumes orphaned jobs are handled because a function says so.
 *
 * WHAT ACTUALLY RECOVERS ORPHANED JOBS, and why nothing is adopted here:
 *
 * - `wait` jobs need no help. A live worker picks them up; this only reports the backlog.
 * - `active` jobs orphaned by a killed process are recovered by BullMQ's own stalled
 *   checker, which the worker is configured with (`stalledInterval: 30_000`,
 *   `maxStalledCount: 1`). The checker runs INSIDE a live worker, so it only fires once a
 *   worker exists — which is why a queue inspected while the app is down still shows them.
 *   MEASURED: 9 such jobs sat on `active` with the app stopped, and the documents from that
 *   same run were fully embedded (e2e-answer.txt 2/2 chunks, the others 1/1).
 *
 * So this is diagnostics, and it is named and documented as such rather than left looking
 * like a recovery mechanism.
 */
async function reportQueuedJobsOnStartup(): Promise<void> {
  try {
    const health = await checkRedisHealth()
    if (!health.connected) {
      console.warn('[worker] Redis not reachable — queued jobs will wait until it is.')
      return
    }
    const waiting = await redis.llen('bull:document-processing:wait')
    if (waiting > 0) {
      console.log(`[worker] ${waiting} document job(s) already queued; a live worker will pick them up.`)
    }
  } catch {
    // diagnostics only — never block worker startup
  }
}

// ponytail: enqueue to Redis when available, run handler synchronously when Redis is down.
// This is the graceful-degradation strategy: no Redis = sync fallback (slower but works).
// Document jobs get bounded retries with exponential backoff — without this a
// transient embedding-provider 429/5xx permanently failed the job after one try.
const DOCUMENT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
}

export async function enqueueOrSync(type: JobType, data: JobData): Promise<'queued' | 'sync'> {
  const health = await checkRedisHealth()
  if (health.connected) {
    await jobQueue.add(type, data, DOCUMENT_JOB_OPTS)
    return 'queued'
  }
  const handler = handlers[type]
  if (handler) {
    await runWithJobOrg(data, () => handler(data))
  } else console.warn('[jobs] no handler for', type)
  return 'sync'
}
