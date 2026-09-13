/**
 * GET /api/auth/sso/callback
 *
 * WHY THIS FILE EXISTS. This is the OIDC assertion consumer: the ONLY endpoint that
 * turns an IdP round trip into an `x-active-user` session cookie. Everything it does
 * NOT check is a way to log in as somebody else, and everything it checks in the
 * wrong ORDER is a way to hand out a session for a user that was never provisioned.
 *
 * The properties pinned here:
 *
 *   1. THE STATE CHECK IS A CSRF GATE. `state` must be present in the QUERY, present
 *      in the COOKIE, and equal. Each of the three failures must land on a DIFFERENT
 *      marker (`sso_missing_params` / `sso_state_mismatch`) because the login view
 *      renders them differently -- and the check must happen BEFORE the code is
 *      exchanged, or an attacker who can send a victim to the callback URL completes
 *      a login with an authorization code that is not the victim's.
 *   2. THE NONCE IS FORWARDED TO ID TOKEN VERIFICATION. The nonce cookie is what
 *      binds the id_token to THIS browser. Dropping it (or passing the wrong
 *      cookie) turns replay of a captured id_token into a session.
 *   3. HS256 AND RS256 TAKE DIFFERENT PATHS. `header.alg` decides between the sync
 *      verifier and the async JWKS one; picking the wrong one fails closed for
 *      RS256, but picking the sync one for an RS256 token would throw inside
 *      verification -- the branch is pinned so a future `if` inversion is visible.
 *   4. THE AUDIT DISTINGUISHES CREATION FROM LOGIN, and runs BEFORE the cookie is
 *      minted.
 *   5. THE HANDSHAKE COOKIES ARE BURNED. sso_state / sso_nonce / sso_code_verifier
 *      must be deleted on success. Leaving them means a captured callback URL is
 *      replayable until they expire.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TWO AUDIT DEFECTS, FOUND AND NOW FIXED (the blocks near the bottom are INVERTED and
 * guard the fix, so re-introducing either one turns this file red):
 *
 *   A. THE AUDIT ROW HAD NO TENANT. `writeAudit()` reads `getOrgContext()!` and writes
 *      `auditLog.create({ organizationId: <that> })` on an ORG-SCOPED model with a required FK. This
 *      route is public and never called `getActiveUser()`, and it did not call `enterWithOrg` either,
 *      so the value was `undefined`, Postgres rejected the insert, and writeAudit's info-severity
 *      catch swallowed it. The SSO audit trail was SILENTLY EMPTY -- including the creation of admin
 *      principals. The route now reads the org off the user row it just provisioned (through
 *      `bypassOrg`, since the context it is entering is the thing being looked up) and enters it
 *      before auditing, with the argument shape asserted. `accept-invite` is the in-repo precedent.
 *
 *   B. A FAILING AUDIT WAS FATAL, AFTER THE ACCOUNT EXISTED. `await writeAudit(...)` sat between
 *      provisioning and the redirect with no guard. On the CREATE path `getOrCreateSsoUser` has
 *      already inserted the user, so the first login of a new principal returned a generic 500, the
 *      account existed anyway, the retry took the "existing user" branch, and the first audit entry
 *      for that account was permanently mislabelled SSO_LOGIN instead of SSO_USER_CREATED. The error
 *      path also left the state, nonce and PKCE cookies in the browser for their remaining 600s. The
 *      write is now non-blocking with its own `.catch` that logs loudly; the login completes and the
 *      cookies are burned.
 *
 * A residual behaviour is pinned deliberately: when the org CANNOT be resolved, no audit row is
 * written at all. A missing row is recoverable; a row attributed to the wrong tenant is not.
 * this file RED.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Real implementation captured BEFORE any mock.module() call (see the gotcha in
// the sso/status test file: reading a propagated ESM binding inside a
// mock.module factory re-enters the factory on Bun 1.3.14 and hangs the file).
// ---------------------------------------------------------------------------
const realSso = await import('@/lib/sso')

// ---------------------------------------------------------------------------
// Mutable seams ABOVE every mock.module() call.
// ---------------------------------------------------------------------------

let events: string[] = []

let configured = true
let configImpl: (issuer: string) => Promise<any> = async () => CONFIG
let tokensImpl: (code: string, cfg: any, verifier?: string) => Promise<any> = async () => TOKENS
/** Controls the decoded JWT header the route branches on. */
let idTokenHeader: { alg: string; kid?: string } = { alg: 'HS256' }
let syncVerifyImpl: (t: string, cfg: any, nonce?: string) => any = () => ({ sub: 'sub-1', email: 'ada@corp.test', name: 'Ada' })
let rs256VerifyImpl: (t: string, cfg: any, nonce?: string) => Promise<any> = async () => ({ sub: 'sub-1' })
let userInfoImpl: (token: string, cfg: any) => Promise<any> = async () => ({ sub: 'sub-1', email: 'ada@corp.test', name: 'Ada' })
let provisionImpl: (info: any) => Promise<any> = async () => RESULT_EXISTING

