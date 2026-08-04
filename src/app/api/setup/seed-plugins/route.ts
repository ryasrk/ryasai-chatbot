import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg, bypassOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/setup/seed-plugins (admin only)
 *   Manually seed prebuilt plugins for the current org. Use when plugins are
 *   missing/empty and the auto-heal on startup didn't run or failed.
 */
export async function POST() {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')
    enterWithOrg(user.organizationId)

    const { seedPlugins } = await import('@/lib/plugin-seeds')
    const before = await bypassOrg(() => db.plugin.count({ where: { organizationId: user.organizationId } }))
    await bypassOrg(() => seedPlugins(user.organizationId))
    const after = await bypassOrg(() => db.plugin.count({ where: { organizationId: user.organizationId } }))

    await writeAudit({
      userId: user.userId,
      action: 'PLUGINS_SEEDED',
      severity: 'warning',
      detail: { before, after, via: 'manual-api' },
    })

    return NextResponse.json({ ok: true, before, after })
  } catch (e) {
    return handleApiError(e, 'Failed to seed plugins.')
  }
}
