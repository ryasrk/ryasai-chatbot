import crypto from 'crypto'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  licenseStatusFromResult,
  licenseUpdateFromResult,
  getLockdownReason,
  isWithinGracePeriod,
  generateMachineId,
  validateLicense,
  type LicenseValidationResult,
} from './license-client'

function result(partial: Partial<LicenseValidationResult>): LicenseValidationResult {
  return {
    valid: false,
    plan: null,
    expiresAt: null,
    message: '',
    signatureVerified: false,
    ...partial,
  }
}

describe('licenseStatusFromResult', () => {
  test('signed + valid → valid', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: true, valid: true }))).toBe('valid')
  })

  test('signed + invalid + message "expired" → expired', () => {
    expect(
      licenseStatusFromResult(result({ signatureVerified: true, valid: false, message: 'License has expired.' })),
    ).toBe('expired')
  })

  test('signed + invalid + message "deactivated" → suspended', () => {
    expect(
      licenseStatusFromResult(
        result({ signatureVerified: true, valid: false, message: 'License has been deactivated.' }),
      ),
    ).toBe('suspended')
  })

  test('signed + invalid + other message → invalid', () => {
    expect(
      licenseStatusFromResult(
        result({ signatureVerified: true, valid: false, message: 'License key not found.' }),
      ),
    ).toBe('invalid')
  })

  test('unsigned (network error) → unreachable', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: false, valid: false }))).toBe('unreachable')
  })

  test('unsigned but valid=true (should not happen, but defensive) → unreachable', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: false, valid: true }))).toBe('unreachable')
  })
})

describe('getLockdownReason', () => {
  test('valid → null (no lockdown)', () => {
    expect(getLockdownReason('valid', null)).toBeNull()
  })

  test('none → null (no lockdown)', () => {
    expect(getLockdownReason('none', null)).toBeNull()
  })

  test('expired → expired', () => {
    expect(getLockdownReason('expired', null)).toBe('expired')
  })

  test('invalid → expired', () => {
    expect(getLockdownReason('invalid', null)).toBe('expired')
  })

  test('suspended → deactivated', () => {
    expect(getLockdownReason('suspended', null)).toBe('deactivated')
  })

  test('unpaid → unpaid (licenseless signup, locked until purchase)', () => {
    expect(getLockdownReason('unpaid', null)).toBe('unpaid')
  })

  test('unreachable + within grace → null', () => {
    const recent = new Date(Date.now() - 60_000)
    expect(getLockdownReason('unreachable', recent)).toBeNull()
  })

  test('unreachable + beyond grace → unreachable', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // 8 days > 7-day default grace
    expect(getLockdownReason('unreachable', old)).toBe('unreachable')
  })

  test('unreachable + null validatedAt → unreachable', () => {
    expect(getLockdownReason('unreachable', null)).toBe('unreachable')
  })

  test('unknown status → null (fail open)', () => {
    expect(getLockdownReason('something-weird', null)).toBeNull()
  })
})

describe('isWithinGracePeriod', () => {
  test('null validatedAt → false', () => {
    expect(isWithinGracePeriod(null)).toBe(false)
  })

  test('recent validatedAt → true', () => {
    expect(isWithinGracePeriod(new Date(Date.now() - 60_000))).toBe(true)
  })

  test('old validatedAt → false', () => {
    expect(isWithinGracePeriod(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))).toBe(false)
  })
})

describe('generateMachineId', () => {
  test('slug + hostname → stable composite id', () => {
    const id = generateMachineId('acme')
    expect(id).toMatch(/^acme:/)
  })

  test('same slug + same hostname → same id', () => {
    expect(generateMachineId('acme')).toBe(generateMachineId('acme'))
  })

  test('different slug → different id', () => {
    expect(generateMachineId('acme')).not.toBe(generateMachineId('globex'))
  })
})

