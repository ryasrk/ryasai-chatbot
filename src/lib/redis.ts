import IORedis from 'ioredis'
import { Queue } from 'bullmq'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// ponytail: single BullMQ connection — maxRetriesPerRequest:null required by BullMQ for blocking commands.
// Per-account queues if throughput matters.
export const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})
redis.on('error', () => {}) // ponytail: suppress unhandled error events when Redis is down

// ponytail: fast-failing connection for rate limiting + health checks — rejects immediately
// when Redis is down (enableOfflineQueue:false) so callers fall back to DB-based logic gracefully.
const cmd = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  enableReadyCheck: false,
})
cmd.on('error', () => {})

// ponytail: single queue for all job types — the `type` field in JobData dispatches to the right handler.
// Split into per-type queues if different concurrency/backoff is needed.
export const jobQueue = new Queue('document-processing', { connection: redis })

export async function rateLimit(
  key: string,
  maxPerMinute: number,
): Promise<{ allowed: boolean; remaining: number } | null> {
  try {
    const now = Date.now()
    const bucketKey = `ratelimit:${key}:${Math.floor(now / 60000)}`
    const count = await cmd.incr(bucketKey)
    if (count === 1) await cmd.expire(bucketKey, 60)
    return { allowed: count <= maxPerMinute, remaining: Math.max(0, maxPerMinute - count) }
  } catch {
    return null // ponytail: Redis down — caller falls back to existing DB-based limiting
  }
}

export async function checkRedisHealth(): Promise<{ connected: boolean; latencyMs?: number }> {
  try {
    const start = Date.now()
    await cmd.ping()
    return { connected: true, latencyMs: Date.now() - start }
  } catch {
    return { connected: false }
  }
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), cmd.quit()])
}
