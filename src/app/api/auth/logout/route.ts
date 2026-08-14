import { NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/auth/logout
 *   Always returns 200 { ok: true } and clears the `x-active-user` cookie,
 *   even if there was no active session (idempotent). Writes a LOGOUT audit
 *   entry when a session was present.
 */
export async function POST() {
  try {
    try {
      const user = await getActiveUser()
    enterWithOrg(user.organizationId)
          await writeAudit({
        userId: user.userId,
        action: 'LOGOUT',
        detail: { email: user.email },
      })
    } catch {
      // No active session — still clear the cookie below.
    }
    const res = NextResponse.json({ ok: true })
    res.cookies.set('x-active-user', '', { httpOnly: true, maxAge: 0, path: '/' })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to log out.')
  }
}
