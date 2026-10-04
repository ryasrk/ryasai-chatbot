import { NextResponse, type NextRequest } from 'next/server'
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_CHAT,
  RATE_LIMIT_AGENT,
  RATE_LIMIT_UPLOAD,
} from '@/lib/constants'
import { getClientIp } from '@/lib/client-ip'
import { checkRateLimit } from '@/lib/distributed-rate-limit'

/**
 * Public paths that still need the middleware's generic per-request limiter.
 *
 * `PUBLIC_API_PATHS` means "do not require a session", and the early return for it used to skip the rate
 * limiter entirely -- so a guard never ran for the one endpoint whose own comment read
 * `// brute force protection`. Measured at the time: 200 POSTs to /api/auth/login -> 200 x HTTP 200, while
 * a NON-public path with the same key went 20 x 200 then 180 x 429.
 *
 * `/api/auth/login` IS DELIBERATELY ABSENT NOW, and the reason is the OPPOSITE defect from the one above.
 * A per-request counter cannot tell a guess from a correct sign-in, so it spent quota on both, and it
 * keyed the bucket on the session cookie -- which a login request cannot have, collapsing every anonymous
 * caller into the single key `session::/api/auth/login`. Measured: the 11th login inside one 60-second
 * window came back 429 with `Retry-After: 60`, on an install whose entire purpose is to let people log in.
 * Brute-force protection now counts FAILURES, per account and per client address, inside the route where
 * the outcome is known: src/lib/login-throttle.ts.
 *
 * The two remaining entries create an organization or a user, with NO session and NO second limiter, which
 * is expensive work worth bounding. The other public paths are deliberately absent:
 *   - `/api/v1/chat/completions` and `/api/v1/agent/run` rate-limit per API KEY inside their handlers;
 *   - `/api/webhooks/*` and `/api/billing/webhook` are signature-authenticated server-to-server callers,
 *     and throttling them would DROP DELIVERIES rather than block an attacker;
 *   - `/api/v1/health`, `/api/health` and `/api` are read-only liveness probes hit by orchestrators.
 */
const PUBLIC_PATHS_RATE_LIMITED = new Set([
  '/api/auth/signup',
  '/api/auth/register',
])

const PUBLIC_API_PATHS = new Set([
  '/api',
  '/api/v1/health',
  '/api/health',
  // The handler verifies either METRICS_TOKEN or an admin session.
  '/api/metrics',
  '/api/v1/chat/completions',
  '/api/v1/agent/run',
  '/api/webhooks/incoming',
  '/api/webhooks/license',
  // Midtrans calls this server-to-server with NO session cookie — authenticity
  // is enforced by the sha512 signature check inside the route handler itself.
  '/api/billing/webhook',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/signup',
  '/api/auth/register',
  '/api/auth/sso/login',
  '/api/auth/sso/callback',
  '/api/auth/sso/status',
  '/api/auth/saml/login',
  '/api/auth/saml/callback',
  '/api/auth/saml/metadata',
  '/api/auth/accept-invite',
  '/api/setup/status',
  '/api/setup/admin',
  '/api/fetch-url',
])

// ponytail: rate limit only state-changing/expensive methods (POST/PUT/DELETE/PATCH).
// GET requests are read-only DB queries (dashboard loads, list views) — limiting them
// breaks normal UI navigation with zero security benefit. Session auth already gates access.
const RATE_LIMITED_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

