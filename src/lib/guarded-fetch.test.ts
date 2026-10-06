import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// guardedFetch / readTextBounded against REAL local servers.
//
// `localhost` is allowlisted (LLM_ALLOWED_HOSTS) so the "public" mock is reachable, while the literal 127.0.0.1
// stays blocked — exactly the production split between a permitted API and an internal address. Every case was
// first measured as a live defect through the REST executor (see guarded-fetch.ts).
// ---------------------------------------------------------------------------

const savedAllow = process.env.LLM_ALLOWED_HOSTS
process.env.LLM_ALLOWED_HOSTS = 'localhost'

const { guardedFetch, readTextBounded, BlockedHostError, TooManyRedirectsError, MAX_REDIRECT_HOPS } = await import('@/lib/guarded-fetch')

let internalHits = 0
const seen: Array<{ path: string; method: string; auth: string | null; apiKey: string | null; contentType: string | null; body?: string }> = []
let publicSrv: ReturnType<typeof Bun.serve>
let otherSrv: ReturnType<typeof Bun.serve>
let internalSrv: ReturnType<typeof Bun.serve>
let PUBLIC = ''
let OTHER = ''

beforeAll(() => {
  internalSrv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { internalHits++; return new Response('INTERNAL-SECRET') } })
  otherSrv = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const body = await req.text()
      seen.push({ path: new URL(req.url).pathname, method: req.method, auth: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key'), contentType: req.headers.get('content-type'), body })
      return new Response('other-origin')
    },
  })
  publicSrv = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      seen.push({ path: u.pathname, method: req.method, auth: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key'), contentType: req.headers.get('content-type') })
      if (u.pathname === '/to-internal') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${internalSrv.port}/meta` } })
      if (u.pathname === '/to-metadata') return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      if (u.pathname === '/to-file') return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } })
      if (u.pathname === '/same') return new Response(null, { status: 302, headers: { location: '/final' } })
      if (u.pathname === '/final') return new Response('final-body')
      if (u.pathname === '/to-other') return new Response(null, { status: 302, headers: { location: `${OTHER}/landed` } })
      if (u.pathname === '/to-other-307') return new Response(null, { status: 307, headers: { location: `${OTHER}/landed` } })
      if (u.pathname === '/see-other') return new Response(null, { status: 303, headers: { location: '/final' } })
      if (u.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } })
      if (u.pathname === '/huge') {
        const chunk = new TextEncoder().encode('y'.repeat(64 * 1024))
        let n = 0
        return new Response(new ReadableStream({ pull(c) { if (n++ < 2000) c.enqueue(chunk); else c.close() } }))
      }
      return new Response('not found', { status: 404 })
    },
  })
  PUBLIC = `http://localhost:${publicSrv.port}`
  OTHER = `http://localhost:${otherSrv.port}`
})

afterAll(() => {
  publicSrv.stop(true); otherSrv.stop(true); internalSrv.stop(true)
  if (savedAllow === undefined) delete process.env.LLM_ALLOWED_HOSTS
  else process.env.LLM_ALLOWED_HOSTS = savedAllow
})

describe('guardedFetch — every redirect hop is SSRF-checked', () => {
  test('a redirect to a private IP is refused, and the internal server is never contacted', async () => {
    internalHits = 0
    await expect(guardedFetch(`${PUBLIC}/to-internal`)).rejects.toBeInstanceOf(BlockedHostError)
    expect(internalHits).toBe(0)
  })

  test('the refusal says it was a REDIRECT, so an operator can tell it from a bad base URL', async () => {
    await expect(guardedFetch(`${PUBLIC}/to-metadata`)).rejects.toThrow('redirected to a blocked internal host')
  })

  test('a blocked FIRST hop keeps the wording callers have always returned', async () => {
    await expect(guardedFetch(`http://127.0.0.1:${internalSrv.port}/`)).rejects.toThrow('Endpoint points to a blocked internal host.')
  })

  test('a redirect to a non-HTTP scheme is refused', async () => {
    await expect(guardedFetch(`${PUBLIC}/to-file`)).rejects.toBeInstanceOf(BlockedHostError)
  })

  test('a same-origin redirect is followed', async () => {
    const res = await guardedFetch(`${PUBLIC}/same`)
    expect(await res.text()).toBe('final-body')
  })

  test('a redirect loop stops at the hop limit', async () => {
    await expect(guardedFetch(`${PUBLIC}/loop`)).rejects.toBeInstanceOf(TooManyRedirectsError)
    expect(MAX_REDIRECT_HOPS).toBe(5)
  })
})

describe('guardedFetch — credentials never follow a redirect to another origin', () => {
  test('Authorization and API-key headers are dropped at the origin change; ordinary headers survive', async () => {
    seen.length = 0
    const res = await guardedFetch(`${PUBLIC}/to-other`, { headers: { Authorization: 'Bearer tenant-secret', 'X-API-Key': 'k-1', Accept: 'application/json' } })
    expect(await res.text()).toBe('other-origin')
    const first = seen.find((s) => s.path === '/to-other')!
    const landed = seen.find((s) => s.path === '/landed')!
    expect(first.auth).toBe('Bearer tenant-secret')
    expect(landed.auth).toBeNull()
    expect(landed.apiKey).toBeNull()
  })

  test('a SAME-origin redirect keeps the credentials (the API asked for its own path)', async () => {
    seen.length = 0
    await guardedFetch(`${PUBLIC}/same`, { headers: { Authorization: 'Bearer tenant-secret' } })
    expect(seen.find((s) => s.path === '/final')!.auth).toBe('Bearer tenant-secret')
  })

  test('303 continues as a GET without the body', async () => {
    seen.length = 0
    const res = await guardedFetch(`${PUBLIC}/see-other`, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    expect(await res.text()).toBe('final-body')
    const final = seen.find((s) => s.path === '/final')!
    expect(final.method).toBe('GET')
    expect(final.contentType).toBeNull()
  })

  test('a cross-origin redirect drops request body to prevent credential leaks (even on 307)', async () => {
    seen.length = 0
    await guardedFetch(`${PUBLIC}/to-other-307`, {
      method: 'POST',
      body: 'client_secret=secret123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    const landed = seen.find((s) => s.path === '/landed')!
    expect(landed.method).toBe('GET')
    expect((landed as any).body).toBe('')
    expect(landed.contentType).toBeNull()
  })
})

describe('readTextBounded — only what is kept is read', () => {
  test('a 125 MB body is cut at the bound and the connection released', async () => {
    const rss0 = process.memoryUsage().rss
    const res = await guardedFetch(`${PUBLIC}/huge`)
    const text = await readTextBounded(res, 64 * 1024)
    expect(text.length).toBe(64 * 1024)
    // Reading the whole body (the old `res.text()`) costs ~125 MB here; the bound keeps it to noise.
    expect((process.memoryUsage().rss - rss0) / 1024 / 1024).toBeLessThan(40)
  })

  test('a small body is returned whole', async () => {
    expect(await readTextBounded(new Response('hello'), 1024)).toBe('hello')
  })

  test('a multi-byte character cut at the bound is dropped, not mangled into a replacement mid-text', async () => {
    const text = await readTextBounded(new Response('ab🚀'), 4) // 2 bytes + the first 2 of a 4-byte emoji
    expect(text.startsWith('ab')).toBe(true)
  })

  test('a response object without a stream still answers through text(), bounded', async () => {
    const fake = { body: null, text: async () => 'x'.repeat(100) } as unknown as Response
    expect(await readTextBounded(fake, 10)).toBe('x'.repeat(10))
  })
})
