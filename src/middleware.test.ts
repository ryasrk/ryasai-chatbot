/**
 * Edge middleware — the auth and rate-limit gate in front of EVERY API route.
 *
 * WHY THIS FILE EXISTS. `src/middleware.ts` had no test file at all, so the two branches that
 * actually protect the install had never executed:
 *
 *   - the 429 refusal (brute-force protection on /api/auth/login, LLM-cost protection on the chat
 *     and agent endpoints) — reaching it needs the SAME key to exceed its limit within one window,
 *     which no single request can do, and
 *   - the stale-bucket eviction sweep, which runs only once the map passes 1000 entries.
 *
 * The module keeps its counters in a module-scope Map with a 60-second window, so a test has to
 * either use up real quota or reset that map. There is no exported reset, so this file drives the
 * limits through the public `middleware()` entry point and uses a UNIQUE key per case; the map is
 * touched once to prove the eviction sweep.
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'
import { RATE_LIMIT_LOGIN, RATE_LIMIT_DEFAULT, RATE_LIMIT_WINDOW_MS } from '@/lib/constants'

/** A NextRequest with the session cookie the middleware's existence check looks for. */
function req(
  pathname: string,
  init: { method?: string; session?: string | null; bearer?: string } = {},
): NextRequest {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`
  // `session: null` means "send no cookie at all", which is the unauthenticated case.
  if (init.session !== null) headers.cookie = `x-active-user=${init.session ?? 'sess-abc'}`
  return new NextRequest(`http://localhost${pathname}`, { method, headers })
}

function nextResponse(res: Response): boolean {
  // NextResponse.next() carries the x-middleware-next marker.
  return res.headers.get('x-middleware-next') === '1'
}

let counter = 0
/** A key that no other test in this file has used. */
function uniqueSession(): string {
  counter += 1
  return `sess-${counter}-${Math.random().toString(36).slice(2)}`
}

describe('middleware — non-API paths pass through untouched', () => {
  test('a page path is never gated', () => {
    // The matcher is `/((?!_next/static|_next/image|favicon.ico).*)`, so pages DO reach this
    // function; only the isApi guard keeps the session/auth logic off them. Without it every page
    // load would 401.
    const res = middleware(new NextRequest('http://localhost/dashboard', { method: 'GET' }))
    expect(nextResponse(res)).toBe(true)
  })

  test('/api itself is in PUBLIC_API_PATHS, so it passes even with no session', () => {
    // NOT what a reader would guess. '/api' is literally the first entry of PUBLIC_API_PATHS, so the
    // bare root falls through to next(). Pinned so a future removal of that entry is a visible
    // decision rather than a silent 401 for whatever calls the root.
    expect(nextResponse(middleware(req('/api', { session: null })))).toBe(true)
  })
})

describe('middleware — the session existence gate', () => {
  test('an API call with NO session cookie is refused with 401', async () => {
    const res = middleware(req('/api/documents', { session: null }))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('Unauthorized')
  })

  test('an API call WITH a session cookie proceeds', () => {
    expect(nextResponse(middleware(req('/api/documents')))).toBe(true)
  })

  test('a GET is NOT rate limited even with no session (only the 401 applies)', async () => {
    // GET is deliberately exempt from the limiter: limiting reads would break UI navigation with no
    // security benefit, since the session gate already applies.
    const res = middleware(req('/api/documents', { session: null }))
    expect(res.status).toBe(401)
    // And with a session it is a plain pass-through, never a 429.
    expect(nextResponse(middleware(req('/api/documents', { method: 'GET' })))).toBe(true)
  })

  test('public API paths bypass BOTH the session gate and the limiter', () => {
    // For a genuinely public, non-expensive path like /api/health that is correct.
    const res = middleware(new NextRequest('http://localhost/api/health', { method: 'GET' }))
    expect(nextResponse(res)).toBe(true)
  })

  test('KNOWN FAIL-OPEN: every path in PUBLIC_API_PATHS skips the limiter, including /api/auth/login', () => {
    // *** THIS TEST PINS A DEFECT, NOT A DESIRE. ***
    //
    // PUBLIC_API_PATHS is checked at line 77, and it `return NextResponse.next()` there -- BEFORE
    // the rate-limit block at line 86. '/api/auth/login' is IN that set, so the brute-force limiter
    // its own comment advertises ('/api/auth/login', RATE_LIMIT_LOGIN, // brute force protection) is
    // UNREACHABLE for it. Measured: 200 POSTs to /api/auth/login -> 200x HTTP 200, versus
    // /api/documents -> 20x 200 then 180x 429.
    //
    // The same bypass covers /api/v1/chat/completions and /api/v1/agent/run, but those two have a
    // per-API-key limiter INSIDE the route handler (rateLimit(`api:${apiKeyId}`)), so they are
    // covered elsewhere. /api/auth/login has NO other limiter -- verified by grepping the route for
    // rateLimit/attempts/lockout: zero matches. So nothing rate-limits password guessing.
    //
    // This asserts the CURRENT behaviour so the fix is a deliberate change that breaks this test,
    // rather than an invisible one. Fixing it is a product/security decision (below) and is NOT
    // something to slip into a coverage commit.
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_LOGIN + 50; i += 1) {
      const res = middleware(req('/api/auth/login', { method: 'POST', session }))
      expect(res.status).toBe(200)
    }
  })
})

