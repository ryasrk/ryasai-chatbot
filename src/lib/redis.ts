import IORedis from 'ioredis'
import { Queue } from 'bullmq'

// ponytail: rediss:// (TLS) for production, redis fallback for local dev only.
// nosemgrep — dev fallback only, production uses rediss:// via REDIS_URL
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

export { cmd as redisCmd }

// ---------------------------------------------------------------------------
// Distributed cache — Redis-backed with in-memory fallback.
// ponytail: replaces per-instance Map caches (rag.ts, smart-router.ts).
// Falls back to in-memory when Redis is down — callers don't need to handle Redis errors.
// ---------------------------------------------------------------------------

const _fallbackCache = new Map<string, string>()

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await cmd.get(key)
    if (raw === null) return null
    return JSON.parse(raw) as T
  } catch {
    // Redis down — try in-memory fallback
    const fallback = _fallbackCache.get(key)
    return fallback ? (JSON.parse(fallback) as T) : null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const raw = JSON.stringify(value)
  try {
    await cmd.set(key, raw, 'EX', ttlSeconds)
  } catch {
    // Redis down — store in-memory (no TTL eviction, but better than nothing)
    _fallbackCache.set(key, raw)
  }
}

export async function cacheDel(prefix: string): Promise<void> {
  try {
    // SCAN + DEL by prefix — avoids KEYS which blocks Redis
    let cursor = '0'
    do {
      const [next, keys] = await cmd.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = next
      if (keys.length > 0) await cmd.del(...keys)
    } while (cursor !== '0')
  } catch {
    // Redis down — clear in-memory fallback
    for (const key of _fallbackCache.keys()) {
      if (key.startsWith(prefix)) _fallbackCache.delete(key)
    }
  }
}
