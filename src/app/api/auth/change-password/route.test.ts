import { describe, expect, test, mock, beforeEach } from 'bun:test'

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

const mockGetActiveUser = mock(async () => ({ userId: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', organizationId: 'org-default' }))
const mockWriteAudit = mock(async () => undefined)
const mockVerifyPassword = mock(() => true)
const mockHashPassword = mock(() => 'scrypt$newhash')
const mockUserFindUnique = mock(async (): Promise<{ id: string; passwordHash: string } | null> => ({ id: 'u1', passwordHash: 'scrypt$old$hash' }))
const mockUserUpdate = mock(async () => ({}))

mock.module('@/lib/session', () => ({
  getActiveUser: mockGetActiveUser,
  writeAudit: mockWriteAudit,
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  UnauthorizedError: MockUnauthorizedError,
}))
mock.module('@/lib/passwords', () => ({
  verifyPassword: mockVerifyPassword,
  hashPassword: mockHashPassword,
}))
mock.module('@/lib/db', () => ({
  db: {
    user: {
      findUnique: mockUserFindUnique,
      update: mockUserUpdate,
    },
  },
}))

import { POST } from './route'

beforeEach(() => {
  mockGetActiveUser.mockClear()
  mockWriteAudit.mockClear()
  mockVerifyPassword.mockClear()
  mockHashPassword.mockClear()
  mockUserFindUnique.mockClear()
  mockUserUpdate.mockClear()
  mockGetActiveUser.mockImplementation(async () => ({ userId: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', organizationId: 'org-default' }))
  mockWriteAudit.mockImplementation(async () => undefined)
  mockVerifyPassword.mockImplementation(() => true)
  mockHashPassword.mockImplementation(() => 'scrypt$newhash')
  mockUserFindUnique.mockImplementation(async () => ({ id: 'u1', passwordHash: 'scrypt$old$hash' }))
  mockUserUpdate.mockImplementation(async () => ({}))
})

function makeReq(body: unknown) {
  return new Request('http://localhost/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/change-password', () => {
  test('valid current password + new password ≥ 8 chars → 200', async () => {
    const res = await POST(makeReq({ currentPassword: 'oldPass123', newPassword: 'newPass456' }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(mockUserUpdate).toHaveBeenCalledTimes(1)
    expect(mockHashPassword).toHaveBeenCalledWith('newPass456')
  })

  test('wrong current password → 401', async () => {
    mockVerifyPassword.mockImplementationOnce(() => false)
    const res = await POST(makeReq({ currentPassword: 'wrongPass', newPassword: 'newPass456' }) as any)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('Current password is incorrect')
    expect(mockUserUpdate).not.toHaveBeenCalled()
  })

  test('missing fields → 400', async () => {
    const res = await POST(makeReq({ currentPassword: '', newPassword: '' }) as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('are required')
  })

  test('new password < 8 chars → 400', async () => {
    const res = await POST(makeReq({ currentPassword: 'oldPass123', newPassword: 'short' }) as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('at least 8 characters')
  })

  test('user not found in DB → 404', async () => {
    mockUserFindUnique.mockImplementationOnce(async () => null)
    const res = await POST(makeReq({ currentPassword: 'oldPass123', newPassword: 'newPass456' }) as any)
    expect(res.status).toBe(404)
  })

  test('auth failure → 401', async () => {
    mockGetActiveUser.mockImplementationOnce(async () => { throw new MockUnauthorizedError() })
    const res = await POST(makeReq({ currentPassword: 'oldPass123', newPassword: 'newPass456' }) as any)
    expect(res.status).toBe(401)
  })
})
