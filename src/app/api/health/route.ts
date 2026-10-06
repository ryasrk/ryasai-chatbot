import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkRedisHealth } from '@/lib/redis'
import { publicConfig } from '@/lib/public-config'
import {
  aggregateHealth,
  defaultProbeTimeouts,
  probeServiceHealth,
  sanitizeHealthError,
  withDeadline,
  type CheckStatus,
} from '@/lib/health-status'
import { validatorUrl } from '@/lib/license-client'
import { cogneeServerReady } from '@/lib/cognee-http'
import { bypassOrg } from '@/lib/prisma-tenant'

/**
 * What one check reports. `configured` keeps "this dependency is absent by
 * design" distinct from "this dependency is down" — two meanings that must not
 * share one value (silent-failure class 13), because only the second one is a
 * reason to look. `note` explains an absent-by-design dependency so an operator
 * reading the payload is not left guessing why it is missing from `degraded`.
 */
type DependencyCheck = CheckStatus & { configured: boolean; note?: string }

/**
 * GET /api/health — the DEPENDENCY-CHECKING endpoint, and the one the container
 * healthcheck probes (docker-compose*.yml, both files).
 *
 * WHY THIS ONE AND NOT /api/v1/health. MEASURED DEFECT this endpoint exists to
 * fix, on the live production deployment: the compose healthcheck probed
 * /api/v1/health — which touches nothing at all — and decided on `r.ok`. So with
 * Postgres DEAD the container still reported `healthy`, and an orchestrator
 * never restarted it. That is this repo's silent-failure class #14: a dead
 * mechanism that reports itself healthy.
 *
 * The two endpoints keep their separate jobs:
 *   /api/v1/health  LIVENESS  — public, fast, touches nothing, no internal
 *                   detail. Removing its dependency-free nature is not an option:
 *                   it is hit by the public site and by orchestrator liveness
 *                   probes, and a liveness probe that fails on a DB blip asks an
 *                   orchestrator to KILL a process that is running correctly.
 *   /api/health     READINESS — this route. Real dependency checks, sanitized
 *                   error classes, 503 when a CRITICAL check fails.
 *
 * THE FLAP TRADE-OFF, stated because it is the whole reason for the split: a
 * healthcheck that fails on a transient sidecar blip causes a RESTART LOOP over
 * a dependency the product is designed to survive. So only `db` is critical (see
 * CRITICAL_CHECKS in lib/health-status.ts) — a dead database genuinely means
 * "this process cannot serve its purpose". Every optional dependency is REPORTED
 * (status 200, named under `degraded`) without being allowed to restart the
 * container. The compose timing is deliberately tolerant on top of that:
 * `retries` × `interval` forbids three consecutive failures, and `start_period`
 * covers a cold boot.
 *
 * COST: all probes run CONCURRENTLY, so the endpoint's latency is the SLOWEST
 * single probe, not their sum. Measured on the live deployment: db 45ms,
 * redis 1ms, validator 296ms — the answer arrives in well under the compose
 * `timeout`. Every probe is individually bounded (defaultProbeTimeouts), so the
 * worst case is bounded too, and a probe that cannot settle can never hold the
 * status that decides a restart.
 *
 * ponytail: PUBLIC (middleware allow-list). Error strings are static per probe
 * (`Service unreachable`, `Service returned HTTP 502`) or sanitized error CLASSES
 * — this endpoint is unauthenticated, so driver errors (which embed hosts, SQL,
 * file paths) must not pass through, and the compose healthcheck prints the
 * failing body into the container log where an operator reads it.
 *
 * ponytail: NO Midtrans probe on purpose — Snap has no cheap unauthenticated
 * GET endpoint; a POST-based probe would consume rate limits / create noise
 * against the payment gateway. Midtrans health is implied by checkout failures
 * surfacing in billing logs instead.
 */
