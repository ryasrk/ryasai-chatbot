// The two branches of getPublicKey that a HAPPY-PATH test can never reach:
// no key configured, and a key that will not parse. Both must fail closed.
//
// They are reachable only with the env set BEFORE the module is first evaluated,
// so this file resets the module registry per case and imports fresh. A static
// import would capture PUBLIC_KEY_HEX once and make both branches untestable.
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

const realFetch = global.fetch
const realKey = process.env.LICENSE_SIGNING_PUBLIC_KEY

beforeEach(() => {})
afterEach(() => {
  global.fetch = realFetch
  if (realKey === undefined) delete process.env.LICENSE_SIGNING_PUBLIC_KEY
  else process.env.LICENSE_SIGNING_PUBLIC_KEY = realKey
})

/** Import a pristine copy of the module with the env as it stands right now. */
async function freshImport(cacheBust: string) {
  const mod = await import(`./license-client?${cacheBust}`)
  return mod as typeof import('./license-client')
}

describe('getPublicKey — fail closed when the key is unusable', () => {
  test('NO key configured: a valid-looking response is still refused', async () => {
    delete process.env.LICENSE_SIGNING_PUBLIC_KEY
    const mod = await freshImport('nokey')
    global.fetch = (async () => new Response(
      JSON.stringify({ valid: true, plan: 'enterprise', message: 'ok', nonce: 'a'.repeat(32) }),
      { status: 200 },
    )) as unknown as typeof fetch
    const r = await mod.validateLicense('K', 'm')
    // Shipping without a key must never mean "everything is licensed".
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
    expect(r.message).toContain('Signature verification failed')
  })

  test('a MALFORMED key: creation fails and the response is refused, not thrown', async () => {
    process.env.LICENSE_SIGNING_PUBLIC_KEY = 'deadbeef'
    const mod = await freshImport('badkey')
    global.fetch = (async () => new Response(
      JSON.stringify({ valid: true, plan: 'enterprise', message: 'ok', nonce: 'a'.repeat(32), signature: 'ab' }),
      { status: 200 },
    )) as unknown as typeof fetch
    const r = await mod.validateLicense('K', 'm')
    // crypto.createPublicKey throws on this input; the client must absorb it and
    // deny, because an exception here would 500 the request handler instead.
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })

  test('no key but an EMPTY signature: still refused, no crash', async () => {
    delete process.env.LICENSE_SIGNING_PUBLIC_KEY
    const mod = await freshImport('nokey2')
    global.fetch = (async () => new Response(
      JSON.stringify({ valid: true, nonce: 'a'.repeat(32), signature: '' }),
      { status: 200 },
    )) as unknown as typeof fetch
    const r = await mod.validateLicense('K', 'm')
    expect(r.valid).toBe(false)
    expect(r.signatureVerified).toBe(false)
  })
})
