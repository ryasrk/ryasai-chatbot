import { describe, expect, test, mock } from 'bun:test'

const queryRawMock = mock(async () => [])
const checkRedisHealthMock = mock(async () => ({ connected: true }))

mock.module('@/lib/db', () => ({
  db: { $queryRaw: queryRawMock },
}))
mock.module('@/lib/redis', () => ({
  checkRedisHealth: checkRedisHealthMock,
}))

import { checkLiveness, checkReadiness } from './health-checks'

describe('checkLiveness', () => {
  test('always returns status ok', () => {
    const r = checkLiveness()
    expect(r.status).toBe('ok')
  })

  test('does not touch DB or Redis', () => {
    queryRawMock.mockClear()
    checkRedisHealthMock.mockClear()
    checkLiveness()
    expect(queryRawMock.mock.calls.length).toBe(0)
    expect(checkRedisHealthMock.mock.calls.length).toBe(0)
  })
})

describe('checkReadiness', () => {
  test('all healthy → status ok', async () => {
    queryRawMock.mockImplementationOnce(async () => [])
    checkRedisHealthMock.mockImplementationOnce(async () => ({ connected: true }))
    const r = await checkReadiness()
    expect(r.status).toBe('ok')
    expect(r.checks.db).toBe(true)
    expect(r.checks.redis).toBe(true)
  })

  test('DB down → not_ready, db=false', async () => {
    queryRawMock.mockImplementationOnce(async () => {
      throw new Error('DB connection refused')
    })
    checkRedisHealthMock.mockImplementationOnce(async () => ({ connected: true }))
    const r = await checkReadiness()
    expect(r.status).toBe('not_ready')
    expect(r.checks.db).toBe(false)
    expect(r.checks.redis).toBe(true)
  })

  test('Redis down → not_ready, redis=false', async () => {
    queryRawMock.mockImplementationOnce(async () => [])
    checkRedisHealthMock.mockImplementationOnce(async () => ({ connected: false }))
    const r = await checkReadiness()
    expect(r.status).toBe('not_ready')
    expect(r.checks.db).toBe(true)
    expect(r.checks.redis).toBe(false)
  })

  test('both down → not_ready, all false', async () => {
    queryRawMock.mockImplementationOnce(async () => {
      throw new Error('down')
    })
    checkRedisHealthMock.mockImplementationOnce(async () => {
      throw new Error('down')
    })
    const r = await checkReadiness()
    expect(r.status).toBe('not_ready')
    expect(r.checks.db).toBe(false)
    expect(r.checks.redis).toBe(false)
  })

  test('Redis check error (not just disconnected) → redis=false', async () => {
    queryRawMock.mockImplementationOnce(async () => [])
    checkRedisHealthMock.mockImplementationOnce(async () => {
      throw new Error('Redis timeout')
    })
    const r = await checkReadiness()
    expect(r.checks.redis).toBe(false)
  })
})
