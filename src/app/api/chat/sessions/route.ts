import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit } from '@/lib/session'

/**
 * GET /api/chat/sessions
 *   List chat sessions for the active user (most recent first, take 50).
 *   Includes `_count.messages` so the UI can show message counts.
 *
 * POST /api/chat/sessions
 *   Body: { title?: string }  (default "Sesi Baru")
 *   Creates a new chat session for the active user.
 */
export async function GET() {
  try {
    const user = await getActiveUser()

    const sessions = await db.chatSession.findMany({
      where: { userId: user.userId, companyId: user.companyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        _count: { select: { messages: true } },
      },
    })

    return NextResponse.json({ items: sessions })
  } catch (err) {
    console.error('[api/chat/sessions GET] error:', err)
    return NextResponse.json(
      { error: 'Gagal memuat daftar sesi chat.' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = await req.json().catch(() => ({}))
    const title: string =
      typeof body?.title === 'string' && body.title.trim().length > 0
        ? body.title.trim().slice(0, 200)
        : 'Sesi Baru'

    const session = await db.chatSession.create({
      data: {
        companyId: user.companyId,
        userId: user.userId,
        title,
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'CHAT_SESSION_CREATE',
      severity: 'info',
      detail: { sessionId: session.id, title: session.title },
    })

    return NextResponse.json(session, { status: 201 })
  } catch (err) {
    console.error('[api/chat/sessions POST] error:', err)
    return NextResponse.json(
      { error: 'Gagal membuat sesi chat baru.' },
      { status: 500 }
    )
  }
}
