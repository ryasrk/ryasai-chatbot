import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { forgetKnowledgeGraph, cognifyDocument } from '@/lib/cognee'
import { invalidateRagCache } from '@/lib/rag'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'

export const runtime = 'nodejs'

/**
 * GET /api/documents/[id]
 * Returns document detail + first 3 chunk previews + total chunk count.
 * (Full chunk list is paginated via the [id]/chunks endpoint.)
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await getActiveUser()
    const { id } = await ctx.params

    const doc = await db.document.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        sizeBytes: true,
        mimeType: true,
        status: true,
        isEnabled: true,
        category: true,
        description: true,
        cognifyStatus: true,
        cognifyError: true,
        cognifiedAt: true,
        contentText: true,
        createdAt: true,
        updatedAt: true,
        chunks: {
          orderBy: { chunkIndex: 'asc' },
          take: 3,
          select: {
            id: true,
            chunkIndex: true,
            content: true,
            tokenCount: true,
            keywords: true,
          },
        },
        _count: { select: { chunks: true } },
      },
    })

    if (!doc) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    return NextResponse.json({
      document: {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        sizeBytes: doc.sizeBytes,
        mimeType: doc.mimeType,
        status: doc.status,
        isEnabled: doc.isEnabled,
        category: doc.category,
        description: doc.description,
        contentText: doc.contentText,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        chunkCount: doc._count.chunks,
        chunkPreview: doc.chunks,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load document details.')
  }
}

interface PatchBody {
  isEnabled?: boolean
}

/**
 * PATCH /api/documents/[id]
 * Toggles document enabled state. Disabled documents are excluded from RAG
 * retrieval (see tool-router.ts) but remain stored and can be re-enabled.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as PatchBody

    const existing = await db.document.findFirst({
      where: { id },
      select: { id: true, name: true, isEnabled: true },
    })

    if (!existing) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    if (typeof body.isEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Field isEnabled (boolean) is required.' },
        { status: 400 },
      )
    }

    const updated = await db.document.update({
      where: { id: existing.id },
      data: { isEnabled: body.isEnabled },
      select: { id: true, isEnabled: true, updatedAt: true },
    })
    invalidateSourceEmbeddingCache()

    // ponytail: cognifyDocument checks isCogneeEnabled internally — no-op if disabled.
    // forgetKnowledgeGraph is global (no per-doc forget in cognee API), so we only
    // re-cognify on enable; stale data on disable is a known limitation.
    if (!existing.isEnabled && body.isEnabled) {
      const chunks = await db.documentChunk.findMany({
        where: { documentId: existing.id },
        select: { content: true, chunkIndex: true },
        orderBy: { chunkIndex: 'asc' },
      })
      void cognifyDocument({
        documentId: existing.id,
        documentName: existing.name,
        chunks: chunks.map((c) => ({ content: c.content, chunkIndex: c.chunkIndex })),
      }).catch(() => null)
    }

    await writeAudit({
      userId: user.userId,
      action: 'DOC_UPDATE',
      severity: 'info',
      detail: {
        documentId: existing.id,
        name: existing.name,
        before: { isEnabled: existing.isEnabled },
        after: { isEnabled: body.isEnabled },
      },
    })

    return NextResponse.json({ ok: true, data: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update document.')
  }
}

/**
 * DELETE /api/documents/[id]
 * Removes a document and (via cascade) all its chunks.
 * Writes a DOC_DELETE audit log.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const existing = await db.document.findFirst({
      where: { id },
      select: { id: true, name: true, type: true, category: true, _count: { select: { chunks: true } } },
    })

    if (!existing) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    await db.document.delete({ where: { id: existing.id } })
    await invalidateRagCache()
    invalidateSourceEmbeddingCache()

    void forgetKnowledgeGraph()

    await writeAudit({
      userId: user.userId,
      action: 'DOC_DELETE',
      severity: 'warning',
      detail: {
        documentId: existing.id,
        name: existing.name,
        type: existing.type,
        category: existing.category,
        chunkCount: existing._count.chunks,
      },
    })

    return NextResponse.json({
      ok: true,
      deletedId: existing.id,
      chunkCountRemoved: existing._count.chunks,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to delete document.')
  }
}
