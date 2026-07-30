import { NextResponse, type NextRequest } from 'next/server'
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_CHAT,
  RATE_LIMIT_LOGIN,
  RATE_LIMIT_AGENT,
  RATE_LIMIT_UPLOAD,
} from '@/lib/constants'

const PUBLIC_API_PATHS = new Set([
  '/api',
  '/api/v1/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/sso/login',
  '/api/auth/sso/callback',
  '/api/setup/status',
  '/api/setup/admin',
  '/api/fetch-url',
])

// ponytail: rate limit only state-changing/expensive methods (POST/PUT/DELETE/PATCH).
// GET requests are read-only DB queries (dashboard loads, list views) — limiting them
// breaks normal UI navigation with zero security benefit. Session auth already gates access.
const RATE_LIMITED_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

// ponytail: in-memory rate limiting — Edge-safe, per-instance.
// Ceiling: not distributed (each instance counts independently). Upgrade to
// Redis-backed rate limiting when deploying >1 instance. Reset every 60s.
const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>()
const ROUTE_LIMITS: Array<[string, number]> = [
  ['/api/chat/sessions', RATE_LIMIT_CHAT], // chat POST = LLM call (expensive)
  ['/api/v1/chat/completions', RATE_LIMIT_CHAT],
  ['/api/v1/agent/run', RATE_LIMIT_AGENT],
  ['/api/agent/dashboard', RATE_LIMIT_AGENT],
  ['/api/auth/login', RATE_LIMIT_LOGIN], // brute force protection
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
  return `session:${session.slice(0, 20)}:${route}`
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isApi = pathname === '/api' || pathname.startsWith('/api/')

  if (!isApi) return NextResponse.next()
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next()

  // ponytail: existence-only check; full HMAC verification happens in route handlers via getActiveUser().
  if (!req.cookies?.get?.('x-active-user')?.value) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limiting — only for state-changing/expensive methods (POST/PUT/DELETE/PATCH).
  // GET requests are read-only and cheap; limiting them breaks UI navigation.
  if (RATE_LIMITED_METHODS.has(req.method)) {
    const { limit, route } = limitFor(pathname)
    const key = rateLimitKey(req, route)
    const now = Date.now()
    const bucket = RATE_BUCKETS.get(key)
    if (!bucket || now > bucket.resetAt) {
      RATE_BUCKETS.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
      // Evict stale buckets periodically
      if (RATE_BUCKETS.size > 1000) {
        for (const [k, b] of RATE_BUCKETS) if (now > b.resetAt) RATE_BUCKETS.delete(k)
      }
    } else {
      bucket.count += 1
      if (bucket.count > limit) {
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
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