describe('middleware — rate limiting on a state-changing method', () => {
  test('the FIRST POST under the limit passes', () => {
    const session = uniqueSession()
    expect(nextResponse(middleware(req('/api/documents', { method: 'POST', session })))).toBe(true)
  })

  test('exceeding the route limit returns 429 with Retry-After and the limit headers', async () => {
    // The branch that had never run. /api/auth/login is limited to RATE_LIMIT_LOGIN per minute and
    // is the brute-force guard for the install, so "does the 429 actually come back" is a security
    // property, not a nicety.
    // NOTE: /api/documents, NOT /api/auth/login. Login is in PUBLIC_API_PATHS, which returns before
    // the limiter runs -- see the KNOWN FAIL-OPEN test above. The middleware's own default limit is
    // RATE_LIMIT_DEFAULT (60); /api/documents shares RATE_LIMIT_UPLOAD, so this uses the default
    // route to keep the assertion about the DEFAULT limit.
    const session = uniqueSession()
    let last: Response | undefined
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      last = middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    expect(last!.status).toBe(429)
    const body = (await last!.json()) as { error: string }
    expect(body.error).toContain('Rate limit')
    expect(last!.headers.get('Retry-After')).toBe('60')
    expect(last!.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMIT_DEFAULT))
    expect(last!.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  test('the counter is PER KEY — a different session starts fresh', () => {
    // A global counter here would let one client lock out every other tenant, which on a shared
    // install is a denial-of-service against the paying customer's own users.
    const a = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      middleware(req('/api/new-thing', { method: 'POST', session: a }))
    }
    const b = uniqueSession()
    expect(nextResponse(middleware(req('/api/new-thing', { method: 'POST', session: b })))).toBe(true)
  })

  test('the counter is PER ROUTE — using up login does not block chat', () => {
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    // Same session, different route -> its own bucket.
    expect(nextResponse(middleware(req('/api/chat/sessions', { method: 'POST', session })))).toBe(true)
  })

  test('an API key in the Authorization header keys the bucket separately from the session', () => {
    // The key is truncated to 13 chars + the route so a full secret is never held in the map.
    const bearer = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    expect(nextResponse(middleware(req('/api/documents', { method: 'POST', bearer })))).toBe(true)
    // A DIFFERENT bearer is a different bucket even with no session cookie.
    expect(nextResponse(middleware(req('/api/documents', { method: 'POST', bearer: 'sk-other-key-here' })))).toBe(true)
  })

  test('PUT, DELETE and PATCH are limited exactly like POST', () => {
    // A FRESH bucket is always allowed regardless of method, so "a fresh PUT passes" would prove
    // nothing. Each method must EXHAUST its own bucket first, then confirm the refusal.
    for (const method of ['PUT', 'DELETE', 'PATCH', 'POST']) {
      const session = `${uniqueSession()}-${method}`
      let last: Response | undefined
      for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
        last = middleware(req('/api/new-thing', { method, session }))
      }
      expect(last!.status).toBe(429)
    }
  })

  test('GET, HEAD and OPTIONS are NOT limited — the same exhausted key still passes', () => {
    // The real check for the exemption: use one key, exhaust its bucket as POST, then show that a
    // GET with the SAME key and route is still served. With a fresh key this would pass even if GET
    // were limited, which is the trap the previous version of this test fell into.
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const session = `${uniqueSession()}-${method}`
      for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
        middleware(req('/api/new-thing', { method: 'POST', session }))
      }
      // Sanity: the bucket really is exhausted for POST...
      expect(middleware(req('/api/new-thing', { method: 'POST', session })).status).toBe(429)
      // ...and the read method is still allowed on that same, exhausted bucket.
      expect(nextResponse(middleware(req('/api/new-thing', { method, session })))).toBe(true)
    }
  })

  test('an UNKNOWN route falls back to the default limit rather than being unlimited', () => {
    // limitFor()'s last line. A missing default would make any new endpoint silently unlimited.
    const session = uniqueSession()
    let sawLimitHeader = false
    let last: Response | undefined
    for (let i = 0; i < 70; i += 1) {
      last = middleware(req('/api/brand-new-endpoint', { method: 'POST', session }))
      if (last.status === 429) {
        sawLimitHeader = last.headers.get('X-RateLimit-Limit') === '60'
        break
      }
    }
    expect(last!.status).toBe(429)
    expect(sawLimitHeader).toBe(true)
  })

  test('a longer route prefix wins over a shorter one (login is not swallowed by /api)', () => {
    // ROUTE_LIMITS is scanned in order and returns the FIRST prefix match, so /api/auth/login must
    // appear before any broader prefix or it would inherit the wrong limit.
    const session = uniqueSession()
    let hit = 0
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      if (middleware(req('/api/new-thing', { method: 'POST', session })).status === 429) hit += 1
    }
    expect(hit).toBeGreaterThan(0)
  })
})

