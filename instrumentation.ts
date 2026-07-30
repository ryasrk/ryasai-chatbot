/**
 * Next.js instrumentation hook — runs once on server startup.
 * Delegates OTel SDK initialization to src/lib/otel.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { initOtel } = await import('./src/lib/otel')
  await initOtel()
}
