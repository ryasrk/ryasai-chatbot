import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { runStreamingChatCompletion, type ChatHistoryEntry } from '@/lib/tool-router'

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface SendBody {
  text?: string
  integrationId?: string
  timezone?: string
}

const TOOL_LABELS: Record<string, string> = {
  SQL: 'Running SQL query...',
  RAG: 'Searching relevant documents...',
  REST_API: 'Calling REST API...',
  CHAT: 'Composing answer...',
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    // --- Pre-stream: auth, validate, persist user message, load history ---
    // Errors here return proper HTTP status codes (client hasn't opened SSE yet).
    const user = await getActiveUser()
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as SendBody

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: 'text is required.' }, { status: 400 })
    }

    const session = await db.chatSession.findFirst({
      where: { id, userId: user.userId },
      select: { id: true, title: true, createdAt: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
    }

    let integrationId: string | undefined
    if (typeof body.integrationId === 'string' && body.integrationId.trim()) {
      const integration = await db.integration.findFirst({
        where: {
          id: body.integrationId,
          status: 'active',
        },
        select: { id: true },
      })
      if (!integration) {
        return NextResponse.json(
          { error: 'Integration is not active or not found.' },
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

    const recentMessages = await db.chatMessage.findMany({
      where: { sessionId: session.id, sender: { in: ['user', 'ai'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sender: true, text: true, createdAt: true },
    })
    const tz = body.timezone || 'UTC'
    const chatHistory: ChatHistoryEntry[] = recentMessages
      .reverse()
      .filter((m) => m.text && m.text.trim())
      .map((m) => {
        const ts = m.createdAt.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        return {
          role: m.sender === 'user' ? 'user' as const : 'assistant' as const,
          content: `[${ts} ${tz}] ${m.text}`,
        }
      })

    const shouldRetitle =
      session.title === 'New Session' || session.title.trim().length === 0
    const started = Date.now()

    // --- SSE stream ---
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }

        try {
          // 1. Send persisted user message so the client can swap its placeholder.
          send('user_message', {
            id: userMessage.id,
            sessionId: session.id,
            sender: 'user',
            text,
            createdAt: userMessage.createdAt.toISOString(),
          })

          // 2. Thinking indicator.
          send('thinking', { content: 'Analyzing question...' })

          // 3. Run the streaming tool-router pipeline.
          //    Inject session start time + current time in the user's timezone
          //    so the LLM can resolve temporal references ("when did this start?").
          //    DB stores the original text unchanged.
          const tz = body.timezone || 'UTC'
          const fmtOpts: Intl.DateTimeFormatOptions = { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
          const sessionStart = session.createdAt.toLocaleString('en-US', fmtOpts)
          const currentTime = new Date().toLocaleString('en-US', fmtOpts)
          const contextualizedText = `[Session started: ${sessionStart} ${tz}]\n[Current time: ${currentTime} ${tz}]\n\n${text}`
          const streaming = await runStreamingChatCompletion({
            question: contextualizedText,
            userId: user.userId,
            integrationId,
            sessionId: session.id,
            chatHistory,
          })

          // 4. Emit tool execution events (skip for pure CHAT — no tool to show).
          const toolRun = streaming.toolRuns[0]
          if (toolRun && toolRun.type !== 'CHAT') {
            send('tool_start', {
              tool: toolRun.type,
              label: TOOL_LABELS[toolRun.type] ?? `Running ${toolRun.type}...`,
            })
            send('tool_end', {
              tool: toolRun.type,
              status: toolRun.status,
              latencyMs: toolRun.latencyMs ?? 0,
            })
          }

          // 5. Stream tokens.
          let fullAnswer = ''
          for await (const token of streaming.stream) {
            fullAnswer += token
            send('token', { content: token })
          }

          // 6. Persist AI message + ToolRuns + update session.
          const aiMessage = await db.chatMessage.create({
            data: {
              sessionId: session.id,
              sender: 'ai',
              text: fullAnswer,
              status: 'complete',
              citations: JSON.stringify(streaming.citations),
              chartData: streaming.chartData ? JSON.stringify(streaming.chartData) : null,
              integrationId: streaming.integrationId ?? null,
            },
            include: {
              integration: { select: { id: true, name: true, provider: true } },
            },
          })

          // persist tool runs
          await Promise.all(
            streaming.toolRuns.map((toolRun) =>
              db.toolRun.create({
                data: {
                  chatMessageId: aiMessage.id,
                  restApiEndpointId: toolRun.restApiEndpointId,
                  type: toolRun.type,
                  status: toolRun.status,
                  latencyMs: toolRun.latencyMs ?? (Date.now() - started),
                  inputSummary: toolRun.inputSummary,
                  outputSummary: toolRun.outputSummary ?? null,
                  errorMessage: toolRun.errorMessage ?? null,
                },
              }),
            ),
          )

          // update session
          await db.chatSession.update({
            where: { id: session.id },
            data: {
              updatedAt: new Date(),
              ...(shouldRetitle ? { title: text.slice(0, 60) } : {}),
            },
          })

          // 7. Answer event with full content + metadata (so client can finalize).
          send('answer', {
            content: fullAnswer,
            citations: streaming.citations,
            chartData: streaming.chartData,
            messageId: aiMessage.id,
            integration: aiMessage.integration
              ? { id: aiMessage.integration.id, name: aiMessage.integration.name }
              : null,
          })

          // 8. Done.
          send('done', { messageId: aiMessage.id, latencyMs: Date.now() - started })
        } catch (e) {
          const status = statusForInternalChatError(e)
          if (status === 503) {
            await persistAssistantError({
              sessionId: session.id,
              userId: user.userId,
              message: text,
            }).catch(() => {
              /* best effort only */
            })
            send('error', {
              message:
                'AI provider is not configured. Open Settings > AI Configuration and set the model API endpoint before using Chat.',
            })
          } else {
            const message =
              e instanceof Error ? e.message : 'An internal error occurred.'
            send('error', { message })
          }
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to send chat message.')
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

async function persistAssistantError(args: {
  sessionId: string
  userId: string
  message: string
}) {
  const text =
    'AI provider is not configured. Open Settings > AI Configuration and set the model API endpoint before using Chat.'
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
      chatMessageId: aiMessage.id,
      type: 'CHAT',
      status: 'error',
      latencyMs: null,
      inputSummary: args.message.slice(0, 240),
      errorMessage: 'LLM provider is not configured.',
    },
  })
}
