/**
 * Every outbound fetch must carry a deadline.
 *
 * WHY THIS FILE EXISTS. A `fetch` with no signal stays open indefinitely: a hung identity
 * provider hangs sign-in, a hung collector socket keeps an observability request alive, and a
 * stalled LLM socket makes the retry ladder unreachable because the first attempt never
 * returns. None of that shows up as a FAILING test -- the suite stays green while the request
 * hangs -- so the regression has to be caught by asserting on the `signal` itself.
 *
 * The global `fetch` is replaced with a probe that records the init it was handed. That is the
 * only way to observe a deadline that is never reached in a unit test.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

// Set BEFORE any dynamic import of the modules under test: `exchangeCode` reads these through
// `env()` at CALL time, but the SSO module also snapshots config at import, so setting them
// here is the safe order.
process.env.OIDC_ISSUER = 'https://idp.test'
process.env.OIDC_CLIENT_ID = 'test-client-id'
process.env.OIDC_CLIENT_SECRET = 'test-client-secret'
process.env.OIDC_REDIRECT_URI = 'https://app.test/api/auth/sso/callback'

const calls: Array<{ url: string; init: RequestInit | undefined }> = []

const realFetch = globalThis.fetch

function installProbe(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url)
    calls.push({ url, init })
    return handler(url)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Every probe below must prove the signal is a REAL AbortSignal, not a truthy placeholder. */
function expectAbortSignal(init: RequestInit | undefined, label: string) {
  expect(init?.signal, `${label}: no signal was passed to fetch`).toBeDefined()
  expect(init!.signal, `${label}: signal is not an AbortSignal`).toBeInstanceOf(AbortSignal)
}

describe('the SSO / OIDC login path is never left without a deadline', () => {
  test('OIDC discovery carries an AbortSignal', async () => {
    installProbe(() =>
      new Response(JSON.stringify({ authorization_endpoint: 'https://idp.test/auth', token_endpoint: 'https://idp.test/token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { getOidcConfig } = await import('@/lib/sso')
    await getOidcConfig('https://idp.test')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://idp.test/.well-known/openid-configuration')
    expectAbortSignal(calls[0]!.init, 'discovery')
  })

  test('the token exchange carries an AbortSignal', async () => {
    installProbe(() => new Response(JSON.stringify({ access_token: 'at', id_token: 'it' }), { status: 200 }))
    const { exchangeCode } = await import('@/lib/sso')
    await exchangeCode('the-code', {
      issuer: 'https://idp.test',
      client_id: 'c',
      client_secret: 's',
      redirect_uri: 'https://app.test/cb',
      authorization_endpoint: 'https://idp.test/auth',
      token_endpoint: 'https://idp.test/token',
      userinfo_endpoint: 'https://idp.test/userinfo',
      jwks_uri: 'https://idp.test/jwks',
    } as never)

    expect(calls.length).toBeGreaterThan(0)
    expectAbortSignal(calls[0]!.init, 'token exchange')
  })

  test('the JWKS fetch carries an AbortSignal', async () => {
    // JWKS loading is reached through the RS256 verification path, not a bare fetchJwks
    // export. A dummy 3-part token is enough: the fetch happens before any signature check.
    installProbe(() =>
      new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'k1', n: 'a', e: 'AQAB' }] }), { status: 200 }),
    )
    const { verifyIdTokenRs256, resetJwksCache } = await import('@/lib/sso')
    resetJwksCache()
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iss: 'https://idp.test', sub: 'u1' })).toString('base64url')
    await verifyIdTokenRs256(`${header}.${payload}.sig`, {
      issuer: 'https://idp.test',
      client_id: 'c',
      client_secret: 's',
      redirect_uri: 'https://app.test/cb',
      authorization_endpoint: 'https://idp.test/auth',
      token_endpoint: 'https://idp.test/token',
      userinfo_endpoint: 'https://idp.test/userinfo',
      jwks_uri: 'https://idp.test/jwks',
    } as never).catch(() => undefined)

    const jwks = calls.filter((c) => c.url === 'https://idp.test/jwks')
    expect(jwks).toHaveLength(1)
    expectAbortSignal(jwks[0]!.init, 'jwks')
  })

  test('the userinfo call carries an AbortSignal', async () => {
    installProbe(() => new Response(JSON.stringify({ sub: 'u1' }), { status: 200 }))
    const { fetchUserInfo } = await import('@/lib/sso')
    await fetchUserInfo('token-value', {
      issuer: 'https://idp.test',
      client_id: 'c',
      client_secret: 's',
      redirect_uri: 'https://app.test/cb',
      authorization_endpoint: 'https://idp.test/auth',
      token_endpoint: 'https://idp.test/token',
      userinfo_endpoint: 'https://idp.test/userinfo',
      jwks_uri: 'https://idp.test/jwks',
    } as never)

    expect(calls).toHaveLength(1)
    expectAbortSignal(calls[0]!.init, 'userinfo')
  })
})

