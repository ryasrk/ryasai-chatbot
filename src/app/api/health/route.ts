import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkRedisHealth } from '@/lib/redis'
import { publicConfig } from '@/lib/public-config'

/**
 * GET /api/health — detailed health check for orchestrators (k8s, Docker, Caddy).
 * Checks: DB connectivity (Prisma), Redis connectivity (optional, degrades gracefully).
 * Returns 200 when healthy, 503 when any critical component is down.
 *
 * For a lightweight liveness probe (no DB hit), use /api/v1/health instead.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {}
  let allOk = true

  // DB check — critical. A single count query is the cheapest connectivity test.
  try {
    const start = Date.now()
    await db.document.count()
    checks.db = { ok: true, latencyMs: Date.now() - start }
  } catch (e) {
    allOk = false
    checks.db = { ok: false, error: e instanceof Error ? e.message : 'DB query failed' }
  }

  // Redis check — optional. App works without Redis (graceful degradation).
  try {
    const redis = await checkRedisHealth()
    checks.redis = {
      ok: redis.connected,
      latencyMs: redis.latencyMs,
      ...(redis.connected ? {} : { error: 'Redis not connected (optional — app degrades gracefully)' }),
    }
  } catch (e) {
    checks.redis = { ok: false, error: e instanceof Error ? e.message : 'Redis check failed' }
  }

  return NextResponse.json(
    {
      ok: allOk,
      service: 'ryasai',
      version: publicConfig.appVersion,
      time: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  )
}
