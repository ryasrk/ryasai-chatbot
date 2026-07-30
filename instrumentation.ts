/**
 * Next.js instrumentation hook — runs once on server startup.
 * Delegates OTel SDK initialization to src/lib/otel.ts.
 * Wires graceful shutdown (SIGTERM/SIGINT) to close DB + Redis cleanly.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { initOtel } = await import('./src/lib/otel')
  await initOtel()

  const { setupGracefulShutdown } = await import('./src/lib/graceful-shutdown')
  const { db } = await import('./src/lib/db')
  const { disconnectRedis } = await import('./src/lib/redis')
  setupGracefulShutdown(undefined, [() => db.$disconnect(), disconnectRedis])
}
