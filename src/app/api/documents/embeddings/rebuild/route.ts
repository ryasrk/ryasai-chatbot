import { NextRequest, NextResponse } from 'next/server'
import { embedCompanyDocuments } from '@/lib/embeddings'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as { documentId?: string }
    const documentId =
      typeof body.documentId === 'string' && body.documentId.trim()
        ? body.documentId.trim()
        : undefined

    const result = await embedCompanyDocuments({
      documentId,
    })

    await writeAudit({
      userId: user.userId,
      action: 'RAG_EMBEDDINGS_REBUILD',
      severity: 'info',
      detail: { documentId: documentId ?? null, ...result },
    })

    return NextResponse.json({ ok: true, data: result })
  } catch (e) {
    return handleApiError(e, 'Gagal rebuild embeddings.', 502)
  }
}
