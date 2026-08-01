import { db } from '@/lib/db'
import { bypassOrg, getOrgContext } from '@/lib/prisma-tenant'
import { serverConfig } from '@/lib/config'
import { extractSessionVersion, verifySession } from '@/lib/crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { scopedLogger } from '@/lib/logger'
import { AppError } from '@/lib/errors'
import { SESSION_INACTIVITY_TIMEOUT_MS } from '@/lib/constants'
const log = scopedLogger('session')

export interface ActiveUser {
  userId: string
  name: string
  email: string
  role: string
  organizationId: string
  plan: string | null
}

export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(message = 'No active session.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  constructor(message = 'Insufficient permissions.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID'
  constructor(message = 'License is no longer valid. Please contact your administrator.') {
    super(message)
    this.name = 'LicenseError'
  }
}

const ROLE_RANK: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }

export function requireRole(user: ActiveUser, minRole: 'admin' | 'analyst' | 'viewer'): void {
  const userRank = ROLE_RANK[user.role] ?? 0
  const requiredRank = ROLE_RANK[minRole] ?? 0
  if (userRank < requiredRank) {
    throw new ForbiddenError(`Requires ${minRole} role. You have ${user.role}.`)
  }
}

// ponytail: in-memory inactivity tracker — per-instance, not distributed.
// Ceiling: cleared on server restart (users re-authenticate). 30min timeout.
// Upgrade to Redis-backed tracker when deploying >1 instance.
const _lastActivity = new Map<string, number>()

function isInactivityExpired(userId: string): boolean {
  const last = _lastActivity.get(userId)
  if (!last) return false // first request or after restart — allow
  return Date.now() - last > SESSION_INACTIVITY_TIMEOUT_MS
}

function touchActivity(userId: string): void {
  _lastActivity.set(userId, Date.now())
  // Evict stale entries periodically
  if (_lastActivity.size > 1000) {
    const now = Date.now()
    for (const [k, t] of _lastActivity) {
      if (now - t > SESSION_INACTIVITY_TIMEOUT_MS) _lastActivity.delete(k)
    }
  }
}

export function handleApiError(e: unknown, fallback: string, status = 500) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED' as const, message: e.message } },
      { status: 401 },
    )
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' as const, message: e.message } },
      { status: 403 },
    )
  }
  if (e instanceof LicenseError) {
    return NextResponse.json(
      { error: { code: 'LICENSE_INVALID' as const, message: e.message } },
      { status: 402 },
    )
  }
  if (e instanceof AppError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, hint: e.hint } },
      { status: e.statusCode },
    )
  }
  log.error('Unhandled API error', { error: e instanceof Error ? e.message : String(e) })
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR' as const, message: fallback } },
    { status },
  )
}

export async function getActiveUser(): Promise<ActiveUser> {
  const store = await cookies()
  const token = store.get('x-active-user')?.value
  const userId = verifySession(token)
  if (userId) {
    // ponytail: inactivity timeout — reject if user has been idle >30min
    if (isInactivityExpired(userId)) {
      _lastActivity.delete(userId)
      throw new UnauthorizedError('Session expired due to inactivity. Please log in again.')
    }

    // ponytail: bypass org context for user lookup — we need to find the user
    // by ID regardless of org (we don't know the org yet).
    const u = await bypassOrg(() =>
      db.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, isActive: true, sessionVersion: true, role: true, organizationId: true },
      }),
    )
    // ponytail: session fixation defense — reject tokens with stale session version.
    if (u && u.isActive && u.sessionVersion === extractSessionVersion(token)) {
      // Set org context for all subsequent queries in this request
      const { enterWithOrg } = await import('@/lib/prisma-tenant')
      enterWithOrg(u.organizationId)
      // License gate — reject if org license is expired/invalid/suspended
      const org = await bypassOrg(() =>
        db.organization.findUnique({
          where: { id: u.organizationId },
          select: { licenseStatus: true, licensePlan: true },
        }),
      )
      if (org && (org.licenseStatus === 'expired' || org.licenseStatus === 'invalid' || org.licenseStatus === 'suspended')) {
        throw new LicenseError()
      }
      touchActivity(userId)
      return { userId: u.id, name: u.name, email: u.email, role: u.role, organizationId: u.organizationId, plan: org?.licensePlan ?? null }
    }
  }

  if (!serverConfig.authDemoFallback) {
    throw new UnauthorizedError()
  }

  if (!serverConfig.isTest) {
    log.warn(
      'AUTH_DEMO_FALLBACK is enabled — impersonating the first user. ' +
        'Disable in production by setting AUTH_DEMO_FALLBACK=false.',
    )
  }
  const user = await bypassOrg(() =>
    db.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, role: true, organizationId: true },
    }),
  )
  if (!user) throw new Error('No active user found. Run the seed script.')
  const { enterWithOrg } = await import('@/lib/prisma-tenant')
  enterWithOrg(user.organizationId)
  // License gate — reject if org license is expired/invalid/suspended
  const fallbackOrg = await bypassOrg(() =>
    db.organization.findUnique({
      where: { id: user.organizationId },
      select: { licenseStatus: true, licensePlan: true },
    }),
  )
  if (fallbackOrg && (fallbackOrg.licenseStatus === 'expired' || fallbackOrg.licenseStatus === 'invalid' || fallbackOrg.licenseStatus === 'suspended')) {
    throw new LicenseError()
  }
  return { userId: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organizationId, plan: fallbackOrg?.licensePlan ?? null }
}

export async function writeAudit(args: {
  userId?: string
  action: string
  severity?: 'info' | 'warning' | 'critical'
  detail: Record<string, unknown>
  ipAddress?: string
}) {
  const severity = args.severity ?? 'info'
  try {
    await db.auditLog.create({
      data: {
        organizationId: getOrgContext()!,
        userId: args.userId,
        action: args.action,
        severity,
        detail: JSON.stringify(args.detail),
        ipAddress: args.ipAddress ?? null,
      },
    })
  } catch (e) {
    // ponytail: critical throws (fail-closed — can't audit a security block → don't proceed), info/warning swallowed (non-critical).
    if (severity === 'critical') throw e
    console.error('[audit] failed to write log:', e)
  }
}
