import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface SendBody {
  text?: string
  integrationId?: string
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const started = Date.now()
  let errorContext:
    | {
        sessionId: string
        companyId: string
        userId: string
        message: string
      }
    | null = null

  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as SendBody

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: 'text wajib diisi.' }, { status: 400 })
    }

    const session = await db.chatSession.findFirst({
      where: { id, companyId: user.companyId, userId: user.userId },
      select: { id: true, title: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Sesi tidak ditemukan.' }, { status: 404 })
    }

    let integrationId: string | undefined
    if (typeof body.integrationId === 'string' && body.integrationId.trim()) {
      const integration = await db.integration.findFirst({
        where: {
          id: body.integrationId,
          companyId: user.companyId,
          status: 'active',
        },
        select: { id: true },
      })
      if (!integration) {
        return NextResponse.json(
          { error: 'Integrasi tidak aktif atau tidak ditemukan.' },
          { status: 400 },
        )
      }
      integrationId = integration.id
    }

    const userMessage = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        userId: user.userId,
        sender: 'user',
        text,
      },
    })
    errorContext = {
      sessionId: session.id,
      companyId: user.companyId,
      userId: user.userId,
      message: text,
    }

    const completion = await runNonStreamingChatCompletion({
      question: text,
      companyId: user.companyId,
      userId: user.userId,
      integrationId,
    })

    const aiMessage = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: 'ai',
        text: completion.answer,
        status: 'complete',
        citations: JSON.stringify(completion.citations),
        chartData: completion.chartData ? JSON.stringify(completion.chartData) : null,
        integrationId: completion.integrationId ?? null,
      },
      include: {
        integration: { select: { id: true, name: true, provider: true } },
      },
    })

    const latencyMs = Date.now() - started
    const toolRuns = await Promise.all(
      completion.toolRuns.map((toolRun) =>
        db.toolRun.create({
          data: {
            companyId: user.companyId,
            chatMessageId: aiMessage.id,
            restApiEndpointId: toolRun.restApiEndpointId,
            type: toolRun.type,
            status: toolRun.status,
            latencyMs: toolRun.latencyMs ?? latencyMs,
            inputSummary: toolRun.inputSummary,
            outputSummary: toolRun.outputSummary ?? null,
            errorMessage: toolRun.errorMessage ?? null,
          },
          select: {
            id: true,
            type: true,
            status: true,
            latencyMs: true,
            restApiEndpointId: true,
          },
        }),
      ),
    )

    const shouldRetitle =
      session.title === 'Sesi Baru' || session.title.trim().length === 0
    await db.chatSession.update({
      where: { id: session.id },
      data: {
        updatedAt: new Date(),
        ...(shouldRetitle ? { title: text.slice(0, 60) } : {}),
      },
    })

    return NextResponse.json({
      ok: true,
      latencyMs,
      userMessage,
      aiMessage: {
        ...aiMessage,
        citations: aiMessage.citations ? safeParse(aiMessage.citations) : null,
        chartData: aiMessage.chartData ? safeParse(aiMessage.chartData) : null,
      },
      toolRuns,
    })
  } catch (e) {
    const status = statusForInternalChatError(e)
    if (status === 503) {
      if (errorContext) {
        await persistAssistantError(errorContext).catch(() => {
          /* best effort only */
        })
      }
      return NextResponse.json(
        {
          ok: false,
          error:
            'AI provider belum dikonfigurasi. Buka Settings > AI Configuration dan isi endpoint model API sebelum memakai Chat.',
        },
        { status },
      )
    }
    if (status === 404) {
      return NextResponse.json({ error: 'Sesi tidak ditemukan.' }, { status })
    }
    return handleApiError(e, 'Gagal mengirim pesan chat.', status)
  }
}

export function statusForInternalChatError(error: unknown): number {
  if (isPrismaMissingSessionRace(error)) return 404

  const message = error instanceof Error ? error.message : String(error)
  if (
    message.includes('Configuration file not found') ||
    message.includes('LLM error') ||
    message.includes('LLM stream error')
  ) {
    return 503
  }
  return 500
}

function isPrismaMissingSessionRace(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'P2003' || code === 'P2025'
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function persistAssistantError(args: {
  sessionId: string
  userId: string
  companyId: string
  message: string
}) {
  const text =
    'AI provider belum dikonfigurasi. Isi Settings > AI Configuration dengan endpoint model API sebelum melanjutkan chat.'
  const aiMessage = await db.chatMessage.create({
    data: {
      sessionId: args.sessionId,
      userId: args.userId,
      sender: 'ai',
      text,
      status: 'error',
    },
  })
  await db.chatSession.update({
    where: { id: args.sessionId },
    data: { updatedAt: new Date() },
  })
  await db.toolRun.create({
    data: {
      companyId: args.companyId,
      chatMessageId: aiMessage.id,
      type: 'CHAT',
      status: 'error',
      latencyMs: null,
      inputSummary: args.message.slice(0, 240),
      errorMessage: 'LLM provider is not configured.',
    },
  })
}
