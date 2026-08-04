// ponytail: Next.js instrumentation hook — validates env on boot, starts the BullMQ worker,
// wires graceful shutdown (db + redis + MCP connections), and starts license revalidation.
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
  const { startLicenseRevalidation } = await import('@/lib/license-revalidation')
  const stopLicenseReval = startLicenseRevalidation()

  // ponytail: auto-heal — seed prebuilt plugins for any org that has none.
  // Existing orgs that completed setup before the plugin-seeding fix never
  // got their plugins. This runs once on boot and fills the gap idempotently.
  try {
    const { seedPlugins } = await import('@/lib/plugin-seeds')
    const { bypassOrg } = await import('@/lib/prisma-tenant')
    const orgs = await bypassOrg(() => db.organization.findMany({ select: { id: true } }))
    for (const org of orgs) {
      const count = await bypassOrg(() => db.plugin.count({ where: { organizationId: org.id } }))
      if (count === 0) {
        console.log(`[instrumentation] Auto-seeding plugins for org ${org.id} (had 0 plugins)`)
        await bypassOrg(() => seedPlugins(org.id))
      }
    }
  } catch (e) {
    console.warn('[instrumentation] Plugin auto-heal failed:', e instanceof Error ? e.message : e)
  }

  setupGracefulShutdown(undefined, [
    () => docWorker.close(),
    db.$disconnect,
    disconnectRedis,
    disconnectAllMcp,
    stopLicenseReval,
  ])
}