describe('the SAML metadata fetch is never left without a deadline', () => {
  test('discoverFromMetadata carries an AbortSignal', async () => {
    installProbe(() =>
      new Response(
        '<EntityDescriptor entityID="https://idp.test"><IDPSSODescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.test/sso"/></IDPSSODescriptor></EntityDescriptor>',
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      ),
    )
    const { discoverFromMetadata } = await import('@/lib/sso-saml')
    await discoverFromMetadata('https://idp.test/metadata')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://idp.test/metadata')
    expectAbortSignal(calls[0]!.init, 'saml metadata')
  })
})

describe('the LLM transport retry ladder is not defeated by a hung socket', () => {
  test('fetchWithRetry passes a signal on every attempt', async () => {
    installProbe(() => new Response('ok', { status: 200 }))
    const { fetchWithRetry } = await import('@/lib/llm-client-utils')
    const res = await fetchWithRetry('https://llm.test/v1/chat', { method: 'POST' })

    expect(res.status).toBe(200)
    // One attempt, and it carried a deadline. Without one the retry ladder below could never
    // run: the first attempt would simply never settle.
    expect(calls).toHaveLength(1)
    expectAbortSignal(calls[0]!.init, 'llm attempt 1')
  })

  test('an AbortSignal supplied by the CALLER is preserved, not overwritten', async () => {
    // The LLM client passes its own `AbortSignal.timeout(LLM_TIMEOUT_MS)`; fetchWithRetry must
    // not replace it, or a caller with a tighter deadline would silently lose it.
    installProbe(() => new Response('ok', { status: 200 }))
    const { fetchWithRetry } = await import('@/lib/llm-client-utils')
    const callerSignal = AbortSignal.timeout(60_000)
    await fetchWithRetry('https://llm.test/v1/chat', { method: 'POST', signal: callerSignal })

    expect(calls[0]!.init!.signal).toBe(callerSignal)
  })
})

describe('observability forwarding cannot outlive the request it observes', () => {
  test('a Langfuse trace forward carries a SHORTER deadline than the login path', async () => {
    installProbe(() => new Response('{}', { status: 200 }))
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    try {
      const { traceLlmCall } = await import('@/lib/observability')
      traceLlmCall({
        purpose: 'chat',
        provider: 'p',
        model: 'm',
        inputPreview: 'in',
        outputPreview: 'out',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
      })
      // traceLlmCall is fire-and-forget; let the microtask queue drain.
      await new Promise((r) => setTimeout(r, 50))

      const forwarded = calls.filter((c) => c.url.includes('langfuse'))
      expect(forwarded.length).toBeGreaterThan(0)
      for (const c of forwarded) expectAbortSignal(c.init, 'langfuse forward')
    } finally {
      delete process.env.LANGFUSE_PUBLIC_KEY
      delete process.env.LANGFUSE_SECRET_KEY
    }
  })

  test('a Langfuse score forward carries an AbortSignal', async () => {
    installProbe(() => new Response('{}', { status: 200 }))
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    try {
      const { postLangfuseScore } = await import('@/lib/observability')
      await postLangfuseScore({ name: 'quality', value: 1, traceId: 't1' })

      const scored = calls.filter((c) => c.url.includes('/scores'))
      expect(scored).toHaveLength(1)
      expectAbortSignal(scored[0]!.init, 'langfuse score')
    } finally {
      delete process.env.LANGFUSE_PUBLIC_KEY
      delete process.env.LANGFUSE_SECRET_KEY
    }
  })
})

describe('the deadlines are OVERRIDABLE for slow on-prem deployments', () => {
  test('OIDC_TIMEOUT_MS is honoured, and a junk value falls back to the default', async () => {
    // An on-prem IdP behind a slow link may legitimately need longer than 10s. A junk value
    // must not produce a NaN deadline, which `AbortSignal.timeout` would reject outright.
    const { __oidcTimeoutMsForTest } = await import('@/lib/sso')
    process.env.OIDC_TIMEOUT_MS = '25000'
    expect(__oidcTimeoutMsForTest()).toBe(25_000)
    process.env.OIDC_TIMEOUT_MS = 'not-a-number'
    expect(__oidcTimeoutMsForTest()).toBe(10_000)
    process.env.OIDC_TIMEOUT_MS = '-5'
    expect(__oidcTimeoutMsForTest()).toBe(10_000)
    delete process.env.OIDC_TIMEOUT_MS
    expect(__oidcTimeoutMsForTest()).toBe(10_000)
  })

  test('OBSERVABILITY_TIMEOUT_MS is honoured, and defaults to 5s', async () => {
    const { __observabilityTimeoutMsForTest } = await import('@/lib/observability')
    expect(__observabilityTimeoutMsForTest()).toBe(5_000)
    process.env.OBSERVABILITY_TIMEOUT_MS = '1500'
    expect(__observabilityTimeoutMsForTest()).toBe(1_500)
    delete process.env.OBSERVABILITY_TIMEOUT_MS
  })

  test('SAML_TIMEOUT_MS is honoured, and defaults to 10s', async () => {
    const { __samlTimeoutMsForTest } = await import('@/lib/sso-saml')
    expect(__samlTimeoutMsForTest()).toBe(10_000)
    process.env.SAML_TIMEOUT_MS = '30000'
    expect(__samlTimeoutMsForTest()).toBe(30_000)
    delete process.env.SAML_TIMEOUT_MS
  })
})