// ponytail: in-memory rate limiting — Edge-safe, per-instance.
// Ceiling: not distributed (each instance counts independently). Reset every 60s.
// The four LLM routes below are the exception — they now consult Redis FIRST via
// checkRateLimit (src/lib/distributed-rate-limit.ts), so instances SHARE one counter
// there and an N-instance install no longer hands out N x the limit on the most
// expensive paths. When Redis is unreachable that helper falls back to this same
// per-instance ceiling (RATE_BUCKETS' memory fallback), so the middleware keeps
// working with Redis entirely absent. Every OTHER route stays on this Map: it is
// Edge-safe, adds no round-trip, and its per-instance ceiling is acceptable for
// cheap routes that an N-instance install multiplies harmlessly.
const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>()
// The routes whose every request is an LLM call paid for out of the customer's own provider
// key. NOTE the coupling: `usesDistributedLimiter()` matches on `limitFor()`'s resolved route,
// so a path listed here but MISSING from ROUTE_LIMITS would resolve to '/api/_default' and
// silently keep the Map path. Keep this set a subset of ROUTE_LIMITS' first column.
const LLM_ROUTES = new Set([
  '/api/chat/sessions',
  '/api/v1/chat/completions',
  '/api/v1/agent/run',
  '/api/agent/dashboard',
])
const ROUTE_LIMITS: Array<[string, number]> = [
  ['/api/chat/sessions', RATE_LIMIT_CHAT], // chat POST = LLM call (expensive)
  ['/api/v1/chat/completions', RATE_LIMIT_CHAT],
  ['/api/v1/agent/run', RATE_LIMIT_AGENT],
  ['/api/agent/dashboard', RATE_LIMIT_AGENT],
  // NOT /api/auth/login. A per-request counter here counted SUCCESSFUL sign-ins and keyed them on a session
  // cookie a login request cannot have, so every anonymous caller shared ONE bucket and the 11th person to
  // sign in inside a minute was refused. Login's brute-force guard counts failures, in the route:
  // src/lib/login-throttle.ts. Re-adding an entry here would silently restore the defect.
  ['/api/documents', RATE_LIMIT_UPLOAD], // upload/processing
  ['/api/integrations', RATE_LIMIT_UPLOAD], // connection testing
]

function limitFor(pathname: string): { limit: number; route: string } {
  for (const [prefix, limit] of ROUTE_LIMITS) {
    if (pathname.startsWith(prefix)) return { limit, route: prefix }
  }
  return { limit: RATE_LIMIT_DEFAULT, route: '/api/_default' }
}