export async function GET() {
  const timeouts = defaultProbeTimeouts()

  // CONCURRENT, deliberately. These four probes have nothing to do with each
  // other, and the previous sequential form made the endpoint's latency the SUM
  // of every probe — the one property a healthcheck must not have.
  const [dbCheck, redisCheck, validatorCheck, cogneeCheck, embeddingsCheck] = await Promise.all([
    probeDb(timeouts.dbMs),
    probeRedis(),
    probeLicenseValidator(timeouts.validatorMs),
    probeCognee(timeouts.probeMs),
    probeLocalEmbeddings(timeouts.probeMs),
  ])

  const checks: Record<string, DependencyCheck> = {
    db: dbCheck,
    redis: redisCheck,
    validator: validatorCheck,
    cognee: cogneeCheck,
    embeddings: embeddingsCheck,
  }

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
 * DB check — CRITICAL. A single count query is the cheapest connectivity test.
 *
 * The deadline is what turns "Postgres is black-holing the connection" from an
 * unbounded hang into a 503 this healthcheck can act on.
 */
async function probeDb(timeoutMs: number): Promise<CheckStatus & { configured: boolean }> {
  const start = Date.now()
  try {
    await withDeadline(bypassOrg(() => db.document.count()), timeoutMs, 'Database probe')
    return { ok: true, configured: true, latencyMs: Date.now() - start }
  } catch (e) {
    return {
      ok: false,
      configured: true,
      latencyMs: Date.now() - start,
      error: sanitizeHealthError(e, 'DB query failed'),
    }
  }
}

/** Redis check — REPORTED ONLY. The app works without Redis (graceful degradation). */
async function probeRedis(): Promise<CheckStatus & { configured: boolean }> {
  try {
    const redis = await checkRedisHealth()
    return {
      ok: redis.connected,
      configured: true,
      latencyMs: redis.latencyMs,
      ...(redis.connected ? {} : { error: 'Redis not connected (optional — app degrades gracefully)' }),
    }
  } catch (e) {
    return { ok: false, configured: true, error: sanitizeHealthError(e, 'Redis check failed') }
  }
}

/**
 * License-Validator probe — REPORTED ONLY (never flips ok→503, never restarts
 * the container). Probed only when explicitly configured so dev machines without
 * the validator don't log a guaranteed failure every scrape interval.
 *
 * The deadline is SHARED by both paths (`/health` then `/`), so the total spent
 * here is `timeoutMs`, not twice it — otherwise the endpoint's worst case would
 * be an unbounded multiple of the configured value.
 */
async function probeLicenseValidator(
  timeoutMs: number,
): Promise<CheckStatus & { configured: boolean }> {
  const base = validatorUrl()
  if (!base) {
    return { ok: false, configured: false, error: 'License validator not configured (license validation disabled)' }
  }
  const start = Date.now()
  for (const path of ['/health', '/']) {
    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0) break
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(remaining),
        headers: { accept: 'application/json' },
      })
      if (res.ok) return { ok: true, configured: true, latencyMs: Date.now() - start }
    } catch {
      // try next path; final error is the static string below
    }
  }
  return {
    ok: false,
    configured: true,
    latencyMs: Date.now() - start,
    error: 'License-Validator unreachable',
  }
}

/**
 * Memory sidecar (cognee) — REPORTED ONLY.
 *
 * WHY IT IS WORTH PROBING AT ALL: a crash-looping cognee was invisible behind
 * `ok:true`. Memory calls degrade to a no-op, so the product keeps serving chat
 * while quietly forgetting everything — the exact shape of silent-failure class
 * #14 from the other direction (healthy-looking, doing nothing).
 *
 * WHY `COGNEE_SERVER_URL` IS READ FROM THE ENVIRONMENT RATHER THAN THROUGH
 * `getCogneeServerOptions()`: this route has NO session and therefore NO org
 * context, and `getCogneeSettings()` returns its DISABLED settings when there is
 * no org — MEASURED, it yields `serverUrl: null` for a process that has
 * `COGNEE_SERVER_URL` set. The helper would therefore report "memory is off" on
 * every deployment, forever: a false negative that makes the new probe useless
 * while looking implemented. The address is a DEPLOYMENT fact, not a tenant
 * preference — cognee-core.ts says exactly that ("the server address is a
 * deployment fact … not a per-tenant preference") — and the compose files set it
 * per deployment, which is where this reads it from.
 *
 * The PROBE itself is the repo's own `cogneeServerReady()`: it checks the
 * sidecar's ready/healthy verdict at `/health`, not merely that a port answered.
 *
 * `COGNEE_ENABLED=false` is a real kill switch process-wide (cognee-core.ts), so
 * it is reported as deliberately-off rather than down.
 */
