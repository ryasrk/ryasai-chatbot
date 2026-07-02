import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

/**
 * POST /api/chat/sessions/[id]/messages
 *   Body: { sender: 'user', text, status?, citations?, chartData?, integrationId? }
 *
 * Persists a USER message to an existing chat session (frontend use, before
 * streaming begins). AI/system messages are written directly to the DB by the
 * WebSocket service — this endpoint does NOT accept sender:'ai'|'system', which
 * prevents any caller from spoofing AI/system messages into a session.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const session = await db.chatSession.findFirst({
      where: { id, companyId: user.companyId, userId: user.userId },
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
    // Only 'user' messages are accepted here (see header comment).
    if (sender !== 'user') {
      return NextResponse.json(
        { error: "Endpoint ini hanya menerima sender 'user'." },
        { status: 400 }
      )
    }

    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.length === 0) {
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

    // Validate integrationId belongs to this company before attaching.
    let integrationId: string | null = null
    if (typeof body?.integrationId === 'string' && body.integrationId.length > 0) {
      const owned = await db.integration.findFirst({
        where: { id: body.integrationId, companyId: user.companyId },
        select: { id: true },
      })
      if (!owned) {
        return NextResponse.json(
          { error: 'Integrasi tidak valid untuk perusahaan ini.' },
          { status: 400 }
        )
      }
      integrationId = owned.id
    }

    const message = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        userId: user.userId,
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
    return handleApiError(err, 'Gagal menyimpan pesan.')
  }
}
