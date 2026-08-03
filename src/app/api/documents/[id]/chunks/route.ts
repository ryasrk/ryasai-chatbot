import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

export const runtime = 'nodejs'

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

/**
 * GET /api/documents/[id]/chunks?page=1&pageSize=20
 * Returns all chunks for a document (paginated), ordered by chunkIndex.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const { searchParams } = new URL(req.url)

    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const requestedSize = parseInt(
      searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE),
      10,
    ) || DEFAULT_PAGE_SIZE
    const pageSize = Math.min(Math.max(1, requestedSize), MAX_PAGE_SIZE)

    // Make sure the document belongs to the active company before paginating.
    const doc = await db.document.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, _count: { select: { chunks: true } } },
    })
    if (!doc) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 },
      )
    }

    const [chunks, total] = await Promise.all([
      db.documentChunk.findMany({ // nosemgrep
        where: { documentId: id },
        orderBy: { chunkIndex: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          chunkIndex: true,
          content: true,
          tokenCount: true,
          keywords: true,
          createdAt: true,
        },
      }),
      db.documentChunk.count({ where: { documentId: id } }),
    ])

    return NextResponse.json({
      documentId: id,
      documentName: doc.name,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      chunks,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load document chunks.')
  }
}