async function probeCognee(timeoutMs: number): Promise<CheckStatus & { configured: boolean }> {
  if (process.env.COGNEE_ENABLED === 'false') {
    return { ok: true, configured: false, error: undefined }
  }
  const baseUrl = process.env.COGNEE_SERVER_URL?.trim()
  if (!baseUrl) {
    return {
      ok: false,
      configured: false,
      error: 'Memory sidecar not configured (COGNEE_SERVER_URL unset — memory is OFF)',
    }
  }
  const start = Date.now()
  try {
    const ready = await cogneeServerReady({ baseUrl, timeoutMs })
    return {
      ok: ready,
      configured: true,
      latencyMs: Date.now() - start,
      ...(ready ? {} : { error: 'Memory sidecar not ready' }),
    }
  } catch {
    // cogneeServerReady already swallows transport errors; this is belt-and-braces
    // so a probe can never throw out of the handler.
    return { ok: false, configured: true, latencyMs: Date.now() - start, error: 'Memory sidecar not ready' }
  }
}

/**
 * Bundled local embedding service — REPORTED ONLY.
 *
 * WHY: this is the vector leg of retrieval. MEASURED (tools/local-embeddings/README)
 * semantic retrieval contributed 3/5 hits on hard paraphrase questions WITH it and
 * 0/5 without it — while retrieval still REPORTED a healthy-looking similarity
 * score. A dead vector leg was invisible behind `ok:true`.
 *
 * WHY THE APP'S EMBEDDING CLIENT IS NOT USED: `getEmbeddingRuntimeConfig()`
 * refuses to resolve without an org context, on purpose — a context-free
 * `findFirst()` returned ANOTHER tenant's model AND base URL (trial/55). This
 * route has no session, so using it would mean weakening that guard. It probes
 * the SERVICE at its deployment-level URL instead.
 *
 * WHY OPTIONAL AND WHY ABSENT MEANS "NOT CONFIGURED", NOT "DOWN": the product is
 * BYOK — a deployment may point at a HOSTED embedder and never run this service
 * at all (the compose file publishes it loopback-only). Probing it critically
 * would fail forever on a healthy install and restart-loop the container over a
 * service the operator deliberately does not run. `LOCAL_EMBEDDINGS_URL` unset is
 * therefore a supported state, reported as such.
 *
 * `/health` there is the service's own probe path (the same one its compose
 * healthcheck uses) and answers `{"ok":true,"model":…,"loaded":…}`. A sidecar
 * still LOADING its weights answers ok:true with `loaded:false`; that is
 * accepted, because a warming embedder must not mark the app unhealthy — and the
 * service's own compose healthcheck accepts it for the same reason.
 */
async function probeLocalEmbeddings(
  timeoutMs: number,
): Promise<CheckStatus & { configured: boolean }> {
  const base = process.env.LOCAL_EMBEDDINGS_URL?.trim().replace(/\/+$/, '')
  if (!base) {
    return {
      ok: false,
      configured: false,
      error: 'Local embedding service not configured (LOCAL_EMBEDDINGS_URL unset)',
    }
  }
  return { ...(await probeServiceHealth({ url: `${base}/health`, timeoutMs })), configured: true }
}