// ---------------------------------------------------------------------------
// licenseUpdateFromResult
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): this four-field update payload was copy-pasted across
// four call sites (periodic revalidation, post-issue validation, admin
// revalidate route, retry route). They had already drifted — license-issue.ts
// wrote `result.plan ?? 'flat'`, the other three wrote bare `result.plan` — so
// the same signed response produced different DB writes depending on which code
// path handled it. These tests pin the two rules the helper now owns.
describe('licenseUpdateFromResult — verified+valid is the only path that advances state', () => {
  test('verified + valid sets status, plan, validatedAt and expiry', () => {
    const out = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: 'flat', expiresAt: '2030-01-01T00:00:00.000Z' }),
    )
    expect(out.licenseStatus).toBe('valid')
    expect(out.licensePlan).toBe('flat')
    expect(out.licenseValidatedAt).toBeInstanceOf(Date)
    expect(out.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('unsigned/unreachable NEVER advances licenseValidatedAt', () => {
    // Advancing validatedAt here would silence the 7-day grace window and lock
    // out a paying customer during a validator outage.
    const out = licenseUpdateFromResult(result({ message: 'timeout' }))
    expect(out.licenseStatus).toBe('unreachable')
    expect(out.licenseValidatedAt).toBeUndefined()
  })

  test('unsigned/unreachable NEVER wipes a known expiry', () => {
    // A network blip must not erase expiry metadata — a later grace check would
    // then see no expiry at all.
    const out = licenseUpdateFromResult(result({ message: 'timeout', expiresAt: '2030-01-01T00:00:00.000Z' }))
    expect(out.licenseExpiresAt).toBeUndefined()
    expect(out.licensePlan).toBeUndefined()
  })

  test('signed-but-expired does not advance validatedAt but keeps expiry', () => {
    const out = licenseUpdateFromResult(
      result({ valid: false, signatureVerified: true, message: 'license expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
    )
    expect(out.licenseStatus).toBe('expired')
    expect(out.licenseValidatedAt).toBeUndefined()
    expect(out.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('planFallback applies ONLY when the signed response omits a plan', () => {
    // The drift that motivated the helper: post-issue validation must not lose
    // the plan, and an admin revalidate must not invent one.
    const noPlan = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: null }),
      { planFallback: 'flat' },
    )
    expect(noPlan.licensePlan).toBe('flat')

    const withPlan = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: 'enterprise' }),
      { planFallback: 'flat' },
    )
    expect(withPlan.licensePlan).toBe('enterprise')
  })

  test('unsigned responses never write a plan, even with a fallback', () => {
    // An unsigned response is untrusted — it must not be able to set a plan.
    const out = licenseUpdateFromResult(result({ plan: 'enterprise' }), { planFallback: 'flat' })
    expect(out.licensePlan).toBeUndefined()
  })

  test('no planFallback leaves plan untouched when response omits it', () => {
    const out = licenseUpdateFromResult(result({ valid: true, signatureVerified: true, plan: null }))
    expect(out.licensePlan).toBeUndefined()
  })

  test('undefined fields mean "leave previous value" for Prisma update', () => {
    // Prisma ignores `undefined` in update data, which is what makes the
    // conditional spreads safe. Assert we emit undefined, not null.
    const out = licenseUpdateFromResult(result({ message: 'blip' }))
    expect(Object.values(out).filter((v) => v === null)).toHaveLength(0)
  })
})

/**
 * validateLicense's fail-closed refusals, reached by changing the env AT CALL TIME.
 *
 * These used to require a query-string import (`./license-client?badkey`), which creates a SECOND,
 * separate module instance -- so the assertions held but the LINES never appeared in any coverage
 * report, and the module-load constant meant a key set after boot was silently ignored. Reading the
 * key inside getPublicKey fixes both: the branches are now ordinary call-time paths.
 */
