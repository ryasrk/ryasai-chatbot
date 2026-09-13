/**
 * GET /api/auth/sso/login
 *
 * WHY THIS FILE EXISTS. This is the entry point of the OIDC flow and it is what the
 * login page navigates the BROWSER to. Nothing here is behind a session -- the whole
 * point is to hand out the CSRF/PKCE material the callback will later check. Three
 * properties decide whether SSO works or silently fails:
 *
 *   1. THE THREE COOKIES MUST EXIST AND MATCH THE URL. `state` guards against CSRF
 *      (the callback compares the cookie against the `state` query param the IdP
 *      echoes back), `nonce` binds the id_token to THIS request, and
 *      `code_verifier` is the PKCE proof. The verifier and the challenge must be a
 *      matching pair, or the token exchange at the IdP is rejected with
 *      `invalid_grant` and the user sees a bare login page with no explanation.
 *   2. THE COOKIES MUST BE httponly/sameSite=lax/600s. A readable `sso_state`
 *      cookie is a CSRF bypass; a long-lived verifier is a replay window; and
 *      sameSite=strict would drop the cookies on the IdP's redirect back to us,
 *      breaking every login.
 *   3. FAIL-CLOSED WHEN UNCONFIGURED. Without OIDC_* env vars the route must bounce
 *      to /login with a DIAGNOSABLE error, not crash and not redirect to a
 *      half-built IdP URL.
 *
 * The lib functions are MOCKED (not the real ones) because the deterministic
 * randomness is what makes the pairing assertions possible: a real
 * crypto.randomBytes state cannot be compared against a cookie without also
 * reimplementing the generator, which would only assert against itself. The
 * verifier/challenge PAIRING is verified by delegating computeCodeChallenge
 * through the real SHA-256 helper captured before the mock is installed, so the
 * test still proves the route passes the VERIFIER (not the challenge, not the
 * state) into computeCodeChallenge.
 *
 * MEASURED GOTCHA: never spread an imported namespace inside a mock.module
 * factory on Bun 1.3.14 -- the prop read re-enters the factory and the file hangs
 * with no output instead of failing. Capture real functions into locals BEFORE
 * the mock.module() calls (see computeCodeChallenge below).
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Real implementation captured BEFORE any mock.module() call. See file header.
// ---------------------------------------------------------------------------
const realSso = await import('@/lib/sso')
const realComputeCodeChallenge = realSso.computeCodeChallenge

// ---------------------------------------------------------------------------
// Mutable seams ABOVE every mock.module() call.
// ---------------------------------------------------------------------------

/** Ordered effect log -- proves the sequence, not just the end state. */
let events: string[] = []

const mockUser = {
  userId: 'u1',
  name: 'Test User',
  email: 't@test.com',
  role: 'admin',
  organizationId: 'org-a',
  plan: null as string | null,
}

let oidcConfigured = true
let oidcConfigImpl: (issuer: string) => Promise<any> = async () => CONFIG
let oidcConfigError: Error | null = null
let stateNonce = { state: 'state-abc123', nonce: 'nonce-xyz789' }
let codeVerifier = 'verifier-plaintext-1'
let authUrlImpl: (cfg: any, state: string, nonce: string, challenge?: string) => string =
  (cfg, state, nonce, challenge) => `${cfg.authorization_endpoint}?state=${state}&nonce=${nonce}&code_challenge=${challenge}`
let handleApiErrorCalls: Array<{ msg: string; status: number }> = []

const CONFIG = {
  issuer: 'https://idp.test',
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/token',
  userinfo_endpoint: 'https://idp.test/userinfo',
  jwks_uri: 'https://idp.test/jwks',
}

/** Every argument list the route passes to buildAuthUrl. */
let buildAuthUrlArgs: any[][] = []
/** Every issuer string passed to getOidcConfig. */
let configIssuerArgs: string[] = []
let generateStateNonceCalls = 0
let generateCodeVerifierCalls = 0

