/**
 * GET /api/auth/sso/status
 *
 * WHY THIS FILE EXISTS. This is a PUBLIC, UNAUTHENTICATED endpoint whose only job
 * is to tell the login screen which SSO buttons to render
 * (`src/components/views/login-view.tsx`: `oidcConfigured || samlConfigured` gates
 * the whole SSO section). It is small, so the two things that can go wrong are
 * both invisible in code review:
 *
 *   1. A FALSE POSITIVE makes the login page advertise an SSO button to every user
 *      of an install that has no IdP configured. Clicking it 302s to
 *      /login?error=sso_not_configured, a dead end the user cannot diagnose.
 *   2. A FALSE NEGATIVE hides SSO from a customer who DID configure it -- the
 *      enterprise login path they paid for disappears with no error at all.
 *
 * The two predicates are mocked as RE-EXPORTS OF THE REAL ONES wrapped in a
 * counter, so the assertions still run against the library's actual
 * configured/not-configured semantics (including the whitespace-only case) while
 * the test can prove evaluation count and order.
 *
 * MEASURED GOTCHA, do not "simplify" this back. Two mock shapes hang the whole
 * file with NO output (SIGTERM at the test timeout, which reads as an
 * infrastructure failure rather than a test failure):
 *
 *   1. `mock.module('@/lib/sso', () => ({ ...realSso, isOidcConfigured: () =>
 *      realSso.isOidcConfigured() }))` -- the spread is evaluated after the mock
 *      replaces the registry entry, so it re-exports the mock, and the handler
 *      recurses until the process is killed. The request trace shows
 *      `isOidcConfigured` firing thousands of times.
 *   2. Reading the real function off the imported namespace INSIDE the factory
 *      (`realSso.isOidcConfigured()`) -- on Bun 1.3.14 a prop read inside a
 *      `mock.module` factory re-enters the factory, so the ESM binding resolves to
 *      the mock and recurses the same way.
 *
 * The fix (below) is to capture the real functions into locals BEFORE any
 * `mock.module()` call and close over the LOCALS. The other named exports are
 * passed through as a snapshot object taken in the same pre-mock window.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Real implementations, captured BEFORE any mock.module() call. Everything the
// mock factories below read must already be sitting in a local.
// ---------------------------------------------------------------------------

const realSso = await import('@/lib/sso')
const realSaml = await import('@/lib/sso-saml')

const realIsOidcConfigured = realSso.isOidcConfigured
const realIsSamlConfigured = realSaml.isSamlConfigured

// ---------------------------------------------------------------------------
// Mutable seams ABOVE every mock.module() call.
// ---------------------------------------------------------------------------

/** Every predicate invocation, in order -- proves count and order, not just value. */
let events: string[] = []
let oidcCalls = 0
let samlCalls = 0
/** Forces a predicate to throw -- pins the route's (absent) error handling. */
let oidcThrows: Error | null = null

mock.module('@/lib/sso', () => ({
  isOidcConfigured: () => {
    events.push('isOidcConfigured')
    oidcCalls++
    if (oidcThrows) throw oidcThrows
    return realIsOidcConfigured()
  },
  // The route's transitive imports must all resolve; a partial mock makes a barrel
  // throw "Export named X not found" at import time.
  getOidcConfig: realSso.getOidcConfig,
  buildAuthUrl: realSso.buildAuthUrl,
  exchangeCode: realSso.exchangeCode,
  decodeIdToken: realSso.decodeIdToken,
  verifyIdToken: realSso.verifyIdToken,
  verifyIdTokenRs256: realSso.verifyIdTokenRs256,
  fetchUserInfo: realSso.fetchUserInfo,
  getOrCreateSsoUser: realSso.getOrCreateSsoUser,
  generateStateNonce: realSso.generateStateNonce,
  generateCodeVerifier: realSso.generateCodeVerifier,
  computeCodeChallenge: realSso.computeCodeChallenge,
  resolveSsoOrganizationId: realSso.resolveSsoOrganizationId,
  resetJwksCache: realSso.resetJwksCache,
}))

mock.module('@/lib/sso-saml', () => ({
  isSamlConfigured: () => {
    events.push('isSamlConfigured')
    samlCalls++
    return realIsSamlConfigured()
  },
  buildSamlConfig: realSaml.buildSamlConfig,
  createSamlInstance: realSaml.createSamlInstance,
  generateSpMetadata: realSaml.generateSpMetadata,
  validateSamlResponse: realSaml.validateSamlResponse,
  generateAuthnRequestRedirectUrl: realSaml.generateAuthnRequestRedirectUrl,
  getOrCreateSsoUser: realSaml.getOrCreateSsoUser,
  discoverFromMetadata: realSaml.discoverFromMetadata,
}))

