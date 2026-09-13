// Licence validation is the paywall for an on-prem deployment, so the signature
// check is the one thing that must not be assumed. Every test here drives the REAL
// Ed25519 verifier with a keypair generated in-process — no stubbed verifySignature,
// because a stubbed verifier would pass whatever the code did.
//
// LICENSE_SIGNING_PUBLIC_KEY is read at MODULE LOAD. bun hoists static imports above
// every statement, so the module must be reached by a TOP-LEVEL AWAIT after the env
// is set. A static `import './license-client'` in this file (or in any file bun runs
// first in the same process) would freeze PUBLIC_KEY_HEX as undefined and silently
// disable verification — the "fail closed" path would then look like a broken
// signature rather than a missing key.
import crypto from 'crypto'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUBLIC_KEY_HEX = publicKey.export({ format: 'der', type: 'spki' }).toString('hex')
process.env.LICENSE_SIGNING_PUBLIC_KEY = PUBLIC_KEY_HEX

const { validateLicense, deactivateMachine } = await import('./license-client')

const realFetch = global.fetch
const realEnv = {
  url: process.env.LICENSE_VALIDATOR_URL,
  product: process.env.LICENSE_PRODUCT,
}

let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = []

/** Sign exactly as the validator must: sorted-key JSON without the signature field. */
function sign(body: Record<string, unknown>): string {
  const canonical = JSON.stringify(body, Object.keys(body).sort())
  return crypto.sign(null, Buffer.from(canonical), privateKey).toString('hex')
}

/** Reply with a body the client should accept, echoing back the nonce it sent. */
function replySigned(build: (nonce: string) => Record<string, unknown>) {
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init })
    const nonce = JSON.parse(String(init?.body)).nonce as string
    const body = build(nonce)
    return new Response(JSON.stringify({ ...body, signature: sign(body) }), { status: 200 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  fetchCalls = []
  delete process.env.LICENSE_VALIDATOR_URL
  delete process.env.LICENSE_PRODUCT
})
afterEach(() => {
  global.fetch = realFetch
  if (realEnv.url === undefined) delete process.env.LICENSE_VALIDATOR_URL
  else process.env.LICENSE_VALIDATOR_URL = realEnv.url
  if (realEnv.product === undefined) delete process.env.LICENSE_PRODUCT
  else process.env.LICENSE_PRODUCT = realEnv.product
})

describe('validateLicense — the happy path', () => {
  test('a correctly signed, valid response is accepted with the plan', async () => {
    replySigned((nonce) => ({ valid: true, plan: 'enterprise', expires_at: '2030-01-01', message: 'ok', nonce }))
    const r = await validateLicense('LIC-123', 'org:host1')
    expect(r.valid).toBe(true)
    expect(r.plan).toBe('enterprise')
    expect(r.expiresAt).toBe('2030-01-01')
    expect(r.signatureVerified).toBe(true)
  })

  test('the request carries the key, machine, product and a fresh nonce', async () => {
    replySigned((nonce) => ({ valid: true, plan: 'pro', expires_at: null, message: 'ok', nonce }))
    await validateLicense('KEY-A', 'slug:host')
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    expect(body.license_key).toBe('KEY-A')
    expect(body.machine_id).toBe('slug:host')
    expect(body.product).toBe('ryasai-chatbot')
    // The nonce must be unpredictable and long enough to make replay useless.
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(String(fetchCalls[0].url)).toBe('http://localhost:9000/api/v1/license/validate')
  })

  test('LICENSE_VALIDATOR_URL is used, with a trailing slash trimmed', async () => {
    process.env.LICENSE_VALIDATOR_URL = 'https://licence.example.com/'
    replySigned((nonce) => ({ valid: true, plan: null, expires_at: null, message: '', nonce }))
    await validateLicense('K', 'm')
    // A doubled slash would 404 on many reverse proxies.
    expect(String(fetchCalls[0].url)).toBe('https://licence.example.com/api/v1/license/validate')
  })

  test('LICENSE_PRODUCT overrides the default', async () => {
    process.env.LICENSE_PRODUCT = 'other-product'
    replySigned((nonce) => ({ valid: true, plan: null, expires_at: null, message: '', nonce }))
    await validateLicense('K', 'm')
    expect(JSON.parse(String(fetchCalls[0].init?.body)).product).toBe('other-product')
  })
})

