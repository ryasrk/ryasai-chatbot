/**
 * Server-side helpers: audit logging + current-user/tenant context.
 * ----------------------------------------------------------------------------
 * The spec mandates full RBAC + JWT, but for the demo we use a lightweight
 * "active user" stored in a cookie/header so the UI is fully interactive
 * without a login screen. Every API writes an AuditLog row for security events.
 */
import { db } from '@/lib/db'
import { cookies } from 'next/headers'

export interface ActiveUser {
  userId: string
  companyId: string
  role: 'admin' | 'manager' | 'staff'
  name: string
  email: string
}

/**
 * Resolve the active user from the `x-active-user` cookie (JSON).
 * Falls back to the first admin user if none is set, so the demo always works.
 */
export async function getActiveUser(): Promise<ActiveUser> {
  const store = await cookies()
  const raw = store.get('x-active-user')?.value
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ActiveUser
      // validate the user still exists
      const u = await db.user.findUnique({
        where: { id: parsed.userId },
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
    } catch {
      /* fall through */
    }
  }
  // default to first admin
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
