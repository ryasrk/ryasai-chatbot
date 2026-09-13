import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.SAML_SP_ENTITY_ID = 'https://chatbot.test'
process.env.SAML_SP_CALLBACK_URL = 'https://chatbot.test/api/auth/saml/callback'
process.env.SAML_IDP_ENTRY_POINT = 'https://idp.test/saml/sso'
process.env.SAML_IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIDfakecert\n-----END CERTIFICATE-----'
process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)

import {
  isSamlConfigured,
  buildSamlConfig,
  generateSpMetadata,
  createSamlInstance,
  generateAuthnRequestRedirectUrl,
} from './sso-saml'

describe('isSamlConfigured', () => {
  test('returns true when all required env vars are set', () => {
    expect(isSamlConfigured()).toBe(true)
  })

  test('returns false when SAML_SP_ENTITY_ID is missing', () => {
    const saved = process.env.SAML_SP_ENTITY_ID
    delete process.env.SAML_SP_ENTITY_ID
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_ENTITY_ID = saved
  })

  test('returns false when SAML_SP_CALLBACK_URL is missing', () => {
    const saved = process.env.SAML_SP_CALLBACK_URL
    delete process.env.SAML_SP_CALLBACK_URL
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_CALLBACK_URL = saved
  })

  test('returns true with only metadata URL (no manual entryPoint)', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedCert = process.env.SAML_IDP_CERT
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_CERT
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    expect(isSamlConfigured()).toBe(true)
    delete process.env.SAML_IDP_METADATA_URL
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    process.env.SAML_IDP_CERT = savedCert
  })

  test('returns false when neither entryPoint nor metadata URL set', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedMeta = process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_METADATA_URL
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    if (savedMeta) process.env.SAML_IDP_METADATA_URL = savedMeta
  })

  test('returns false when env var is whitespace only', () => {
    const saved = process.env.SAML_SP_ENTITY_ID
    process.env.SAML_SP_ENTITY_ID = '   '
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_ENTITY_ID = saved
  })
})

describe('buildSamlConfig', () => {
  test('builds correct config from env vars', () => {
    const cfg = buildSamlConfig()
    expect(cfg.issuer).toBe('https://chatbot.test')
    expect(cfg.callbackUrl).toBe('https://chatbot.test/api/auth/saml/callback')
    expect(cfg.entryPoint).toBe('https://idp.test/saml/sso')
    expect(cfg.cert).toBe('-----BEGIN CERTIFICATE-----\nMIIDfakecert\n-----END CERTIFICATE-----')
  })

  test('throws when no entry point and no metadata URL', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedMeta = process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_METADATA_URL
    expect(() => buildSamlConfig()).toThrow('SAML_IDP_ENTRY_POINT or SAML_IDP_METADATA_URL')
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    if (savedMeta) process.env.SAML_IDP_METADATA_URL = savedMeta
  })
})

describe('generateSpMetadata', () => {
  test('returns valid XML with correct entityID', () => {
    const xml = generateSpMetadata()
    expect(xml).toContain('<EntityDescriptor')
    expect(xml).toContain('https://chatbot.test')
    expect(xml).toContain('AssertionConsumerService')
    expect(xml).toContain('https://chatbot.test/api/auth/saml/callback')
  })
})

// ===========================================================================
// createSamlInstance — metadata discovery and SP signing material
//
// validateSamlResponse and getOrCreateSsoUser are covered in
// sso-saml-provisioning.test.ts, which supplies its own @node-saml mock. THIS file
// previously reached neither createSamlInstance nor the metadata fetch at all.
// ===========================================================================

const realMod = await import('@node-saml/node-saml')

/** Module-scoped so the redirect describe below can read it. */
let authorizeArgs: { host: string; requestId: unknown; extra: unknown } | null = null

