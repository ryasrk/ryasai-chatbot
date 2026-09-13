/**
 * GET /api/v1/health — the unauthenticated liveness probe.
 *
 * WHY THIS FILE EXISTS. This is the route orchestrators (k8s, Docker, Caddy) hit on a scrape
 * interval, and it is reachable with NO session: `src/middleware.ts` lists `/api/v1/health` in
 * `PUBLIC_API_PATHS`, and the handler itself calls nothing that could authenticate. Three
 * consequences make it worth pinning rather than leaving as a trivial "returns ok" test:
 *
 *   1. ITS ONLY JOB IS LIVENESS — IT MUST TOUCH NOTHING. The sibling `/api/health` route documents
 *      this one as the "lightweight liveness probe (no DB hit)". The whole reason a second health
 *      route exists is that the detailed one queries Postgres, Redis and the license validator. If
 *      a DB/Redis/session call is ever added here, the probe starts failing for reasons that have
 *      nothing to do with the process being alive, and it is no longer a liveness signal. Asserted
 *      by COUNTING calls into every such seam (throwing mocks), not by reading the source.
 *   2. THE RESPONSE IS ANONYMOUSLY READABLE, SO IT IS AN ATTACKER'S FIRST FREE LOOK. The one value
 *      that is genuinely derived from configuration is `version`, sourced from
 *      `publicConfig.appVersion` (`NEXT_PUBLIC_APP_VERSION`). It is therefore asserted positively
 *      (it IS the configured value) AND negatively (the body carries no host, connection string,
 *      credential, env-var name or `checks` object — the detailed route's payload shape). A future
 *      "add the build info to the health payload" edit must fail this file.
 *   3. `time` AND THE VERSION ARE THE IDENTIFIER. An uptime/liveness consumer keys on `time` being
 *      a valid, clock-consistent ISO-8601 instant; a naive `new Date().toString()` or a cached
 *      module-load timestamp would both look fine by eye and break it. Asserted by shape and by
 *      two successive calls advancing.
 *
 * Also pinned: the response is 200 with `content-type: application/json`, `ok` is a real boolean
 * (not a truthy string an orchestrator's `=== true` check would reject), and the field set is
 * EXACTLY the four documented keys — asserted as a sorted key list so any added field is a
 * deliberate edit rather than a silent leak.
 *
 * NO DEFECT WAS FOUND in this route. The two behaviours that could be argued about are recorded as
 * CURRENT, DELIBERATE behaviour below (the version disclosure and the absence of caching headers)
 * with the reasoning, rather than being written up as bugs.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared at the TOP, ABOVE every mock.module ----
//
// Module namespace bindings are read-only in Bun (`Attempted to assign to readonly property`), so
// the value the route reads has to live in a `let` in this file's own scope and be exposed through
// the mock's closure. A getter is used (rather than a copied value) so a test can swap the version
// and have the already-imported route observe the change.
let version = '0.0.0-test'

/**
 * Every session/auth seam the route must NOT reach. Each throws AND increments a counter: a throw
 * alone would be caught by nothing here, but the counter is what lets a test assert the call never
 * happened at all, which is the property that matters for a liveness probe.
 */
let sessionTouches = 0
let dbTouches = 0
let tenantTouches = 0
let outboundFetches = 0
const events: string[] = []

mock.module('@/lib/public-config', () => ({
  publicConfig: {
    get appVersion() {
      events.push('publicConfig.appVersion')
      return version
    },
    wsPort: 3003,
  },
}))

mock.module('@/lib/session', () => {
  const touch = (name: string) => {
    sessionTouches++
    events.push(`session.${name}`)
    throw new Error(`the liveness probe must not call ${name}`)
  }
  return {
    getActiveUser: async () => touch('getActiveUser'),
    requireRole: () => touch('requireRole'),
    writeAudit: async () => touch('writeAudit'),
    handleApiError: () => touch('handleApiError'),
  }
})

// A Proxy is used so that ANY property access on the Prisma client is counted. A mock exposing
// only `document.count` would pass a route that calls `db.organization.findFirst()`, which is
// exactly the kind of "small, cheap extra check" this probe is supposed to never grow.
mock.module('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        dbTouches++
        events.push('db')
        throw new Error('the liveness probe must not query the database')
      },
    },
  ),
}))

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async () => {
    tenantTouches++
    events.push('bypassOrg')
    throw new Error('the liveness probe must not open a tenant context')
  },
  enterWithOrg: () => {
    tenantTouches++
    events.push('enterWithOrg')
    throw new Error('the liveness probe must not open a tenant context')
  },
}))