describe('validateLicense — fail closed on an unusable signing key', () => {
  const realKey = process.env.LICENSE_SIGNING_PUBLIC_KEY
  const realFetch = global.fetch

  function jsonResponse(body: Record<string, unknown>): void {
    global.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  }

  afterEach(() => {
    if (realKey === undefined) delete process.env.LICENSE_SIGNING_PUBLIC_KEY
    else process.env.LICENSE_SIGNING_PUBLIC_KEY = realKey
    global.fetch = realFetch
  })

  test('NO key configured: a valid-looking response is still refused', async () => {
    delete process.env.LICENSE_SIGNING_PUBLIC_KEY
    jsonResponse({ valid: true, plan: 'enterprise', message: 'ok', nonce: 'a'.repeat(32) })
    const r = await validateLicense('K', 'm')
    // Shipping without a key must never mean "everything is licensed".
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
    expect(r.message).toContain('Signature verification failed')
  })

  test('a MALFORMED key: createPublicKey throws and the client ABSORBS it', async () => {
    // The catch this exercises is the one that matters most: an exception escaping here would 500
    // the request handler instead of denying the licence. 'deadbeef' is valid hex but not a DER SPKI.
    process.env.LICENSE_SIGNING_PUBLIC_KEY = 'deadbeef'
    jsonResponse({ valid: true, plan: 'enterprise', message: 'ok', nonce: 'a'.repeat(32), signature: 'ab' })
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a key that is valid DER but the WRONG TYPE is also refused, not thrown', async () => {
    // An Ed25519 private key (PKCS8) parses fine as DER but is not an spki public key, so this
    // covers a different parse failure from 'deadbeef' (which fails on the hex/DER shape itself).
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('hex')
    jsonResponse({ valid: true, nonce: 'a'.repeat(32), signature: 'ab' })
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a key set AFTER boot is honoured (the reason the read moved to call time)', async () => {
    // With a module-load constant this returned "no key" forever. Now the key is read per call, so a
    // key injected by a config reload, a secret mount or a test takes effect immediately.
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')
    // Signature is bogus, so verification must FAIL -- but it must fail as a SIGNATURE failure
    // (key was parsed and used) rather than as an unusable-key refusal.
    jsonResponse({ valid: true, nonce: 'a'.repeat(32), signature: '00'.repeat(64) })
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a bogus signature with a GOOD key is refused without throwing', async () => {
    // The catch around crypto.verify: verify() can throw on a malformed signature length.
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')
    jsonResponse({ valid: true, nonce: 'a'.repeat(32), signature: 'zz' })
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a FULLY VALID signed response is ACCEPTED — the control for every refusal above', async () => {
    // Without this, every "must refuse" test above could pass for the wrong reason: the key is
    // unparseable, the nonce never matches, or the signature is junk, so the refusals prove nothing
    // about the SPECIFIC guard they name. Here we sign the canonical payload with a real Ed25519
    // private key and echo the nonce the client sent, so acceptance is the only correct outcome.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')

    let sentNonce = ''
    global.fetch = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { nonce: string }
      sentNonce = sent.nonce
      const payload = { valid: true, plan: 'flat', expires_at: '2030-01-01', message: 'ok', nonce: sentNonce }
      const canonical = JSON.stringify(payload, Object.keys(payload).sort())
      const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('hex')
      return new Response(JSON.stringify({ ...payload, signature }), { status: 200 })
    }) as unknown as typeof fetch

    const r = await validateLicense('K', 'm')
    expect(sentNonce).toHaveLength(32)
    expect(r.valid).toBe(true)
    expect(r.signatureVerified).toBe(true)
    expect(r.plan).toBe('flat')
    expect(r.expiresAt).toBe('2030-01-01')
  })

  test('a valid signature over the WRONG nonce is refused (replay protection)', async () => {
    // Same real keypair and a REAL signature, but the response echoes a different nonce. Only the
    // nonce guard can reject this -- the signature itself is cryptographically valid.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')

    global.fetch = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { nonce: string }
      // A DIFFERENT but well-formed nonce.
      const replayNonce = sent.nonce.split('').reverse().join('')
      const payload = { valid: true, plan: 'flat', message: 'ok', nonce: replayNonce }
      const canonical = JSON.stringify(payload, Object.keys(payload).sort())
      const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('hex')
      return new Response(JSON.stringify({ ...payload, signature }), { status: 200 })
    }) as unknown as typeof fetch

    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
    expect(r.message).toContain('Signature verification failed')
  })

  test('a TAMPERED field invalidates an otherwise real signature', async () => {
    // The signature is genuine but the client recomputes canonical JSON from the RECEIVED payload, so
    // flipping `valid` after signing must break it. This is what makes the canonicalisation load-bearing.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')

    global.fetch = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { nonce: string }
      const signedPayload = { valid: false, plan: 'flat', message: 'nope', nonce: sent.nonce }
      const canonical = JSON.stringify(signedPayload, Object.keys(signedPayload).sort())
      const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('hex')
      // Ship a DIFFERENT valid value than the one that was signed.
      return new Response(
        JSON.stringify({ ...signedPayload, valid: true, signature }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a MISSING signature field is refused even when the key is perfectly good', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')
    jsonResponse({ valid: true, plan: 'flat', message: 'ok', nonce: 'a'.repeat(32) })
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a NONCE mismatch is refused even with a structurally fine signature', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    process.env.LICENSE_SIGNING_PUBLIC_KEY = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex')
    jsonResponse({ valid: true, nonce: 'b'.repeat(32), signature: '00'.repeat(64) })
    const r = await validateLicense('K', 'm')
    // Replay protection: the response must echo the nonce we SENT.
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })
})
