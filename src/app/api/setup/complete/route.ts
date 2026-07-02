import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'

/**
 * POST /api/setup/complete (auth required)
 *   Sets AppConfig.setupCompleted = true and writes a SETUP_COMPLETED audit.
 *   Returns 200 { ok: true }.
 */
export async function POST() {
  try {
    const user = await getActiveUser()
    await db.appConfig.upsert({
      where: { companyId: user.companyId },
      create: { companyId: user.companyId, setupCompleted: true },
      update: { setupCompleted: true },
    })
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'SETUP_COMPLETED',
      detail: {},
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleApiError(e, 'Gagal menyelesaikan setup.')
  }
}
