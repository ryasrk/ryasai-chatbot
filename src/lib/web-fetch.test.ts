import { afterEach, describe, expect, it, mock } from 'bun:test'
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

// ---------------------------------------------------------------------------
// The search paths.
//
// Both legs of the search were uncovered: the SearXNG path (no test set the
// endpoint) and the DuckDuckGo path (no test made fetch resolve). Only the two
// empty-query guards ran. This left the ONLY external-information channel the
// planner has — everything the model does not already know — completely
// unverified, including the HTML parser and the fallback contract between the two
// legs. These tests make fetch resolve so both legs execute.
// ---------------------------------------------------------------------------
describe('webSearch — DuckDuckGo leg', () => {
  afterEach(() => {
    delete process.env.SEARXNG_URL
  })

  const DDG_HTML = `
    <table>
      <tr><td><a class="result-link" href="https://docs.example.com/alpha">Alpha documentation</a></td></tr>
      <tr><td>Alpha is a curated reference for the thing you asked about.</td></tr>
      <tr><td><a class="result-link" href="https://www.beta.example.org/blog/post">Beta blog post</a></td></tr>
      <tr><td>Beta covers the same topic from a different angle here.</td></tr>
    </table>`

  it('parses titles and urls out of the lite HTML', async () => {
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=sales%20report': { status: 200, headers: { 'content-type': 'text/html' }, body: DDG_HTML },
    }, async (calls) => {
      const r = await webSearch('sales report')
      expect(r.ok).toBe(true)
      expect(r.results.map((x) => x.url)).toEqual([
        'https://docs.example.com/alpha',
        'https://www.beta.example.org/blog/post',
      ])
      expect(r.results[0].title).toBe('Alpha documentation')
      expect(calls[0]).toContain('lite.duckduckgo.com')
    })
  })

  it('caps the result count at maxResults', async () => {
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: DDG_HTML },
    }, async () => {
      const r = await webSearch('x', 1)
      expect(r.results).toHaveLength(1)
    })
  })

  it('drops DuckDuckGo internal links and sponsored rows', async () => {
    const html = `
      <a href="https://duckduckgo.com/y.js?ad_provider=x">Advert one</a>
      <a href="https://duckduckgo.org/about">About DDG</a>
      <a href="https://good.example.com/real">A real result</a>`
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: html },
    }, async () => {
      const r = await webSearch('x')
      // Sponsored/internal rows are noise; a planner citing them cites an ad.
      expect(r.results.map((x) => x.url)).toEqual(['https://good.example.com/real'])
    })
  })

  it('an empty parse is a FAILURE, not an empty success', async () => {
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>nothing here</body></html>' },
    }, async () => {
      const r = await webSearch('x')
      // Reporting ok with zero results would make the planner believe it searched
      // and found nothing, instead of that the scrape broke.
      expect(r.ok).toBe(false)
      expect(r.error).toContain('No results')
    })
  })

  it('an HTTP failure is reported with the status', async () => {
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=x': { status: 429 },
    }, async () => {
      const r = await webSearch('x')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('429')
    })
  })

  it('a network throw is reported, not propagated', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('EAI_AGAIN') }) as unknown as typeof fetch
    try {
      const r = await webSearch('x')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('EAI_AGAIN')
    } finally {
      globalThis.fetch = original
    }
  })

  it('the query is URL-encoded', async () => {
    const seen: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      seen.push(typeof input === 'string' ? input : input.href)
      return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    try {
      await webSearch('a & b = c?')
      // Measured: the URL is built with encodeURIComponent, so spaces are %20 and
      // NOT '+'. Asserting '+' was my assumption, not the source's behaviour.
      expect(seen[0]).toContain('q=a%20%26%20b%20%3D%20c%3F')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('webSearch — SearXNG leg', () => {
  afterEach(() => {
    delete process.env.SEARXNG_URL
  })

  it('a configured SearXNG is preferred and its JSON is mapped', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    await withMockFetch({
      'http://searxng.local:8080/search?q=revenue&format=json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results: [
          { title: 'Revenue explained', url: 'https://ex.example/a', content: 'Revenue is the top line.' },
        ] }),
      },
    }, async (calls) => {
      const r = await webSearch('revenue')
      expect(r.ok).toBe(true)
      expect(r.results[0].title).toBe('Revenue explained')
      expect(r.results[0].snippet).toBe('Revenue is the top line.')
      // DuckDuckGo must NOT be contacted when SearXNG answered.
      expect(calls).toHaveLength(1)
    })
  })

  it('results missing a title or url are dropped', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    await withMockFetch({
      'http://searxng.local:8080/search?q=x&format=json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results: [
          { title: 'No url here' },
          { url: 'https://ex.example/b' },
          { title: 'Complete', url: 'https://ex.example/c' },
        ] }),
      },
    }, async () => {
      const r = await webSearch('x')
      expect(r.results.map((x) => x.url)).toEqual(['https://ex.example/c'])
    })
  })

  it('a snippet is truncated to 200 characters', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    await withMockFetch({
      'http://searxng.local:8080/search?q=x&format=json': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results: [{ title: 'T', url: 'https://ex.example/d', content: 'y'.repeat(500) }] }),
      },
    }, async () => {
      const r = await webSearch('x')
      expect(r.results[0].snippet).toHaveLength(200)
    })
  })

  it('an HTTP error FALLS BACK to DuckDuckGo rather than failing', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    await withMockFetch({
      'http://searxng.local:8080/search?q=x&format=json': { status: 503 },
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: '<a href="https://good.example.com/r">A result</a>' },
    }, async () => {
      const r = await webSearch('x')
      // A self-hosted SearXNG being down must not disable search entirely.
      expect(r.ok).toBe(true)
      expect(r.results[0].url).toBe('https://good.example.com/r')
    })
  })

  it('an EMPTY SearXNG result set falls back to DuckDuckGo', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    await withMockFetch({
      'http://searxng.local:8080/search?q=x&format=json': {
        status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [] }),
      },
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: '<a href="https://good.example.com/r">A result</a>' },
    }, async () => {
      const r = await webSearch('x')
      expect(r.ok).toBe(true)
      expect(r.results[0].url).toBe('https://good.example.com/r')
    })
  })

  it('a SearXNG throw falls back to DuckDuckGo', async () => {
    process.env.SEARXNG_URL = 'http://searxng.local:8080'
    const original = globalThis.fetch
    let n = 0
    globalThis.fetch = (async (input: any) => {
      n += 1
      const href = typeof input === 'string' ? input : input.href
      if (href.includes('searxng')) throw new Error('ECONNREFUSED')
      return new Response('<a href="https://good.example.com/r">A result</a>', { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    try {
      const r = await webSearch('x')
      expect(r.ok).toBe(true)
      expect(n).toBe(2)
    } finally {
      globalThis.fetch = original
    }
  })

  it('with NO SearXNG configured, DuckDuckGo is used directly', async () => {
    delete process.env.SEARXNG_URL
    await withMockFetch({
      'https://lite.duckduckgo.com/lite/?q=x': { status: 200, headers: { 'content-type': 'text/html' }, body: '<a href="https://good.example.com/r">A result</a>' },
    }, async (calls) => {
      const r = await webSearch('x')
      expect(r.ok).toBe(true)
      expect(calls).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// The per-hop guard suite and the failure branches
//
// Nine lines had never run, and every one of them is a refusal: a DNS-rebinding
// block, a redirect carrying embedded credentials, a non-ok status, a network
// throw, and the hop cap. A guard that has never been executed is a guard nobody
// knows works.
// ---------------------------------------------------------------------------

describe('web-fetch — per-hop guards that had never run', () => {
  afterEach(() => {
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
  })

  it('a redirect whose Location carries embedded credentials is refused', async () => {
    // Credentials in a Location header are a classic way to smuggle auth into a
    // follow-up request; this fetch attaches none itself, so accepting one would
    // hand a third party a credential the caller never intended to send.
    await withMockFetch({
      'https://start.example/a': { status: 302, headers: { location: 'https://user:pass@public.example/final' } },
      // Deliberately absent: if the guard fails, the test fails on the unexpected URL
      // rather than silently fetching with credentials.
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('must not contain embedded credentials')
      // The credentialed URL must never be requested.
      expect(calls).toEqual(['https://start.example/a'])
    })
  })

  it('a non-ok status (e.g. 404) returns the status in the error', async () => {
    await withMockFetch({
      'https://start.example/missing': { status: 404, body: 'not found' },
    }, async () => {
      const r = await fetchUrlForPlanner('https://start.example/missing')
      expect(r.ok).toBe(false)
      // The STATUS is the actionable part: 404 means "wrong URL", 403 means "blocked
      // us", 500 means "try again". Collapsing them loses that.
      expect(r.error).toContain('404')
    })
  })

  it('a network throw becomes a Fetch error result, not an exception', async () => {
    // The planner calls this while composing an answer; a rejected promise would
    // abort the whole turn instead of letting the model work without the page.
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:443') }) as unknown as typeof fetch
    try {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Fetch error')
      expect(r.error).toContain('ECONNREFUSED')
    } finally {
      globalThis.fetch = original
    }
  })

  it('a non-Error throw is stringified rather than reported as undefined', async () => {
    // A provider or polyfill can reject with a plain string; `e.message` would be
    // undefined and the operator would read "Fetch error: undefined".
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw 'socket died' }) as unknown as typeof fetch
    try {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('socket died')
      expect(r.error).not.toContain('undefined')
    } finally {
      globalThis.fetch = original
    }
  })

  it('a redirect LOOP stops at the hop cap instead of spinning forever', async () => {
    // A self-redirecting URL is the simplest way to hang a fetcher. The cap is
    // bounded by the SAME deadline as the whole request, so five hops cannot
    // multiply the timeout.
    const routes: Record<string, MockRoute> = {}
    const LIMIT = 5
    for (let i = 0; i <= LIMIT; i++) {
      routes[`https://hop${i}.example/p`] = { status: 302, headers: { location: `https://hop${i + 1}.example/p` } }
    }
    await withMockFetch(routes, async (calls) => {
      const r = await fetchUrlForPlanner('https://hop0.example/p')
      expect(r.ok).toBe(false)
      // BOTH the in-loop cap and the trailing fall-through say "Too many redirects",
      // so the message alone cannot distinguish them — deleting the cap left this
      // test green. What IS distinguishable is the LIMIT text, which only the cap
      // produces.
      expect(r.error).toContain(`limit ${LIMIT}`)
      // Exactly cap+1 requests: one per permitted hop, then the refusal. More would
      // mean the cap is off by one; fewer would mean it refuses early.
      expect(calls).toHaveLength(LIMIT + 1)
    })
  })

  it('a redirect without a Location header is reported, not followed blindly', async () => {
    await withMockFetch({
      'https://start.example/a': { status: 302 },
    }, async () => {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('without Location header')
    })
  })

  it('a Location that is not a valid URL is refused', async () => {
    // `new URL(location, current)` throws on a malformed value; the catch must turn
    // that into a refusal rather than an unhandled rejection.
    await withMockFetch({
      'https://start.example/a': { status: 302, headers: { location: 'http://[invalid' } },
    }, async () => {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('not a valid URL')
    })
  })

  it('a redirect to a non-http scheme is refused at the NEXT hop', async () => {
    // file:// and friends are rejected per hop, so validating only hop 0 would let a
    // redirect escape the allowlist.
    await withMockFetch({
      'https://start.example/a': { status: 302, headers: { location: 'file:///etc/passwd' } },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('must use http or https')
      expect(calls).toEqual(['https://start.example/a'])
    })
  })

  it('the HTTP client follows redirects MANUALLY, so every hop is validated', async () => {
    // If the runtime followed redirects automatically the guard suite would only ever
    // see hop 0. This is an invariant of the call, not of the response.
    const original = globalThis.fetch
    let seenRedirectMode: unknown
    globalThis.fetch = (async (_i: unknown, init: RequestInit) => {
      seenRedirectMode = init.redirect
      return new Response(HTML_200.body, { status: 200, headers: HTML_200.headers })
    }) as typeof fetch
    try {
      await fetchUrlForPlanner('https://start.example/a')
      expect(seenRedirectMode).toBe('manual')
    } finally {
      globalThis.fetch = original
    }
  })
})

// ---------------------------------------------------------------------------
// DNS rebinding, and the text-decoding failure
//
// The DNS layer had NEVER been exercised: the existing fixtures use `.example`,
// whose lookup fails, and isBlockedHostAsync fails OPEN on resolution failure. So
// the second half of every hop's guard was untested — the half that catches a
// hostname which looks public but RESOLVES to a private address.
// ---------------------------------------------------------------------------

mock.module('node:dns/promises', () => ({
  // A public-looking name that resolves to RFC1918. This is the rebinding shape:
  // the string guard passes, the resolved address is what must stop it.
  lookup: async (hostname: string) =>
    hostname === 'rebind.example'
      ? [{ address: '10.0.0.5', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
}))

describe('web-fetch — the DNS layer', () => {
  afterEach(() => {
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
  })

  it('a hostname that RESOLVES to a private address is refused before fetching', async () => {
    await withMockFetch({
      // Present so the failure is an assertion, not an unexpected-URL throw.
      'https://rebind.example/a': { status: 200, body: 'should never be read' },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://rebind.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('DNS rebinding')
      // No request at all: the check precedes the fetch, so the private address is
      // never connected to.
      expect(calls).toEqual([])
    })
  })

  it('the resolved address is re-checked on EVERY hop, not just the first', async () => {
    // The whole point of manual redirects: hop 0 can be public while hop 1 resolves
    // to a private address. Validating only the initial hostname is the bug the
    // module header describes.
    await withMockFetch({
      'https://start.example/a': { status: 302, headers: { location: 'https://rebind.example/b' } },
      'https://rebind.example/b': { status: 200, body: 'should never be read' },
    }, async (calls) => {
      const r = await fetchUrlForPlanner('https://start.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('DNS rebinding')
      expect(calls).toEqual(['https://start.example/a'])
    })
  })

  it('a public name that resolves publicly is fetched normally', async () => {
    // The inverse, so the test above cannot pass merely because the DNS mock
    // blocks everything.
    await withMockFetch({
      'https://fine.example/a': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
    }, async () => {
      const r = await fetchUrlForPlanner('https://fine.example/a')
      expect(r.ok).toBe(true)
      expect(r.content).toBe('ok')
    })
  })

  it('a body that fails to DECODE becomes a Fetch error, not a rejection', async () => {
    // res.text() can reject on a truncated or aborted body. The planner is composing
    // an answer here, so a rejection would abort the turn rather than letting the
    // model proceed without the page.
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => { throw new Error('terminated') },
    })) as unknown as typeof fetch
    try {
      const r = await fetchUrlForPlanner('https://fine.example/a')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Fetch error')
      expect(r.error).toContain('terminated')
    } finally {
      globalThis.fetch = original
    }
  })
})
