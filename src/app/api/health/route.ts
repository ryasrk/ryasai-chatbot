import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkRedisHealth } from '@/lib/redis'
import { publicConfig } from '@/lib/public-config'
import { aggregateHealth, sanitizeHealthError, type CheckStatus } from '@/lib/health-status'
import { validatorUrl } from '@/lib/license-client'

/**
 * GET /api/health — detailed health check for orchestrators (k8s, Docker, Caddy).
 * Checks: DB connectivity (Prisma), Redis connectivity (optional, degrades
 * gracefully), License-Validator reachability (informational probe).
 * Returns 200 when healthy (DB up), 503 only when a CRITICAL component is down.
 *
 * ponytail: PUBLIC (middleware allow-list). Error strings are truncated and
 * generic — this endpoint is unauthenticated, so raw driver errors (which
 * embed hosts, SQL, file paths) must not leak to anonymous callers.
 *
 * ponytail: NO Midtrans probe on purpose — Snap has no cheap unauthenticated
 * GET endpoint; a POST-based probe would consume rate limits / create noise
 * against the payment gateway. Midtrans health is implied by checkout failures
 * surfacing in billing logs instead.
 *
 * For a lightweight liveness probe (no DB hit), use /api/v1/health instead.
 */
export async function GET() {
  const checks: Record<string, CheckStatus> = {}

  // DB check — critical. A single count query is the cheapest connectivity test.
  try {
    const start = Date.now()
    await db.document.count()
    checks.db = { ok: true, latencyMs: Date.now() - start }
  } catch (e) {
    checks.db = { ok: false, error: sanitizeHealthError(e, 'DB query failed') }
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
    checks.redis = { ok: false, error: sanitizeHealthError(e, 'Redis check failed') }
  }

  // License-Validator probe — informational ONLY (never flips ok→503).
  // Probed only when explicitly configured so dev machines without the
  // validator don't log a guaranteed failure every scrape interval.
  checks.validator = await probeLicenseValidator()

  const { ok, degraded } = aggregateHealth(checks)
  return NextResponse.json(
    {
      ok,
      ...(degraded.length > 0 ? { degraded } : {}),
      service: 'ryasai',
      version: publicConfig.appVersion,
      time: new Date().toISOString(),
      checks,
    },
    { status: ok ? 200 : 503 },
  )
}

/**
 * Probe the License-Validator with a short timeout. Tries /health first
 * (FastAPI convention), falls back to / if that 404s. Any failure is reported
 * as a sanitized non-ok status — never thrown.
 */
async function probeLicenseValidator(): Promise<CheckStatus> {
  const base = validatorUrl()
  if (!base) {
    return { ok: false, error: 'License validator not configured (license validation disabled)' }
  }
  const start = Date.now()
  for (const path of ['/health', '/']) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(2000),
        headers: { accept: 'application/json' },
      })
      if (res.ok) return { ok: true, latencyMs: Date.now() - start }
    } catch {
      // try next path; final error sanitized below
    }
  }
  return { ok: false, latencyMs: Date.now() - start, error: 'License-Validator unreachable' }
}
