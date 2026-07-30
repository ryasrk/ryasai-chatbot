/**
 * Health checks — liveness vs readiness for Kubernetes probes.
 * ----------------------------------------------------------------------------
 * - checkLiveness(): process is alive → always { status: 'ok' }
 * - checkReadiness(): can serve requests → checks DB + Redis
 *
 * Wire into health API routes:
 *   GET /api/v1/health   → checkLiveness()
 *   GET /api/health       → checkReadiness()
 */
import { db } from '@/lib/db'
import { checkRedisHealth } from '@/lib/redis'

export interface LivenessResult {
  status: 'ok'
}

export interface ReadinessResult {
  status: 'ok' | 'not_ready'
  checks: { db: boolean; redis: boolean }
}

export function checkLiveness(): LivenessResult {
  return { status: 'ok' }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const checks = { db: false, redis: false }

  try {
    await db.$queryRaw`SELECT 1`
    checks.db = true
  } catch {
    // DB down
  }

  try {
    const r = await checkRedisHealth()
    checks.redis = r.connected
  } catch {
    // Redis down
  }

  return {
    status: checks.db && checks.redis ? 'ok' : 'not_ready',
    checks,
  }
}
