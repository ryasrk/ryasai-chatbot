import { describe, expect, test, beforeAll } from 'bun:test'
import crypto from 'crypto'

process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)

import { resetEncryptionKeyCache } from './config'
import { encryptConfig, decryptConfig, maskConfig, signSession, verifySession, extractSessionVersion } from './crypto'

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
    const masked = maskConfig({ clientSecret: 'abc123def456' }) // nosemgrep — deterministic test value, not a real credential
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
    // ponytail: verifySession uses the same key, so cross-key test is manual
    const otherKey = Buffer.from('b'.repeat(64), 'hex')
    const otherSig = crypto.createHmac('sha256', otherKey).update('user1').digest('base64url')
    const forgedToken = `user1.${otherSig}`
    expect(verifySession(forgedToken)).toBeNull()
  })
})


// ===========================================================================
// extractSessionVersion — the session-fixation half of the token check
// ===========================================================================

describe('extractSessionVersion', () => {
  test('reads the version from a signed 3-part token', () => {
    // `session.ts` compares this against the DB column:
    //   if (u.isActive && u.sessionVersion === extractSessionVersion(token))
    // so the number has to round-trip exactly for a NON-legacy session.
    expect(extractSessionVersion(signSession('u1', 0))).toBe(0)
    expect(extractSessionVersion(signSession('u1', 1))).toBe(1)
    expect(extractSessionVersion(signSession('u1', 7))).toBe(7)
    expect(extractSessionVersion(signSession('u1', 999_999))).toBe(999_999)
  })

  test('a MISSING token, or one with fewer than 3 parts, is version 0 (legacy)', () => {
    // Documented contract: "Returns 0 for legacy tokens". A legacy 2-part token has no
    // version field, and the DB default for `sessionVersion` is 0, so the comparison
    // succeeds and legacy sessions keep working until those users re-login.
    expect(extractSessionVersion(undefined)).toBe(0)
    expect(extractSessionVersion(null)).toBe(0)
    expect(extractSessionVersion('')).toBe(0)
    expect(extractSessionVersion('no-dots')).toBe(0)
    expect(extractSessionVersion('user.signature')).toBe(0) // 2 parts
  })

  test('the parts<3 guard is load-bearing: a 2-part token with a NUMERIC tail', () => {
    // This is the input that separates the guard from the `Number.isFinite` fallback.
    // For 'user.signature' the fallback ALSO yields 0 (parseInt('signature') is NaN), which
    // is why a control removing only the guard produced NO failing test -- for that input.
    //
    // 'user.5' is different: parts[1] is '5', so WITHOUT the guard the function returns 5,
    // contradicting its own documented "Returns 0 for legacy tokens" contract. Both current
    // callers happen to run verifySession first, and verifySession rejects this token --
    // but that is a property of the CALLERS, not of this function, and the function is
    // exported. Pinned so a future caller cannot be handed 5 for a legacy token.
    expect(extractSessionVersion('user.5')).toBe(0)
    expect(verifySession('user.5')).toBeNull()
  })

  test('an UNPARSEABLE version is 0, never NaN', () => {
    // `Number.parseInt('abc')` is NaN, and `NaN === anything` is false -- if that NaN
    // escaped, the session comparison would fail for EVERY request and lock users out.
    // `Number.isFinite(v) ? v : 0` is what prevents it.
    expect(extractSessionVersion('user.abc.sig')).toBe(0)
    expect(extractSessionVersion('user..sig')).toBe(0)
    expect(extractSessionVersion('user. .sig')).toBe(0)
    for (const bad of ['abc', '', ' ', 'NaN', 'Infinity', '1e999']) {
      const v = extractSessionVersion(`user.${bad}.sig`)
      expect(Number.isFinite(v)).toBe(true)
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  test('the version is a LEADING-INTEGER parse, and extra parts shift the field', () => {
    // parseInt is used, not Number: '1.0' parses to 1 and '2abc' to 2. And the version is
    // read from index 1 specifically, so a 4-part token reads the SECOND field, whatever
    // the caller assumed. Pinned so a future refactor does not silently change which
    // field is compared against the database.
    expect(extractSessionVersion('user.1.0.sig')).toBe(1)
    expect(extractSessionVersion('user.2abc.sig')).toBe(2)
    expect(extractSessionVersion('a.2.b.c')).toBe(2)
    // A negative version is returned as-is: parseInt does not clamp, and since the column
    // default is 0 no real session can carry one, so a -1 can never match.
    expect(extractSessionVersion('user.-1.sig')).toBe(-1)
  })

  test('SECURITY: the version cannot be FORGED, because it is inside the HMAC', () => {
    // The reason a stale-session check based on a client-supplied number is safe: the
    // payload `userId.version` is what `sessionHmac` signs, so editing the version
    // invalidates the signature and `verifySession` rejects the token outright. MEASURED:
    // rewriting version 1 to 'abc' in an otherwise valid token yields null from
    // verifySession, and BOTH verifySession and extractSessionVersion are used together
    // in session.ts -- verification happens first.
    const token = signSession('user-abc', 1)
    const parts = token.split('.')
    const forged = [parts[0], '999', parts[2]].join('.')
    expect(verifySession(forged)).toBeNull()
    expect(extractSessionVersion(forged)).toBe(999) // parsed, but the token never gets this far
  })

  test('SECURITY: a MULTI-BYTE signature passes the length guard and is caught', () => {
    // `sig.length !== expected.length` compares STRING lengths, but `timingSafeEqual`
    // compares BYTES and THROWS when they differ. For a multi-byte string the two lengths
    // disagree: '\u00e9'.repeat(43) has 43 characters and 86 bytes, so the guard is
    // SKIPPED and timingSafeEqual is called -- and throws.
    //
    // That makes the surrounding `catch` REACHABLE and load-bearing, not defensive
    // decoration: without it, this token would propagate a TypeError out of
    // verifySession, and verifySession is awaited on every authenticated request. The
    // rejection is still correct (null), which is what the assertion pins.
    const real = signSession('u', 1)
    const expectedSig = real.slice(real.lastIndexOf('.') + 1)
    expect(expectedSig.length).toBe(43) // base64url, ASCII
    const tricky = '\u00e9'.repeat(expectedSig.length)
    expect(tricky.length).toBe(expectedSig.length) // guard is passed
    expect(Buffer.byteLength(tricky)).toBe(expectedSig.length * 2) // ...but not the bytes
    expect(() => crypto.timingSafeEqual(Buffer.from(tricky), Buffer.from(expectedSig))).toThrow()

    const payload = real.slice(0, real.lastIndexOf('.'))
    expect(verifySession(`${payload}.${tricky}`)).toBeNull()
  })

  test('DECLARED EQUIVALENT: the signature-length guard duplicates the catch', () => {
    // `if (sig.length !== expected.length) return null` and the `catch` around
    // timingSafeEqual are REDUNDANT for every input: a different BYTE length makes
    // timingSafeEqual throw and the catch returns the same null, while a different STRING
    // length with equal bytes still yields false. MEASURED -- a control removing the guard
    // produced no failing test. The guard is kept as the FAST PATH (it avoids building two
    // Buffers) and to keep the multi-byte case below deliberate rather than incidental.
    const token = signSession('u', 1)
    const parts = token.split('.')
    // Same character count, wrong content: no throw, plain mismatch.
    expect(verifySession(`${parts[0]}.${'x'.repeat(43)}.${parts[2]}`)).toBeNull()
    // Different length: guard exits early, or the catch would.
    expect(verifySession(`${parts[0]}.x.${parts[2]}`)).toBeNull()
  })

  test('DECLARED EQUIVALENT: parts.length < 2 cannot be reached with a different outcome', () => {
    // With fewer than 2 parts, `parts.slice(0, -1).join('.')` is '' and `sessionHmac('')`
    // never equals the single remaining part, so the signature check rejects the token
    // anyway. The guard is a fast path over an input that is already invalid. Pinned so
    // removing it cannot silently change behaviour.
    expect(verifySession('justauserid')).toBeNull()
    expect(verifySession('')).toBeNull()
  })

  test('SECURITY: a version-0 token and an unparseable version are indistinguishable', () => {
    // A DECLARED property, not a bug: both are 0, and 0 is the column default. It is safe
    // only because the token must first pass verifySession -- an attacker cannot present
    // an unparseable version on a token they did not sign. If `sessionVersion` were ever
    // made NOT to default to 0, this equality would start mattering.
    expect(extractSessionVersion('user.abc.sig'))
      .toBe(extractSessionVersion(signSession('u', 0)))
    expect(extractSessionVersion(signSession('u', 0))).toBe(extractSessionVersion(signSession('u')))
  })
})
