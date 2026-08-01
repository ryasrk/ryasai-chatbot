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
    const existing = await db.appConfig.findFirst()
    if (existing) {
      await db.appConfig.update({ where: { id: existing.id }, data: { setupCompleted: true } })
    } else {
      await db.appConfig.create({ data: { organizationId: user.organizationId, setupCompleted: true } })
    }
    await writeAudit({
      userId: user.userId,
      action: 'SETUP_COMPLETED',
      detail: {},
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleApiError(e, 'Failed to complete setup.')
  }
}
