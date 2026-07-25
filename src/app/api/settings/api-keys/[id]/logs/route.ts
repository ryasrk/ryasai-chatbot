import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/settings/api-keys/[id]/logs
 *   Returns recent request logs for a specific API key.
 */
interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    await getActiveUser()
    const { id } = await ctx.params

    // Verify the key exists
    const key = await db.apiKey.findFirst({
      where: { id },
      select: { id: true },
    })
    if (!key) {
      return NextResponse.json(
        { ok: false, error: 'API key tidak ditemukan.' },
        { status: 404 },
      )
    }

    const logs = await db.apiRequestLog.findMany({
      where: { apiKeyId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
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
