/**
 * Health-check status helpers — pure logic extracted from /api/health so the
 * aggregation rules are unit-testable without a DB/Redis/HTTP round-trip.
 */

export type CheckStatus = {
  ok: boolean
  latencyMs?: number
  error?: string
}

/**
 * Aggregate individual dependency checks into a response verdict.
 *
 * ponytail: ONLY db is critical. Redis is optional (graceful degradation) and
 * the License-Validator probe is informational (license revalidation retries
 * on its own schedule — a momentary validator blip must not page the on-call
 * or fail a compose healthcheck that would restart the app for no reason).
 */
export function aggregateHealth(checks: Record<string, CheckStatus>): {
  ok: boolean
  degraded: string[]
} {
  const degraded: string[] = []
  let ok = true
  for (const [name, check] of Object.entries(checks)) {
    if (check.ok) continue
    if (name === 'db') ok = false
    else degraded.push(name)
  }
  return { ok, degraded }
}

/**
 * Keep only the leading error CLASS from a raw error, capped at 120 chars.
 * "Connection terminated due to connection timeout (…db.internal.prod:5432…)"
 * becomes "Connection terminated…" — enough to debug, nothing to recon with.
 * This endpoint's output reaches anonymous callers (middleware allow-list), so
 * raw driver errors (hosts, SQL, file paths) must never pass through.
 */
export function sanitizeHealthError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  const first = e.message.split('(')[0].trim() || e.name
  return first.slice(0, 120)
}
