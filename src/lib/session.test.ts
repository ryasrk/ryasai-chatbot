import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mutable mock state (reset between tests via beforeEach) ---
const mockVerifySession = mock<(token: string | undefined | null) => string | null>(
  () => null,
)
const mockCookieGet = mock<(name: string) => { value: string } | undefined>(() => undefined)
const mockUserFindUnique = mock<(args: any) => Promise<any>>(async () => null)
const mockUserFindFirst = mock<(args: any) => Promise<any>>(async () => null)
const mockAuditLogCreate = mock<(args: any) => Promise<any>>(async () => ({}))

mock.module('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}))
mock.module('@/lib/crypto', () => ({
  verifySession: mockVerifySession,
  extractSessionVersion: () => 0,
}))
mock.module('@/lib/db', () => ({
  db: {
    user: { findUnique: mockUserFindUnique, findFirst: mockUserFindFirst },
    auditLog: { create: mockAuditLogCreate },
  },
}))

import { handleApiError, writeAudit, getActiveUser, UnauthorizedError } from './session'

beforeEach(() => {
  process.env.AUTH_DEMO_FALLBACK = 'false'
  mockVerifySession.mockImplementation(() => null)
  mockCookieGet.mockImplementation(() => undefined)
  mockUserFindUnique.mockImplementation(async () => null)
  mockUserFindFirst.mockImplementation(async () => null)
  mockAuditLogCreate.mockImplementation(async () => ({}))
  mockAuditLogCreate.mockImplementation(async () => ({}))
})

describe('handleApiError', () => {
  test('UnauthorizedError → 401 with correct message', async () => {
    const res = handleApiError(new UnauthorizedError('no session'), 'fallback')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('no session')
  })

  test('UnauthorizedError uses default message', async () => {
    const res = handleApiError(new UnauthorizedError(), 'fallback')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('No active session.')
  })

  test('Generic Error → 500 with fallback message', async () => {
    const res = handleApiError(new Error('boom'), 'Something went wrong')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Something went wrong')
  })

  test('Generic Error → custom status', async () => {
    const res = handleApiError(new Error('bad'), 'Bad request', 400)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Bad request')
  })

  test('non-Error value → 500 with fallback', async () => {
    const res = handleApiError('string error', 'fallback')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('fallback')
  })
})

describe('writeAudit — fail-closed for critical, swallow for non-critical', () => {
  test('successful write → no throw', async () => {
    await writeAudit({ action: 'LOGIN', severity: 'info', detail: { ip: '1.2.3.4' } })
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
  })

  test('critical severity + DB failure → THROWS (fail-closed)', async () => {
    mockAuditLogCreate.mockImplementation(async () => {
      throw new Error('DB down')
    })
    await expect(
      writeAudit({ action: 'GUARDRAIL_BLOCK', severity: 'critical', detail: {} }),
    ).rejects.toThrow('DB down')
  })

  test('info severity + DB failure → swallowed (no throw)', async () => {
    mockAuditLogCreate.mockImplementation(async () => {
      throw new Error('DB down')
    })
    await expect(
      writeAudit({ action: 'LOGIN', severity: 'info', detail: {} }),
    ).resolves.toBeUndefined()
  })

  test('warning severity + DB failure → swallowed (no throw)', async () => {
    mockAuditLogCreate.mockImplementation(async () => {
      throw new Error('DB down')
    })
    await expect(
      writeAudit({ action: 'RETRY', severity: 'warning', detail: {} }),
    ).resolves.toBeUndefined()
  })

  test('default severity is info', async () => {
    await writeAudit({ action: 'TEST', detail: {} })
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ severity: 'info' }) }),
    )
  })
})

describe('getActiveUser', () => {
  test('valid cookie + active user → returns user', async () => {
    mockCookieGet.mockImplementation(() => ({ value: 'signed.token' }))
    mockVerifySession.mockImplementation(() => 'user-1')
    mockUserFindUnique.mockImplementation(async () => ({
      id: 'user-1',
      name: 'Admin',
      email: 'admin@test.com',
      isActive: true,
      sessionVersion: 0,
    }))

    const user = await getActiveUser()
    expect(user).toEqual({ userId: 'user-1', name: 'Admin', email: 'admin@test.com' })
  })

  test('valid cookie + INACTIVE user → falls through, throws (no fallback)', async () => {
    mockCookieGet.mockImplementation(() => ({ value: 'signed.token' }))
    mockVerifySession.mockImplementation(() => 'user-1')
    mockUserFindUnique.mockImplementation(async () => ({
      id: 'user-1',
      name: 'Admin',
      email: 'admin@test.com',
      isActive: false,
      sessionVersion: 0,
    }))

    await expect(getActiveUser()).rejects.toThrow()
  })

  test('invalid cookie + AUTH_DEMO_FALLBACK=false → throws UnauthorizedError', async () => {
    process.env.AUTH_DEMO_FALLBACK = 'false'
    mockCookieGet.mockImplementation(() => undefined)

    await expect(getActiveUser()).rejects.toThrow('No active session')
  })

  test('no cookie + AUTH_DEMO_FALLBACK=true → returns first active user', async () => {
    process.env.AUTH_DEMO_FALLBACK = 'true'
    mockCookieGet.mockImplementation(() => undefined)
    mockUserFindFirst.mockImplementation(async () => ({
      id: 'demo-user',
      name: 'Demo',
      email: 'demo@test.com',
      isActive: true,
    }))

    const user = await getActiveUser()
    expect(user.userId).toBe('demo-user')
    expect(user.name).toBe('Demo')
  })

  test('no cookie + AUTH_DEMO_FALLBACK=true + no users → throws Error', async () => {
    process.env.AUTH_DEMO_FALLBACK = 'true'
    mockCookieGet.mockImplementation(() => undefined)
    mockUserFindFirst.mockImplementation(async () => null)

    await expect(getActiveUser()).rejects.toThrow('No active user found')
  })

  test('expired/invalid cookie signature + fallback disabled → throws', async () => {
    process.env.AUTH_DEMO_FALLBACK = 'false'
    mockCookieGet.mockImplementation(() => ({ value: 'tampered.token' }))
    mockVerifySession.mockImplementation(() => null)

    await expect(getActiveUser()).rejects.toThrow()
  })
})
