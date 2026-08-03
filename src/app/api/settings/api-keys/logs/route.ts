import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/settings/api-keys/logs
 *   Returns all recent request logs for the tenant (across all API keys).
 */
export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const logs = await db.apiRequestLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        endpoint: true,
        status: true,
        latencyMs: true,
        errorMessage: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ ok: true, items: logs })
  } catch (e) {
    return handleApiError(e, 'Failed to load request logs.')
  }
}
