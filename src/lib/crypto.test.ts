import { describe, expect, test, beforeAll } from 'bun:test'
import crypto from 'crypto'

// ponytail: fixed test key — deterministic, no env dependency.
const TEST_KEY = Buffer.from('a'.repeat(64), 'hex')

process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)

import { resetEncryptionKeyCache } from './config'
import { encryptConfig, decryptConfig, maskConfig, signSession, verifySession } from './crypto'

beforeAll(() => { resetEncryptionKeyCache() })

describe('encryptConfig / decryptConfig round-trip', () => {
  test('simple object round-trips', () => {
    const config = { host: 'localhost', port: 5432 }
    const enc = encryptConfig(config)
    expect(typeof enc).toBe('string')
    expect(enc).not.toContain('localhost')
    const dec = decryptConfig(enc)
    expect(dec).toEqual(config)
  })

  test('nested object round-trips', () => {
    const config = { db: { host: 'db.internal', creds: { user: 'admin', pass: 's3cret' } } }
    const dec = decryptConfig(encryptConfig(config))
    expect(dec).toEqual(config)
  })

  test('empty object round-trips', () => {
    const dec = decryptConfig(encryptConfig({}))
    expect(dec).toEqual({})
  })

  test('unicode values round-trip', () => {
    const config = { note: 'café — naïve résumé 日本語 🎉' }
    const dec = decryptConfig(encryptConfig(config))
    expect(dec).toEqual(config)
  })

  test('very long string round-trips', () => {
    const config = { data: 'x'.repeat(10_000) }
    const dec = decryptConfig(encryptConfig(config))
    expect(dec).toEqual(config)
  })

  test('null and numeric values round-trip', () => {
    const config = { a: null, b: 0, c: true, d: -1.5 }
    const dec = decryptConfig(encryptConfig(config))
    expect(dec).toEqual(config)
  })
})

describe('decryptConfig — tampered ciphertext rejection (GCM auth tag)', () => {
  test('flipping a ciphertext byte → throws', () => {
    const enc = encryptConfig({ secret: 'value' })
    const buf = Buffer.from(enc, 'hex')
    // Flip a byte in the ciphertext region (between nonce and tag)
    const ctStart = 12
    const ctEnd = buf.length - 16
    buf[ctStart + 5] ^= 0x01
    expect(() => decryptConfig(buf.toString('hex'))).toThrow()
  })

  test('flipping an auth tag byte → throws', () => {
    const enc = encryptConfig({ secret: 'value' })
    const buf = Buffer.from(enc, 'hex')
    buf[buf.length - 1] ^= 0x01
    expect(() => decryptConfig(buf.toString('hex'))).toThrow()
  })

  test('truncated ciphertext → throws', () => {
    const enc = encryptConfig({ secret: 'value' })
    const truncated = enc.slice(0, enc.length - 10)
    expect(() => decryptConfig(truncated)).toThrow()
  })

  test('garbage input → throws', () => {
    expect(() => decryptConfig('not-valid-hex')).toThrow()
    expect(() => decryptConfig('')).toThrow()
  })
})

describe('maskConfig', () => {
  test('password field masked', () => {
    const masked = maskConfig({ password: 'supersecret123' })
    expect(masked.password).not.toBe('supersecret123')
    expect(masked.password).toContain('••••')
  })

  test('secret field masked', () => {
    const masked = maskConfig({ clientSecret: 'abc123def456' })
    expect(masked.clientSecret).not.toBe('abc123def456')
    expect(masked.clientSecret).toContain('••••')
  })

  test('token field masked', () => {
    const masked = maskConfig({ authToken: 'bearer-token-xyz' })
    expect(masked.authToken).toContain('••••')
  })

  test('apiKey / secretKey fields masked (contains "key")', () => {
    const masked = maskConfig({ apiKey: 'ryas_abc123', secretKey: 'sk_live_xxx' })
    expect(masked.apiKey).toContain('••••')
    expect(masked.secretKey).toContain('••••')
  })

  test('non-sensitive field NOT masked', () => {
    const masked = maskConfig({ host: 'localhost', port: 5432, name: 'admin' })
    expect(masked.host).toBe('localhost')
    expect(masked.port).toBe(5432)
    expect(masked.name).toBe('admin')
  })

  test('short value (< 5 chars) → just ••••', () => {
    const masked = maskConfig({ password: 'ab' })
    expect(masked.password).toBe('••••')
  })

  test('non-string sensitive field → not masked (only strings)', () => {
    const masked = maskConfig({ password: 12345 })
    expect(masked.password).toBe(12345)
  })
})

describe('signSession / verifySession', () => {
  test('round-trip: sign → verify → same userId', () => {
    const userId = 'user_abc123'
    const token = signSession(userId)
    expect(token).toContain(userId)
    expect(token).toContain('.')
    expect(verifySession(token)).toBe(userId)
  })

  test('wrong signature → null', () => {
    const token = signSession('user_abc')
    // Tamper with the signature part
    const parts = token.split('.')
    const tampered = `${parts[0]}.${parts[1].slice(0, -2)}xx`
    expect(verifySession(tampered)).toBeNull()
  })

  test('tampered userId → null (HMAC mismatch)', () => {
    const token = signSession('user_abc')
    // Replace userId but keep original signature
    const idx = token.lastIndexOf('.')
    const tampered = 'user_impersonated' + token.slice(idx)
    expect(verifySession(tampered)).toBeNull()
  })

  test('null / undefined / empty → null', () => {
    expect(verifySession(null)).toBeNull()
    expect(verifySession(undefined)).toBeNull()
    expect(verifySession('')).toBeNull()
  })

  test('malformed token (no dot) → null', () => {
    expect(verifySession('justauserid')).toBeNull()
  })

  test('token with dot at start → null', () => {
    expect(verifySession('.signature')).toBeNull()
  })

  test('different keys produce different signatures', () => {
    // ponytail: verifySession uses the same TEST_KEY, so cross-key test is manual
    const token = signSession('user1')
    const otherKey = Buffer.from('b'.repeat(64), 'hex')
    const otherSig = crypto.createHmac('sha256', otherKey).update('user1').digest('base64url')
    const forgedToken = `user1.${otherSig}`
    expect(verifySession(forgedToken)).toBeNull()
  })
})
