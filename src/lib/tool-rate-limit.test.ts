import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockIncr = mock<(key: string) => Promise<number>>(async () => 1)
const mockExpire = mock<(key: string, s: number) => Promise<number>>(async () => 1)

mock.module('@/lib/redis', () => ({
  redisCmd: { incr: mockIncr, expire: mockExpire },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}))

import { checkToolRateLimit } from './tool-rate-limit'

beforeEach(() => {
  mockIncr.mockImplementation(async () => 1)
  mockExpire.mockImplementation(async () => 1)
  mockIncr.mockClear()
  mockExpire.mockClear()
})

describe('checkToolRateLimit', () => {
  test('under limit → allowed, remaining decreases', async () => {
    mockIncr.mockImplementation(async () => 3)
    const r = await checkToolRateLimit('mcp', 'org-1', 10, 60)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(7)
  })

  test('over limit → denied, remaining 0', async () => {
    mockIncr.mockImplementation(async () => 11)
    const r = await checkToolRateLimit('mcp', 'org-1', 10, 60)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test('first request sets expiry', async () => {
    mockIncr.mockImplementation(async () => 1)
    await checkToolRateLimit('mcp', 'org-1', 10, 60)
    expect(mockExpire.mock.calls.length).toBe(1)
  })

  test('Redis down → fail open (allowed)', async () => {
    mockIncr.mockImplementation(async () => {
      throw new Error('Redis unavailable')
    })
    const r = await checkToolRateLimit('mcp', 'org-1', 10, 60)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(10)
  })
})
