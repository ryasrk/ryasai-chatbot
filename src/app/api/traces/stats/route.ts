import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { getTraceStats } from '@/lib/observability'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    return NextResponse.json({ ok: true, stats: getTraceStats() })
  } catch (e) {
    return handleApiError(e, 'Failed to load trace stats.')
  }
}
