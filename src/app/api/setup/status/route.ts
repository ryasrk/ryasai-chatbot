import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSetupState } from '@/lib/setup'
import { handleApiError } from '@/lib/session'
import { bypassOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/setup/status (public — no auth required)
 *   Returns { ok, setupCompleted, hasAdmin } so the shell can decide whether to
 *   render the setup wizard.
 */
export async function GET() {
  try {
    const state = await bypassOrg(() => getSetupState(db))
    return NextResponse.json({ ok: true, ...state })
  } catch (e) {
    return handleApiError(e, 'Failed to read setup status.')
  }
}
