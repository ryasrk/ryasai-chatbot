import { db } from '@/lib/db'
import { serverConfig } from '@/lib/config'
import { verifySession } from '@/lib/crypto'
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

export function handleApiError(e: unknown, fallback: string, status = 500) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: e.message }, { status: 401 })
  }
  console.error('[api]', e)
  return NextResponse.json({ error: fallback }, { status })
}

export async function getActiveUser(): Promise<ActiveUser> {
  const store = await cookies()
  const userId = verifySession(store.get('x-active-user')?.value)
  if (userId) {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, isActive: true },
    })
    if (u && u.isActive) {
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
