// ponytail: Next.js instrumentation hook — validates env on boot, starts the BullMQ worker,
// and wires graceful shutdown (db + redis + MCP connections).
// Guarded to nodejs runtime (Edge can't run BullMQ). Handlers register at module load.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { validateEnv } = await import('@/lib/env-schema')
  try {
    validateEnv()
  } catch (e) {
    console.error('[instrumentation] Env validation failed:', e instanceof Error ? e.message : e)
  }
  const { startJobWorker } = await import('@/lib/job-processor')
  const docWorker = startJobWorker()

  const { initOtel } = await import('@/lib/otel')
  await initOtel()

  const { setupGracefulShutdown } = await import('@/lib/graceful-shutdown')
  const { db } = await import('@/lib/db')
  const { disconnectRedis } = await import('@/lib/redis')
  const { disconnectAllMcp } = await import('@/lib/mcp-client')
  setupGracefulShutdown(undefined, [
    () => docWorker.close(),
    db.$disconnect,
    disconnectRedis,
    disconnectAllMcp,
  ])
}
