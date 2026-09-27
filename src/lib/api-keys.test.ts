import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks for requireExternalApiKey tests (must precede import) ---
const mockApiKeyFindMany = mock<(args: any) => Promise<any[]>>(async () => [] as any[])
const mockApiKeyUpdate = mock<(args: { where: { id: string }; data: { lastUsedAt: Date } }) => Promise<void>>(async () => undefined)
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
import { NextRequest } from 'next/server'

beforeEach(() => {
  mockApiKeyFindMany.mockClear()
  mockApiKeyUpdate.mockClear()
  mockApiRequestLogCount.mockClear()
  mockApiKeyFindMany.mockImplementation(async () => [] as any[])
  mockApiKeyUpdate.mockImplementation(async () => undefined)
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

  test('verifyApiKey returns false for different-length hash', () => {
    expect(verifyApiKey('ryas_test', 'short')).toBe(false)
  })

  test('hashApiKey produces deterministic 64-char hex', () => {
    const h1 = hashApiKey('ryas_key_1')
    const h2 = hashApiKey('ryas_key_1')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(64)
    expect(h1).toMatch(/^[0-9a-f]+$/)
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
    await expect(requireExternalApiKey(req)).rejects.toThrow('API key must be')
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
    await expect(requireExternalApiKey(req)).rejects.toThrow('invalid or has been revoked')
    // ponytail: db query filters isActive:true, revokedAt:null — revoked keys never appear
    mockApiKeyFindMany.mockImplementation(async () => [])

    const revokedReq = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Bearer ryas_revoked_key' },
    })
    await expect(requireExternalApiKey(revokedReq)).rejects.toThrow('invalid or has been revoked')
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
    await expect(requireExternalApiKey(req)).rejects.toThrow('Rate limit per minute')
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
    await expect(requireExternalApiKey(req)).rejects.toThrow('Daily limit')
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

  test('short token (< 13 chars) → falls back to all-keys scan, still invalid', async () => {
    mockApiKeyFindMany.mockImplementation(async () => [])
    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: 'Bearer ryas' },
    })
    await expect(requireExternalApiKey(req)).rejects.toThrow('invalid or has been revoked')
  })

  test('no rate limits configured → skips count checks, succeeds', async () => {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-nolimit',
        label: 'no-limit',
        keyHash: key.hash,
        requestLimitPerMinute: null,
        dailyRequestLimit: null,
      },
    ])
    const req = new NextRequest('http://localhost/', {
      headers: { Authorization: `Bearer ${key.plainText}` },
    })
    const identity = await requireExternalApiKey(req)
    expect(identity.apiKeyId).toBe('key-nolimit')
    expect(mockApiRequestLogCount).not.toHaveBeenCalled()
  })
})

/**
 * The AUTH path must carry the key's scope out to its callers.
 *
 * WHY THIS BLOCK EXISTS. `requireExternalApiKey` is the only place that reads the scope columns, and
 * `identity.scope` is the only thing the transports enforce. Neither hop had a test: every existing
 * test above builds a mock row with NO scope columns at all, so they would all still pass if the
 * `allowedIntegrationIds`/`allowedDocumentIds`/`allowedTools` entries were deleted from the `select`.
 * That is silent-failure class 3 (a field selected but never mapped) with the select removed: the
 * caller would receive `scope: { allowedX: [] }`, every array empty, which this codebase defines as
 * UNRESTRICTED — so a scoped key would be silently promoted to full access and nothing would error.
 */
describe('requireExternalApiKey — the key scope is transported, not dropped', () => {
  function mockRow(scope: Record<string, unknown>) {
    const key = generateApiKey()
    mockApiKeyFindMany.mockImplementation(async () => [
      {
        id: 'key-scoped', label: 'scoped', keyHash: key.hash,
        requestLimitPerMinute: null, dailyRequestLimit: null, ...scope,
      },
    ])
    return key
  }

  test('a scoped key reports its restriction on the identity', async () => {
    const key = mockRow({
      allowedIntegrationIds: ['erp'],
      allowedDocumentIds: ['doc-1'],
      allowedTools: ['RAG'],
    })
    const identity = await requireExternalApiKey(
      new NextRequest('http://localhost/', { headers: { Authorization: `Bearer ${key.plainText}` } }),
    )
    expect(identity.scope.allowedIntegrationIds).toEqual(['erp'])
    expect(identity.scope.allowedDocumentIds).toEqual(['doc-1'])
    expect(identity.scope.allowedTools).toEqual(['RAG'])
  })

  test('the SELECT actually requests the scope columns', async () => {
    // Asserts on the query args, not on the row: a dropped `select` would otherwise be invisible
    // because the mock returns whatever it is given. This is the hop that has no other guard.
    const key = mockRow({ allowedDocumentIds: ['doc-1'] })
    await requireExternalApiKey(
      new NextRequest('http://localhost/', { headers: { Authorization: `Bearer ${key.plainText}` } }),
    )
    const args = mockApiKeyFindMany.mock.calls[0]?.[0] as { select?: Record<string, boolean> }
    expect(args?.select?.allowedIntegrationIds).toBe(true)
    expect(args?.select?.allowedDocumentIds).toBe(true)
    expect(args?.select?.allowedTools).toBe(true)
  })

  test('a pre-feature key with no scope columns stays unrestricted', async () => {
    // The migration promise: keys created before scoping existed must keep full access. Their rows have
    // empty arrays, so the identity must report unrestricted rather than denied.
    const key = mockRow({ allowedIntegrationIds: [], allowedDocumentIds: [], allowedTools: [] })
    const identity = await requireExternalApiKey(
      new NextRequest('http://localhost/', { headers: { Authorization: `Bearer ${key.plainText}` } }),
    )
    expect(identity.scope.allowedIntegrationIds).toEqual([])
    expect(identity.scope.allowedDocumentIds).toEqual([])
    expect(identity.scope.allowedTools).toEqual([])
  })
})
