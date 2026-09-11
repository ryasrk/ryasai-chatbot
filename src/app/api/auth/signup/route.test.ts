import { describe, expect, test, mock, beforeEach } from 'bun:test'

interface ValidationResult {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  message: string
  signatureVerified: boolean
}

// --- Mutable mock state (reset between tests via beforeEach) ---
const mockValidateLicense = mock<(key: string, machineId: string) => Promise<ValidationResult>>(async () => ({
  valid: true,
  plan: 'flat',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  message: '',
  signatureVerified: true,
}))
const mockGenerateMachineId = mock((slug: string) => `${slug}:host`)
const mockOrgFindUnique = mock(async (): Promise<unknown> => null)
const mockUserFindUnique = mock(async (): Promise<unknown> => null)
const mockOrgCreate = mock(async (args: any) => ({ id: 'org-1', name: args.data.name, slug: args.data.slug, licensePlan: args.data.licensePlan ?? null }))
const mockUserCreate = mock(async () => ({ id: 'user-1', name: 'Admin', email: 'admin@test.com' }))
const mockAppConfigCreate = mock(async () => ({}))
const mockSignSession = mock(() => 'signed.cookie')

mock.module('@/lib/license-client', () => ({
  validateLicense: mockValidateLicense,
  generateMachineId: mockGenerateMachineId,
}))
mock.module('@/lib/prisma-tenant', () => ({
  // ponytail: signup runs before any org context exists — pass calls straight through
  bypassOrg: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))
mock.module('@/lib/passwords', () => ({
  hashPassword: (pw: string) => `scrypt$${pw}`,
}))
mock.module('@/lib/crypto', () => ({
  signSession: mockSignSession,
  verifySession: () => null,
  extractSessionVersion: () => 0,
}))
mock.module('@/lib/db', () => ({
  db: {
    organization: { findUnique: mockOrgFindUnique, create: mockOrgCreate },
    user: { findUnique: mockUserFindUnique, create: mockUserCreate },
    appConfig: { create: mockAppConfigCreate },
  },
}))

import { POST } from './route'

beforeEach(() => {
  mockValidateLicense.mockClear()
  mockValidateLicense.mockImplementation(async () => ({
    valid: true,
    plan: 'flat',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    message: '',
    signatureVerified: true,
  }))
  mockOrgFindUnique.mockImplementation(async () => null)
  mockUserFindUnique.mockImplementation(async () => null)
  mockOrgCreate.mockClear()
  mockAppConfigCreate.mockClear()
})

function makeReq(body: unknown) {
  return new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const BASE_BODY = {
  organizationName: 'Acme',
  slug: 'acme',
  name: 'Admin',
  email: 'admin@test.com',
  password: 'supersecret',
}

describe('POST /api/auth/signup', () => {
  test('licenseless signup → org created with licenseStatus unpaid, licensePlan null', async () => {
    const res = await POST(makeReq(BASE_BODY) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    expect(mockValidateLicense).not.toHaveBeenCalled()
    const data = mockOrgCreate.mock.calls[0][0].data
    expect(data.licenseStatus).toBe('unpaid')
    expect(data.licensePlan).toBeNull()
    expect(data.slug).toBe('acme')
    expect(mockAppConfigCreate).toHaveBeenCalledTimes(1)
  })

  test('signup with valid licenseKey → org created valid with plan from validator (back-compat)', async () => {
    const res = await POST(makeReq({ ...BASE_BODY, licenseKey: ' LIC-123 ' }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.organization.plan).toBe('flat')

    expect(mockValidateLicense).toHaveBeenCalledTimes(1)
    const [calledKey] = mockValidateLicense.mock.calls[0]
    expect(calledKey).toBe('LIC-123')
    const data = mockOrgCreate.mock.calls[0][0].data
    expect(data.licenseStatus).toBe('valid')
    expect(data.licensePlan).toBe('flat')
    expect(data.licenseKey).toBe('LIC-123')
    expect(data.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('signup with invalid licenseKey → 403, no org created', async () => {
    mockValidateLicense.mockImplementation(async () => ({
      valid: false,
      plan: null,
      expiresAt: null,
      message: 'License key not found.',
      signatureVerified: true,
    }))
    const res = await POST(makeReq({ ...BASE_BODY, licenseKey: 'BAD' }) as any)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('License validation failed')
    expect(mockOrgCreate).not.toHaveBeenCalled()
  })

  test('missing required fields (no licenseKey needed anymore) → 400 lists fields without licenseKey', async () => {
    const res = await POST(makeReq({ organizationName: 'Acme' }) as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('organizationName')
    expect(body.error).not.toContain('licenseKey')
    expect(mockOrgCreate).not.toHaveBeenCalled()
  })

  test('taken slug → 409 before creating anything', async () => {
    mockOrgFindUnique.mockImplementation(async () => ({ id: 'org-existing' }))
    const res = await POST(makeReq(BASE_BODY) as any)
    expect(res.status).toBe(409)
    expect(mockOrgCreate).not.toHaveBeenCalled()
  })

  test('password < 8 chars → 400, no validator call', async () => {
    const res = await POST(makeReq({ ...BASE_BODY, password: 'short' }) as any)
    expect(res.status).toBe(400)
    expect(mockValidateLicense).not.toHaveBeenCalled()
    expect(mockOrgCreate).not.toHaveBeenCalled()
  })
})
