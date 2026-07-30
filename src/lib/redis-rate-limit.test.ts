import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

const incrMock = mock(async () => 1)
const expireMock = mock(async () => 1)

mock.module('@/lib/redis', () => ({
  redisCmd: {
    incr: incrMock,
    expire: expireMock,
    on: () => {},
  },
}))

import { redisRateLimit, resetRedisRateLimit } from './redis-rate-limit'

beforeEach(() => {
  incrMock.mockClear()
  expireMock.mockClear()
  resetRedisRateLimit()
})
afterEach(() => resetRedisRateLimit())

describe('redisRateLimit — Redis path', () => {
  test('first request → allowed, remaining = limit - 1', async () => {
    incrMock.mockImplementationOnce(async () => 1)
    const r = await redisRateLimit('user-1', 10, 60)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(9)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })

  test('count <= limit → allowed', async () => {
    incrMock.mockImplementationOnce(async () => 5)
    const r = await redisRateLimit('user-2', 10, 60)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(5)
  })

  test('count > limit → denied', async () => {
    incrMock.mockImplementationOnce(async () => 11)
    const r = await redisRateLimit('user-3', 10, 60)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test('EXPIRE called only on first INCR (count === 1)', async () => {
    incrMock.mockImplementationOnce(async () => 1)
    await redisRateLimit('user-4', 10, 60)
    expect(expireMock.mock.calls.length).toBe(1)

    incrMock.mockImplementationOnce(async () => 2)
    await redisRateLimit('user-4', 10, 60)
    expect(expireMock.mock.calls.length).toBe(1)
  })

  test('resetAt is the start of the next window', async () => {
    const windowSec = 60
    const expectedBucket = Math.floor(Date.now() / (windowSec * 1000))
    incrMock.mockImplementationOnce(async () => 1)
    const r = await redisRateLimit('user-5', 10, windowSec)
    expect(r.resetAt).toBe((expectedBucket + 1) * windowSec * 1000)
  })
})

describe('redisRateLimit — in-memory fallback (Redis throws)', () => {
  test('Redis error → falls back to in-memory, allowed', async () => {
    incrMock.mockImplementationOnce(async () => {
      throw new Error('Redis connection refused')
    })
    const r = await redisRateLimit('fb-1', 3, 60)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
  })

  test('in-memory fallback enforces limit', async () => {
    const id = `fb-2-${Date.now()}`
    for (let i = 0; i < 3; i++) {
      incrMock.mockImplementationOnce(async () => {
        throw new Error('down')
      })
      await redisRateLimit(id, 3, 60)
    }
    incrMock.mockImplementationOnce(async () => {
      throw new Error('down')
    })
    const r = await redisRateLimit(id, 3, 60)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test('in-memory resetAt is in the future', async () => {
    incrMock.mockImplementationOnce(async () => {
      throw new Error('down')
    })
    const r = await redisRateLimit('fb-3', 10, 60)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })
})
