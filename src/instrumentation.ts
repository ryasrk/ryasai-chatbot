// ponytail: Next.js instrumentation hook — starts the BullMQ worker on server boot.
// Guarded to nodejs runtime (Edge can't run BullMQ). Handlers register at module load.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startJobWorker } = await import('@/lib/job-processor')
  startJobWorker()
}