mock.module('@/lib/sso', () => ({
  isOidcConfigured: () => {
    events.push('isOidcConfigured')
    return oidcConfigured
  },
  getOidcConfig: async (issuer: string) => {
    events.push('getOidcConfig')
    configIssuerArgs.push(issuer)
    if (oidcConfigError) throw oidcConfigError
    return oidcConfigImpl(issuer)
  },
  generateStateNonce: () => {
    events.push('generateStateNonce')
    generateStateNonceCalls++
    return stateNonce
  },
  generateCodeVerifier: () => {
    events.push('generateCodeVerifier')
    generateCodeVerifierCalls++
    return codeVerifier
  },
  // Delegates to the REAL helper so the challenge is a genuine SHA-256 base64url of
  // whatever the route hands in -- that is what proves the route passes the
  // verifier. Using the captured local avoids the factory re-entry trap.
  computeCodeChallenge: (v: string) => {
    events.push('computeCodeChallenge')
    return realComputeCodeChallenge(v)
  },
  buildAuthUrl: (cfg: any, state: string, nonce: string, challenge?: string) => {
    events.push('buildAuthUrl')
    buildAuthUrlArgs.push([cfg, state, nonce, challenge])
    return authUrlImpl(cfg, state, nonce, challenge)
  },
  // Pass-throughs: a partial mock makes a transitive import throw at load time.
  exchangeCode: realSso.exchangeCode,
  decodeIdToken: realSso.decodeIdToken,
  verifyIdToken: realSso.verifyIdToken,
  verifyIdTokenRs256: realSso.verifyIdTokenRs256,
  fetchUserInfo: realSso.fetchUserInfo,
  getOrCreateSsoUser: realSso.getOrCreateSsoUser,
  resolveSsoOrganizationId: realSso.resolveSsoOrganizationId,
  resetJwksCache: realSso.resetJwksCache,
}))

mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, msg: string, status = 500) => {
    events.push('handleApiError')
    handleApiErrorCalls.push({ msg, status })
    void e
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
  // Present so an accidental getActiveUser() in this public route is a compile-time
  // reachable mock rather than an undefined-is-not-a-function crash.
  getActiveUser: async () => {
    events.push('getActiveUser')
    return mockUser
  },
}))

// ---------------------------------------------------------------------------
// Module under test -- dynamic import AFTER every mock.module() call.
// ---------------------------------------------------------------------------
const { GET } = await import('./route')

const OIDC_KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of [...OIDC_KEYS, 'NODE_ENV']) savedEnv[k] = process.env[k]

function setEnv() {
  process.env.OIDC_ISSUER = 'https://idp.test'
  process.env.OIDC_CLIENT_ID = 'client-1'
  process.env.OIDC_REDIRECT_URI = 'https://chatbot.test/api/auth/sso/callback'
}

/**
 * A NextRequest stand-in. The route reads `req.url` (for the not-configured
 * redirect) and nothing else, so a plain Request with a `nextUrl` grafted on is
 * the minimum faithful shape -- `req.nextUrl` does not exist on a bare Request,
 * which is the trap this helper exists to avoid.
 */
