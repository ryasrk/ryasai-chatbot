import { Worker, type Job } from 'bullmq'
import { redis, jobQueue, checkRedisHealth } from '@/lib/redis'
import { embedDocumentChunks, embedCompanyDocuments } from '@/lib/embeddings'
import { cognifyDocument } from '@/lib/cognee'
import { rebuildFts } from '@/lib/rag-fts'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

export type JobType = 'document-embed' | 'document-cognify' | 'fts-rebuild' | 'embedding-rebuild'

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

let worker: Worker<JobData> | null = null

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
    { connection: redis, concurrency: 3, lockDuration: 300_000, stalledInterval: 30_000, maxStalledCount: 1 },
  )
  worker.on('failed', (job, err) => console.error('[worker] job failed:', job?.data.type, err.message))
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
export async function enqueueOrSync(type: JobType, data: JobData): Promise<'queued' | 'sync'> {
  const health = await checkRedisHealth()
  if (health.connected) {
    await jobQueue.add(type, data)
    return 'queued'
  }
  const handler = handlers[type]
  if (handler) {
    await enterJobOrg(data)
    await handler(data)
  } else console.warn('[jobs] no handler for', type)
  return 'sync'
}
