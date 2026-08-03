import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/chat/sessions
 *   List chat sessions for the active user (most recent first, take 50).
 *   Includes `_count.messages` so the UI can show message counts.
 *
 * POST /api/chat/sessions
 *   Body: { title?: string }  (default "New Session")
 *   Creates a new chat session for the active user.
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const sessions = await db.chatSession.findMany({
      where: {
        userId: user.userId,
        title: { not: { startsWith: '[Agent]' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        _count: { select: { messages: true } },
      },
    })

    return NextResponse.json({ items: sessions })
  } catch (err) {
    return handleApiError(err, 'Failed to load chat sessions.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const body = await req.json().catch(() => ({}))
    const title: string =
      typeof body?.title === 'string' && body.title.trim().length > 0
        ? body.title.trim().slice(0, 200)
        : 'New Session'

    const session = await db.chatSession.create({
      data: {
        organizationId: user.organizationId,
        userId: user.userId,
        title,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'CHAT_SESSION_CREATE',
      severity: 'info',
      detail: { sessionId: session.id, title: session.title },
    })

    return NextResponse.json(session, { status: 201 })
  } catch (err) {
    return handleApiError(err, 'Failed to create new chat session.')
  }
}
