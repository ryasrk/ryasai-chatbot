/**
 * Rate limiting — in-memory Map with Redis fallback.
 * ----------------------------------------------------------------------------
 * ponytail: in-memory Map-based limiter (stdlib, no Redis required).
 * Ceiling: per-instance, not distributed. In a multi-instance deployment,
 * each instance counts independently (limit × instances). Upgrade to
 * Redis-only when deploying >1 instance.
 *
 * Usage: call `requireRateLimit(req)` at the top of route handlers.
 * Returns { ok: true } when allowed, { ok: false, retryAfter } when over limit.
 */
import { NextRequest, NextResponse } from 'next/server'
import { rateLimit as redisRateLimit } from '@/lib/redis'

interface RateBucket {
  count: number
  resetAt: number
}

// ponytail: global Map — persists across requests within the same Node.js process.
const _buckets = new Map<string, RateBucket>()
const DEFAULT_LIMIT_PER_MIN = 60
const WINDOW_MS = 60_000

// Per-route limit overrides (route prefix → limit per minute)
const ROUTE_LIMITS: Record<string, number> = {
  '/api/chat/sessions': 30, // chat is expensive (LLM calls)
  '/api/v1/chat/completions': 30,
  '/api/v1/agent/run': 20,
  '/api/agent/dashboard': 20,
  '/api/auth/login': 10, // login is sensitive (brute force protection)
  '/api/documents': 20,
  '/api/integrations': 20,
}

/** Resolve the rate limit for a given pathname. Falls back to DEFAULT_LIMIT_PER_MIN. */
function limitFor(pathname: string): number {
  for (const [prefix, limit] of Object.entries(ROUTE_LIMITS)) {
    if (pathname.startsWith(prefix)) return limit
  }
  return DEFAULT_LIMIT_PER_MIN
}

/** Identify the rate-limit key — by API key (external) or by session cookie (internal). */
function resolveKey(req: NextRequest): string {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (apiKey) return `apikey:${apiKey.slice(0, 13)}`
  const session = req.cookies.get('x-active-user')?.value ?? ''
  return `session:${session.slice(0, 20)}`
}

export interface RateLimitResult {
  ok: boolean
  limit: number
  remaining: number
  retryAfter?: number
}

/** Check rate limit. Uses Redis when available, falls back to in-memory Map. */
export async function requireRateLimit(req: NextRequest): Promise<RateLimitResult> {
  const { pathname } = req.nextUrl
  const limit = limitFor(pathname)
  const key = resolveKey(req)

  // Try Redis first (distributed, accurate)
  try {
    const redisResult = await redisRateLimit(key, limit)
    if (redisResult !== null) {
      return {
        ok: redisResult.allowed,
        limit,
        remaining: redisResult.remaining,
        retryAfter: redisResult.allowed ? undefined : 60,
      }
    }
  } catch {
    // Redis down — fall through to in-memory
  }

  // In-memory fallback (per-instance, not distributed)
  const now = Date.now()
  const bucket = _buckets.get(key)

  if (!bucket || now > bucket.resetAt) {
    _buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
    // ponytail: evict stale buckets periodically (every 100 requests)
    if (_buckets.size > 1000) {
      for (const [k, b] of _buckets) {
        if (now > b.resetAt) _buckets.delete(k)
      }
    }
    return { ok: true, limit, remaining: limit - 1 }
  }

  bucket.count += 1
  if (bucket.count > limit) {
    return { ok: false, limit, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }

  return { ok: true, limit, remaining: limit - bucket.count }
}

/** Next.js response helper — returns 429 when rate limited. */
export function rateLimitResponse(result: RateLimitResult): NextResponse | null {
  if (result.ok) return null
  return NextResponse.json(
    {
      error: 'Rate limit reached. Try again later.',
      retryAfter: result.retryAfter,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfter ?? 60),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
      },
    },
  )
}
