import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

/**
 * GET /api/chat/sessions/[id]
 *   Returns a single session with its messages (sorted asc by createdAt).
 *   Citations + chartData JSON strings are parsed into objects.
 *
 * DELETE /api/chat/sessions/[id]
 *   Deletes the session (messages cascade).
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const session = await db.chatSession.findFirst({
      where: { id, companyId: user.companyId, userId: user.userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            integration: { select: { id: true, name: true, provider: true } },
          },
        },
      },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      )
    }

    // parse JSON fields on each message for the frontend
    const messages = session.messages.map((m) => ({
      ...m,
      citations: m.citations ? safeParse(m.citations) : null,
      chartData: m.chartData ? safeParse(m.chartData) : null,
    }))

    return NextResponse.json({ ...session, messages })
  } catch (err) {
    return handleApiError(err, 'Gagal memuat detail sesi chat.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const session = await db.chatSession.findFirst({
      where: { id, companyId: user.companyId, userId: user.userId },
      select: { id: true, userId: true, title: true },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Sesi tidak ditemukan.' },
        { status: 404 }
      )
    }

    await db.chatSession.delete({ where: { id: session.id } })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'CHAT_SESSION_DELETE',
      severity: 'warning',
      detail: { sessionId: session.id, title: session.title, ownerUserId: session.userId },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return handleApiError(err, 'Gagal menghapus sesi chat.')
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