function rateLimitKey(req: NextRequest, route: string): string {
  // ponytail: guard against missing headers in test mocks
  const apiKey = req.headers?.get?.('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (apiKey) return `apikey:${apiKey.slice(0, 13)}:${route}`
  const session = req.cookies?.get?.('x-active-user')?.value ?? ''
  if (session) return `session:${session.slice(0, 20)}:${route}`
  // ANONYMOUS callers have no session cookie by definition, so the old `session::<route>` key collapsed all
  // of them into a SINGLE bucket: one caller's requests spent everyone's quota. Key on the address the proxy
  // observed instead (src/lib/client-ip.ts explains why the LAST forwarded hop is the trustworthy one).
  // A caller able to forge the header buys a fresh bucket, never a bypass -- an anonymous request holds no
  // credential to bypass with, and the bucket only decides whether the request reaches the handler.
  return `ip:${getClientIp(req)}:${route}`
}

/**
 * The 429 the caller sees when a bucket is exhausted. One literal, shared by the Map path and the
 * Redis path so the two cannot drift — a caller's retry behaviour must not depend on which
 * counter happened to be consulted.
 */
function rateLimitDenied(limit: number): NextResponse {
  return NextResponse.json(
    { error: 'Rate limit reached. Try again later.' },
    {
      status: 429,
      headers: {
        'Retry-After': '60',
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
      },
    },
  )
}

/**
 * The rate-limit decision, shared by the public-credential path and the normal path so the two cannot drift.
 * Returns a 429 response when the bucket is exhausted, or null to continue. The periodic eviction is a memory
 * optimisation, not a correctness guard: the read path already resets a stale bucket, which is why removing the
 * sweep is unobservable (recorded in the middleware tests).
 */
function applyRateLimit(req: NextRequest, pathname: string): NextResponse | null {
  const { limit, route } = limitFor(pathname)
  const key = rateLimitKey(req, route)
  const now = Date.now()
  const bucket = RATE_BUCKETS.get(key)
  if (!bucket || now > bucket.resetAt) {
    RATE_BUCKETS.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (RATE_BUCKETS.size > 1000) {
      for (const [k, b] of RATE_BUCKETS) if (now > b.resetAt) RATE_BUCKETS.delete(k)
    }
    return null
  }
  bucket.count += 1
  if (bucket.count <= limit) return null
  return rateLimitDenied(limit)
}

/**
 * The four LLM routes go through the SHARED counter instead. Redis is asked first
 * (src/lib/distributed-rate-limit.ts); on a Redis outage it degrades to its own per-instance
 * memory bucket, so this never throws and never blocks the request on Redis being absent.
 * The denial response is the same literal as the Map path's.
 */
async function applyDistributedRateLimit(req: NextRequest, pathname: string): Promise<NextResponse | null> {
  const { limit, route } = limitFor(pathname)
  const key = rateLimitKey(req, route)
  const decision = await checkRateLimit({ key, maxPerMinute: limit })
  if (decision.allowed) return null
  return rateLimitDenied(limit)
}

/**
 * Routes the Map limiter still owns. `LLM_ROUTES` are excluded because they are served by the
 * distributed helper above; everything else — including the credential-creating public paths and
 * the upload/connection-testing routes — keeps the cheap, Edge-safe, in-process counter.
 */
function usesDistributedLimiter(pathname: string): boolean {
  return LLM_ROUTES.has(limitFor(pathname).route)
}

// Async because the four LLM routes await a Redis round-trip (see applyDistributedRateLimit).
// Next.js middleware may be async; the await only happens on those four paths.
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl
  const isApi = pathname === '/api' || pathname.startsWith('/api/')

  if (!isApi) return NextResponse.next()

  // Throttle the credential-CREATING public paths even though they are public. This MUST happen before the
  // public early-return below, which is exactly where the limiter used to be skipped.
  // These are NOT LLM routes, so the Map path is used — no round-trip to Redis for a signup.
  if (PUBLIC_PATHS_RATE_LIMITED.has(pathname) && RATE_LIMITED_METHODS.has(req.method)) {
    const limited = applyRateLimit(req, pathname)
    if (limited) return limited
  }

  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next()

  // ponytail: existence-only check; full HMAC verification happens in route handlers via getActiveUser().
  if (!req.cookies?.get?.('x-active-user')?.value) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limiting — only for state-changing/expensive methods (POST/PUT/DELETE/PATCH).
  // GET requests are read-only and cheap; limiting them breaks UI navigation.
  if (RATE_LIMITED_METHODS.has(req.method)) {
    // The LLM routes consult the SHARED (Redis-first) counter; everything else uses the Map.
    // Both paths answer with the same 429, so the caller sees no difference between them.
    const limited = usesDistributedLimiter(pathname)
      ? await applyDistributedRateLimit(req, pathname)
      : applyRateLimit(req, pathname)
    if (limited) return limited
  }

  return NextResponse.next()
}

/*
 * RUNTIME: Node, not Edge — and this is load-bearing, not a preference.
 *
 * The distributed rate limiter resolves `@/lib/redis` lazily, which keeps the import out of the
 * module-evaluation path but NOT out of the bundle: Turbopack still resolves it statically, and in an
 * Edge build it rewrites `node:net`/`node:tls`/`node:dns` to `__import_unsupported` stubs (MEASURED in
 * the built artifact after an integration review flagged it). The middleware then carried ~700 KB of
 * ioredis it could never connect, and every Redis verdict degraded to the per-instance memory bucket —
 * the shared counter existed in the code and not in the behaviour. Nothing here uses an Edge-only API
 * (no crypto.subtle, no streams), so declaring the Node runtime makes the limiter actually work and
 * drops the dead module from the bundle.
 */
export const runtime = 'nodejs'

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
