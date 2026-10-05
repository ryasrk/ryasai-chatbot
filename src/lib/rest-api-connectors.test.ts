import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
  invalidateOAuthToken,
  _clearOAuthTokenCache,
  type EndpointDefinition,
} from './rest-api-connectors'

const endpoints: EndpointDefinition[] = [
  { id: 'ep_1', method: 'GET', path: '/invoices', enabled: true },
  { id: 'ep_2', method: 'POST', path: '/tickets', enabled: false },
]

describe('REST API connector utilities', () => {
  test('matches only enabled endpoint by method and path', () => {
    expect(matchEndpoint('get', '/invoices', endpoints)?.id).toBe('ep_1')
    expect(matchEndpoint('POST', '/tickets', endpoints)).toBeNull()
    expect(matchEndpoint('GET', '/customers', endpoints)).toBeNull()
  })

  test('builds URL with query params', () => {
    expect(
      buildEndpointUrl('https://api.example.com/base', '/invoices', {
        status: 'overdue',
        page: 2,
      }),
    ).toBe('https://api.example.com/base/invoices?status=overdue&page=2')
  })

  test('builds auth headers', async () => {
    expect(await buildAuthHeaders('BEARER', { token: 'abc' })).toEqual({
      Authorization: 'Bearer abc',
    })
    expect(
      await buildAuthHeaders('API_KEY_HEADER', {
        headerName: 'X-API-Key',
        apiKey: 'secret',
      }),
    ).toEqual({ 'X-API-Key': 'secret' })
    expect(await buildAuthHeaders('NONE', {})).toEqual({})
  })

  test('builds BASIC auth header', async () => {
    const headers = await buildAuthHeaders('BASIC', {
      username: 'admin',
      password: 'secret123',
    })
    expect(headers.Authorization).toMatch(/^Basic /)
    const decoded = Buffer.from(
      headers.Authorization.replace('Basic ', ''),
      'base64',
    ).toString()
    expect(decoded).toBe('admin:secret123')
  })

  test('BASIC auth with empty creds returns no header', async () => {
    expect(await buildAuthHeaders('BASIC', {})).toEqual({})
  })

  test('OAUTH2 with missing config returns no header', async () => {
    expect(await buildAuthHeaders('OAUTH2', {})).toEqual({})
    expect(await buildAuthHeaders('OAUTH2', { tokenUrl: 'https://x.com/token' })).toEqual({})
  })

  test('sanitizes sensitive headers', () => {
    expect(
      sanitizeHeaders({ Authorization: 'Bearer abc', 'X-Trace': '1' }),
    ).toEqual({
      Authorization: '••••',
      'X-Trace': '1',
    })
  })
})

/**
 * The OAuth2 client-credentials flow. Previously only the MISSING-CONFIG guard was tested (which
 * returns before any fetch), so the token request itself -- the whole reason the branch exists --
 * had never executed. This is the path a customer's REST API integration uses to authenticate, and
 * a defect here surfaces as a 401 from the third party with no local explanation.
 */
describe('buildAuthHeaders — OAUTH2 client credentials', () => {
  const realFetch = global.fetch
  // Tokens are cached per credential set, so every test starts cold or it would read a neighbour's token.
  beforeEach(() => _clearOAuthTokenCache())
  afterEach(() => {
    global.fetch = realFetch
  })

  function capture(): { url: () => string; init: () => RequestInit } {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    global.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 })
    }) as unknown as typeof fetch
    return { url: () => seenUrl, init: () => seenInit! }
  }

  test('POSTs form-encoded client_credentials to the token URL and returns a Bearer header', async () => {
    const seen = capture()
    const headers = await buildAuthHeaders('OAUTH2', {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'cid',
      clientSecret: 'shh',
    })

    expect(seen.url()).toBe('https://auth.example.com/oauth/token')
    expect(seen.init().method).toBe('POST')
    expect((seen.init().headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    // The token endpoint requires exactly this shape; a JSON body is rejected by most providers.
    const body = new URLSearchParams(String(seen.init().body))
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('shh')
    // scope is OMITTED when not configured -- an empty `scope=` is rejected by some providers.
    expect(body.has('scope')).toBe(false)

    expect(headers).toEqual({ Authorization: 'Bearer tok-123' })
  })

  test('includes scope when configured', async () => {
    const seen = capture()
    await buildAuthHeaders('OAUTH2', {
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'shh',
      scope: 'read write',
    })
    const body = new URLSearchParams(String(seen.init().body))
    expect(body.get('scope')).toBe('read write')
  })

  test('a non-2xx token response THROWS with the status, rather than returning no header', async () => {
    // Returning {} would make the real API call unauthenticated and report a bare 401 from the third
    // party; the operator needs to know the TOKEN step failed.
    global.fetch = (async () =>
      new Response('{"error":"invalid_client"}', { status: 401 })) as unknown as typeof fetch

    await expect(
      buildAuthHeaders('OAUTH2', {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'bad',
      }),
    ).rejects.toThrow(/OAuth2 token fetch failed \(HTTP 401\)/)
  })

  test('a 200 response with NO access_token THROWS, like any failed token step', async () => {
    // Some providers answer 200 with an error envelope. Never `Bearer undefined` — and no longer a silent `{}`
    // either: that sent the API call unauthenticated, and the operator saw a third party's bare 401 instead of the
    // token problem. Same reasoning as the non-2xx case above.
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_scope' }), { status: 200 })) as unknown as typeof fetch

    await expect(
      buildAuthHeaders('OAUTH2', {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'shh',
      }),
    ).rejects.toThrow('no access_token')
  })

  test('a non-string access_token is not coerced into a header', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 12345 }), { status: 200 })) as unknown as typeof fetch

    await expect(
      buildAuthHeaders('OAUTH2', {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'shh',
      }),
    ).rejects.toThrow('no access_token')
  })

  test('a THROWN network error propagates (the caller decides how to report it)', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    await expect(
      buildAuthHeaders('OAUTH2', {
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid',
        clientSecret: 'shh',
      }),
    ).rejects.toThrow('ECONNREFUSED')
  })

  test('the secret is sent to the TOKEN URL only, never to the API base URL', async () => {
    // Pins the direction of the credential: a mistake here would leak the client secret to the
    // customer's own API host instead of their identity provider.
    const seen = capture()
    await buildAuthHeaders('OAUTH2', {
      tokenUrl: 'https://idp.example.com/token',
      clientId: 'cid',
      clientSecret: 'secret-value',
    })
    expect(seen.url()).toBe('https://idp.example.com/token')
    expect(seen.url()).not.toContain('api.example.com')
    // And the returned header carries the ACCESS TOKEN, not the client secret.
    const headers = await buildAuthHeaders('OAUTH2', {
      tokenUrl: 'https://idp.example.com/token',
      clientId: 'cid',
      clientSecret: 'secret-value',
    })
    expect(JSON.stringify(headers)).not.toContain('secret-value')
  })
})

