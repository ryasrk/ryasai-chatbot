import crypto from 'crypto'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg, getOrgContext, requireOrgContext } from '@/lib/prisma-tenant'
import { serverConfig } from '@/lib/config'
import { extractSessionVersion, verifySession } from '@/lib/crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { scopedLogger } from '@/lib/logger'
import { redisCmd } from '@/lib/redis'
import { AppError } from '@/lib/errors'
import { SESSION_INACTIVITY_TIMEOUT_MS } from '@/lib/constants'
import { getLockdownReason } from '@/lib/license-client'
import { sessionActivityExpired } from '@/lib/session-activity'
const log = scopedLogger('session')

export interface ActiveUser {
  userId: string
  name: string
  email: string
  role: string
  organizationId: string
  plan: string | null
}

// Defined in a leaf module so `errors.ts` can recognise them without importing this file (which imports it).
export { UnauthorizedError, ForbiddenError, LicenseError } from '@/lib/session-errors'
import { UnauthorizedError, ForbiddenError, LicenseError } from '@/lib/session-errors'

const ROLE_RANK: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }

export function requireRole(user: ActiveUser, minRole: 'admin' | 'analyst' | 'viewer'): void {
  const userRank = ROLE_RANK[user.role] ?? 0
  const requiredRank = ROLE_RANK[minRole] ?? 0
  if (userRank < requiredRank) {
    throw new ForbiddenError(`Requires ${minRole} role. You have ${user.role}.`)
  }
}

// ponytail: Redis-backed inactivity tracker — distributed across instances.
// Keep evidence for the full signed session lifetime, scoped to the login version.
async function isInactivityExpired(userId: string, token: string): Promise<boolean> {
  try {
    const last = await redisCmd.get(`session:activity:${userId}:${extractSessionVersion(token)}`)
    const now = Date.now()
    const expired = sessionActivityExpired(last, token, now)
    if (expired) log.warn('Session activity expired', {
      activityAgeMs: last === null ? null : now - Number(last),
      tokenAgeMs: now - Number(token.split('.')[2]),
    })
    return expired
  } catch {
    // A freshly authenticated session works during an outage; stale evidence cannot renew it.
    return sessionActivityExpired(null, token)
  }
}

async function touchActivity(userId: string, token: string): Promise<void> {
  try {
    await redisCmd.set(
      `session:activity:${userId}:${extractSessionVersion(token)}`,
      String(Date.now()),
      'PX',
      7 * 24 * 60 * 60 * 1000 + SESSION_INACTIVITY_TIMEOUT_MS,
    )
  } catch {
    // Redis down — skip
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

export interface GetActiveUserOptions {
  /**
   * When true, resolve the session and org context but skip the license gate.
   * Used by routes that must re-validate the license themselves even when the
   * org is already locked down (e.g. POST /api/license/retry) — without this,
   * getActiveUser() would throw LicenseError before the caller can act.
   */
  skipLicenseCheck?: boolean
  /**
   * When true, let sessions through whose ONLY license problem is
   * `licenseStatus === 'unpaid'` (licenseless signup that hasn't purchased
   * yet). Expired/suspended/invalid/unreachable-beyond-grace still throw.
   * Used ONLY by /api/billing/*, /api/me, and auth routes so locked users can
   * reach checkout — every other route keeps blocking unpaid orgs.
   */
  allowUnlicensed?: boolean
}

export async function getActiveUser(opts: GetActiveUserOptions = {}): Promise<ActiveUser> {
  const skipLicense = opts.skipLicenseCheck === true
  const allowUnlicensed = opts.allowUnlicensed === true
  const store = await cookies()
  const token = store.get('x-active-user')?.value
  const userId = verifySession(token)
  if (userId) {
    // ponytail: inactivity timeout — reject if user has been idle >30min
    if (await isInactivityExpired(userId, token!)) {
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
      enterWithOrg(u.organizationId)
      const org = await bypassOrg(() =>
        db.organization.findUnique({
          where: { id: u.organizationId },
          select: { licenseStatus: true, licensePlan: true, licenseValidatedAt: true },
        }),
      )
      // License gate — block expired/invalid/suspended. 'unreachable' blocked only beyond grace period.
      // Skipped when the caller is performing the revalidation itself (e.g. /api/license/retry).
      // 'unpaid' passes through when the caller explicitly allows it (billing/me/auth routes).
      if (!skipLicense && org) {
        const lockdownReason = getLockdownReason(org.licenseStatus, org.licenseValidatedAt ?? null)
        const waived = allowUnlicensed && lockdownReason === 'unpaid'
        if (lockdownReason && !waived) {
          throw new LicenseError(lockdownReason)
        }
      }
      await touchActivity(userId, token!)
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
  enterWithOrg(user.organizationId)
  const fallbackOrg = await bypassOrg(() =>
    db.organization.findUnique({
      where: { id: user.organizationId },
      select: { licenseStatus: true, licensePlan: true, licenseValidatedAt: true },
    }),
  )
  if (!skipLicense && fallbackOrg) {
    const lockdownReason = getLockdownReason(fallbackOrg.licenseStatus, fallbackOrg.licenseValidatedAt ?? null)
    const waived = allowUnlicensed && lockdownReason === 'unpaid'
    if (lockdownReason && !waived) {
      throw new LicenseError(lockdownReason)
    }
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
    const content = JSON.stringify({ userId: args.userId, action: args.action, severity, detail: args.detail, timestamp: Date.now() })
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    await db.auditLog.create({
      data: {
        organizationId: requireOrgContext(),
        userId: args.userId,
        action: args.action,
        severity,
        detail: JSON.stringify(args.detail),
        ipAddress: args.ipAddress ?? null,
        hash,
      },
    })
  } catch (e) {
    // ponytail: critical throws (fail-closed — can't audit a security block → don't proceed), info/warning swallowed (non-critical).
    if (severity === 'critical') throw e
    console.error('[audit] failed to write log:', e)
  }
}
