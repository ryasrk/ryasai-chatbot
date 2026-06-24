import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit } from '@/lib/session'

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
    const user = await getActiveUser()
    const { id } = await ctx.params

    const doc = await db.document.findFirst({
      where: { id, companyId: user.companyId },
      select: {
        id: true,
        name: true,
        type: true,
        sizeBytes: true,
        mimeType: true,
        status: true,
        category: true,
        description: true,
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
    console.error('[GET /api/documents/[id]]', e)
    return NextResponse.json(
      { error: 'Failed to fetch document', detail: String(e) },
      { status: 500 },
    )
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
      where: { id, companyId: user.companyId },
      select: { id: true, name: true, type: true, category: true, _count: { select: { chunks: true } } },
    })

    if (!existing) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    // DocumentChunk has onDelete: Cascade on its document relation,
    // so deleting the document automatically removes the chunks.
    await db.document.delete({ where: { id: existing.id } })

    await writeAudit({
      companyId: user.companyId,
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
    console.error('[DELETE /api/documents/[id]]', e)
    return NextResponse.json(
      { error: 'Failed to delete document', detail: String(e) },
      { status: 500 },
    )
  }
}