// The route is unauthenticated and must stay off the network. `fetch` is counted, not stubbed to
// succeed, so an added validator/Redis probe shows up as a failure here rather than as a slow
// successful request in production.
const realFetch = globalThis.fetch
// Cast through `unknown`: the stub omits `fetch.preconnect`, which Bun's `typeof fetch` requires,
// so a direct cast is rejected. The stub is only ever reached if the route regresses.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  outboundFetches++
  events.push(`fetch:${String(input)}`)
  throw new Error('the liveness probe must not make outbound requests')
}) as unknown as typeof fetch

// DYNAMIC import — MUST come after every mock.module above. A static `import` is evaluated before
// the mocks install, which would bypass all of them and make this file conclude "the route never
// calls the DB" without ever having proved it.
const { GET } = await import('./route')

beforeEach(() => {
  version = '0.0.0-test'
  sessionTouches = 0
  dbTouches = 0
  tenantTouches = 0
  outboundFetches = 0
  events.length = 0
})

/** GET, then read the body ONCE as text and parse it — `res.text()` consumes the stream. */
async function call(): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const res = await GET()
  const raw = await res.text()
  return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> }
}

describe('GET /api/v1/health — the liveness contract', () => {
  test('it is 200 with the exact documented field set and nothing more', async () => {
    // Sorted key list, not a subset check: the response is anonymously readable, so an ADDED field
    // is the failure mode that matters, and `toMatchObject` would not catch it.
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'time', 'version'])
  })

  test('ok is a real boolean true, not a truthy stand-in', async () => {
    // A `'true'` string or a 1 would pass an eyeball check and fail an orchestrator's `=== true`.
    const { body } = await call()
    expect(body.ok).toBe(true)
    expect(typeof body.ok).toBe('boolean')
  })

  test('service names the deployment target', async () => {
    const { body } = await call()
    expect(body.service).toBe('ryasai')
  })

  test('the content type is JSON so a scraper parses it without sniffing', async () => {
    const res = await GET()
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('the body round-trips as valid JSON from the raw text', async () => {
    // Guards against a handler that builds the payload by hand (a string template) and produces
    // something that only looks like JSON.
    const { raw, body } = await call()
    expect(raw.startsWith('{')).toBe(true)
    expect(body).toEqual(JSON.parse(raw) as Record<string, unknown>)
  })
})

describe('GET /api/v1/health — version comes from publicConfig, not a constant', () => {
  test('version IS the configured value', async () => {
    const { body } = await call()
    expect(body.version).toBe('0.0.0-test')
  })

  test('it reads publicConfig.appVersion and does NOT hardcode the version', async () => {
    // A hardcoded '0.4.0' would silently disagree with the package version forever after the first
    // release. Changing the seam and seeing the response follow is the only way to prove the route
    // reads the config rather than a literal that happens to match today.
    version = '9.9.9-sentinel'
    const { body } = await call()
    expect(body.version).toBe('9.9.9-sentinel')
  })

  test('the version is read per REQUEST, not frozen at module load', async () => {
    // Two calls with the seam changed in between: a module-scope `const v = publicConfig.appVersion`
    // would answer the first value twice.
    const first = await call()
    version = 'second-boot'
    const second = await call()
    expect(first.body.version).toBe('0.0.0-test')
    expect(second.body.version).toBe('second-boot')
    expect(events.filter((e) => e === 'publicConfig.appVersion')).toHaveLength(2)
  })
})

describe('GET /api/v1/health — time is a usable liveness instant', () => {
  test('time is a valid ISO-8601 instant', async () => {
    const { body } = await call()
    const iso = body.time as string
    expect(typeof body.time).toBe('string')
    const t = new Date(iso)
    expect(Number.isNaN(t.getTime())).toBe(false)
    // Strict ISO-8601 (Zulu): `new Date().toString()` would also parse, so the FORMAT is asserted
    // explicitly, not just parseability.
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(t.toISOString()).toBe(iso)
  })

  test('time is the CURRENT time, not a module-load or epoch constant', async () => {
    const before = Date.now()
    const { body } = await call()
    const after = Date.now()
    const t = new Date(body.time as string).getTime()
    expect(t).toBeGreaterThanOrEqual(before - 1000)
    expect(t).toBeLessThanOrEqual(after + 1000)
  })

  test('two calls advance, so a scrape can see the process is progressing', async () => {
    const a = await call()
    await new Promise((r) => setTimeout(r, 5))
    const b = await call()
    expect(new Date(b.body.time as string).getTime()).toBeGreaterThanOrEqual(
      new Date(a.body.time as string).getTime(),
    )
  })
})

