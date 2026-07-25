import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks for requireExternalApiKey tests (must precede import) ---
const mockApiKeyFindMany = mock<(args: any) => Promise<any[]>>(async () => [] as any[])
const mockApiKeyUpdate = mock<(args: { where: { id: string }; data: { lastUsedAt: Date } }) => Promise<{}>>(async () => ({}))
const mockApiRequestLogCount = mock<(args: any) => Promise<number>>(async () => 0)

mock.module('@/lib/db', () => ({
  db: {
    apiKey: {
      findMany: mockApiKeyFindMany,
      update: mockApiKeyUpdate,
    },
    apiRequestLog: {
      count: mockApiRequestLogCount,
    },
  },
}))

import {
  generateApiKey,
  hashApiKey,
  maskApiKey,
  verifyApiKey,
  requireExternalApiKey,
  getBearerToken,
} from './api-keys'
import { UnauthorizedError } from './session'
import { NextRequest } from 'next/server'

beforeEach(() => {
  mockApiKeyFindMany.mockClear()
  mockApiKeyUpdate.mockClear()
  mockApiRequestLogCount.mockClear()
  mockApiKeyFindMany.mockImplementation(async () => [] as any[])
  mockApiKeyUpdate.mockImplementation(async () => ({}))
  mockApiRequestLogCount.mockImplementation(async () => 0)
})

describe('api key utilities', () => {
  test('generates a ryas-prefixed key with prefix and hash', () => {
    const key = generateApiKey()

    expect(key.plainText.startsWith('ryas_')).toBe(true)
    expect(key.prefix.startsWith('ryas_')).toBe(true)
    expect(key.hash).not.toContain(key.plainText)
  })

  test('verifies only the matching key', () => {
    const plain = 'ryas_test_key_123'
    const hash = hashApiKey(plain)

    expect(verifyApiKey(plain, hash)).toBe(true)
    expect(verifyApiKey('ryas_wrong_key_123', hash)).toBe(false)
  })

  test('masks by prefix', () => {
    expect(maskApiKey('ryas_abc12345')).toBe('ryas_abc12345...')
  })
})

describe('getBearerToken', () => {
  test('extracts token from Bearer header', () => {
    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Bearer ryas_abc123' },
    })
    expect(getBearerToken(req)).toBe('ryas_abc123')
  })

  test('returns null for missing header', () => {
    const req = new NextRequest('http://localhost/')
    expect(getBearerToken(req)).toBeNull()
  })

  test('returns null for non-Bearer scheme', () => {
    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(getBearerToken(req)).toBeNull()
  })

  test('handles case-insensitive Bearer prefix', () => {
    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'bearer ryas_xyz' },
    })
    expect(getBearerToken(req)).toBe('ryas_xyz')
  })
})

describe('requireExternalApiKey', () => {
  test('valid API key → returns identity with apiKeyId', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-1',
        label: 'test-key',
        keyHash: key.hash,
        requestLimitPerMinute: null,
        dailyRequestLimit: null,
      },
    ])

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    const identity = await requireExternalApiKey(req)
    expect(identity.apiKeyId).toBe('key-1')
    expect(identity.label).toBe('test-key')
  })

  test('missing Authorization header → throws UnauthorizedError', async () => {
    const req = new NextRequest('http://localhost/')
    await expect(requireExternalApiKey(req)).rejects.toThrow('API key wajib')
  })

  test('wrong API key → throws UnauthorizedError', async () => {
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-1',
        label: 'test',
        keyHash: hashApiKey('ryas_wrong_key'),
        requestLimitPerMinute: null,
        dailyRequestLimit: null,
      },
    ])

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Bearer ryas_a_different_key' },
    })
    await expect(requireExternalApiKey(req)).rejects.toThrow('tidak valid')
  })

  test('revoked key (isActive=false) → not in candidates → throws', async () => {
    // ponytail: db query filters isActive:true, revokedAt:null — revoked keys never appear
    mockApiKeyFindMany.mockImplementation(async () => [])

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Bearer ryas_revoked_key' },
    })
    await expect(requireExternalApiKey(req)).rejects.toThrow('tidak valid')
  })

  test('per-minute rate limit exceeded → throws 429-style message', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-rl',
        label: 'rate-limited',
        keyHash: key.hash,
        requestLimitPerMinute: 10,
        dailyRequestLimit: null,
      },
    ])
    mockApiRequestLogCount.mockImplementation(async () => 10)

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    await expect(requireExternalApiKey(req)).rejects.toThrow('Rate limit per menit')
  })

  test('daily limit exceeded → throws daily limit message', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-daily',
        label: 'daily-limited',
        keyHash: key.hash,
        requestLimitPerMinute: null,
        dailyRequestLimit: 1000,
      },
    ])
    // First count call (per-minute) is skipped (null limit), second (daily) returns 1000
    mockApiRequestLogCount.mockImplementation(async () => 1000)

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    await expect(requireExternalApiKey(req)).rejects.toThrow('Batas harian')
  })

  test('updates lastUsedAt on successful auth', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-update',
        label: 'test',
        keyHash: key.hash,
        requestLimitPerMinute: null,
        dailyRequestLimit: null,
      },
    ])

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    await requireExternalApiKey(req)
    expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1)
    const callArg = mockApiKeyUpdate.mock.calls[0][0]
    expect(callArg.where.id).toBe('key-update')
    expect(callArg.data.lastUsedAt).toBeInstanceOf(Date)
  })

  test('under rate limit → succeeds', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-ok',
        label: 'ok',
        keyHash: key.hash,
        requestLimitPerMinute: 100,
        dailyRequestLimit: 10000,
      },
    ])
    mockApiRequestLogCount.mockImplementation(async () => 5)

    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    const identity = await requireExternalApiKey(req)
    expect(identity.apiKeyId).toBe('key-ok')
  })
})
