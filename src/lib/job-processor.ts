import { Worker, type Job } from 'bullmq'
import { redis, jobQueue, checkRedisHealth } from '@/lib/redis'
import { embedDocumentChunks, embedCompanyDocuments } from '@/lib/embeddings'
import { cognifyDocument } from '@/lib/cognee'
import { rebuildFts } from '@/lib/rag-fts'
import { db } from '@/lib/db'

export type JobType = 'document-embed' | 'document-cognify' | 'fts-rebuild' | 'embedding-rebuild'

export interface JobData {
  type: JobType
  documentId?: string
  [key: string]: unknown
}

type JobHandler = (data: JobData) => Promise<void>

const handlers: Partial<Record<JobType, JobHandler>> = {}

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
      await handler(job.data)
    },
    { connection: redis, concurrency: 3, lockDuration: 300_000, stalledInterval: 30_000, maxStalledCount: 1 },
  )
  worker.on('failed', (job, err) => console.error('[worker] job failed:', job?.data.type, err.message))
  return worker
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
  if (handler) await handler(data)
  else console.warn('[jobs] no handler for', type)
  return 'sync'
}
