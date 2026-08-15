import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { getSetupState } from '@/lib/setup'
import { handleApiError } from '@/lib/session'
import { bypassOrg } from '@/lib/prisma-tenant'
import { verifySession, extractSessionVersion } from '@/lib/crypto'

/**
 * GET /api/setup/status (public — no auth required)
 *   Returns { ok, setupCompleted, hasAdmin } so the shell can decide whether to
 *   render the setup wizard.
 *
 *   setupCompleted is scoped to the caller's own organization when a valid
 *   session cookie is present (see getSetupState) — session verification is
 *   inlined here rather than via getActiveUser() because that throws on a
 *   missing/expired session or a license lockdown, and this route must never
 *   fail just because the caller isn't logged in yet.
 */
export async function GET() {
  try {
    const store = await cookies()
    const token = store.get('x-active-user')?.value
    const userId = verifySession(token)
    let organizationId: string | undefined
    if (userId) {
      const u = await bypassOrg(() =>
        db.user.findUnique({
          where: { id: userId },
          select: { organizationId: true, isActive: true, sessionVersion: true },
        }),
      )
      if (u && u.isActive && u.sessionVersion === extractSessionVersion(token)) {
        organizationId = u.organizationId
      }
    }
    const state = await bypassOrg(() => getSetupState(db, organizationId))
    return NextResponse.json({ ok: true, ...state })
  } catch (e) {
    return handleApiError(e, 'Failed to read setup status.')
  }
}