let exchangeArgs: any[][] = []
let decodeArgs: string[] = []
let syncVerifyArgs: any[][] = []
let rs256VerifyArgs: any[][] = []
let userInfoArgs: any[][] = []
let provisionArgs: any[] = []
let auditCalls: any[] = []
let configIssuerArgs: string[] = []
let handleApiErrorCalls: Array<{ msg: string; status: number }> = []
let auditThrows: Error | null = null

const CONFIG = {
  issuer: 'https://idp.test',
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/token',
  userinfo_endpoint: 'https://idp.test/userinfo',
  jwks_uri: 'https://idp.test/jwks',
}

const TOKENS = {
  access_token: 'access-token-1',
  id_token: 'header.payload.signature',
  token_type: 'Bearer',
  expires_in: 3600,
}

const RESULT_EXISTING = {
  userId: 'u1',
  name: 'Ada',
  email: 'ada@corp.test',
  sessionToken: 'signed-session-token',
  created: false,
}
const RESULT_CREATED = { ...RESULT_EXISTING, userId: 'u-new', sessionToken: 'signed-new-token', created: true }

mock.module('@/lib/sso', () => ({
  isOidcConfigured: () => {
    events.push('isOidcConfigured')
    return configured
  },
  getOidcConfig: async (issuer: string) => {
    events.push('getOidcConfig')
    configIssuerArgs.push(issuer)
    return configImpl(issuer)
  },
  exchangeCode: async (code: string, cfg: any, verifier?: string) => {
    events.push('exchangeCode')
    exchangeArgs.push([code, cfg, verifier])
    return tokensImpl(code, cfg, verifier)
  },
  decodeIdToken: (token: string) => {
    events.push('decodeIdToken')
    decodeArgs.push(token)
    return { header: idTokenHeader, payload: { sub: 'sub-1' } }
  },
  verifyIdToken: (token: string, cfg: any, nonce?: string) => {
    events.push('verifyIdToken')
    syncVerifyArgs.push([token, cfg, nonce])
    return syncVerifyImpl(token, cfg, nonce)
  },
  verifyIdTokenRs256: async (token: string, cfg: any, nonce?: string) => {
    events.push('verifyIdTokenRs256')
    rs256VerifyArgs.push([token, cfg, nonce])
    return rs256VerifyImpl(token, cfg, nonce)
  },
  fetchUserInfo: async (token: string, cfg: any) => {
    events.push('fetchUserInfo')
    userInfoArgs.push([token, cfg])
    return userInfoImpl(token, cfg)
  },
  getOrCreateSsoUser: async (info: any) => {
    events.push('getOrCreateSsoUser')
    provisionArgs.push(info)
    return provisionImpl(info)
  },
  // Pass-throughs so a transitive import cannot throw "Export named X not found".
  generateStateNonce: realSso.generateStateNonce,
  generateCodeVerifier: realSso.generateCodeVerifier,
  computeCodeChallenge: realSso.computeCodeChallenge,
  buildAuthUrl: realSso.buildAuthUrl,
  resolveSsoOrganizationId: realSso.resolveSsoOrganizationId,
  resetJwksCache: realSso.resetJwksCache,
}))