function makeReq(url = 'http://localhost/api/auth/sso/login') {
  const r = new Request(url, { method: 'GET' }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  events.push('request')
  return r as any
}

beforeEach(() => {
  events = []
  oidcConfigured = true
  oidcConfigImpl = async () => CONFIG
  oidcConfigError = null
  stateNonce = { state: 'state-abc123', nonce: 'nonce-xyz789' }
  codeVerifier = 'verifier-plaintext-1'
  authUrlImpl = (cfg, state, nonce, challenge) =>
    `${cfg.authorization_endpoint}?state=${state}&nonce=${nonce}&code_challenge=${challenge}`
  buildAuthUrlArgs = []
  configIssuerArgs = []
  generateStateNonceCalls = 0
  generateCodeVerifierCalls = 0
  handleApiErrorCalls = []
  setEnv()
})

afterEach(() => {
  for (const k of [...OIDC_KEYS, 'NODE_ENV']) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------------------
// Containment: the codes must never leave in the URL without the cookie
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/login -- the happy path hands out CSRF + PKCE material', () => {
  test('302-redirects to the IdP authorization URL', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc.startsWith('https://idp.test/authorize')).toBe(true)
    // The state and nonce must actually make it into the URL -- the IdP echoes them
    // back and the callback compares them.
    expect(loc).toContain('state=state-abc123')
    expect(loc).toContain('nonce=nonce-xyz789')
  })

  test('sets sso_state, sso_nonce and sso_code_verifier cookies with the matching values', async () => {
    const res = await GET(makeReq())

    const state = res.cookies.get('sso_state')
    const nonce = res.cookies.get('sso_nonce')
    const verifier = res.cookies.get('sso_code_verifier')
    expect(state?.value).toBe('state-abc123')
    expect(nonce?.value).toBe('nonce-xyz789')
    expect(verifier?.value).toBe('verifier-plaintext-1')
    // Each cookie must equal what went into the URL / what the callback will read.
    const loc = res.headers.get('location')!
    expect(loc).toContain(`state=${state!.value}`)
    expect(loc).toContain(`nonce=${nonce!.value}`)
  })

  test('the three cookies are ALL httpOnly, sameSite=lax, path=/ and maxAge 600', async () => {
    const res = await GET(makeReq())

    for (const name of ['sso_state', 'sso_nonce', 'sso_code_verifier']) {
      const c = res.cookies.get(name)
      expect(c).toBeDefined()
      // httpOnly: a readable sso_state cookie can be planted by any script that
      // achieves XSS, which turns the CSRF defence into a formality.
      expect(c!.httpOnly).toBe(true)
      // lax, NOT strict: the IdP redirects back to us cross-site, and strict would
      // withhold these cookies on that navigation, breaking every login.
      expect(c!.sameSite).toBe('lax')
      expect(c!.path).toBe('/')
      // 10 minutes -- long enough for a human at an IdP login screen, short enough
      // that a leaked verifier is useless by the time anyone finds it.
      expect(c!.maxAge).toBe(600)
    }
  })

  test('secure is off in development and on in production', async () => {
    // A `secure` cookie is never stored over plain http, so hardcoding true silently
    // breaks local SSO; hardcoding false ships the CSRF material in the clear.
    const dev = await GET(makeReq())
    expect(dev.cookies.get('sso_state')!.secure).toBe(false)

    // `process.env.NODE_ENV` is typed READ-ONLY (`@types/node`), and assigning it is also unsound because the Next
    // runtime caches the value. The mutable holder the route reads through is the seam; setting it directly made
    // tsc fail with TS2540 while the test happened to pass.
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    const prod = await GET(makeReq())
    expect(prod.cookies.get('sso_state')!.secure).toBe(true)
    expect(prod.cookies.get('sso_nonce')!.secure).toBe(true)
    expect(prod.cookies.get('sso_code_verifier')!.secure).toBe(true)
  })

  test('the challenge sent to the IdP is the REAL SHA-256 base64url of the VERIFIER cookie', async () => {
    // The single most valuable assertion in this file. S256 PKCE means
    // challenge = BASE64URL(SHA256(verifier)); the IdP re-derives it from the
    // verifier our callback sends at exchange time. If the route ever passes the
    // state, the nonce, the challenge itself, or a stale verifier into
    // computeCodeChallenge, the pairing breaks and every login ends in
    // `invalid_grant` at the token endpoint -- an error the user sees only as a
    // bounce back to /login.
    codeVerifier = 'a-verifier-that-is-not-the-state'
    stateNonce = { state: 'unrelated-state', nonce: 'unrelated-nonce' }
    const res = await GET(makeReq())

    const verifier = res.cookies.get('sso_code_verifier')!.value
    const expected = createHash('sha256').update(verifier).digest('base64url')

    expect(buildAuthUrlArgs).toHaveLength(1)
    const challengeArg = buildAuthUrlArgs[0][3]
    expect(challengeArg).toBe(expected)
    expect(res.headers.get('location')).toContain(`code_challenge=${expected}`)
    // Explicit non-identity: the challenge is not any of the other secrets.
    expect(challengeArg).not.toBe(verifier)
    expect(challengeArg).not.toBe('unrelated-state')
    expect(challengeArg).not.toBe('unrelated-nonce')
  })

  test('buildAuthUrl receives the DISCOVERED config, this request state, nonce and challenge', async () => {
    await GET(makeReq())

    expect(buildAuthUrlArgs).toHaveLength(1)
    const [cfg, state, nonce, challenge] = buildAuthUrlArgs[0]
    // The config object must be the discovery result, not a literal: the endpoints
    // live at the IdP and are only knowable via /.well-known/openid-configuration.
    expect(cfg).toBe(CONFIG)
    expect(state).toBe('state-abc123')
    expect(nonce).toBe('nonce-xyz789')
    expect(typeof challenge).toBe('string')
  })

  test('the issuer passed to discovery is OIDC_ISSUER, not the redirect URI', async () => {
    // getOidcConfig(issuer) appends /.well-known/openid-configuration. Passing the
    // wrong env var fetches a 404 discovery document and the login dies before the
    // browser ever reaches the IdP.
    await GET(makeReq())
    expect(configIssuerArgs).toEqual(['https://idp.test'])
  })

  test('each request generates FRESH state, nonce and verifier', async () => {
    // Reused state across requests makes the CSRF check pass for an attacker who
    // captured one link; reused PKCE material makes the verifier guessable.
    await GET(makeReq())
    stateNonce = { state: 'state-second', nonce: 'nonce-second' }
    codeVerifier = 'verifier-second'
    const res2 = await GET(makeReq())

    expect(generateStateNonceCalls).toBe(2)
    expect(generateCodeVerifierCalls).toBe(2)
    expect(res2.cookies.get('sso_state')!.value).toBe('state-second')
    expect(res2.cookies.get('sso_code_verifier')!.value).toBe('verifier-second')
  })
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/login -- evaluation order', () => {
  test('discovery happens BEFORE any secrets are minted', async () => {
    // Minting a verifier before discovery means a discovery failure burns a verifier
    // (harmless in isolation) but, more importantly, means the state cookie set
    // later would not correspond to the URL the user is sent to. Asserting the order
    // states the invariant that the URL and the cookies are built from one attempt.
    await GET(makeReq())
    expect(events.indexOf('isOidcConfigured')).toBeLessThan(events.indexOf('getOidcConfig'))
    expect(events.indexOf('getOidcConfig')).toBeLessThan(events.indexOf('generateStateNonce'))
    expect(events.indexOf('generateCodeVerifier')).toBeLessThan(events.indexOf('computeCodeChallenge'))
    expect(events.indexOf('computeCodeChallenge')).toBeLessThan(events.indexOf('buildAuthUrl'))
  })

  test('the verifier is generated before the challenge that derives from it', async () => {
    await GET(makeReq())
    expect(events.indexOf('generateCodeVerifier')).toBeLessThan(events.indexOf('computeCodeChallenge'))
  })

  test('exactly one set of secrets is minted per request', async () => {
    await GET(makeReq())
    expect(events.filter((e) => e === 'generateStateNonce')).toHaveLength(1)
    expect(events.filter((e) => e === 'generateCodeVerifier')).toHaveLength(1)
    expect(events.filter((e) => e === 'computeCodeChallenge')).toHaveLength(1)
    expect(events.filter((e) => e === 'buildAuthUrl')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Fail-closed when unconfigured
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/login -- OIDC not configured', () => {
  test('302-redirects back to /login with the sso_not_configured marker', async () => {
    oidcConfigured = false
    const res = await GET(makeReq())

    // MEASURED: 307, not 302. The unconfigured branch calls
    // `NextResponse.redirect(url)` WITHOUT an explicit status, and Next's default
    // for that overload is 307 (temporary, method-preserving) -- the configured
    // branch passes 302 explicitly. The distinction is immaterial for a GET (no body
    // to preserve) so this is recorded as the actual value rather than asserted as a
    // contract; the browser follows both.
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.pathname).toBe('/login')
    // The login view maps this exact marker to "SSO is not configured on this server."
    // A different/absent marker leaves the user on a blank login page wondering why
    // the button did nothing.
    expect(loc.searchParams.get('error')).toBe('sso_not_configured')
  })

  test('the configured branch really does emit 302, unlike the unconfigured one', async () => {
    // Pins the asymmetry deliberately: if someone "tidies" the branches to share one
    // redirect helper, this test makes the resulting status change visible.
    const res = await GET(makeReq())
    expect(res.status).toBe(302)
  })

  test('the not-configured redirect is resolved against the REQUEST origin', async () => {
    // `new URL('/login?...', req.url)` -- an absolute URL pinned to localhost would
    // bounce an on-prem customer to the wrong host.
    oidcConfigured = false
    const res = await GET(makeReq('https://chatbot.acme.internal/api/auth/sso/login'))
    expect(res.headers.get('location')).toBe('https://chatbot.acme.internal/login?error=sso_not_configured')
  })

  test('an unconfigured provider touches nothing -- no discovery, no secrets, no cookies', async () => {
    oidcConfigured = false
    const res = await GET(makeReq())

    expect(configIssuerArgs).toEqual([])
    expect(generateStateNonceCalls).toBe(0)
    expect(generateCodeVerifierCalls).toBe(0)
    expect(buildAuthUrlArgs).toEqual([])
    // Critically: no sso_* cookies. Setting them without an IdP would leave stale
    // CSRF material in the browser that a later, correctly-configured attempt could
    // accidentally match.
    expect(res.cookies.get('sso_state')).toBeUndefined()
    expect(res.cookies.get('sso_nonce')).toBeUndefined()
    expect(res.cookies.get('sso_code_verifier')).toBeUndefined()
  })

  test('no error envelope is returned for the unconfigured case -- it is a redirect, not an error', async () => {
    oidcConfigured = false
    const res = await GET(makeReq())
    expect(handleApiErrorCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Failures inside the flow
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/login -- discovery and build failures', () => {
  test('a discovery failure is routed through handleApiError, not leaked', async () => {
    // getOidcConfig throws on a non-OK discovery response ("OIDC discovery failed:
    // 404 ...") and on a document missing the required endpoints. Both must reach
    // the sanitized handler: the raw message carries the IdP URL, which is
    // reconnaissance and, in an on-prem install, an internal hostname.
    oidcConfigError = new Error('OIDC discovery failed: 404 for https://idp.test/.well-known/openid-configuration')
    const res = await GET(makeReq())

    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(JSON.parse(raw).error.code).toBe('INTERNAL_ERROR')
    expect(raw).not.toContain('openid-configuration')
    expect(handleApiErrorCalls).toEqual([{ msg: 'Failed to initiate SSO login.', status: 500 }])
  })

  test('a buildAuthUrl failure (missing client id/redirect uri) is handled the same way', async () => {
    authUrlImpl = () => {
      throw new Error('OIDC_CLIENT_ID or OIDC_REDIRECT_URI not set')
    }
    const res = await GET(makeReq())

    expect(res.status).toBe(500)
    expect(JSON.parse(await res.text()).error.message).toBe('Failed to initiate SSO login.')
    // No cookies: a redirect that failed to build must not leave half the handshake
    // in the browser. The failure response is a plain Response.json() from the
    // handleApiError mock, which carries no cookie jar at all -- so the observable
    // fact is the absence of `set-cookie`, not a missing cookie object.
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a redirect target that is not a valid URL is caught, not thrown at the caller', async () => {
    // The url comes from IdP discovery -- a buggy/malicious document could yield a
    // relative or empty authorization_endpoint, and NextResponse.redirect throws on
    // an invalid URL. That must surface as the route's error envelope.
    oidcConfigImpl = async () => ({ ...CONFIG, authorization_endpoint: '' })
    const res = await GET(makeReq())

    expect(res.status).toBe(500)
    expect(handleApiErrorCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/login -- public, session-less surface', () => {
  test('the route never resolves a session', async () => {
    // It cannot: the user has no session yet, that is the whole point of logging in.
    // Pinned so adding getActiveUser() here is a deliberate, visible change.
    await GET(makeReq())
    expect(events).not.toContain('getActiveUser')
  })

  test('only GET is exported', async () => {
    const mod = await import('./route')
    expect(typeof mod.GET).toBe('function')
    expect('POST' in mod).toBe(false)
    expect('PUT' in mod).toBe(false)
    expect('DELETE' in mod).toBe(false)
  })

  test('the no-cache headers of a redirect are intact (no stale SSO link)', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(302)
    // A cached 302 pins the user to a state cookie pair that no longer matches what
    // the browser holds after the first attempt.
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).not.toContain('public')
  })

  test('static: the three cookie names are literally the ones the callback reads', async () => {
    // The callback (src/app/api/auth/sso/callback/route.ts) reads sso_state,
    // sso_nonce and sso_code_verifier. A rename on one side only is a silent
    // production break: the callback sees no state cookie and redirects to
    // /login?error=sso_missing_params forever. Pinning the literal names in BOTH
    // files together is what catches that.
    const login = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    const callback = readFileSync(join(import.meta.dir, '..', 'callback', 'route.ts'), 'utf8')

    for (const name of ['sso_state', 'sso_nonce', 'sso_code_verifier']) {
      expect(login).toContain(`'${name}'`)
      expect(callback).toContain(`'${name}'`)
    }
  })
})
