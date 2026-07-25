import { NextResponse } from 'next/server'
import { rebuildFts } from '@/lib/rag-fts'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST() {
  try {
    const user = await getActiveUser()
    const result = await rebuildFts()
    await writeAudit({
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