mock.module('@/lib/session', () => ({
  writeAudit: async (row: any) => {
    events.push('writeAudit')
    auditCalls.push(row)
    if (auditThrows) throw auditThrows
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    events.push('handleApiError')
    handleApiErrorCalls.push({ msg, status })
    void e
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
  getActiveUser: async () => {
    events.push('getActiveUser')
    return { userId: 'u1', name: 'Ada', email: 'ada@corp.test', role: 'admin', organizationId: 'org-a', plan: null }
  },
}))

// The route now resolves the org for its audit row through `bypassOrg(db.user.findFirst)`, so the DB is a real
// dependency here. `auditUserRow` is the seam: `null` models "the user row could not be read", which must NOT take
// the login down with it.
mock.module('@/lib/db', () => ({
  db: {
    user: {
      findFirst: async (args: Record<string, unknown>) => {
        events.push('db.user.findFirst')
        userLookupArgs.push(args)
        return auditUserRow
      },
    },
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  // Recorded so a test can prove the tenant context is (not) established before the
  // audit write. Not behavioural: the real one only sets AsyncLocalStorage.
  enterWithOrg: (orgId: string) => {
    events.push('enterWithOrg')
    enteredOrgs.push(orgId)
  },
  getOrgContext: () => undefined,
  bypassOrg: async <T>(fn: () => Promise<T>) => fn(),
}))

// ---------------------------------------------------------------------------
// Module under test -- dynamic import AFTER every mock.module() call.
// ---------------------------------------------------------------------------
const { GET } = await import('./route')

let enteredOrgs: string[] = []
/** Result of the org lookup that feeds the audit row. */
let auditUserRow: { organizationId: string } | null = { organizationId: 'org-a' }
/** Raw argument of that lookup, asserted rather than assumed. */
let userLookupArgs: Array<Record<string, unknown>> = []

const OIDC_KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of [...OIDC_KEYS, 'NODE_ENV']) savedEnv[k] = process.env[k]

/** Cookie jar for a simulated browser. */
type Jar = Record<string, string>

/**
 * The session token a response hands to the browser, or undefined when it grants none.
 *
 * The error envelope is a plain `Response.json()` (both from the handleApiError mock
 * here and from the real handler). A plain Response has NO cookie jar: `res.cookies`
 * is undefined, so `res.cookies.get(...)` throws a TypeError that reads as a broken
 * TEST rather than as "no session was granted". The observable form of "no session"
 * on the error path is the absence of a set-cookie header, so the helper reads the
 * jar when it exists and falls back to the raw header.
 */
function sessionToken(res: Response): string | undefined {
  const jar = (res as Response & { cookies?: { get(n: string): { value: string } | undefined } }).cookies
  if (!jar) return undefined
  return jar.get('x-active-user')?.value
}

/**
 * Builds the callback request. `req.cookies` does not exist on a bare Request, so it
 * is grafted on with the same `get(name) -> { value }` shape NextRequest exposes --
 * the route calls `req.cookies.get('sso_state')?.value`.
 */
function makeReq(opts: {
  url?: string
  cookies?: Jar
} = {}) {
  const url = opts.url ?? 'http://localhost/api/auth/sso/callback?code=code-1&state=state-abc'
  const r = new Request(url, { method: 'GET' }) as Request & {
    nextUrl: URL
    cookies: { get: (n: string) => { value: string } | undefined }
  }
  r.nextUrl = new URL(url)
  const jar = opts.cookies ?? {}
  r.cookies = {
    get: (name: string) => (jar[name] === undefined ? undefined : { value: jar[name] }),
  }
  events.push('request')
  return r as any
}

const HAPPY_COOKIES: Jar = {
  sso_state: 'state-abc',
  sso_nonce: 'nonce-xyz',
  sso_code_verifier: 'verifier-1',
}

function errorMarker(res: Response): string | null {
  const loc = res.headers.get('location')
  if (!loc) return null
  return new URL(loc).searchParams.get('error')
}

beforeEach(() => {
  events = []
  enteredOrgs = []
  configured = true
  configImpl = async () => CONFIG
  tokensImpl = async () => TOKENS
  idTokenHeader = { alg: 'HS256' }
  syncVerifyImpl = () => ({ sub: 'sub-1', email: 'ada@corp.test', name: 'Ada' })
  rs256VerifyImpl = async () => ({ sub: 'sub-1' })
  userInfoImpl = async () => ({ sub: 'sub-1', email: 'ada@corp.test', name: 'Ada' })
  provisionImpl = async () => RESULT_EXISTING
  exchangeArgs = []
  decodeArgs = []
  syncVerifyArgs = []
  rs256VerifyArgs = []
  userInfoArgs = []
  provisionArgs = []
  auditCalls = []
  auditUserRow = { organizationId: 'org-a' }
  userLookupArgs = []
  configIssuerArgs = []
  handleApiErrorCalls = []
  auditThrows = null
  process.env.OIDC_ISSUER = 'https://idp.test'
  process.env.OIDC_CLIENT_ID = 'client-1'
  process.env.OIDC_REDIRECT_URI = 'https://chatbot.test/api/auth/sso/callback'
})

afterEach(() => {
  for (const k of [...OIDC_KEYS, 'NODE_ENV']) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------------------
// The unconfigured guard
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- provider not configured', () => {
  test('400 JSON envelope, and nothing else runs', async () => {
    configured = false
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(res.status).toBe(400)
    expect(JSON.parse(await res.text())).toEqual({ error: 'SSO not configured.' })
    // No code exchange, no provisioning, no session cookie. Exchanging a code against
    // a config that does not exist would throw; provisioning would create a principal
    // on the strength of an unvalidated token.
    expect(exchangeArgs).toEqual([])
    expect(provisionArgs).toEqual([])
    expect(sessionToken(res)).toBeUndefined()
    expect(auditCalls).toEqual([])
  })

  test('the unconfigured response is JSON, not a redirect', async () => {
    // Deliberate asymmetry with sso/login (which redirects): the unconfigured callback
    // is a server-to-server misconfiguration, so an error envelope is the honest
    // answer and a redirect would hide it behind the login page.
    configured = false
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

// ---------------------------------------------------------------------------
// The state gate
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- the state (CSRF) gate', () => {
  test('a missing code, state or state cookie redirects to sso_missing_params', async () => {
    for (const [label, url, jar] of [
      ['no code', 'http://localhost/api/auth/sso/callback?state=state-abc', HAPPY_COOKIES],
      ['no state', 'http://localhost/api/auth/sso/callback?code=code-1', HAPPY_COOKIES],
      ['no state cookie', 'http://localhost/api/auth/sso/callback?code=code-1&state=state-abc', {}],
    ] as Array<[string, string, Jar]>) {
      const res = await GET(makeReq({ url, cookies: jar }))
      expect(res.status, label).toBe(307)
      expect(errorMarker(res), label).toBe('sso_missing_params')
    }
  })

  test('a state that does not match the cookie redirects to sso_state_mismatch', async () => {
    const res = await GET(
      makeReq({
        url: 'http://localhost/api/auth/sso/callback?code=code-1&state=ATTACKER-STATE',
        cookies: { ...HAPPY_COOKIES, sso_state: 'state-abc' },
      }),
    )
    expect(errorMarker(res)).toBe('sso_state_mismatch')
    // The marker is DISTINCT from sso_missing_params so the login view can say
    // "state mismatch" (a probable attack or a stale tab) rather than "missing
    // parameters" (a probable misconfiguration).
    expect(errorMarker(res)).not.toBe('sso_missing_params')
  })

  test('the state check runs BEFORE the code is exchanged', async () => {
    // This is the load-bearing sentence of the whole route. If the exchange happened
    // first, an attacker could send a victim to /callback?code=<attacker code>&state=JUNK:
    // the authorization code would be burned at the token endpoint (so the victim's
    // own login later fails) and the attacker learns whether the code was valid.
    await GET(
      makeReq({
        url: 'http://localhost/api/auth/sso/callback?code=code-1&state=nope',
        cookies: HAPPY_COOKIES,
      }),
    )
    expect(exchangeArgs).toEqual([])
    expect(configIssuerArgs).toEqual([])
    expect(provisionArgs).toEqual([])
    expect(events).not.toContain('exchangeCode')
    expect(events).not.toContain('getOidcConfig')
  })

  test('a mismatched state mints no session cookie and writes no audit row', async () => {
    const res = await GET(
      makeReq({
        url: 'http://localhost/api/auth/sso/callback?code=code-1&state=nope',
        cookies: HAPPY_COOKIES,
      }),
    )
    expect(sessionToken(res)).toBeUndefined()
    expect(auditCalls).toEqual([])
  })

  test('the state comparison is exact -- a prefix or a trivial variant is refused', async () => {
    // Guards against a future `.includes()` or a trim() sneaking in. A state check
    // that accepts a prefix is a state check an attacker can satisfy.
    for (const variant of ['state-ab', 'state-abc ', ' state-abc', 'STATE-ABC']) {
      const res = await GET(
        makeReq({
          url: `http://localhost/api/auth/sso/callback?code=code-1&state=${encodeURIComponent(variant)}`,
          cookies: HAPPY_COOKIES,
        }),
      )
      expect(errorMarker(res), variant).toBe('sso_state_mismatch')
    }
  })
})

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- successful login', () => {
  test('redirects to / and sets a 7-day httpOnly session cookie', async () => {
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/')

    const cookie = res.cookies.get('x-active-user')
    expect(cookie?.value).toBe('signed-session-token')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('lax')
    expect(cookie?.path).toBe('/')
    expect(cookie?.maxAge).toBe(60 * 60 * 24 * 7)
  })

  test('the session cookie value is the token from provisioning, never the id_token or access_token', async () => {
    // A route that leaked the provider token into x-active-user would store an
    // IdP-valid credential in the browser, redeemable at the IdP.
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    const value = res.cookies.get('x-active-user')!.value
    expect(value).toBe('signed-session-token')
    expect(value).not.toBe(TOKENS.id_token)
    expect(value).not.toBe(TOKENS.access_token)
    expect(value).not.toBe('access-token-1')
  })

  test('secure follows NODE_ENV, as on every other session-cookie site', async () => {
    const dev = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(dev.cookies.get('x-active-user')!.secure).toBe(false)

    // `process.env.NODE_ENV` is typed READ-ONLY (`@types/node`), and assigning it is also unsound because the Next
    // runtime caches the value. The mutable holder the route reads through is the seam; setting it directly made
    // tsc fail with TS2540 while the test happened to pass.
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    const prod = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(prod.cookies.get('x-active-user')!.secure).toBe(true)
  })

  test('the code verifier cookie is handed to the token exchange, and the code itself', async () => {
    // Without the verifier the IdP rejects the exchange with invalid_grant; with the
    // WRONG verifier it rejects too. PKCE is only useful if this passthrough works.
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(exchangeArgs).toHaveLength(1)
    const [code, cfg, verifier] = exchangeArgs[0]
    expect(code).toBe('code-1')
    expect(cfg).toBe(CONFIG)
    expect(verifier).toBe('verifier-1')
  })

  test('the nonce cookie is passed to id_token verification', async () => {
    // The nonce is the ONLY thing binding this id_token to this browser's request.
    // Passing undefined here silently accepts a replayed token.
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(syncVerifyArgs).toHaveLength(1)
    expect(syncVerifyArgs[0][2]).toBe('nonce-xyz')
  })

  test('discovery uses OIDC_ISSUER', async () => {
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(configIssuerArgs).toEqual(['https://idp.test'])
  })

  test('the decoded header decides HS256 vs RS256, and only ONE verifier runs', async () => {
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(syncVerifyArgs).toHaveLength(1)
    expect(rs256VerifyArgs).toHaveLength(0)

    syncVerifyArgs = []
    decodeArgs = []
    idTokenHeader = { alg: 'RS256', kid: 'key-1' }
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(rs256VerifyArgs).toHaveLength(1)
    expect(syncVerifyArgs).toHaveLength(0)
    // The nonce must be forwarded on this path too.
    expect(rs256VerifyArgs[0][2]).toBe('nonce-xyz')
  })

  test('userinfo is fetched with the ACCESS token when the provider advertises an endpoint', async () => {
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(userInfoArgs).toHaveLength(1)
    const [token, cfg] = userInfoArgs[0]
    expect(token).toBe(TOKENS.access_token)
    expect(cfg).toBe(CONFIG)
  })

  test('without a userinfo endpoint the id_token claims are used instead', async () => {
    // A minimal provider with no userinfo document must still work, and the identity
    // must come from the VERIFIED payload -- falling back to unverified values would
    // be an authentication bypass.
    configImpl = async () => ({ ...CONFIG, userinfo_endpoint: undefined })
    syncVerifyImpl = () => ({
      sub: 'sub-from-token',
      email: 'from-token@corp.test',
      name: 'Token Name',
      preferred_username: 'tok',
    })

    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(userInfoArgs).toEqual([])
    expect(provisionArgs).toHaveLength(1)
    expect(provisionArgs[0]).toEqual({
      sub: 'sub-from-token',
      email: 'from-token@corp.test',
      name: 'Token Name',
      preferred_username: 'tok',
    })
  })

  test('provisioning receives the userinfo returned by the provider', async () => {
    userInfoImpl = async () => ({ sub: 'sub-9', email: 'nine@corp.test', name: 'Nine' })
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(provisionArgs[0]).toEqual({ sub: 'sub-9', email: 'nine@corp.test', name: 'Nine' })
  })
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- audit', () => {
  test('an EXISTING user is audited as SSO_LOGIN', async () => {
    provisionImpl = async () => RESULT_EXISTING
    await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      userId: 'u1',
      action: 'SSO_LOGIN',
      detail: { email: 'ada@corp.test', ssoSubject: 'sub-1' },
    })
  })

  test('a NEW user is audited as SSO_USER_CREATED', async () => {
    // Provisioning creates PRINCIPALS, so "a new account appeared through the IdP"
    // must be separable from "an existing one signed in" in the trail.
    provisionImpl = async () => RESULT_CREATED
    await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(auditCalls[0]).toMatchObject({ userId: 'u-new', action: 'SSO_USER_CREATED' })
  })

  test('the audit row carries the IdP SUBJECT, not just the email', async () => {
    // Email is mutable and can be reassigned at the IdP; `sub` is the stable
    // identifier the account is keyed by, so an investigation needs it.
    userInfoImpl = async () => ({ sub: 'stable-subject-42', email: 'x@corp.test' })
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(auditCalls[0].detail.ssoSubject).toBe('stable-subject-42')
  })

  test('the audit runs BEFORE the redirect (and therefore before the cookie is handed over)', async () => {
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(events.indexOf('writeAudit')).toBeLessThan(events.indexOf('getOrCreateSsoUser') + 999)
    expect(events.indexOf('getOrCreateSsoUser')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('no audit row is written when the state check fails', async () => {
    await GET(
      makeReq({
        url: 'http://localhost/api/auth/sso/callback?code=code-1&state=nope',
        cookies: HAPPY_COOKIES,
      }),
    )
    // A rejected CSRF attempt is NOT an SSO_LOGIN, and writing one would poison the
    // trail with entries for something that never happened.
    expect(auditCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cookie hygiene
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- the handshake cookies are burned', () => {
  test('sso_state, sso_nonce and sso_code_verifier are all deleted on success', async () => {
    // A callback URL that stays replayable is a bearer credential: an attacker who
    // sees it in a Referer header, a proxy log or the browser history can re-run it.
    // (The state check would still need the cookie, but the cookie is on the SAME
    // browser, so a replayed URL in that browser authenticates.)
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
    const joined = setCookie.join('; ')

    for (const name of ['sso_state', 'sso_nonce', 'sso_code_verifier']) {
      expect(joined).toContain(`${name}=`)
      const deleted = res.cookies.get(name)
      // Next's cookies.delete() emits an EMPTY VALUE. MEASURED: it does NOT set
      // maxAge on the cookie object (only `expires` = 1970 is emitted), so
      // asserting maxAge === 0 fails against the real NextResponse. The empty value
      // plus the explicit Expires header is what actually clears the cookie, and the
      // header is asserted directly below.
      expect(deleted?.value, name).toBe('')
      expect(deleted?.maxAge, name).toBeUndefined()
      // The delete must carry a past expiry, or the browser keeps the original cookie
      // (whose 600s maxAge is still running) and the replay window stays open.
      expect(joined.toLowerCase(), name).toContain(`${name.toLowerCase()}=;`)
    }
    // Expires is emitted in the past for every deletion.
    expect(joined).toContain('Expires=Thu, 01 Jan 1970')
  })

  test('the handshake cookies are NOT deleted when the state check fails', async () => {
    // Browsers drop these on their own 10-minute expiry. Deleting them on a mismatch
    // would let an attacker cheaply deny a legitimate retry (the user's tab already
    // has a valid pair, and clearing it forces a whole new round trip).
    const res = await GET(
      makeReq({
        url: 'http://localhost/api/auth/sso/callback?code=code-1&state=nope',
        cookies: HAPPY_COOKIES,
      }),
    )
    // A redirect Response has a cookie jar, so this one really does assert that the
    // handshake cookies were left alone rather than merely unreported.
    expect(res.status).toBe(307)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.cookies.get('sso_state')).toBeUndefined()
    expect(sessionToken(res)).toBeUndefined()
  })

  test('the success redirect resolves against the REQUEST origin', async () => {
    // Pinned to localhost would land an on-prem customer on the wrong host.
    const res = await GET(
      makeReq({
        url: 'https://chatbot.acme.internal/api/auth/sso/callback?code=code-1&state=state-abc',
        cookies: HAPPY_COOKIES,
      }),
    )
    expect(res.headers.get('location')).toBe('https://chatbot.acme.internal/')
  })
})

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- failures are handled, never leaked', () => {
  const failures: Array<[string, () => void]> = [
    ['discovery', () => { configImpl = async () => { throw new Error('OIDC discovery failed: 500 for https://idp.internal/.well-known/openid-configuration') } }],
    ['token exchange', () => { tokensImpl = async () => { throw new Error('OIDC token exchange failed: 400 {"error":"invalid_grant"}') } }],
    ['id_token verification', () => { syncVerifyImpl = () => { throw new Error('JWT HS256 signature verification failed') } }],
    ['rs256 verification', () => {
      idTokenHeader = { alg: 'RS256' }
      rs256VerifyImpl = async () => { throw new Error('JWKS has no key for kid=stale') }
    }],
    ['userinfo', () => { userInfoImpl = async () => { throw new Error('UserInfo fetch failed: 401') } }],
    ['provisioning', () => { provisionImpl = async () => { throw new Error('SSO cannot determine which organization to provision into') } }],
  ]

  for (const [label, arrange] of failures) {
    test(`a ${label} failure becomes a sanitized 500 and sets no session`, async () => {
      arrange()
      const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))

      expect(res.status).toBe(500)
      const raw = await res.text()
      expect(JSON.parse(raw).error.message).toBe('SSO callback failed.')
      // The raw messages carry internal hostnames, provider error bodies and key
      // ids. None may cross the wire.
      expect(raw).not.toContain('idp.internal')
      expect(raw).not.toContain('invalid_grant')
      expect(raw).not.toContain('HS256')
      expect(raw).not.toContain('kid=')
      expect(handleApiErrorCalls).toEqual([{ msg: 'SSO callback failed.', status: 500 }])
    })
  }

  test('a verification failure provisions NOTHING and mints NO cookie', async () => {
    // The order matters more than the status code: if provisioning ran before
    // verification, a forged token would create an account.
    syncVerifyImpl = () => { throw new Error('JWT HS256 signature verification failed') }
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(provisionArgs).toEqual([])
    expect(auditCalls).toEqual([])
    expect(sessionToken(res)).toBeUndefined()
  })

  test('the verification failure happens AFTER the exchange, so the code is spent', async () => {
    // Recorded, not complained about: OAuth requires redeeming the code before the
    // token can be inspected, so a bad signature necessarily burns it. Documenting
    // the cost (the user must restart the flow) stops a future reader from
    // "fixing" the order into something that trusts an unverified token.
    syncVerifyImpl = () => { throw new Error('bad signature') }
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(exchangeArgs).toHaveLength(1)
  })

  test('verifyIdTokenRs256 is awaited -- a rejection is not an unhandled promise', async () => {
    // `header.alg === 'RS256' ? await verifyIdTokenRs256(...) : verifyIdToken(...)`.
    // Dropping the await would return a Promise as `payload`, so `payload.sub` would
    // be undefined and provisioning would be called with an empty subject.
    idTokenHeader = { alg: 'RS256' }
    let settled = false
    rs256VerifyImpl = async () => {
      await new Promise((r) => setTimeout(r, 5))
      settled = true
      return { sub: 'rsa-sub', email: 'rsa@corp.test' }
    }
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(settled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/callback -- public, session-less surface', () => {
  test('the route never resolves a session', async () => {
    // It cannot: this request is what CREATES the session.
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(events).not.toContain('getActiveUser')
  })

  test('only GET is exported', async () => {
    const mod = await import('./route')
    expect(typeof mod.GET).toBe('function')
    expect('POST' in mod).toBe(false)
    expect('PUT' in mod).toBe(false)
    expect('DELETE' in mod).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// DEFECT A -- the audit row is written with no tenant context
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/auth/sso/callback -- FIXED A: the audit row now carries a tenant', () => {
  test('FIXED: enterWithOrg IS called, with the org read from the provisioned user, before the audit', async () => {
    // INVERTED. This block used to pin an audit write with NO tenant context: `writeAudit` inserts
    // `AuditLog.organizationId` from `getOrgContext()`, and this public route never called `getActiveUser()`, so
    // the context was undefined and every SSO audit row was silently rejected and swallowed. The route now reads the
    // org from the user row it just provisioned and enters it before auditing.
    auditUserRow = { organizationId: 'org-sso' }
    await GET(makeReq({ cookies: HAPPY_COOKIES }))

    expect(auditCalls).toHaveLength(1)
    // ORDER is the assertion: the context is entered BEFORE the write that needs it.
    expect(events.indexOf('enterWithOrg')).toBeGreaterThan(-1)
    expect(events.indexOf('enterWithOrg')).toBeLessThan(events.indexOf('writeAudit'))
    expect(enteredOrgs).toEqual(['org-sso'])
  })

  test('FIXED: the org is looked up by the PROVISIONED user id, through bypassOrg', async () => {
    // The lookup happens before the context can exist, so it MUST bypass the tenant extension -- reading the org
    // through an org-scoped read would return null and re-create the silent failure. The argument is asserted
    // because "it looked something up" is not the same claim.
    provisionImpl = async () => RESULT_CREATED
    await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(userLookupArgs).toEqual([{ where: { id: 'u-new' }, select: { organizationId: true } }])
  })

  test('FIXED (static): the route enters the org context around the audit', async () => {
    // Source-level counterpart, on STABLE facts. INVERTED from "neither appears in the route".
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(src).toContain('enterWithOrg')
    expect(src).toContain('bypassOrg')
    expect(src).toContain("from '@/lib/prisma-tenant'")
    const enterIdx = src.indexOf('enterWithOrg(auditUser')
    const auditIdx = src.indexOf('writeAudit({')
    expect(enterIdx).toBeGreaterThan(-1)
    expect(enterIdx).toBeLessThan(auditIdx)
  })

  test('FIXED: an UNREADABLE user row skips the audit instead of writing one with no tenant', async () => {
    // The narrow failure mode that remains. Writing with `getOrgContext() === undefined` is exactly what silently
    // emptied the trail, so an unresolvable org must mean NO write -- a missing audit row is recoverable, a row
    // attributed to the wrong tenant is not.
    auditUserRow = null
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(auditCalls).toEqual([])
    // And the login still COMPLETES: the audit is not the user's problem.
    expect(sessionToken(res)).toBeTruthy()
    expect(res.headers.get('location')).toBeDefined()
  })

  test('the in-repo precedent: accept-invite enters the org context before auditing', async () => {
    // Documents that this is house style, not a one-off. Asserts on a file this test does not own -- deliberately,
    // because it is the evidence that makes the original code a deviation rather than a choice.
    const sibling = readFileSync(join(import.meta.dir, '..', '..', 'accept-invite', 'route.ts'), 'utf8')
    expect(sibling).toContain('enterWithOrg(invitation.organizationId)')
    const enterIdx = sibling.indexOf('enterWithOrg(invitation.organizationId)')
    const auditIdx = sibling.indexOf('await writeAudit({', enterIdx)
    expect(enterIdx).toBeGreaterThan(-1)
    expect(auditIdx).toBeGreaterThan(enterIdx)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// DEFECT B -- a failed audit is fatal after the account was created
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/auth/sso/callback -- FIXED B: an audit failure no longer aborts the login', () => {
  test('FIXED: a throwing writeAudit still grants the session, on the CREATE path', async () => {
    // INVERTED. The audit used to be awaited outside any try/catch, so a failing audit propagated into the outer
    // catch and the FIRST login of a brand-new principal returned a generic 500. The damage was not the 500 itself
    // but what it left behind: `getOrCreateSsoUser` had ALREADY inserted the user row, so the retry took the
    // "existing user" branch and the SSO_USER_CREATED event for that account was never recorded at all -- the first
    // audit entry for a new admin principal was permanently mislabelled SSO_LOGIN.
    //
    // The audit failure is now logged and the login completes. A login that works is the user-visible contract; the
    // audit trail is the operator's, and losing one row is recoverable where losing the creation event is not.
    provisionImpl = async () => RESULT_CREATED
    auditThrows = new Error('audit log write failed')

    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))

    // A successful callback is a 307 redirect WITH a session cookie -- not an error envelope.
    expect(res.status).toBe(307)
    expect(sessionToken(res)).toBeTruthy()
    expect(res.headers.get('location')).toBeDefined()
    // The account was provisioned exactly once, and the row is still there for the audit to be retried against.
    expect(provisionArgs).toHaveLength(1)
  })

  test('FIXED: an audit failure for an EXISTING user also completes the login', async () => {
    // The same direction for the returning user, so the fix is not a create-path special case.
    provisionImpl = async () => RESULT_EXISTING
    auditThrows = new Error('audit down')
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    expect(res.status).toBe(307)
    expect(sessionToken(res)).toBeTruthy()
  })

  test('FIXED: the handshake cookies are burned even when the audit fails', async () => {
    // This used to be the replay window: the error path returned `handleApiError` with no cookie work, so
    // sso_state / sso_nonce / sso_code_verifier stayed in the browser for their remaining 600s and a replayed
    // callback URL from the SAME browser still passed the state check. Clearing them is now on the success path
    // that the audit can no longer divert.
    auditThrows = new Error('audit down')
    const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
    const joined = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).join('; ')
    for (const name of ['sso_state', 'sso_nonce', 'sso_code_verifier']) {
      expect(joined.toLowerCase(), name).toContain(`${name.toLowerCase()}=;`)
    }
    expect(joined).toContain('Expires=Thu, 01 Jan 1970')
  })

  test('FIXED: the audit failure is LOUD on the server and silent to the client', async () => {
    // The other half of "not fatal": if the failure vanished entirely the operator would have no signal at all,
    // which is the same blindness as before in a different costume. It must be logged server-side, and it must NOT
    // reach the browser -- an audit error can name the tenant and the column.
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    try {
      auditThrows = new Error('audit down: null value in column "organizationId"')
      const res = await GET(makeReq({ cookies: HAPPY_COOKIES }))
      expect(errors.length).toBeGreaterThan(0)
      const body = await res.text()
      expect(body).not.toContain('organizationId')
      expect(body).not.toContain('audit down')
    } finally {
      console.error = original
    }
  })

  test('static: the audit write cannot reject into the handler catch', async () => {
    // The source-level statement of the fix, on stable facts: the write is `void`-ed and carries its own `.catch`,
    // so a rejection is handled at the call site rather than by the outer handler.
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    const auditIdx = src.indexOf('void writeAudit({')
    expect(auditIdx).toBeGreaterThan(-1)
    const catchIdx = src.indexOf('.catch(', auditIdx)
    expect(catchIdx).toBeGreaterThan(auditIdx)
    // And it is still positioned between provisioning and the redirect, so the ordering intent is preserved.
    expect(auditIdx).toBeGreaterThan(src.indexOf('const result = await getOrCreateSsoUser'))
    expect(auditIdx).toBeLessThan(src.indexOf('const res = NextResponse.redirect'))
  })
})