/**
 * OAuth2 tokens are cached, shared, and fetched through the SSRF guard.
 *
 * MEASURED against a mock identity provider that allows 20 token requests a second: 100 concurrent API calls made
 * 100 token requests, 80 were refused with 429, and those 80 calls failed. The token URL was also never SSRF-checked,
 * so a client secret could be posted to an internal host.
 */
describe('OAuth2 tokens — cached, shared, and SSRF-checked', () => {
  const realFetch = global.fetch
  const creds = { tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'shh' }
  let tokenCalls = 0
  let expiresIn: number | undefined = 3600
  beforeEach(() => {
    _clearOAuthTokenCache()
    tokenCalls = 0
    expiresIn = 3600
    global.fetch = (async () => {
      tokenCalls++
      // A real provider takes a moment; the overlap is what single-flight has to handle.
      await new Promise((r) => setTimeout(r, 20))
      return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, ...(expiresIn ? { expires_in: expiresIn } : {}) }), { status: 200 })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  test('a second call reuses the token instead of asking again', async () => {
    const a = await buildAuthHeaders('OAUTH2', creds)
    const b = await buildAuthHeaders('OAUTH2', creds)
    expect(a).toEqual({ Authorization: 'Bearer tok-1' })
    expect(b).toEqual(a)
    expect(tokenCalls).toBe(1)
  })

  test('100 concurrent first calls share ONE token request (cold cache)', async () => {
    const all = await Promise.all(Array.from({ length: 100 }, () => buildAuthHeaders('OAUTH2', creds)))
    expect(tokenCalls).toBe(1)
    expect(new Set(all.map((h) => h.Authorization))).toEqual(new Set(['Bearer tok-1']))
  })

  test('different credentials get different tokens', async () => {
    await buildAuthHeaders('OAUTH2', creds)
    const other = await buildAuthHeaders('OAUTH2', { ...creds, clientId: 'another' })
    expect(other).toEqual({ Authorization: 'Bearer tok-2' })
    expect(tokenCalls).toBe(2)
  })

  test('a token past its lifetime is fetched again', async () => {
    expiresIn = 0.04 // 40 ms; a short-lived token is reused for half its life
    await buildAuthHeaders('OAUTH2', creds)
    await new Promise((r) => setTimeout(r, 60))
    await buildAuthHeaders('OAUTH2', creds)
    expect(tokenCalls).toBe(2)
  })

  test('invalidateOAuthToken (the executor calls it on a 401) forces a fresh token', async () => {
    await buildAuthHeaders('OAUTH2', creds)
    invalidateOAuthToken(creds)
    const again = await buildAuthHeaders('OAUTH2', creds)
    expect(again).toEqual({ Authorization: 'Bearer tok-2' })
  })

  test('a FAILED token request is not cached: the next call tries again', async () => {
    let first = true
    global.fetch = (async () => {
      tokenCalls++
      if (first) { first = false; return new Response('busy', { status: 429 }) }
      return new Response(JSON.stringify({ access_token: 'recovered', expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(buildAuthHeaders('OAUTH2', creds)).rejects.toThrow('HTTP 429')
    expect(await buildAuthHeaders('OAUTH2', creds)).toEqual({ Authorization: 'Bearer recovered' })
  })

  test('a non-JSON token response is a clear error, not a JSON parse crash', async () => {
    global.fetch = (async () => new Response('<html>login page</html>', { status: 200 })) as unknown as typeof fetch
    await expect(buildAuthHeaders('OAUTH2', creds)).rejects.toThrow('did not return JSON')
  })

  test('a token URL on a private IP is refused BEFORE the client secret is sent', async () => {
    let sent = false
    global.fetch = (async () => { sent = true; return new Response('{}') }) as unknown as typeof fetch
    await expect(buildAuthHeaders('OAUTH2', { ...creds, tokenUrl: 'http://169.254.169.254/token' })).rejects.toThrow('blocked internal host')
    expect(sent).toBe(false)
  })
})