// ---------------------------------------------------------------------------
// Module under test -- dynamic import AFTER the mocks.
// ---------------------------------------------------------------------------
const { GET } = await import('./route')

const OIDC_KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'] as const
const SAML_KEYS = ['SAML_SP_ENTITY_ID', 'SAML_SP_CALLBACK_URL', 'SAML_IDP_ENTRY_POINT', 'SAML_IDP_METADATA_URL'] as const

const savedEnv: Record<string, string | undefined> = {}
for (const k of [...OIDC_KEYS, ...SAML_KEYS]) savedEnv[k] = process.env[k]

function clearProviderEnv() {
  for (const k of [...OIDC_KEYS, ...SAML_KEYS]) delete process.env[k]
}

function setOidc() {
  process.env.OIDC_ISSUER = 'https://idp.test'
  process.env.OIDC_CLIENT_ID = 'client-1'
  process.env.OIDC_REDIRECT_URI = 'https://chatbot.test/api/auth/sso/callback'
}

function setSaml() {
  process.env.SAML_SP_ENTITY_ID = 'https://chatbot.test'
  process.env.SAML_SP_CALLBACK_URL = 'https://chatbot.test/api/auth/saml/callback'
  process.env.SAML_IDP_ENTRY_POINT = 'https://idp.test/saml/sso'
}

/** Single body read: res.text() drains the stream, so a later res.json() throws. */
async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

beforeEach(() => {
  events = []
  oidcCalls = 0
  samlCalls = 0
  oidcThrows = null
  clearProviderEnv()
})

afterEach(() => {
  for (const k of [...OIDC_KEYS, ...SAML_KEYS]) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------------------
// The configuration combinations
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/status -- configuration combinations', () => {
  test('nothing configured -> both false and configured false', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    // The login view keys the entire SSO block off `configured`, so this is what
    // keeps a plain install from rendering a button that leads nowhere.
    expect(await bodyOf(res)).toEqual({ ok: true, oidc: false, saml: false, configured: false })
  })

  test('OIDC only -> oidc true, saml false, configured true', async () => {
    setOidc()
    const res = await GET()
    // `configured: oidc || saml` -- one provider is enough to show the section.
    expect(await bodyOf(res)).toEqual({ ok: true, oidc: true, saml: false, configured: true })
  })

  test('SAML only -> saml true, oidc false, configured true', async () => {
    setSaml()
    const res = await GET()
    expect(await bodyOf(res)).toEqual({ ok: true, oidc: false, saml: true, configured: true })
  })

  test('both configured -> both true, configured true', async () => {
    setOidc()
    setSaml()
    const res = await GET()
    expect(await bodyOf(res)).toEqual({ ok: true, oidc: true, saml: true, configured: true })
  })

  test('partial OIDC config is NOT enough -- all three vars are required', async () => {
    // Dropping one var is the realistic operator mistake (usually the redirect URI).
    // The predicate requires all three; reporting `configured: true` here would send
    // users to a redirect the IdP rejects.
    setOidc()
    delete process.env.OIDC_REDIRECT_URI
    expect(await bodyOf(await GET())).toEqual({ ok: true, oidc: false, saml: false, configured: false })
  })

  test('partial SAML config is NOT enough', async () => {
    setSaml()
    delete process.env.SAML_IDP_ENTRY_POINT
    // With no entry point AND no metadata URL there is nowhere to redirect to.
    expect(await bodyOf(await GET())).toEqual({ ok: true, oidc: false, saml: false, configured: false })
  })

  test('a whitespace-only env var counts as UNCONFIGURED', async () => {
    // Both predicates funnel through a trim()-then-truthiness helper. Reading
    // process.env directly would report configured:true for '   ', which the login
    // page renders as a button that fails on click.
    setOidc()
    process.env.OIDC_ISSUER = '   '
    setSaml()
    process.env.SAML_SP_ENTITY_ID = '  '
    expect(await bodyOf(await GET())).toEqual({ ok: true, oidc: false, saml: false, configured: false })
  })

  test('SAML configuration is decided by entry point OR metadata URL', async () => {
    // Discovery-only SAML (no entry point, metadata URL present) is a supported
    // setup. Reporting saml:false there hides SSO from those customers.
    delete process.env.SAML_SP_ENTITY_ID && setSaml()
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_SP_ENTITY_ID
    process.env.SAML_SP_ENTITY_ID = 'https://chatbot.test'
    process.env.SAML_SP_CALLBACK_URL = 'https://chatbot.test/api/auth/saml/callback'
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    expect(await bodyOf(await GET())).toEqual({ ok: true, oidc: false, saml: true, configured: true })
  })
})

