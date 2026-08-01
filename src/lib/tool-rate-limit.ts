import { redisCmd } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('rate-limit')

// ponytail: sliding window rate limiter via Redis INCR + EXPIRE.
// Ceiling: 1-second granularity. Upgrade to sliding window log if precise
// rate limiting is needed.
const DEFAULT_LIMIT = 10 // requests per window
const DEFAULT_WINDOW_S = 60 // 1 minute

export async function checkToolRateLimit(
  toolName: string,
  organizationId: string,
  limit = DEFAULT_LIMIT,
  windowS = DEFAULT_WINDOW_S,
): Promise<{ allowed: boolean; remaining: number }> {
  const key = `ratelimit:tool:${toolName}:${organizationId}`
  try {
    const count = await redisCmd.incr(key)
    if (count === 1) {
      await redisCmd.expire(key, windowS)
    }
    const remaining = Math.max(0, limit - count)
    if (count > limit) {
      log.warn('Tool rate limit exceeded', { toolName, organizationId, count, limit })
      return { allowed: false, remaining: 0 }
    }
    return { allowed: true, remaining }
  } catch (e) {
    // ponytail: Redis down — fail open (allow). Rate limiting is a protection
    // measure, not a security barrier. Don't block all tools if Redis is down.
    log.warn('Rate limit check failed — Redis unavailable', { error: e instanceof Error ? e.message : String(e) })
    return { allowed: true, remaining: limit }
  }
}
