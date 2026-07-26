import { NextRequest, NextResponse } from 'next/server'
import { embedCompanyDocuments } from '@/lib/embeddings'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { jobQueue, checkRedisHealth } from '@/lib/redis'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as { documentId?: string }
    const documentId =
      typeof body.documentId === 'string' && body.documentId.trim()
        ? body.documentId.trim()
        : undefined

    // ponytail: enqueue to Redis when available, run synchronously when Redis is down.
    const health = await checkRedisHealth()
    if (health.connected) {
      await jobQueue.add('embedding-rebuild', { type: 'embedding-rebuild', documentId })
      await writeAudit({
        userId: user.userId,
        action: 'RAG_EMBEDDINGS_REBUILD',
        severity: 'info',
        detail: { documentId: documentId ?? null, queued: true },
      })
      return NextResponse.json({
        ok: true,
        message: 'Embedding rebuild queued',
        data: { embedded: 0, skipped: 0, documents: 0, provider: null, model: null },
      })
    }

    // sync fallback — Redis down
    const result = await embedCompanyDocuments({ documentId })
    await writeAudit({
      userId: user.userId,
      action: 'RAG_EMBEDDINGS_REBUILD',
      severity: 'info',
      detail: { documentId: documentId ?? null, ...result },
    })
    return NextResponse.json({ ok: true, message: 'Embedding rebuild completed', data: result })
  } catch (e) {
    return handleApiError(e, 'Gagal rebuild embeddings.', 502)
  }
}
