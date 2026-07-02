/**
 * Server-side helpers: audit logging + current-user/tenant context.
 * ----------------------------------------------------------------------------
 * The spec mandates full RBAC + JWT, but for the demo we use a lightweight
 * "active user" stored in a cookie/header so the UI is fully interactive
 * without a login screen. Every API writes an AuditLog row for security events.
 */
import { db } from '@/lib/db'
import { serverConfig } from '@/lib/config'
import { verifySession } from '@/lib/crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export interface ActiveUser {
  userId: string
  companyId: string
  role: 'admin' | 'manager' | 'staff'
  name: string
  email: string
}

/** Tagged error so route handlers can map it to a 401. */
export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(message = 'Tidak ada sesi aktif.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

/**
 * Shared API error handler. Maps domain errors to the correct HTTP status and
 * returns a generic client message (never leaks internal error details like
 * `String(e)`, which can expose schema/table names or stack info).
 *   - UnauthorizedError → 401
 *   - anything else     → given status (default 500), logged server-side.
 *
 * Clients treat a missing `ok` field as failure, so the `{ error }` shape works
 * for both the `{ error }` and `{ ok:false, error }` route conventions.
 */
export function handleApiError(e: unknown, fallback: string, status = 500) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: e.message }, { status: 401 })
  }
  console.error('[api]', e)
  return NextResponse.json({ error: fallback }, { status })
}

/**
 * Resolve the active user from the `x-active-user` cookie (JSON).
 *
 * If no valid cookie is present:
 *   - When AUTH_DEMO_FALLBACK is enabled (default in dev), impersonate the first
 *     admin so the demo UI works without a login screen.
 *   - Otherwise (production / explicit opt-out), throw UnauthorizedError so the
 *     request fails closed instead of silently running as admin.
 */
export async function getActiveUser(): Promise<ActiveUser> {
  const store = await cookies()
  // The cookie is a signed `userId.signature` token; only trust the id if the
  // HMAC verifies (prevents forging another user's id).
  const userId = verifySession(store.get('x-active-user')?.value)
  if (userId) {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, name: true, email: true, companyId: true, isActive: true },
    })
    if (u && u.isActive) {
      return {
        userId: u.id,
        companyId: u.companyId,
        role: u.role as ActiveUser['role'],
        name: u.name,
        email: u.email,
      }
    }
  }

  if (!serverConfig.authDemoFallback) {
    throw new UnauthorizedError()
  }

  // demo fallback — first admin (dev convenience only)
  if (!serverConfig.isTest) {
    console.warn(
      '[session] AUTH_DEMO_FALLBACK is enabled — impersonating the first admin. ' +
        'Disable in production by setting AUTH_DEMO_FALLBACK=false.',
    )
  }
  const admin = await db.user.findFirst({
    where: { role: 'admin', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!admin) throw new Error('No active user found. Run the seed script.')
  return {
    userId: admin.id,
    companyId: admin.companyId,
    role: 'admin',
    name: admin.name,
    email: admin.email,
  }
}

export async function writeAudit(args: {
  companyId: string
  userId?: string
  action: string
  severity?: 'info' | 'warning' | 'critical'
  detail: Record<string, unknown>
  ipAddress?: string
}) {
  try {
    await db.auditLog.create({
      data: {
        companyId: args.companyId,
        userId: args.userId,
        action: args.action,
        severity: args.severity ?? 'info',
        detail: JSON.stringify(args.detail),
        ipAddress: args.ipAddress ?? null,
      },
    })
  } catch (e) {
    // audit must never break the main flow
    console.error('[audit] failed to write log:', e)
  }
}