// ---------------------------------------------------------------------------
// Shape and disclosure
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/status -- response shape', () => {
  test('responds 200 with the exact four-key envelope', async () => {
    setOidc()
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    // Pin the key SET: an extra key here reaches an unauthenticated caller. Adding
    // one (issuer URL, client id, tenant slug) is a disclosure decision, so this
    // test fails until the list is updated deliberately.
    expect(Object.keys(body).sort()).toEqual(['configured', 'oidc', 'ok', 'saml'])
    // ...and there are exactly four, so a removed key is caught too.
    expect(Object.keys(body)).toHaveLength(4)
  })

  test('discloses booleans only -- never the issuer, client id or IdP secrets', async () => {
    setOidc()
    setSaml()
    process.env.SAML_IDP_CERT = '-----BEGIN CERTIFICATE-----SUPERSECRET'
    process.env.OIDC_CLIENT_SECRET = 'oidc-super-secret'

    const raw = await (await GET()).text()
    // This endpoint is reachable without a session, so IdP internals here are free
    // reconnaissance (tenant name, IdP vendor, tenant id) for an attacker.
    expect(raw).not.toContain('idp.test')
    expect(raw).not.toContain('client-1')
    expect(raw).not.toContain('SUPERSECRET')
    expect(raw).not.toContain('oidc-super-secret')
    expect(raw).not.toContain('chatbot.test')
    expect(JSON.parse(raw)).toEqual({ ok: true, oidc: true, saml: true, configured: true })
  })

  test('the body is byte-stable across repeated calls', async () => {
    setSaml()
    const first = await (await GET()).text()
    const second = await (await GET()).text()
    // Byte-equal, not merely deeply-equal: a leaking field would show up here first.
    expect(second).toBe(first)
  })

  test('the envelope is JSON with a JSON content type', async () => {
    // The login view calls res.json() with no defensive parsing.
    const res = await GET()
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('the response sets no cookies', async () => {
    setOidc()
    const res = await GET()
    // No session material belongs in this response -- it runs before login.
    expect(res.cookies.get('x-active-user')).toBeUndefined()
    expect(res.cookies.get('sso_state')).toBeUndefined()
    expect(res.cookies.get('sso_nonce')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Evaluation order
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/status -- provider evaluation', () => {
  test('both predicates are evaluated exactly once per request, oidc first', async () => {
    await bodyOf(await GET())
    // `configured` is computed from the two already-evaluated locals; a second call
    // would mean the route re-derived state and could report an inconsistent pair.
    expect(oidcCalls).toBe(1)
    expect(samlCalls).toBe(1)
    expect(events).toEqual(['isOidcConfigured', 'isSamlConfigured'])
  })

  test('SAML is evaluated even when OIDC is already configured', async () => {
    // Short-circuiting on `oidc ||` would leave saml unevaluated and mis-report
    // saml:false for an install with both providers, hiding the SAML button.
    setOidc()
    setSaml()
    const body = await bodyOf(await GET())
    expect(body.saml).toBe(true)
    expect(samlCalls).toBe(1)
  })

  test('the route has NO auth, tenant context or handleApiError wrapper', async () => {
    // Decided, not overlooked: the login page renders BEFORE a session exists, so
    // requiring getActiveUser() would make the SSO buttons unreachable. Pinned so a
    // "hardening" edit that adds auth is a visible, deliberate change.
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(src).not.toContain('getActiveUser')
    expect(src).not.toContain('enterWithOrg')
    expect(src).not.toContain('bypassOrg')
    expect(src).not.toContain('handleApiError')
    // ...and it does not touch the database at all.
    expect(src).not.toContain('@/lib/db')
  })

  test('only GET is exported -- no mutation surface on a public route', async () => {
    const mod = await import('./route')
    expect(typeof mod.GET).toBe('function')
    expect('POST' in mod).toBe(false)
    expect('PUT' in mod).toBe(false)
    expect('DELETE' in mod).toBe(false)
    expect('PATCH' in mod).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Failure behaviour -- a NON-control, declared as such
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/status -- predicate failure (NON-CONTROL)', () => {
  test('a throwing predicate propagates instead of becoming a JSON 500 envelope', async () => {
    // DECLARED NON-CONTROL, and why: this does not prove the route handles the
    // failure well -- it proves the route has no try/catch at all. That is a real
    // property (the throw escapes to the Next.js route wrapper, producing a
    // framework 500 with no `{ error }` envelope), but it is a property of ABSENCE,
    // so there is no branch to break: mutating the route cannot make this red in any
    // way other than deleting the whole body. It is recorded here so the missing
    // error path is a stated gap rather than an implied coverage claim.
    oidcThrows = new Error('env exploded')
    await expect(GET()).rejects.toThrow('env exploded')
    // The failure happens before SAML is consulted -- nothing pretends to work.
    expect(samlCalls).toBe(0)
  })
})
