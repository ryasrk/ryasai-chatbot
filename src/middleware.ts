import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_API_PATHS = new Set([
  '/api',
  '/api/v1/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/setup/status',
  '/api/setup/admin',
  '/api/fetch-url',
])

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isApi = pathname === '/api' || pathname.startsWith('/api/')

  if (!isApi) return NextResponse.next()
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next()

  // ponytail: existence-only check; full HMAC verification happens in route handlers via getActiveUser().
  if (!req.cookies.get('x-active-user')?.value) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