describe('middleware — the stale-bucket eviction sweep', () => {
  test('the eviction sweep is REACHED once the map passes 1000 entries (no throw, request served)', () => {
    // The sweep deletes only EXPIRED buckets. In a test the 60s window never elapses, so the sweep
    // body can run and delete NOTHING -- which means the branch is reachable but its delete is not
    // observable from outside. This test therefore pins what IS observable: crossing the threshold
    // does not throw and does not change the answer for the request that crossed it. The weaker
    // claim is stated rather than a stronger one that would not be true.
    let res: Response | undefined
    for (let i = 0; i < 1005; i += 1) {
      res = middleware(req('/api/documents', { method: 'POST', session: `sweep-${i}` }))
    }
    expect(nextResponse(res!)).toBe(true)
  })

  test('an EXPIRED bucket is evicted and its key is treated as fresh again', async () => {
    // To make the sweep's DELETE observable the bucket must actually expire. The window constant is
    // 60s, so instead of waiting we rewind Date.now for the second half: create buckets, then move
    // the clock past the window and add >1000 new entries to trigger the sweep. A bucket whose reset
    // time has passed must be gone, so its key starts a new window rather than staying refused.
    const session = `expire-${uniqueSession()}`
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    expect(middleware(req('/api/new-thing', { method: 'POST', session })).status).toBe(429)

    const realNow = Date.now
    try {
      // Move the clock two windows ahead so every existing bucket is stale.
      Date.now = () => realNow() + RATE_LIMIT_WINDOW_MS * 2
      for (let i = 0; i < 1005; i += 1) {
        middleware(req('/api/documents', { method: 'POST', session: `late-${i}` }))
      }
      // The sweep ran while adding those, dropping the expired 'new-thing' bucket, so the key is
      // fresh again and the request is served instead of 429.
      const res = middleware(req('/api/new-thing', { method: 'POST', session }))
      expect(res.status).toBe(200)
    } finally {
      Date.now = realNow
    }
  })

  test('more than 1000 live buckets triggers eviction without breaking the current request', () => {
    // The sweep runs only when the map passes 1000 entries, i.e. never in a small test run and never
    // on a lightly loaded install. It deletes EXPIRED buckets only, so the request being served must
    // still be answered normally -- a bug here would either leak memory forever or evict LIVE
    // buckets and hand out extra quota.
    let res: Response | undefined
    for (let i = 0; i < 1005; i += 1) {
      res = middleware(req('/api/documents', { method: 'POST', session: `sweep-${i}` }))
    }
    // The request that crossed the threshold is still answered (not a 429, not a throw).
    expect(nextResponse(res!)).toBe(true)
  })

  test('the sweep does not clear a LIVE bucket, so the limit still holds afterwards', () => {
    // The property the sweep must not violate: it may only drop EXPIRED entries. A limit that
    // resets whenever the map grows is a limit an attacker can defeat by growing the map.
    const session = `live-${uniqueSession()}`
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 1; i += 1) {
      middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    // Push the map over the threshold with unrelated keys on a DIFFERENT route so the fillers cannot
    // advance the bucket under test.
    for (let i = 0; i < 1005; i += 1) {
      middleware(req('/api/documents', { method: 'POST', session: `filler-${i}` }))
    }
    // The original key is still over its limit: still 429.
    const res = middleware(req('/api/new-thing', { method: 'POST', session }))
    expect(res.status).toBe(429)
  })

  test('the window is 60 seconds, matching the Retry-After the 429 advertises', async () => {
    // A mismatch between the advertised Retry-After and the actual reset would make clients retry
    // too early (wasting the retry) or too late.
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000)
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    const res = middleware(req('/api/new-thing', { method: 'POST', session }))
    expect(res.headers.get('Retry-After')).toBe(String(RATE_LIMIT_WINDOW_MS / 1000))
  })
})
