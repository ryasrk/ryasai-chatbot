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
async function enterJobOrg(data: JobData): Promise<void> {
  if (data.organizationId) {
    enterWithOrg(data.organizationId)
    return
  }
  if (!data.documentId) return
  const doc = await bypassOrg(() =>
    db.document.findUnique({
      where: { id: data.documentId },
      select: { organizationId: true },
    }),
  )
  if (doc?.organizationId) enterWithOrg(doc.organizationId)
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
  const doc = await db.document.findUnique({
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
export function startJobWorker(): Worker<JobData> {
  if (worker) return worker
  worker = new Worker<JobData>(
    'document-processing',
    async (job: Job<JobData>) => {
      const handler = handlers[job.data.type]
      if (!handler) throw new Error(`No handler for job type: ${job.data.type}`)
      await enterJobOrg(job.data)
      await handler(job.data)
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
  // ponytail: orphaned-job recovery. If the app crashes/redeploys mid-job the
  // job stays on the `active` list holding a stale lock; BullMQ's stalled
  // checker re-queues it, but jobs enqueued by a process whose worker never
  // started (the duplicated-root-instrumentation bug) sit on `wait` forever
  // with zero attempts — `wait`-side jobs are picked up automatically once a
  // live worker exists, so this only needs to log what we adopted.
  void adoptStuckJobs().catch(() => null)
  return worker
}

/** Log the queue depth the moment a worker first attaches — makes backlog visible. */
async function adoptStuckJobs(): Promise<void> {
  try {
    const health = await checkRedisHealth()
    if (!health.connected) {
      console.warn('[worker] Redis not reachable — queued jobs will wait until it is.')
      return
    }
    const waiting = await redis.llen('bull:document-processing:wait')
    if (waiting > 0) {
      console.log(`[worker] Adopting ${waiting} queued document job(s) from a previous run.`)
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
    await enterJobOrg(data)
    await handler(data)
  } else console.warn('[jobs] no handler for', type)
  return 'sync'
}
