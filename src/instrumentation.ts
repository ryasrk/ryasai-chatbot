// ponytail: Next.js instrumentation hook — validates env on boot, starts the BullMQ worker,
// wires graceful shutdown (db + redis + MCP connections), and starts license revalidation.
// Guarded to nodejs runtime (Edge can't run BullMQ). Handlers register at module load.
export async function register() {
  // ponytail: positive guard (not an early return) so Turbopack dead-code-eliminates
  // this block from the Edge build, otherwise process.exit trips its Edge-runtime check.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // ponytail: E2E_TEST_MODE unlocks the localhost SSRF hatch for the prod-build
    // e2e suite (see playwright.prod.config.ts). It must NEVER be on in a customer
    // deployment: it disables the LLM/REST SSRF guard. The predicate lives in
    // env-schema.ts as a pure function so it can be unit-tested directly — a test
    // that re-derived the logic could drift from what actually runs at boot.
    const { shouldRefuseBootForTestMode, validateEnv } = await import('@/lib/env-schema')
    if (shouldRefuseBootForTestMode()) {
      console.error('='.repeat(68))
      console.error('[instrumentation] FATAL: E2E_TEST_MODE=true on what looks like a deployment.')
      console.error('E2E_TEST_MODE disables the SSRF guard and must never reach production.')
      console.error('Remove it from the deployment environment.')
      console.error('='.repeat(68))
      process.exit(1)
    }
    // ponytail: this catch MUST exit. It once logged-and-continued, letting a
    // prod container boot without required env and fail every request instead.
    try {
      validateEnv()
    } catch (e) {
      console.error('='.repeat(68))
      console.error('[instrumentation] FATAL: environment validation failed.')
      console.error(e instanceof Error ? e.message : e)
      console.error('Fix .env (see .env.example) and restart the server.')
      console.error('='.repeat(68))
      process.exit(1)
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
      console.log(`[instrumentation] Plugin auto-heal: found ${orgs.length} org(s)`)
      let seeded = 0
      for (const org of orgs) {
        const count = await bypassOrg(() => db.plugin.count({ where: { organizationId: org.id } }))
        if (count === 0) {
          console.log(`[instrumentation] Auto-seeding plugins for org ${org.id} (had 0 plugins)`)
          await bypassOrg(() => seedPlugins(org.id))
          seeded++
        } else {
          console.log(`[instrumentation] Org ${org.id} already has ${count} plugins, skipping`)
        }
      }
      console.log(`[instrumentation] Plugin auto-heal complete: seeded ${seeded} org(s)`)
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
}
