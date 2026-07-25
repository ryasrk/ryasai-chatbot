import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/settings/api-keys/logs
 *   Returns all recent request logs for the tenant (across all API keys).
 */
export async function GET() {
  try {
    await getActiveUser()

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
    return handleApiError(e, 'Gagal memuat request logs.')
  }
}
