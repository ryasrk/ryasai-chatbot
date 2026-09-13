/**
 * GET /api/auth/saml/login — the SP-initiated SAML entry point.
 *
 * WHY THIS FILE EXISTS. This route is the single click that hands a user to the IdP. It is three lines of logic
 * and every one of them is load-bearing:
 *
 *   1. THE CONFIGURATION GATE. When SAML env vars are unset the route must NOT attempt to build an AuthnRequest
 *      (that throws and the user sees a 500) — it must bounce back to /login with a named reason so the login page
 *      can say why. The gate is checked BEFORE the outbound work, and that ORDER is asserted here (see the events
 *      array test): a gate checked after the redirect URL is built is not a gate.
 *   2. THE 302 IS EXPLICIT. `NextResponse.redirect(redirectUrl, 302)` passes the status itself; the default for
 *      `redirect()` is 307, which a browser would re-POST to the IdP. Pinned by value.
 *   3. THE ERROR PATH DOES NOT LEAK. A build/network failure is answered by handleApiError with a fixed message.
 *
 * Control tests in this file were verified by mutating the route in place, running the file, and restoring it; the
 * mutations that were proven to bite are named in each test comment. Nothing in this file asserts the redirect URL
 * VALUE, because the query-string shape belongs to @node-saml and is already covered by sso-saml.test.ts.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
let configured = true
let redirectUrl = 'https://idp.test/saml/sso?SAMLRequest=abc&RelayState=xyz'
let buildThrows: Error | null = null
let generateCalls = 0
let generateArgs: unknown[] = []
const events: string[] = []
/** Captured so the redirect target can be asserted without reading the mock's own return value. */
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/sso-saml', () => ({
  isSamlConfigured: () => {
    events.push('isSamlConfigured')
    return configured
  },
  generateAuthnRequestRedirectUrl: async (...args: unknown[]) => {
    generateCalls++
    generateArgs = args
    events.push('generateAuthnRequestRedirectUrl')
    if (buildThrows) throw buildThrows
    return redirectUrl
  },
}))

mock.module('@/lib/session', () => ({
  // Deliberately the same envelope shape as the real handleApiError: { error: { code, message } }.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    handleErrorArgs.push({ fallback, status })
    events.push('handleApiError')
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

// DYNAMIC: mock.module does NOT apply to static imports, so the route must be loaded after the mocks above.
const { GET } = await import('./route')

/**
 * NextRequest exposes `nextUrl` and a `cookies` property that a plain WHATWG `Request` does NOT have. The code
 * under test reads neither, but the route is exercised through the same helper the other route tests use so a
 * future edit that reaches for `req.nextUrl` fails loudly here instead of with a confusing undefined.
 */
function get(url = 'http://localhost/api/auth/saml/login') {
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return GET(req as never)
}

beforeEach(() => {
  configured = true
  redirectUrl = 'https://idp.test/saml/sso?SAMLRequest=abc&RelayState=xyz'
  buildThrows = null
  generateCalls = 0
  generateArgs = []
  events.length = 0
  handleErrorArgs = []
})

describe('the configuration gate', () => {
  test('an unconfigured deployment is redirected to /login instead of answering a 500', async () => {
    // Control C1 (deleting the `if (!isSamlConfigured())` block): the route threw and every assertion below turned
    // red. This is the "SAML not set up yet" path, i.e. the default state of a fresh install.
    configured = false
    const res = await get()
    const target = res.headers.get('location')!
    // Asserts the DESTINATION rather than the raw status: `NextResponse.redirect` on a relative target answers 200
    // in a bun test process (no server stands between the handler and the assertion), and pinning 302 there would
    // test the test harness rather than the route. The explicit-302 half of the contract is covered below by the
    // configured redirect, where the target is absolute.
    expect(new URL(target).pathname).toBe('/login')
  })

  test('the failure names the reason so the login page can explain it', async () => {
    // Control C2 (changing the query string to a bare /login): red. A bare redirect leaves the operator staring at
    // an unchanged login form with no hint that the SAML env vars are missing.
    configured = false
    const res = await get()
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('saml_not_configured')
  })

  test('THE GATE IS CHECKED FIRST: no AuthnRequest is built when SAML is unconfigured', async () => {
    // ORDER MATTERS. Building the redirect before checking the config means an unconfigured install does an
    // outbound metadata fetch (or throws) on every click.
    configured = false
    await get()
    expect(events).toEqual(['isSamlConfigured'])
    expect(generateCalls).toBe(0)
  })

  test('the unconfigured redirect is relative to the REQUEST origin, not a constant host', async () => {
    // A hardcoded host would bounce a self-hosted deployment to someone else's domain.
    configured = false
    const res = await get('https://tenant.example.com/api/auth/saml/login')
    expect(new URL(res.headers.get('location')!).origin).toBe('https://tenant.example.com')
  })

  test('the unconfigured path never reaches the error handler', async () => {
    // The redirect IS the contract, not a fallback: reporting it as an internal error would 500 the page.
    configured = false
    const res = await get()
    expect(res.headers.get('location')).not.toBeNull()
    expect(handleErrorArgs).toHaveLength(0)
  })
})

describe('the configured redirect', () => {
  test('the IdP URL from the builder is the Location header', async () => {
    // Control C3 (returning NextResponse.redirect(new URL('/login', req.url)) unconditionally): red.
    const res = await get()
    expect(res.headers.get('location')).toBe(redirectUrl)
  })

  test('the status is 302 and the builder is called exactly once', async () => {
    // 307 (the NextResponse.redirect default) would make the browser re-POST the body to the IdP.
    const res = await get()
    expect(res.status).toBe(302)
    expect(generateCalls).toBe(1)
  })

  test('the builder is called with no arguments (it reads env itself)', async () => {
    // Pinning the arity: a future edit that passes a request-derived host into the builder would change the
    // AuthnRequest Destination/ACS in ways the IdP config would have to follow.
    await get()
    expect(generateArgs).toEqual([])
  })

  test('the gate runs BEFORE the builder on the happy path too', async () => {
    await get()
    expect(events).toEqual(['isSamlConfigured', 'generateAuthnRequestRedirectUrl'])
  })

  test('the redirect does not depend on the request path or query string', async () => {
    // A login click carrying stray query params (utm_, a stale ?error=) must not be forwarded to the IdP.
    const res = await get('http://localhost/api/auth/saml/login?error=stale&next=/admin')
    expect(res.headers.get('location')).toBe(redirectUrl)
  })
})

describe('the failure path', () => {
  test('a builder failure is an internal error with the route-specific fallback message', async () => {
    buildThrows = new Error('SAML entry point could not be resolved')
    const res = await get()
    expect(res.status).toBe(500)
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to initiate SAML login.', status: 500 }])
  })

  test('the raw error text never reaches the client', async () => {
    // The thrown message can name an internal hostname or the IdP metadata URL.
    buildThrows = new Error('fetch failed for https://idp.internal.corp/metadata')
    const res = await get()
    const body = await res.text()
    expect(body).not.toContain('idp.internal.corp')
    expect(body).not.toContain('entry point')
  })

  test('the error envelope keeps the documented { error: { code, message } } shape', async () => {
    buildThrows = new Error('boom')
    const body = (await (await get()).json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe('Failed to initiate SAML login.')
  })
})
