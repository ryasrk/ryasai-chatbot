import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enqueueOrSync } from '@/lib/job-processor'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'
import { enterWithOrg } from '@/lib/prisma-tenant'

export const runtime = 'nodejs'

/**
 * POST /api/documents/[id]/reprocess
 * Re-enqueues embedding + cognify for a FAILED document (status='error' or
 * cognifyStatus='failed'). Mirrors how POST /api/documents enqueues after an
 * upload. Ready documents are rejected — there is nothing to repair.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params

    const doc = await db.document.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, status: true, cognifyStatus: true },
    })

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (doc.status !== 'error' && doc.cognifyStatus !== 'failed') {
      return NextResponse.json(
        { error: 'Document is not in a failed state — nothing to reprocess.' },
        { status: 409 },
      )
    }

    // Same enqueue shape as the upload path (documents/route.ts): embed first,
    // cognify fire-and-forget. enqueueOrSync falls back to synchronous
    // processing when Redis is down.
    const mode = await enqueueOrSync('document-embed', {
      type: 'document-embed',
      documentId: doc.id,
      organizationId: user.organizationId,
    })
    void enqueueOrSync('document-cognify', {
      type: 'document-cognify',
      documentId: doc.id,
      organizationId: user.organizationId,
    }).catch(() => null)

    await writeAudit({
      userId: user.userId,
      action: 'DOC_REPROCESS',
      severity: 'info',
      detail: {
        documentId: doc.id,
        name: doc.name,
        beforeStatus: doc.status,
        beforeCognifyStatus: doc.cognifyStatus,
        mode,
      },
    })
    invalidateSourceEmbeddingCache()

    return NextResponse.json({ ok: true, mode })
  } catch (e) {
    return handleApiError(e, 'Failed to reprocess document.')
  }
}
