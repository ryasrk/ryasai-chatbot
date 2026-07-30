import { describe, expect, test, mock } from 'bun:test'
import { requireRateLimit, rateLimitResponse } from './rate-limit'
import type { NextRequest } from 'next/server'

function mockReq(pathname: string, opts?: { auth?: string; cookie?: string }): NextRequest {
  const headers = new Headers()
  if (opts?.auth) headers.set('authorization', `Bearer ${opts.auth}`)
  const cookies = opts?.cookie ? { 'x-active-user': opts.cookie } : {}
  return {
    nextUrl: { pathname },
    headers,
    cookies: { get: (name: string) => cookies[name] ? { value: cookies[name] } : undefined },
  } as unknown as NextRequest
}

mock.module('@/lib/redis', () => ({
  rateLimit: async () => null,
  checkRedisHealth: async () => ({ connected: false, latencyMs: 0 }),
}))

describe('rate-limit — limitFor (per-route limits)', () => {
  test('chat sessions → 30/min', async () => {
    const r = await requireRateLimit(mockReq('/api/chat/sessions/123/send'))
    expect(r.limit).toBe(30)
  })

  test('chat completions → 30/min', async () => {
    const r = await requireRateLimit(mockReq('/api/v1/chat/completions'))
    expect(r.limit).toBe(30)
  })

  test('agent run → 20/min', async () => {
    const r = await requireRateLimit(mockReq('/api/v1/agent/run'))
    expect(r.limit).toBe(20)
  })

  test('login → 10/min', async () => {
    const r = await requireRateLimit(mockReq('/api/auth/login'))
    expect(r.limit).toBe(10)
  })

  test('unrecognized route → 60/min default', async () => {
    const r = await requireRateLimit(mockReq('/api/unknown/route'))
    expect(r.limit).toBe(60)
  })
})

describe('rate-limit — requireRateLimit (in-memory)', () => {
  test('first request → ok=true', async () => {
    const r = await requireRateLimit(mockReq('/api/test', { cookie: 'session-abc' }))
    expect(r.ok).toBe(true)
    expect(r.remaining).toBe(r.limit - 1)
  })

  test('multiple requests under limit → ok=true', async () => {
    const req = mockReq('/api/test', { cookie: 'unique-session-1' })
    for (let i = 0; i < 5; i++) {
      const r = await requireRateLimit(req)
      expect(r.ok).toBe(true)
    }
  })

  test('exceeding limit → ok=false with retryAfter', async () => {
    const req = mockReq('/api/auth/login', { cookie: 'unique-session-2' })
    for (let i = 0; i < 10; i++) {
      await requireRateLimit(req)
    }
    const r = await requireRateLimit(req)
    expect(r.ok).toBe(false)
    expect(r.retryAfter).toBeDefined()
    expect(r.retryAfter).toBeGreaterThan(0)
  })

  test('different sessions → independent limits', async () => {
    const req1 = mockReq('/api/test', { cookie: 'session-a' })
    const req2 = mockReq('/api/test', { cookie: 'session-b' })
    await requireRateLimit(req1)
    await requireRateLimit(req1)
    const r2 = await requireRateLimit(req2)
    expect(r2.ok).toBe(true)
    expect(r2.remaining).toBe(r2.limit - 1)
  })

  test('API key → used as rate limit key', async () => {
    const req = mockReq('/api/test', { auth: 'rk_test_1234567890123' })
    const r = await requireRateLimit(req)
    expect(r.ok).toBe(true)
  })
})

describe('rate-limit — rateLimitResponse', () => {
  test('ok=true → returns null', () => {
    const result = rateLimitResponse({ ok: true, limit: 60, remaining: 59 })
    expect(result).toBeNull()
  })

  test('ok=false → returns 429 response', () => {
    const result = rateLimitResponse({ ok: false, limit: 10, remaining: 0, retryAfter: 45 })
    expect(result).not.toBeNull()
    expect(result!.status).toBe(429)
    expect(result!.headers.get('Retry-After')).toBe('45')
    expect(result!.headers.get('X-RateLimit-Limit')).toBe('10')
  })
})
