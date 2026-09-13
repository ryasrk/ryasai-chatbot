import { describe, expect, test, mock, beforeEach } from 'bun:test'

let authThrows = false

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authThrows) throw new MockUnauthorizedError()
    return { userId: 'u1', name: 'Test', email: 't@t.com', role: 'admin', organizationId: 'org-default' }
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  UnauthorizedError: MockUnauthorizedError,
}))

mock.module('@/lib/llm-config', () => ({
  isBlockedHost: (hostname: string) => {
    const h = hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h === '::1' ||
      /^127\./.test(h) ||
      /^0\.0\.0\.0$/.test(h) ||
      /^169\.254\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
      /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h) ||
      /^fd[0-9a-f]/.test(h) ||
      /^fe[89ab][0-9a-f]/.test(h)
    )
  },
}))

// Scripted result for fetchUrlForPlanner. The four original tests drove the REAL
// helper (the 403 case relies on the actual host blocker), which covers the refusal
// path but can never reach the success, 502 or 422 branches -- so those three lines
// ran in no test at all. A settable result makes them reachable without a network.
let fetchResult: { ok: boolean; content: string; title?: string; error?: string } | null = null
const fetchCalls: string[] = []

// Capture the REAL implementation BY VALUE, before overriding. Importing the module
// namespace and calling `realWebFetch.fetchUrlForPlanner(...)` inside the wrapper
// recurses forever (RangeError: Maximum call stack size exceeded), because the
// namespace object this test holds is the one mock.module PATCHED -- so the call
// re-enters the wrapper. That is the "capture by value before overriding" rule.
const realFetchUrlForPlanner = (await import('@/lib/web-fetch')).fetchUrlForPlanner

mock.module('@/lib/web-fetch', () => ({
  fetchUrlForPlanner: async (url: string) => {
    fetchCalls.push(url)
    // null means "use the real implementation", so the pre-existing 403 test (which
    // relies on the actual host blocker) keeps exercising real code.
    if (fetchResult) return fetchResult
    return realFetchUrlForPlanner(url)
  },
}))

import { POST } from './route'

beforeEach(() => {
  authThrows = false
  fetchResult = null
  fetchCalls.length = 0
})

describe('POST /api/fetch-url', () => {
  test('returns 401 when auth fails', async () => {
    authThrows = true
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  test('returns 400 when url is missing', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  test('returns 400 when url is invalid', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'not-a-url' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  test('returns 403 for blocked host 127.0.0.1', async () => {
    const req = new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/fetch-url — the result branches', () => {
  function req(url: string) {
    return new Request('http://localhost/api/fetch-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }) as any
  }

  test('a successful fetch returns the text, its title and its LENGTH', async () => {
    // The happy path had no test at all: every existing case was a refusal. Without
    // this the shape the planner consumes could change unnoticed.
    fetchResult = { ok: true, content: 'hello world', title: 'Doc' }
    const res = await POST(req('https://example.com/page'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      title: 'Doc',
      url: 'https://example.com/page',
      content: 'hello world',
      length: 11,
    })
  })

  test('a missing title is reported as an empty string, never undefined', async () => {
    // `result.title ?? ''` -- an undefined would drop the key from the JSON and the
    // client would render "undefined".
    fetchResult = { ok: true, content: 'x' }
    const body = await (await POST(req('https://example.com/'))).json()
    expect(body.title).toBe('')
  })

  test('ok=true with EMPTY content is 422, not a 200 with an empty body', async () => {
    // Lines 42-44. The fetch succeeded but extraction produced nothing (a
    // JS-only page). Returning 200 with content:'' would let a caller store an
    // empty document believing it had fetched one. 422 tells it extraction failed.
    fetchResult = { ok: true, content: '' }
    const res = await POST(req('https://example.com/empty'))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'Could not extract content.' })
  })

  test('a non-blocked failure is 502 (upstream), NOT 403', async () => {
    // The status is what the caller uses to decide whether to retry: a timeout is
    // worth retrying, a policy refusal is not. Collapsing both to one code would
    // make a retry loop hammer a forbidden host, or give up on a transient error.
    fetchResult = { ok: false, content: '', error: 'Fetch timed out.' }
    const res = await POST(req('https://example.com/slow'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Fetch timed out.' })
  })

  test('a BLOCKED-host failure is 403 (policy), with the upstream message', async () => {
    fetchResult = { ok: false, content: '', error: 'Host is blocked by policy.' }
    const res = await POST(req('https://evil.example.com/'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Host is blocked by policy.' })
  })

  test('a failure with NO message falls back to a generic one', async () => {
    // `result.error ?? 'Fetch failed.'` -- an empty error would otherwise surface a
    // blank toast.
    fetchResult = { ok: false, content: '' }
    const res = await POST(req('https://example.com/'))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Fetch failed.' })
  })

  test('the URL is passed through to the fetcher UNCHANGED', async () => {
    // The route must not normalise or rewrite the URL; fetchUrlForPlanner owns the
    // protocol and SSRF checks, and second-guessing them here was the drift the
    // file header describes.
    fetchResult = { ok: true, content: 'c' }
    await POST(req('https://example.com/a/../b?q=1'))
    expect(fetchCalls).toEqual(['https://example.com/a/../b?q=1'])
  })

  test('the fetcher is NOT called for an invalid URL', async () => {
    // The shape check runs first, so a malformed URL never reaches the network.
    await POST(req('not-a-url'))
    expect(fetchCalls).toEqual([])
  })
})
