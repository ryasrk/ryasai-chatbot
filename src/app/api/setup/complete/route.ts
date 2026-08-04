import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'

/**
 * POST /api/setup/complete (auth required)
 *   Sets AppConfig.setupCompleted = true, seeds prebuilt plugins for the org,
 *   and writes a SETUP_COMPLETED audit. Returns 200 { ok: true }.
 */
export async function POST() {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')
    const existing = await db.appConfig.findFirst()
    if (existing) {
      await db.appConfig.update({ where: { id: existing.id }, data: { setupCompleted: true } })
    } else {
      await db.appConfig.create({ data: { organizationId: user.organizationId, setupCompleted: true } })
    }

    // Seed prebuilt plugins for this org if it has none yet. Scoped count —
    // a previous global pluginCount check skipped seeding for new orgs when
    // any other org already had plugins.
    const orgPluginCount = await db.plugin.count({ where: { organizationId: user.organizationId } })
    if (orgPluginCount === 0) {
      const { seedPlugins } = await import('@/lib/plugin-seeds')
      await seedPlugins(user.organizationId)
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