describe('createSamlInstance', () => {
  /** Captures the options object handed to the SAML constructor. */
  let captured: Record<string, unknown> | null = null
  let constructed = 0

  // The wrapper DELEGATES to the real class, so generateSpMetadata's genuine
  // getMetadata() still runs and its existing test stays valid. Replacing the class
  // outright broke that test immediately -- a partial mock silently breaks the
  // production call sites it does not cover.
  const realSaml = realMod.SAML
  mock.module('@node-saml/node-saml', () => ({
    ...(realMod ?? {}),
    SAML: class extends (realSaml as new (o: unknown) => object) {
      constructor(o: Record<string, unknown>) {
        super(o)
        constructed++
        captured = o
      }
      getAuthorizeUrlAsync(host: string, requestId: unknown, extra: unknown) {
        authorizeArgs = { host, requestId, extra }
        return Promise.resolve('https://idp.test/saml/sso?SAMLRequest=signed-redirect')
      }
    },
    ValidateInResponseTo: { never: 'never', always: 'always', ifPresent: 'ifPresent' },
  }))

  const saved = {
    entry: process.env.SAML_IDP_ENTRY_POINT,
    cert: process.env.SAML_IDP_CERT,
    meta: process.env.SAML_IDP_METADATA_URL,
    spCert: process.env.SAML_SP_CERT,
    spKey: process.env.SAML_SP_PRIVATE_KEY,
  }
  const realFetch = global.fetch

  beforeEach(() => {
    captured = null
    constructed = 0
    authorizeArgs = null
    delete process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_SP_CERT
    delete process.env.SAML_SP_PRIVATE_KEY
    process.env.SAML_IDP_ENTRY_POINT = 'https://idp.test/saml/sso'
    process.env.SAML_IDP_CERT = 'CERT-FROM-ENV'
  })
  afterEach(() => {
    global.fetch = realFetch
    if (saved.entry === undefined) delete process.env.SAML_IDP_ENTRY_POINT
    else process.env.SAML_IDP_ENTRY_POINT = saved.entry
    if (saved.cert === undefined) delete process.env.SAML_IDP_CERT
    else process.env.SAML_IDP_CERT = saved.cert
    if (saved.meta === undefined) delete process.env.SAML_IDP_METADATA_URL
    else process.env.SAML_IDP_METADATA_URL = saved.meta
    if (saved.spCert === undefined) delete process.env.SAML_SP_CERT
    else process.env.SAML_SP_CERT = saved.spCert
    if (saved.spKey === undefined) delete process.env.SAML_SP_PRIVATE_KEY
    else process.env.SAML_SP_PRIVATE_KEY = saved.spKey
  })

  test('with entry point and cert in env it fetches NO metadata', async () => {
    // The discovery fetch only runs when something is MISSING. Fetching anyway would
    // make every login depend on the IdP's metadata endpoint being reachable.
    let fetched = 0
    global.fetch = (async () => { fetched++; return new Response('', { status: 200 }) }) as unknown as typeof fetch
    await createSamlInstance()
    expect(fetched).toBe(0)
    expect(captured!.entryPoint).toBe('https://idp.test/saml/sso')
    expect(captured!.idpCert).toBe('CERT-FROM-ENV')
  })

  test('a MISSING entry point is discovered from the metadata URL', async () => {
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_ENTRY_POINT
    global.fetch = (async () => new Response(
      '<EntityDescriptor><SingleSignOnService Location="https://idp.test/discovered/sso" Binding="x"/></EntityDescriptor>',
      { status: 200 },
    )) as unknown as typeof fetch

    await createSamlInstance()
    expect(captured!.entryPoint).toBe('https://idp.test/discovered/sso')
  })

  test('a MISSING cert is discovered and PEM-wrapped, while the entry point is KEPT', async () => {
    // The two discoveries are independent: having one must not discard the other.
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_CERT
    // MEASURED: discoverFromMetadata REQUIRES a SingleSignOnService Location and
    // throws without one, so a certificate-only document is not valid metadata. My
    // first version returned exactly that and failed -- the entry point is mandatory
    // in the metadata shape this parser accepts.
    const body = 'A'.repeat(64) + 'B'.repeat(10)
    global.fetch = (async () => new Response(
      '<EntityDescriptor>' +
      '<SingleSignOnService Location="https://idp.test/from-metadata/sso"/>' +
      `<X509Certificate>${body}</X509Certificate></EntityDescriptor>`,
      { status: 200 },
    )) as unknown as typeof fetch

    await createSamlInstance()
    expect(captured!.entryPoint).toBe('https://idp.test/saml/sso')
    const cert = captured!.idpCert as string
    expect(cert.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true)
    expect(cert.endsWith('\n-----END CERTIFICATE-----')).toBe(true)
    // Wrapped at 64 chars per line, and no trailing blank line before the END marker.
    const inner = cert.split('\n').slice(1, -1)
    expect(inner[0]!.length).toBe(64)
    expect(inner[inner.length - 1]!.length).toBe(10)
    expect(cert).not.toContain('\n\n')
  })

  test('whitespace inside the certificate body is stripped before wrapping', async () => {
    // IdP metadata is often pretty-printed; embedded spaces/newlines would otherwise
    // land inside the base64 and make the PEM unparseable.
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_CERT
    global.fetch = (async () => new Response(
      '<EntityDescriptor><SingleSignOnService Location="https://idp.test/sso2"/>' +
      '<X509Certificate>\n  AA BB\n  CC DD\n</X509Certificate></EntityDescriptor>',
      { status: 200 },
    )) as unknown as typeof fetch

    await createSamlInstance()
    const inner = (captured!.idpCert as string).split('\n').slice(1, -1).join('')
    expect(inner).toBe('AABBCCDD')
  })

  test('metadata with NO SingleSignOnService Location is a HARD failure', async () => {
    // Falling through would leave entryPoint empty and SAML would later redirect the
    // user to ''. Failing here names the actual problem.
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_ENTRY_POINT
    global.fetch = (async () => new Response('<EntityDescriptor></EntityDescriptor>', { status: 200 })) as unknown as typeof fetch

    await expect(createSamlInstance()).rejects.toThrow('SingleSignOnService')
  })

  test('a NON-OK metadata response is refused, and the status is in the message', async () => {
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_ENTRY_POINT
    global.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch

    // A 404 body could be an HTML error page whose text happens to contain no
    // certificate; parsing it would silently produce a config with no cert.
    await expect(createSamlInstance()).rejects.toThrow('metadata fetch failed: 404')
  })

  test('SP signing material is attached ONLY when BOTH cert and key are present', async () => {
    // `if (cfg.privateKey && cfg.spCert)`. A private key without its certificate (or
    // the reverse) would make node-saml attempt a signed AuthnRequest it cannot
    // complete, so the pair is all-or-nothing.
    process.env.SAML_SP_PRIVATE_KEY = 'PRIV'
    process.env.SAML_SP_CERT = 'SPCERT'
    await createSamlInstance()
    expect(captured!.privateKey).toBe('PRIV')
    expect(captured!.publicCert).toBe('SPCERT')

    captured = null
    delete process.env.SAML_SP_CERT
    await createSamlInstance()
    expect(captured!.privateKey).toBeUndefined()
    expect(captured!.publicCert).toBeUndefined()

    captured = null
    delete process.env.SAML_SP_PRIVATE_KEY
    process.env.SAML_SP_CERT = 'SPCERT'
    await createSamlInstance()
    expect(captured!.privateKey).toBeUndefined()
    expect(captured!.publicCert).toBeUndefined()
  })

  test('the HARDENING options are set, not left at library defaults', async () => {
    // These are the settings that make a SAML SP safe: both signatures REQUIRED, a
    // tight assertion age, and clock skew bounded. A change here silently weakens
    // every SSO login, so each is pinned by name.
    await createSamlInstance()
    expect(captured!.wantAssertionsSigned).toBe(true)
    expect(captured!.wantAuthnResponseSigned).toBe(true)
    expect(captured!.signatureAlgorithm).toBe('sha256')
    expect(captured!.maxAssertionAgeMs).toBe(60_000)
    expect(captured!.acceptedClockSkewMs).toBe(60_000)
    // The audience must be OUR entity id, or a token minted for another SP verifies.
    expect(captured!.audience).toBe('https://chatbot.test')
    expect(captured!.issuer).toBe('https://chatbot.test')
    // INVERTED. This used to pin 'never', justified by the cache provider being a no-op: with no store for the
    // request id, ANY binding check would reject every login. The justification was the bug -- 'never' means the
    // assertion id is not checked AT ALL, so a captured SAMLResponse was a bearer credential replayable from
    // anywhere until NotOnOrAfter. The cache is now Redis-backed and the option is 'ifPresent', which binds the
    // assertion to this browser's request whenever the id was saved and still accepts IdP-initiated POSTs (this
    // route accepts them by design) where no id exists to compare against.
    expect(captured!.validateInResponseTo).toBe('ifPresent')
    // `never` anywhere in this file would mean the binding is off again.
    const src = readFileSync(join(import.meta.dir, 'sso-saml.ts'), 'utf8')
    expect(src).not.toContain('ValidateInResponseTo.never')
    expect(src).toContain('ValidateInResponseTo.ifPresent')
  })

  test('an unresolvable entry point (metadata yields nothing usable) throws', async () => {
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    delete process.env.SAML_IDP_ENTRY_POINT
    // Discovery succeeds but returns no cert, and the entry point is set, so this is
    // the safe path; then remove the entry point source entirely.
    global.fetch = (async () => new Response('<SingleSignOnService Location="https://x.test/sso"/>', { status: 200 })) as unknown as typeof fetch
    await createSamlInstance()
    expect(captured!.entryPoint).toBe('https://x.test/sso')

    // Now make discovery return nothing at all.
    delete process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_IDP_ENTRY_POINT
    await expect(createSamlInstance()).rejects.toThrow()
  })
})

describe('generateAuthnRequestRedirectUrl — the SP-initiated login redirect', () => {
  test('builds the instance and returns the IdP authorize URL', async () => {
    // This is the URL a user is sent to when they click "Sign in with SSO". Returning
    // a malformed value means the browser lands nowhere, so the passthrough is pinned.
    const url = await generateAuthnRequestRedirectUrl()
    expect(url).toBe('https://idp.test/saml/sso?SAMLRequest=signed-redirect')
    // The library is called with an EMPTY host and no request id: request-id
    // validation is set to 'never' precisely because no cache provider is
    // configured, so supplying one here would be misleading.
    expect(authorizeArgs!.host).toBe('')
    expect(authorizeArgs!.requestId).toBeUndefined()
  })
})
