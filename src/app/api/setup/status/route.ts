import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSetupState } from '@/lib/setup'
import { handleApiError } from '@/lib/session'

/**
 * GET /api/setup/status (public — no auth required)
 *   Returns { ok, setupCompleted, hasAdmin } so the shell can decide whether to
 *   render the setup wizard.
 */
export async function GET() {
  try {
    const state = await getSetupState(db)
    return NextResponse.json({ ok: true, ...state })
  } catch (e) {
    return handleApiError(e, 'Gagal membaca status setup.')
  }
}
