import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { getTraceStats } from '@/lib/observability'

export async function GET() {
  try {
    await getActiveUser()
    return NextResponse.json({ ok: true, stats: getTraceStats() })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat trace stats.')
  }
}