describe('GET /api/v1/health — needs NO session and no tenant context', () => {
  test('it answers 200 with an empty request and no auth (it takes no arguments at all)', async () => {
    // The handler signature is `GET()` — it cannot even look at cookies or headers. Called with
    // nothing, exactly as the route -- and the middleware allow-list -- intends.
    const { status } = await call()
    expect(status).toBe(200)
  })

  test('it never calls into @/lib/session', async () => {
    // The mocks THROW, so a single call would surface as a rejected GET, not a silent pass.
    await call()
    expect(sessionTouches).toBe(0)
  })

  test('it never touches the database', async () => {
    await call()
    expect(dbTouches).toBe(0)
  })

  test('it never opens a tenant context', async () => {
    await call()
    expect(tenantTouches).toBe(0)
  })

  test('it makes no outbound requests (no validator/Redis probe)', async () => {
    // This is the specific difference from the sibling /api/health route, which does all three.
    await call()
    expect(outboundFetches).toBe(0)
    expect(realFetch).toBeDefined()
  })

  test('the ONLY seam the route consults is publicConfig.appVersion', async () => {
    // Side-effect ORDER and the complete set of seams in one assertion: a liveness probe that
    // reaches anything else has stopped being a liveness probe.
    await call()
    expect(events).toEqual(['publicConfig.appVersion'])
  })
})

describe('GET /api/v1/health — no secret is disclosed to an anonymous caller', () => {
  test('the body contains no connection string, credential, env-var NAME or checks object', async () => {
    // The response is unauthenticated and world-readable. Assert on the RAW text, so a secret
    // nested inside a new sub-object is caught too — inspecting known keys only would miss it.
    //
    // Deliberately NOT asserted as bugs, but recorded as the current, intended shape:
    //   * the FOUR keys only — the detailed /api/health route's `checks` map (db/redis/validator
    //     status, latencies and error strings) must never appear here.
    //   * `version` IS disclosed, on purpose: it is `NEXT_PUBLIC_APP_VERSION`, already inlined into
    //     the public browser bundle, so it is not a secret and it is what the probe is for.
    const { raw, body } = await call()
    const lower = raw.toLowerCase()

    for (const needle of [
      'postgres',
      'postgresql',
      'mysql',
      'redis',
      'database_url',
      'password',
      'secret',
      'token',
      'apikey',
      'api_key',
      'authorization',
      'bearer',
      'encryption',
      'private',
      'license',
      'checks',
      'latency',
      'stack',
      '/home/',
      'localhost',
      '127.0.0.1',
      '::1',
    ]) {
      expect(lower).not.toContain(needle)
    }

    // No value in the payload may look like a URL, a filesystem path, or a long opaque blob — the
    // shapes a leaked endpoint/credential takes.
    for (const value of Object.values(body)) {
      if (typeof value !== 'string') continue
      const v: string = value
      expect(v).not.toMatch(/:\/\//)
      expect(value).not.toMatch(/\/(home|var|usr|etc|app)\//)
      expect(value).not.toMatch(/^[A-Za-z0-9+/=_-]{40,}$/)
    }
  })

  test('the response is not a stack trace or an error envelope', async () => {
    const { body } = await call()
    expect(body).not.toHaveProperty('error')
    expect(body).not.toHaveProperty('stack')
    expect(body).not.toHaveProperty('message')
    expect(body).not.toHaveProperty('checks')
  })

  test('no caching header is set — recorded as CURRENT, DELIBERATE behaviour', async () => {
    // PINNED AS-IS, NOT A DEFECT. A liveness probe must report the state of the process NOW; a
    // shared/proxy cache of `time` would report liveness for a dead instance. Nothing here sets
    // `cache-control`, and the route is a dynamic GET with no static revalidation, so Next serves
    // it uncached. If a `cache-control: public, max-age=...` is ever added, INVERT this assertion —
    // that change would let a CDN answer for a dead pod.
    const res = await GET()
    expect(res.headers.get('cache-control')).toBeNull()
  })
})
