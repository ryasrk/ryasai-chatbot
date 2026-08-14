import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { getRecentTraces } from '@/lib/observability'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(req: NextRequest) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? '50'), 1), 100)
    return NextResponse.json({ ok: true, traces: getRecentTraces(limit) })
  } catch (e) {
    return handleApiError(e, 'Failed to load traces.')
  }
}
