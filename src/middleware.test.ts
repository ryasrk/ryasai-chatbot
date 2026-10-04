/**
 * Edge middleware — the auth and rate-limit gate in front of EVERY API route.
 *
 * WHY THIS FILE EXISTS. `src/middleware.ts` had no test file at all, so the two branches that
 * actually protect the install had never executed:
 *
 *   - the 429 refusal (LLM-cost protection on the chat and agent endpoints, signup/register
 *     protection on the credential-CREATING public paths) — reaching it needs the SAME key to
 *     exceed its limit within one window, which no single request can do, and
 *   - the stale-bucket eviction sweep, which runs only once the map passes 1000 entries.
 *
 * `/api/auth/login` USED to be pinned here as rate limited, and that pin is now replaced by its
 * INVERSION: login must NOT be limited by the middleware at all. The per-request counter could not
 * see whether an attempt succeeded, so it spent quota on correct passwords too, and — because a
 * login request carries no session cookie — it keyed every anonymous caller on the single shared
 * key `session::/api/auth/login`. Measured: the 11th successful sign-in inside one 60-second window
 * came back 429. Brute-force protection counts FAILURES now, inside the route, per account and per
 * client address: src/lib/login-throttle.ts (+ its own test file).
 *
 * The module keeps its counters in a module-scope Map with a 60-second window, so a test has to
 * either use up real quota or reset that map. There is no exported reset, so this file drives the
 * limits through the public `await middleware()` entry point and uses a UNIQUE key per case; the map is
 * touched once to prove the eviction sweep.
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'
import { RATE_LIMIT_LOGIN, RATE_LIMIT_DEFAULT, RATE_LIMIT_AGENT, RATE_LIMIT_WINDOW_MS } from '@/lib/constants'

/** A NextRequest with the session cookie the middleware's existence check looks for. */
function req(
  pathname: string,
  init: { method?: string; session?: string | null; bearer?: string; ip?: string } = {},
): NextRequest {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`
  if (init.ip) headers['x-forwarded-for'] = init.ip
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
  test('a page path is never gated', async () => {
    // The matcher is `/((?!_next/static|_next/image|favicon.ico).*)`, so pages DO reach this
    // function; only the isApi guard keeps the session/auth logic off them. Without it every page
    // load would 401.
    const res = await middleware(new NextRequest('http://localhost/dashboard', { method: 'GET' }))
    expect(nextResponse(res)).toBe(true)
  })

  test('/api itself is in PUBLIC_API_PATHS, so it passes even with no session', async () => {
    // NOT what a reader would guess. '/api' is literally the first entry of PUBLIC_API_PATHS, so the
    // bare root falls through to next(). Pinned so a future removal of that entry is a visible
    // decision rather than a silent 401 for whatever calls the root.
    expect(nextResponse(await middleware(req('/api', { session: null })))).toBe(true)
  })
})

describe('middleware — the session existence gate', () => {
  test('metrics authentication reaches the handler without a browser cookie', async () => {
    expect(nextResponse(await middleware(req('/api/metrics', { session: null, bearer: 'scraper-token' })))).toBe(true)
    // An absent token also reaches the handler, which must reject it unless an admin session exists.
    expect(nextResponse(await middleware(req('/api/metrics', { session: null })))).toBe(true)
    expect((await middleware(req('/api/metrics/other', { session: null }))).status).toBe(401)
  })
  test('an API call with NO session cookie is refused with 401', async () => {
    const res = await middleware(req('/api/documents', { session: null }))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('Unauthorized')
  })

  test('an API call WITH a session cookie proceeds', async () => {
    expect(nextResponse(await middleware(req('/api/documents')))).toBe(true)
  })

  test('a GET is NOT rate limited even with no session (only the 401 applies)', async () => {
    // GET is deliberately exempt from the limiter: limiting reads would break UI navigation with no
    // security benefit, since the session gate already applies.
    const res = await middleware(req('/api/documents', { session: null }))
    expect(res.status).toBe(401)
    // And with a session it is a plain pass-through, never a 429.
    expect(nextResponse(await middleware(req('/api/documents', { method: 'GET' })))).toBe(true)
  })

  test('public API paths bypass BOTH the session gate and the limiter', async () => {
    // For a genuinely public, non-expensive path like /api/health that is correct.
    const res = await middleware(new NextRequest('http://localhost/api/health', { method: 'GET' }))
    expect(nextResponse(res)).toBe(true)
  })

  test('INVERTED: /api/auth/login is NOT limited by the middleware, so a correct password is never refused', async () => {
    // THIS TEST PINS THE OPPOSITE OF WHAT IT USED TO. The login limiter was moved here from the public-path
    // early return to fix a genuine fail-open (200 POSTs -> 200 x HTTP 200 while a non-public path went
    // 20 x 200 then 180 x 429). THAT fix then produced a worse defect, measured: the bucket counted EVERY
    // request -- including a CORRECT sign-in, because the middleware cannot see the outcome -- and, since a
    // login request has no session cookie, keyed every anonymous caller on the shared literal
    // `session::/api/auth/login`. The 11th person to sign in inside one 60-second window got HTTP 429 on an
    // install whose whole purpose is letting people log in. Brute-force protection now counts FAILURES,
    // per account and per client address, inside the route (src/lib/login-throttle.ts). So the middleware
    // must let every one of these through: no cookie, no address header, same shared identity that used to
    // be exhausted at RATE_LIMIT_LOGIN.
    let refused: Response | undefined
    for (let i = 0; i < RATE_LIMIT_LOGIN + 50; i += 1) {
      const res = await middleware(req('/api/auth/login', { method: 'POST', session: null }))
      if (res.status === 429) refused = res
    }
    expect(refused).toBeUndefined()
  })

  test('INVERTED: the 11th anonymous sign-in in a minute succeeds (the exact measured failure)', async () => {
    // The reported shape, reproduced deliberately: 11 logins, no cookie, no forwarded address. Before the
    // fix attempts 1-10 passed and 11 came back 429 with Retry-After: 60. The guard that produces that
    // refusal now lives behind the password check, where a SUCCESS never counts.
    const statuses: number[] = []
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await middleware(req('/api/auth/login', { method: 'POST', session: null }))).status)
    }
    expect(statuses).toHaveLength(11)
    expect(statuses.every((s) => s !== 429)).toBe(true)
  })

  test('an ANONYMOUS caller on a credential-creating path is keyed on the client ADDRESS, not on the missing cookie', async () => {
    // The remaining rate-limited public paths (signup/register) DO still throttle, and with no session cookie
    // to key on they must use the forwarded address. Exhausting one address must not spend another's quota --
    // that collapse is precisely the defect this change removes, so it has to be pinned on the path that
    // still has a limiter.
    const a = '203.0.113.10'
    const b = '203.0.113.11'
    let refusedA = false
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 5; i += 1) {
      if ((await middleware(req('/api/auth/signup', { method: 'POST', session: null, ip: a }))).status === 429) {
        refusedA = true
        break
      }
    }
    expect(refusedA).toBe(true)
    // A DIFFERENT address still gets through, which proves the key carries the address.
    expect(nextResponse(await middleware(req('/api/auth/signup', { method: 'POST', session: null, ip: b })))).toBe(true)
  })

  test('with NO forwarded address at all, anonymous callers share ONE bucket rather than none', async () => {
    // Deliberate: an install with no reverse proxy cannot distinguish its callers, so the safe reading is a
    // shared budget (still bounded) rather than an unbounded one. Pinned so the fallback is a decision.
    let refused = false
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 5; i += 1) {
      if ((await middleware(req('/api/auth/signup', { method: 'POST', session: null }))).status === 429) {
        refused = true
        break
      }
    }
    expect(refused).toBe(true)
  })

  test('signup and register are throttled too -- the other two credential-creating public paths', async () => {
    for (const path of ['/api/auth/signup', '/api/auth/register']) {
      const session = uniqueSession()
      let blocked = false
      for (let i = 0; i < RATE_LIMIT_DEFAULT + 5; i += 1) {
        if ((await middleware(req(path, { method: 'POST', session }))).status === 429) {
          blocked = true
          break
        }
      }
      expect(blocked).toBe(true)
    }
  })

  test('GET on a credential path is NOT throttled, so a login page load cannot lock a user out', async () => {
    // The limiter is method-scoped by design: limiting GET breaks UI navigation, and the public path must not
    // have changed that.
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_LOGIN + 20; i += 1) {
      expect(nextResponse(await middleware(req('/api/auth/login', { method: 'GET', session })))).toBe(true)
    }
  })

  test('a SIGNATURE-authenticated receiver is deliberately NOT throttled', async () => {
    // Throttling these would DROP DELIVERIES from a legitimate provider rather than stop an attacker: the
    // sender is authenticated by HMAC, and a retry after a 429 is not guaranteed. Asserted so the omission is a
    // decision on record rather than an oversight.
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 20; i += 1) {
      expect(nextResponse(await middleware(req('/api/webhooks/incoming', { method: 'POST', session })))).toBe(true)
    }
  })
})

describe('middleware — rate limiting on a state-changing method', () => {
  test('the FIRST POST under the limit passes', async () => {
    const session = uniqueSession()
    expect(nextResponse(await middleware(req('/api/documents', { method: 'POST', session })))).toBe(true)
  })

  test('exceeding the route limit returns 429 with Retry-After and the limit headers', async () => {
    // The branch that had never run. "Does the 429 actually come back" is a security property, not a nicety.
    // NOTE: /api/new-thing, deliberately an endpoint with no specific limit, so this pins the middleware's
    // own DEFAULT limit (RATE_LIMIT_DEFAULT = 60). /api/auth/login is NOT used here: it has no middleware
    // limiter at all any more (see the two INVERTED tests above), and /api/documents shares
    // RATE_LIMIT_UPLOAD, which is a different number.
    const session = uniqueSession()
    let last: Response | undefined
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      last = await middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    expect(last!.status).toBe(429)
    const body = (await last!.json()) as { error: string }
    expect(body.error).toContain('Rate limit')
    expect(last!.headers.get('Retry-After')).toBe('60')
    expect(last!.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMIT_DEFAULT))
    expect(last!.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  test('the counter is PER KEY — a different session starts fresh', async () => {
    // A global counter here would let one client lock out every other tenant, which on a shared
    // install is a denial-of-service against the paying customer's own users.
    const a = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      await middleware(req('/api/new-thing', { method: 'POST', session: a }))
    }
    const b = uniqueSession()
    expect(nextResponse(await middleware(req('/api/new-thing', { method: 'POST', session: b })))).toBe(true)
  })

  test('the counter is PER ROUTE — exhausting one route does not block another', async () => {
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      await middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    // Same session, different route -> its own bucket.
    expect(nextResponse(await middleware(req('/api/chat/sessions', { method: 'POST', session })))).toBe(true)
  })

  test('an API key in the Authorization header keys the bucket separately from the session', async () => {
    // The key is truncated to 13 chars + the route so a full secret is never held in the map.
    const bearer = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    expect(nextResponse(await middleware(req('/api/documents', { method: 'POST', bearer })))).toBe(true)
    // A DIFFERENT bearer is a different bucket even with no session cookie.
    expect(nextResponse(await middleware(req('/api/documents', { method: 'POST', bearer: 'sk-other-key-here' })))).toBe(true)
  })

  test('PUT, DELETE and PATCH are limited exactly like POST', async () => {
    // A FRESH bucket is always allowed regardless of method, so "a fresh PUT passes" would prove
    // nothing. Each method must EXHAUST its own bucket first, then confirm the refusal.
    for (const method of ['PUT', 'DELETE', 'PATCH', 'POST']) {
      const session = `${uniqueSession()}-${method}`
      let last: Response | undefined
      for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
        last = await middleware(req('/api/new-thing', { method, session }))
      }
      expect(last!.status).toBe(429)
    }
  })

  test('GET, HEAD and OPTIONS are NOT limited — the same exhausted key still passes', async () => {
    // The real check for the exemption: use one key, exhaust its bucket as POST, then show that a
    // GET with the SAME key and route is still served. With a fresh key this would pass even if GET
    // were limited, which is the trap the previous version of this test fell into.
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const session = `${uniqueSession()}-${method}`
      for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
        await middleware(req('/api/new-thing', { method: 'POST', session }))
      }
      // Sanity: the bucket really is exhausted for POST...
      expect((await middleware(req('/api/new-thing', { method: 'POST', session }))).status).toBe(429)
      // ...and the read method is still allowed on that same, exhausted bucket.
      expect(nextResponse(await middleware(req('/api/new-thing', { method, session })))).toBe(true)
    }
  })

  test('an UNKNOWN route falls back to the default limit rather than being unlimited', async () => {
    // limitFor()'s last line. A missing default would make any new endpoint silently unlimited.
    const session = uniqueSession()
    let sawLimitHeader = false
    let last: Response | undefined
    for (let i = 0; i < 70; i += 1) {
      last = await middleware(req('/api/brand-new-endpoint', { method: 'POST', session }))
      if (last.status === 429) {
        sawLimitHeader = last.headers.get('X-RateLimit-Limit') === '60'
        break
      }
    }
    expect(last!.status).toBe(429)
    expect(sawLimitHeader).toBe(true)
  })

  test('a route with no specific limit still counts its own requests (the prefix scan hits the default)', async () => {
    // ROUTE_LIMITS is scanned in order and returns the FIRST prefix match; when nothing matches, limitFor()
    // falls through to the default. This pins that the fall-through still ENFORCES a limit rather than
    // letting an unknown route run unlimited.
    const session = uniqueSession()
    let hit = 0
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      if ((await middleware(req('/api/new-thing', { method: 'POST', session }))).status === 429) hit += 1
    }
    expect(hit).toBeGreaterThan(0)
  })
})

describe('middleware — the stale-bucket eviction sweep', () => {
  test('the eviction sweep is REACHED once the map passes 1000 entries (no throw, request served)', async () => {
    // The sweep deletes only EXPIRED buckets. In a test the 60s window never elapses, so the sweep
    // body can run and delete NOTHING -- which means the branch is reachable but its delete is not
    // observable from outside. This test therefore pins what IS observable: crossing the threshold
    // does not throw and does not change the answer for the request that crossed it. The weaker
    // claim is stated rather than a stronger one that would not be true.
    let res: Response | undefined
    for (let i = 0; i < 1005; i += 1) {
      res = await middleware(req('/api/documents', { method: 'POST', session: `sweep-${i}` }))
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
      await middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    expect((await middleware(req('/api/new-thing', { method: 'POST', session }))).status).toBe(429)

    const realNow = Date.now
    try {
      // Move the clock two windows ahead so every existing bucket is stale.
      Date.now = () => realNow() + RATE_LIMIT_WINDOW_MS * 2
      for (let i = 0; i < 1005; i += 1) {
        await middleware(req('/api/documents', { method: 'POST', session: `late-${i}` }))
      }
      // The sweep ran while adding those, dropping the expired 'new-thing' bucket, so the key is
      // fresh again and the request is served instead of 429.
      const res = await middleware(req('/api/new-thing', { method: 'POST', session }))
      expect(res.status).toBe(200)
    } finally {
      Date.now = realNow
    }
  })

  test('more than 1000 live buckets triggers eviction without breaking the current request', async () => {
    // The sweep runs only when the map passes 1000 entries, i.e. never in a small test run and never
    // on a lightly loaded install. It deletes EXPIRED buckets only, so the request being served must
    // still be answered normally -- a bug here would either leak memory forever or evict LIVE
    // buckets and hand out extra quota.
    let res: Response | undefined
    for (let i = 0; i < 1005; i += 1) {
      res = await middleware(req('/api/documents', { method: 'POST', session: `sweep-${i}` }))
    }
    // The request that crossed the threshold is still answered (not a 429, not a throw).
    expect(nextResponse(res!)).toBe(true)
  })

  test('the sweep does not clear a LIVE bucket, so the limit still holds afterwards', async () => {
    // The property the sweep must not violate: it may only drop EXPIRED entries. A limit that
    // resets whenever the map grows is a limit an attacker can defeat by growing the map.
    const session = `live-${uniqueSession()}`
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 1; i += 1) {
      await middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    // Push the map over the threshold with unrelated keys on a DIFFERENT route so the fillers cannot
    // advance the bucket under test.
    for (let i = 0; i < 1005; i += 1) {
      await middleware(req('/api/documents', { method: 'POST', session: `filler-${i}` }))
    }
    // The original key is still over its limit: still 429.
    const res = await middleware(req('/api/new-thing', { method: 'POST', session }))
    expect(res.status).toBe(429)
  })

  test('the window is 60 seconds, matching the Retry-After the 429 advertises', async () => {
    // A mismatch between the advertised Retry-After and the actual reset would make clients retry
    // too early (wasting the retry) or too late.
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000)
    const session = uniqueSession()
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 2; i += 1) {
      await middleware(req('/api/new-thing', { method: 'POST', session }))
    }
    const res = await middleware(req('/api/new-thing', { method: 'POST', session }))
    expect(res.headers.get('Retry-After')).toBe(String(RATE_LIMIT_WINDOW_MS / 1000))
  })
})

describe('middleware — the distributed limiter denies like the Map path does', () => {
  /*
   * The distributed helper's DENIAL return was the one executable line the suite never took (coverage
   * fell to 99.15% after the Redis-first path landed): every test exercised the allowed path, so a
   * regression that made the 429 unreachable would have been invisible. Same request, driven past
   * RATE_LIMIT_AGENT — the shared counter is in-process here (no Redis in the test env), which is the
   * documented fallback shape and exercises the same denial line.
   */
  test('an LLM route past its limit returns the same 429 and Retry-After as the Map path', async () => {
    let refused: Response | undefined
    for (let i = 0; i < RATE_LIMIT_AGENT + 3; i += 1) {
      const res = await middleware(req('/api/agent/dashboard', { method: 'POST' }))
      if (res.status === 429) { refused = res; break }
    }
    expect(refused).toBeDefined()
    expect(refused!.status).toBe(429)
    expect(refused!.headers.get('Retry-After')).toBe('60')
    const body = (await refused!.json()) as { error: string }
    expect(body.error).toContain('Rate limit reached')
  })

  test('a NON-LLM route still uses the Map and denies with the identical response shape', async () => {
    // The parity that matters: both paths answer with the same literal, so a caller cannot tell which
    // limiter refused it. Driving the default limit on a non-LLM POST exercises the Map arm.
    let refused: Response | undefined
    for (let i = 0; i < RATE_LIMIT_DEFAULT + 3; i += 1) {
      const res = await middleware(req('/api/documents', { method: 'POST' }))
      if (res.status === 429) { refused = res; break }
    }
    expect(refused).toBeDefined()
    expect(refused!.headers.get('Retry-After')).toBe('60')
  })
})
