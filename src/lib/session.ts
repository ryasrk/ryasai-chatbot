import { db } from '@/lib/db'
import { serverConfig } from '@/lib/config'
import { extractSessionVersion, verifySession } from '@/lib/crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export interface ActiveUser {
  userId: string
  name: string
  email: string
}

export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(message = 'Tidak ada sesi aktif.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

// ponytail: in-memory inactivity tracker — per-instance, not distributed.
// Ceiling: cleared on server restart (users re-authenticate). 30min timeout.
// Upgrade to Redis-backed tracker when deploying >1 instance.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000
const _lastActivity = new Map<string, number>()

function isInactivityExpired(userId: string): boolean {
  const last = _lastActivity.get(userId)
  if (!last) return false // first request or after restart — allow
  return Date.now() - last > INACTIVITY_TIMEOUT_MS
}

function touchActivity(userId: string): void {
  _lastActivity.set(userId, Date.now())
  // Evict stale entries periodically
  if (_lastActivity.size > 1000) {
    const now = Date.now()
    for (const [k, t] of _lastActivity) {
      if (now - t > INACTIVITY_TIMEOUT_MS) _lastActivity.delete(k)
    }
  }
}

export function handleApiError(e: unknown, fallback: string, status = 500) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: e.message }, { status: 401 })
  }
  console.error('[api]', e)
  return NextResponse.json({ error: fallback }, { status })
}

export async function getActiveUser(): Promise<ActiveUser> {
  const store = await cookies()
  const token = store.get('x-active-user')?.value
  const userId = verifySession(token)
  if (userId) {
    // ponytail: inactivity timeout — reject if user has been idle >30min
    if (isInactivityExpired(userId)) {
      _lastActivity.delete(userId)
      throw new UnauthorizedError('Sesi kedaluwarsa karena tidak aktif. Silakan login kembali.')
    }

    const u = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, isActive: true, sessionVersion: true },
    })
    // ponytail: session fixation defense — reject tokens with stale session version.
    // Old cookies (pre-login) have version 0 or a prior version; new logins increment it.
    if (u && u.isActive && u.sessionVersion === extractSessionVersion(token)) {
      touchActivity(userId)
      return { userId: u.id, name: u.name, email: u.email }
    }
  }

  if (!serverConfig.authDemoFallback) {
    throw new UnauthorizedError()
  }

  if (!serverConfig.isTest) {
    console.warn(
      '[session] AUTH_DEMO_FALLBACK is enabled — impersonating the first user. ' +
        'Disable in production by setting AUTH_DEMO_FALLBACK=false.',
    )
  }
  const user = await db.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!user) throw new Error('No active user found. Run the seed script.')
  return { userId: user.id, name: user.name, email: user.email }
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