describe('validateLicense — signature and nonce are the paywall', () => {
  test('an UNSIGNED response is rejected even when it claims valid', async () => {
    replySigned((nonce) => ({ valid: true, plan: 'enterprise', expires_at: null, message: 'ok', nonce }))
    // Remove the signature the helper added, to model a validator that forgot to sign.
    const signedFetch = global.fetch
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const res = await (signedFetch as unknown as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init)
      const body = JSON.parse(await res.text())
      delete body.signature
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const r = await validateLicense('K', 'm')
    // Without this, anyone who can answer on the wire grants themselves a licence.
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
    expect(r.message).toContain('Signature verification failed')
  })

  test('a response signed by the WRONG key is rejected', async () => {
    const other = crypto.generateKeyPairSync('ed25519')
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init })
      const nonce = JSON.parse(String(init?.body)).nonce as string
      const body = { valid: true, plan: 'enterprise', expires_at: null, message: 'ok', nonce }
      const canonical = JSON.stringify(body, Object.keys(body).sort())
      const sig = crypto.sign(null, Buffer.from(canonical), other.privateKey).toString('hex')
      return new Response(JSON.stringify({ ...body, signature: sig }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a TAMPERED field invalidates an otherwise genuine signature', async () => {
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init })
      const nonce = JSON.parse(String(init?.body)).nonce as string
      const body = { valid: false, plan: null, expires_at: null, message: 'expired', nonce }
      const sig = sign(body)
      // The signature was made over valid:false; flip it to true in flight.
      return new Response(JSON.stringify({ ...body, valid: true, plan: 'enterprise', signature: sig }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await validateLicense('K', 'm')
    // This is the whole point of signing the payload: a MITM cannot upgrade a
    // refusal into an entitlement by editing one field.
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a signature over a DIFFERENT nonce is rejected (replay defence)', async () => {
    replySigned(() => ({ valid: true, plan: 'pro', expires_at: null, message: 'ok', nonce: 'f'.repeat(32) }))
    const r = await validateLicense('K', 'm')
    // A previously captured response must not validate a later request.
    expect(r.valid).toBe(false)
    expect(r.message).toContain('Signature verification failed')
  })

  test('a missing nonce in the response is rejected', async () => {
    replySigned((nonce) => ({ valid: true, plan: 'pro', expires_at: null, message: 'ok', nonce: undefined as unknown as string }))
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
  })

  test('an EMPTY signature is rejected even when the nonce is correct', async () => {
    // NOTE, measured: this case does NOT isolate the `if (!signature)` guard. It was
    // originally written to, and the negative control disproved it — deleting that
    // guard leaves the test passing, because crypto.verify() itself returns false for
    // an empty, one-byte and non-hex signature alike (checked directly against
    // node:crypto). The guard is a cheap short-circuit for a case the verifier
    // already handles, so no input can distinguish it. Kept as a behavioural
    // assertion of the contract (nonce right + signature absent => refused), not as
    // a control over that line.
    replySigned((nonce) => ({ valid: true, plan: 'pro', expires_at: null, message: 'ok', nonce, signatureOverride: '' }))
    // replySigned appends the real signature; overwrite with an empty one so the
    // nonce is right and ONLY the signature is absent.
    const signedFetch = global.fetch
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const res = await (signedFetch as unknown as (a: unknown, b?: RequestInit) => Promise<Response>)(input, init)
      const body = JSON.parse(await res.text())
      body.signature = ''
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('a garbage signature hex is rejected, not thrown', async () => {
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init })
      const nonce = JSON.parse(String(init?.body)).nonce as string
      return new Response(JSON.stringify({ valid: true, plan: 'pro', nonce, signature: 'not-hex-at-all' }), { status: 200 })
    }) as unknown as typeof fetch
    // crypto.verify throws on malformed input; the client must absorb that and fail
    // closed rather than 500 the request handler.
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('an HTTP error is surfaced with its status and not treated as valid', async () => {
    global.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    const r = await validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.message).toContain('503')
    expect(r.signatureVerified).toBe(false)
  })

  test('missing optional fields become null / empty, never undefined', async () => {
    replySigned((nonce) => ({ valid: true, nonce }))
    const r = await validateLicense('K', 'm')
    // Persisted to the DB, so undefined would be an implied column write.
    expect(r.plan).toBeNull()
    expect(r.expiresAt).toBeNull()
    expect(r.message).toBe('')
    expect(r.signatureVerified).toBe(true)
  })
})

describe('deactivateMachine', () => {
  test('returns the server verdict on success', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    expect(await deactivateMachine('K', 'm')).toBe(true)
  })

  test('a rejected deactivation reports false', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as unknown as typeof fetch
    expect(await deactivateMachine('K', 'm')).toBe(false)
  })

  test('an HTTP error is false, not a thrown error', async () => {
    global.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    expect(await deactivateMachine('K', 'm')).toBe(false)
  })

  test('a network failure is false, so callers can log and continue', async () => {
    global.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await deactivateMachine('K', 'm')).toBe(false)
  })

  test('it sends key, machine and product but NO nonce (no signature to bind)', async () => {
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch
    await deactivateMachine('KEY-Z', 'slug:host')
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    expect(body.license_key).toBe('KEY-Z')
    expect(body.machine_id).toBe('slug:host')
    expect(body.product).toBe('ryasai-chatbot')
    expect(body.nonce).toBeUndefined()
  })
})
