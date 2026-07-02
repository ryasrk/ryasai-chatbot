import { NextResponse } from 'next/server'
import { rebuildCompanyFts } from '@/lib/rag-fts'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST() {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const result = await rebuildCompanyFts(user.companyId)
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'RAG_FTS_REBUILD',
      severity: 'info',
      detail: result,
    })
    return NextResponse.json({ ok: true, data: result })
  } catch (e) {
    return handleApiError(e, 'Gagal rebuild FTS.', 500)
  }
}
