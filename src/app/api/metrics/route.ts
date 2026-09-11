import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { prometheusText, initMetrics } from '@/lib/metrics'
import {
  ForbiddenError,
  getActiveUser,
  handleApiError,
  requireRole,
  UnauthorizedError,
} from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * Prometheus scrape endpoint — NEVER anonymous. Two modes:
 *
 * - METRICS_TOKEN set: requires `Authorization: Bearer <token>` (timing-safe
 *   compare). Intended for unauthenticated scrapers (Prometheus has no login).
 * - METRICS_TOKEN unset: falls back to an authenticated ADMIN session
 *   (getActiveUser + requireRole(user, 'admin')) so the endpoint is never
 *   publicly readable by default.
 */
initMetrics()

export const dynamic = 'force-dynamic'

// ponytail: hash-then-compare lets timingSafeEqual handle differing lengths —
// raw byte comparison would early-return on length mismatch and leak length.
function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

function metricsResponse(): NextResponse {
  return new NextResponse(prometheusText(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(req: NextRequest) {
  try {
    const configured = process.env.METRICS_TOKEN
    if (configured) {
      const provided = bearerToken(req)
      if (!provided || !timingSafeStringEqual(provided, configured)) {
        throw new UnauthorizedError('Invalid or missing metrics token.')
      }
      return metricsResponse()
    }

    // No token configured → admin session required.
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    return metricsResponse()
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof UnauthorizedError) {
      return handleApiError(e, e.message)
    }
    return handleApiError(e, 'Failed to collect metrics.')
  }
}
