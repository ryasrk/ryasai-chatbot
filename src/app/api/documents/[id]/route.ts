import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { forgetKnowledgeGraph, cognifyDocument } from '@/lib/cognee'
import { invalidateRagCache } from '@/lib/rag'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'
import { enterWithOrg } from '@/lib/prisma-tenant'

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
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params

    const doc = await db.document.findFirst({ // nosemgrep
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
        contextPrompt: true,
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
        contextPrompt: doc.contextPrompt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        chunkCount: doc._count.chunks,
        chunkPreview: doc.chunks,
        // These two were SELECTED but never mapped into the response, so they were silently
        // dropped on the way out: the detail dialog had no way to show why a document produced no
        // searchable content. Both are in the select list above and in Prisma, and the list route
        // returns them — only this mapping was missing.
        cognifyStatus: doc.cognifyStatus,
        cognifyError: doc.cognifyError,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load document details.')
  }
}

interface PatchBody {
  isEnabled?: boolean
  contextPrompt?: string
}

const DOC_PROMPT_MAX = 4000

/**
 * PATCH /api/documents/[id]
 * Toggles document enabled state (admin) and/or sets the admin-editable
 * `contextPrompt` (≤4000 chars, trimmed) injected into RAG answer synthesis
 * when chunks from this document contribute to an answer (buildSourceGuidance
 * in source-guidance.ts). Disabled documents are excluded from RAG retrieval
 * (see tool-router.ts) but remain stored and can be re-enabled.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as PatchBody

    const existing = await db.document.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, isEnabled: true, contextPrompt: true },
    })

    if (!existing) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    const data: { isEnabled?: boolean; contextPrompt?: string } = {}
    if (typeof body.isEnabled === 'boolean') {
      data.isEnabled = body.isEnabled
    }
    if (typeof body.contextPrompt === 'string') {
      const trimmed = body.contextPrompt.trim()
      if (trimmed.length > DOC_PROMPT_MAX) {
        return NextResponse.json(
          { error: `contextPrompt must be at most ${DOC_PROMPT_MAX} characters.` },
          { status: 400 },
        )
      }
      data.contextPrompt = trimmed
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'Field isEnabled (boolean) or contextPrompt (string) is required.' },
        { status: 400 },
      )
    }

    const updated = await db.document.update({
      where: { id: existing.id },
      data,
      select: { id: true, isEnabled: true, contextPrompt: true, updatedAt: true },
    })
    // Retrieval filters on isEnabled, but cached results were computed before the
    // toggle — without this a disabled document keeps answering for the cache TTL.
    await invalidateRagCache()
    invalidateSourceEmbeddingCache()

    // ponytail: cognifyDocument checks isCogneeEnabled internally — no-op if disabled.
    // forgetKnowledgeGraph is global (no per-doc forget in cognee API), so we only
    // re-cognify on enable; stale data on disable is a known limitation.
    if (!existing.isEnabled && body.isEnabled) {
      const chunks = await db.documentChunk.findMany({ // nosemgrep
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
        before: { isEnabled: existing.isEnabled, contextPrompt: existing.contextPrompt },
        after: data,
        contextPromptLength:
          typeof data.contextPrompt === 'string' ? data.contextPrompt.length : undefined,
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
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params

    const existing = await db.document.findFirst({ // nosemgrep
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
