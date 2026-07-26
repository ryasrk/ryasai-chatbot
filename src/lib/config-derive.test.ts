import { describe, expect, test, beforeAll } from 'bun:test'
import crypto from 'crypto'

// Different env from config.test.ts — fresh module instance per file.
delete process.env.AUTH_DEMO_FALLBACK
delete process.env.WS_CORS_ORIGIN
process.env.ENCRYPTION_SECRET_KEY = 'my-secret-passphrase'

import { getEncryptionKey, serverConfig, resetEncryptionKeyCache } from './config'

beforeAll(() => { resetEncryptionKeyCache() })

describe('getEncryptionKey — passphrase derivation', () => {
  test('non-hex passphrase → SHA-256 derived 32-byte key', () => {
    const key = getEncryptionKey()
    const expected = crypto.createHash('sha256').update('my-secret-passphrase').digest()
    expect(key.length).toBe(32)
    expect(key.equals(expected)).toBe(true)
  })

  test('cached — second call returns same reference', () => {
    const a = getEncryptionKey()
    const b = getEncryptionKey()
    expect(b).toBe(a)
  })
})

describe('serverConfig — defaults when env unset', () => {
  test('authDemoFallback defaults to false', () => {
    expect(serverConfig.authDemoFallback).toBe(false)
  })

  test('wsCorsOrigins empty when env unset', () => {
    expect(serverConfig.wsCorsOrigins).toEqual([])
  })
})
