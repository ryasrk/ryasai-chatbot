import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    await getActiveUser()
    const searchParams = req.nextUrl.searchParams
    const sessionId = searchParams.get('sessionId')

    if (sessionId) {
      const messages = await db.chatMessage.findMany({
        where: { sessionId, sender: { in: ['user', 'agent'] } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          sender: true,
          text: true,
          status: true,
          citations: true,
          chartData: true,
          createdAt: true,
        },
      })
      return NextResponse.json({ ok: true, messages })
    }

    const sessions = await db.chatSession.findMany({
      where: { title: { startsWith: '[Agent]' } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: { where: { sender: { in: ['user', 'agent'] } } } } },
      },
    })
    return NextResponse.json({ ok: true, sessions })
  } catch (e) {
    return handleApiError(e, 'Failed to load agentic sessions.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as { title?: string }
    const title = body.title?.trim() || `[Agent] ${new Date().toLocaleString('id-ID')}`

    const session = await db.chatSession.create({
      data: {
        title,
        userId: user.userId,
      },
    })
    return NextResponse.json({ ok: true, session })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat sesi agentic.')
  }
}
