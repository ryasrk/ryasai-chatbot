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
      where: { id, userId: user.userId },
      include: {
        messages: {
          where: { sender: { in: ['user', 'ai'] } },
          orderBy: { createdAt: 'asc' as const },
          include: {
            integration: { select: { id: true, name: true, provider: true } },
            toolRuns: { select: { type: true, status: true, outputSummary: true } },
          },
        },
      },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found.' },
        { status: 404 }
      )
    }

    // parse JSON fields + derive toolType/toolHasResults from toolRuns
    const messages = session.messages.map((m) => {
      const toolRun = m.toolRuns?.[0]
      const toolType = toolRun?.type && toolRun.type !== 'CHAT' ? toolRun.type : null
      const toolHasResults =
        !!toolRun &&
        toolRun.status === 'success' &&
        !!toolRun.outputSummary &&
        toolRun.outputSummary.length > 0
      return {
        ...m,
        citations: m.citations ? safeParse(m.citations) : null,
        chartData: m.chartData ? safeParse(m.chartData) : null,
        toolType,
        toolHasResults,
      }
    })

    return NextResponse.json({ ...session, messages })
  } catch (err) {
    return handleApiError(err, 'Failed to load chat session details.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const session = await db.chatSession.findFirst({
      where: { id, userId: user.userId },
      select: { id: true, userId: true, title: true },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found.' },
        { status: 404 }
      )
    }

    await db.chatSession.delete({ where: { id: session.id } })

    await writeAudit({
      userId: user.userId,
      action: 'CHAT_SESSION_DELETE',
      severity: 'warning',
      detail: { sessionId: session.id, title: session.title, ownerUserId: session.userId },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return handleApiError(err, 'Failed to delete chat session.')
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
