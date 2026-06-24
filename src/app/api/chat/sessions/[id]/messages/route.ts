import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

/**
 * POST /api/chat/sessions/[id]/messages
 *   Body: { sender: 'user'|'ai'|'system', text, status?, citations?, chartData?, integrationId? }
 *
 * Persists a message to an existing chat session. citations / chartData are
 * stored as JSON strings (per schema). Used by:
 *   - frontend (to persist the user's message before streaming begins)
 *   - WebSocket service (to persist the AI's streamed message after completion)
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const session = await db.chatSession.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true },
    })
    if (!session) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      )
    }

    const body = await req.json().catch(() => ({}))
    const sender = String(body?.sender ?? 'user')
    if (!['user', 'ai', 'system'].includes(sender)) {
      return NextResponse.json(
        { error: "sender harus 'user' | 'ai' | 'system'." },
        { status: 400 }
      )
    }

    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.length === 0 && sender !== 'system') {
      return NextResponse.json(
        { error: 'text wajib diisi.' },
        { status: 400 }
      )
    }

    const status =
      typeof body?.status === 'string' && body.status.length > 0
        ? body.status.slice(0, 64)
        : null

    const citations =
      body?.citations === undefined || body?.citations === null
        ? null
        : JSON.stringify(body.citations)

    const chartData =
      body?.chartData === undefined || body?.chartData === null
        ? null
        : JSON.stringify(body.chartData)

    const integrationId =
      typeof body?.integrationId === 'string' && body.integrationId.length > 0
        ? body.integrationId
        : null

    const message = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        userId: sender === 'user' ? user.userId : null,
        sender,
        text,
        status,
        citations,
        chartData,
        integrationId,
      },
    })

    // touch session.updatedAt so the list view reflects recent activity
    await db.chatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    })

    return NextResponse.json(message, { status: 201 })
  } catch (err) {
    console.error('[api/chat/sessions/[id]/messages POST] error:', err)
    return NextResponse.json(
      { error: 'Gagal menyimpan pesan.' },
      { status: 500 }
    )
  }
}
