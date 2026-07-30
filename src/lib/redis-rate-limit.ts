/**
 * Distributed rate limiter — Redis INCR + EXPIRE with in-memory fallback.
 * ----------------------------------------------------------------------------
 * ponytail: fixed-window bucket (INCR + EXPIRE). Ceiling: not a true sliding
 * window — a burst at the bucket boundary can allow 2× limit. Upgrade to a
 * sorted-set or Lua-script sliding window if that matters.
 *
 * Should be wired into middleware.ts for multi-instance deployments.
 * The existing in-memory limiter in middleware.ts is sufficient for single-instance.
 */
import { redisCmd } from '@/lib/redis'

interface MemBucket {
  count: number
  resetAt: number
}

const _mem = new Map<string, MemBucket>()

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  resetAt: number
}

export async function redisRateLimit(
  identifier: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitDecision> {
  if (redisCmd) {
    try {
      const now = Date.now()
      const bucket = Math.floor(now / (windowSec * 1000))
      const key = `rl:${identifier}:${bucket}`
      const count = await redisCmd.incr(key)
      if (count === 1) await redisCmd.expire(key, windowSec)
      const resetAt = (bucket + 1) * windowSec * 1000
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetAt,
      }
    } catch {
      // Redis down — fall through to in-memory
    }
  }

  const now = Date.now()
  const b = _mem.get(identifier)
  if (!b || now > b.resetAt) {
    const resetAt = now + windowSec * 1000
    _mem.set(identifier, { count: 1, resetAt })
    if (_mem.size > 10_000) {
      for (const [k, v] of _mem) if (now > v.resetAt) _mem.delete(k)
    }
    return { allowed: true, remaining: limit - 1, resetAt }
  }
  b.count += 1
  if (b.count > limit) return { allowed: false, remaining: 0, resetAt: b.resetAt }
  return { allowed: true, remaining: limit - b.count, resetAt: b.resetAt }
}

export function resetRedisRateLimit(): void {
  _mem.clear()
}
