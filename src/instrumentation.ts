// ponytail: Next.js instrumentation hook — validates env on boot, starts the BullMQ worker.
// Guarded to nodejs runtime (Edge can't run BullMQ). Handlers register at module load.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { validateEnv } = await import('@/lib/env-schema')
  try {
    validateEnv()
  } catch (e) {
    console.error('[instrumentation] Env validation failed:', e instanceof Error ? e.message : e)
    // ponytail: don't crash in production — log loudly and continue. App will fail-closed at use sites.
  }
  const { startJobWorker } = await import('@/lib/job-processor')
  startJobWorker()
}
