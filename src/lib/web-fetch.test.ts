import { afterEach, describe, expect, it } from 'bun:test'
import { fetchUrlForPlanner, webSearch, getSearxngEndpoint } from '@/lib/web-fetch'

// ---------------------------------------------------------------------------
// fetch mocking for redirect tests. Hostnames use the reserved `.example` TLD
// so isBlockedHostAsync's DNS lookup fails fast (it fails open on resolution
// errors) and no real network is touched. Blocked targets use IP literals,
// which skip DNS entirely.
// ---------------------------------------------------------------------------

interface MockRoute {
  status: number
  headers?: Record<string, string>
  body?: string
}

function withMockFetch(routes: Record<string, MockRoute>, run: (calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(href)
    const route = routes[href]
    if (!route) throw new Error(`mock fetch: unexpected URL ${href}`)
    return new Response(route.body ?? '', {
      status: route.status,
      headers: route.headers ?? {},
    })
  }) as typeof fetch
  return run(calls).finally(() => {
    globalThis.fetch = original
  })
}

const HTML_200: MockRoute = { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Final</title></head><body>Hello</body></html>' }

describe('web-fetch redirects', () => {
  afterEach(() => {
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
  })

  it('follows an unauthenticated redirect to a public host', async () => {
    await withMockFetch({
      'https://start.example/page': { status: 302, headers: { location: 'https://public.example/final' } },
      'https://public.example/final': HTML_200,
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://start.example/page')
      expect(r.ok).toBe(true)
      expect(r.title).toBe('Final')
      expect(r.content).toContain('Hello')
      expect(calls).toEqual(['https://start.example/page', 'https://public.example/final'])
    })
  })

  it('rejects a 302 that redirects to a blocked internal IP', async () => {
    await withMockFetch({
      'https://evil.example/a': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://evil.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('blocked')
      // The redirected hop must never be fetched
      expect(calls).toEqual(['https://evil.example/a'])
    })
  })

  it('rejects a multi-hop chain where hop2 redirects to an internal target', async () => {
    await withMockFetch({
      'https://hop1.example/x': { status: 301, headers: { location: 'https://hop2.example/y' } },
      'https://hop2.example/y': { status: 302, headers: { location: 'http://10.0.0.5/admin' } },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://hop1.example/x')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('blocked')
      expect(calls).toEqual(['https://hop1.example/x', 'https://hop2.example/y'])
    })
  })

  it('resolves relative Location headers against the current URL', async () => {
    await withMockFetch({
      'https://site.example/dir/page': { status: 302, headers: { location: '/other/doc?q=1' } },
      'https://site.example/other/doc?q=1': HTML_200,
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://site.example/dir/page')
      expect(r.ok).toBe(true)
      expect(calls[1]).toBe('https://site.example/other/doc?q=1')
    })
  })

  it('allows https→http downgrade (documented policy: credential-free read-only fetch)', async () => {
    await withMockFetch({
      'https://legacy.example/start': { status: 302, headers: { location: 'http://mirror.example/plain' } },
      'http://mirror.example/plain': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain text' },
    }, async () => {
      const r = await fetchUrlForPlanner('https://legacy.example/start')
      expect(r.ok).toBe(true)
      expect(r.content).toContain('plain text')
    })
  })

  it('rejects non-http(s) schemes introduced mid-redirect', async () => {
    await withMockFetch({
      'https://sneaky.example/x': { status: 302, headers: { location: 'file:///etc/passwd' } },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://sneaky.example/x')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('http')
      expect(calls).toEqual(['https://sneaky.example/x'])
    })
  })

  it('enforces the redirect hop cap', async () => {
    const routes: Record<string, MockRoute> = {}
    for (let i = 0; i < 10; i++) {
      routes[`https://loop.example/h${i}`] = { status: 302, headers: { location: `/h${i + 1}` } }
    }
    await withMockFetch(routes, async () => {
      const r = await fetchUrlForPlanner('https://loop.example/h0')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Too many redirects')
    })
  })

  it('reports a 3xx without a Location header as a failure', async () => {
    await withMockFetch({
      'https://odd.example/r': { status: 304 },
    }, async () => {
      const r = await fetchUrlForPlanner('https://odd.example/r')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Location')
    })
  })
})

describe('web-fetch', () => {
  it('rejects invalid URL', async () => {
    const r = await fetchUrlForPlanner('not-a-url')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects non-http protocols', async () => {
    const r = await fetchUrlForPlanner('ftp://example.com/file')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('http')
  })

  it('rejects blocked internal host (localhost)', async () => {
    const r = await fetchUrlForPlanner('http://localhost:8080')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('blocked')
  })

  it('rejects blocked internal host (169.254.x metadata)', async () => {
    const r = await fetchUrlForPlanner('http://169.254.169.254/latest')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('blocked')
  })

  it('rejects empty URL', async () => {
    const r = await fetchUrlForPlanner('')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('webSearch', () => {
  it('rejects empty query', async () => {
    const r = await webSearch('')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects whitespace-only query', async () => {
    const r = await webSearch('   ')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('getSearxngEndpoint', () => {
  const original = process.env.SEARXNG_URL
  afterEach(() => {
    if (original === undefined) delete process.env.SEARXNG_URL
    else process.env.SEARXNG_URL = original
  })

  it('unset or blank → null (DuckDuckGo fallback stays the default)', () => {
    delete process.env.SEARXNG_URL
    expect(getSearxngEndpoint()).toBeNull()
    process.env.SEARXNG_URL = '   '
    expect(getSearxngEndpoint()).toBeNull()
  })

  it('strips trailing slashes so /search is not doubled up', () => {
    process.env.SEARXNG_URL = 'http://searxng:8080//'
    expect(getSearxngEndpoint()).toBe('http://searxng:8080')
  })

  it('preserves a subpath deployment', () => {
    process.env.SEARXNG_URL = 'https://example.com/searx/'
    expect(getSearxngEndpoint()).toBe('https://example.com/searx')
  })

  it('rejects non-http protocols and garbage', () => {
    process.env.SEARXNG_URL = 'file:///etc/passwd'
    expect(getSearxngEndpoint()).toBeNull()
    process.env.SEARXNG_URL = 'not-a-url'
    expect(getSearxngEndpoint()).toBeNull()
  })
})
