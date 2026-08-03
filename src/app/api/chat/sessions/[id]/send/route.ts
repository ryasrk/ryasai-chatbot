import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { runStreamingChatCompletion, type ChatHistoryEntry, type StreamingCompletionResult } from '@/lib/tool-router'

// ponytail: hard ceiling for the whole handler (Next.js route segment config) —
// the agentic loop can otherwise pin a worker for minutes across iterations.
export const maxDuration = 120

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface SendBody {
  text?: string
  integrationId?: string
  timezone?: string
  promptId?: string
  messageId?: string
}

const MAX_TEXT_LENGTH = 100_000
const OVERALL_DEADLINE_MS = 120_000
const IDLE_TIMEOUT_MS = 120_000
const LLM_NOT_CONFIGURED_TEXT =
  'AI provider is not configured. Open Settings > AI Configuration and set the model API endpoint before using Chat.'
const GENERIC_ERROR_TEXT =
  'Something went wrong while generating a response. Please try again.'
const LLM_TIMEOUT_TEXT =
  'Stream timed out — no response within the time limit. Please try again.'

const TOOL_LABELS: Record<string, string> = {
  SQL: 'Running SQL query...',
  RAG: 'Searching relevant documents...',
  REST_API: 'Calling REST API...',
  CHAT: 'Composing answer...',
  PLUGIN: 'Querying external tool...',
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
    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Message is too long (max ${MAX_TEXT_LENGTH} characters).` },
        { status: 400 },
      )
    }

    const session = await db.chatSession.findFirst({ // nosemgrep
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

    // Retry dedupe: when the client re-sends a failed turn with its persisted
    // user message id, reuse that message instead of inserting a duplicate.
    let existingUserMessage: { id: string; createdAt: Date } | null = null
    if (typeof body.messageId === 'string' && body.messageId) {
      existingUserMessage = await db.chatMessage.findFirst({ // nosemgrep
        where: {
          id: body.messageId,
          sessionId: session.id,
          userId: user.userId,
          sender: 'user',
        },
        select: { id: true, createdAt: true },
      })
    }
    const skipDuplicateId = existingUserMessage?.id

    const recentMessages = await db.chatMessage.findMany({ // nosemgrep
      where: {
        sessionId: session.id,
        sender: { in: ['user', 'ai'] },
        // Exclude the retried message so it isn't duplicated into chat history.
        ...(skipDuplicateId ? { id: { not: skipDuplicateId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sender: true, text: true, createdAt: true },
    })

    let systemPromptPrefix: string | undefined
    if (typeof body.promptId === 'string' && body.promptId.trim()) {
      const prompt = await db.savedPrompt.findUnique({ where: { id: body.promptId } })
      if (prompt) systemPromptPrefix = prompt.content
    }

    const userMessage =
      existingUserMessage ??
      (await db.chatMessage.create({
        data: {
          organizationId: user.organizationId,
          sessionId: session.id,
          userId: user.userId,
          sender: 'user',
          text,
        },
      }))
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
        // ponytail: closed flag guards enqueues after a timeout/error close —
        // controller.enqueue on a closed controller throws, which would escape
        // the async start() and surface as an unhandled rejection.
        let closed = false
        // Client cancel + overall deadline coalesced into one abort reason.
        // ponytail: we close the generator chain (return()) to stop consuming
        // the upstream LLM body; a full fetch-level abort would need an
        // AbortSignal threaded into llm-client's chatStream fetch — out of
        // scope for this change set.
        let streaming: StreamingCompletionResult | null = null
        let abortReason: 'client' | 'deadline' | null = null
        const onAbort = () => {
          abortReason = req.signal.aborted ? 'client' : 'deadline'
          streaming?.stream.return?.().catch(() => {})
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
        const deadline = new AbortController()
        const deadlineTimer = setTimeout(() => deadline.abort(), OVERALL_DEADLINE_MS)
        deadline.signal.addEventListener('abort', onAbort, { once: true })
        const send = (event: string, data: unknown) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\n`))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
          }
        }
        const safeClose = () => {
          if (closed) return
          closed = true
          try { controller.close() } catch { /* already closed */ }
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
          streaming = await runStreamingChatCompletion({
            question: contextualizedText,
            userId: user.userId,
            integrationId,
            sessionId: session.id,
            chatHistory,
            allowMultiStepDag: true,
            systemPromptPrefix,
          })

          // 4. Emit tool execution events (skip for pure CHAT — no tool to show).
          const toolRun = streaming.toolRuns[0]
          const toolHasResults =
            toolRun &&
            toolRun.type !== 'CHAT' &&
            toolRun.status === 'success' &&
            !!toolRun.outputSummary &&
            toolRun.outputSummary.length > 0
          if (toolRun && toolRun.type !== 'CHAT') {
            send('tool_start', {
              tool: toolRun.type,
              label: TOOL_LABELS[toolRun.type] ?? `Running ${toolRun.type}...`,
            })
            send('tool_end', {
              tool: toolRun.type,
              status: toolRun.status,
              latencyMs: toolRun.latencyMs ?? 0,
              hasResults: toolHasResults,
            })
          }

          // 5. Stream tokens — with an idle watchdog + client/deadline abort.
          //    If no token arrives within 120s, send a typed LLM_TIMEOUT error
          //    frame and close (the partial answer is never saved as complete).
          let fullAnswer = ''
          let timedOut = false
          const onIdleTimeout = () => {
            timedOut = true
            streaming?.stream.return?.().catch(() => {})
            send('error', {
              code: 'LLM_TIMEOUT',
              message: LLM_TIMEOUT_TEXT,
            })
            safeClose()
          }
          let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS)
          for await (const token of streaming.stream) {
            if (timedOut || abortReason) break
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS)
            fullAnswer += token
            send('token', { content: token })
          }
          if (idleTimer) clearTimeout(idleTimer)
          if (abortReason === 'client') return // client disconnected — do not persist
          if (timedOut || abortReason === 'deadline') {
            await persistAssistantError({
              sessionId: session.id,
              userId: user.userId,
              organizationId: user.organizationId,
              input: text,
              text: LLM_TIMEOUT_TEXT,
            }).catch(() => {
              /* best effort only */
            })
            if (!timedOut) {
              send('error', { code: 'LLM_TIMEOUT', message: LLM_TIMEOUT_TEXT })
              safeClose()
            }
            return
          }

          // 6. Persist AI message + ToolRuns + update session.
          const aiMessage = await db.chatMessage.create({
            data: {
              organizationId: user.organizationId,
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
                  organizationId: user.organizationId,
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
          //    toolHasResults recomputed from the FINAL toolRuns — the agentic
          //    loop (follow-up messages) fills toolRuns only while streaming.
          const finalToolRun = streaming.toolRuns[0]
          const finalToolHasResults =
            finalToolRun &&
            finalToolRun.type !== 'CHAT' &&
            finalToolRun.status === 'success' &&
            !!finalToolRun.outputSummary &&
            finalToolRun.outputSummary.length > 0
          send('answer', {
            content: fullAnswer,
            citations: streaming.citations,
            chartData: streaming.chartData,
            messageId: aiMessage.id,
            integration: aiMessage.integration
              ? { id: aiMessage.integration.id, name: aiMessage.integration.name }
              : null,
            toolHasResults: finalToolHasResults,
          })

          // 8. Done.
          send('done', { messageId: aiMessage.id, latencyMs: Date.now() - started })
        } catch (e) {
          if (abortReason === 'client') return // client disconnected — no persistence
          if (!closed) {
            // Never pass raw error text to the client — it can leak internals.
            // Log it server-side for diagnosis instead.
            console.error('[chat-send] stream error:', e)
            const status = statusForInternalChatError(e)
            const is503 = status === 503
            const message = is503 ? LLM_NOT_CONFIGURED_TEXT : GENERIC_ERROR_TEXT
            await persistAssistantError({
              sessionId: session.id,
              userId: user.userId,
              organizationId: user.organizationId,
              input: text,
              text: message,
            }).catch(() => {
              /* best effort only */
            })
            send('error', { code: is503 ? 'LLM_NOT_CONFIGURED' : 'LLM_ERROR', message })
          }
        } finally {
          req.signal.removeEventListener('abort', onAbort)
          deadline.signal.removeEventListener('abort', onAbort)
          clearTimeout(deadlineTimer)
          safeClose()
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
    message.includes('LLM not configured') ||
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
  organizationId: string
  input: string
  text?: string
}) {
  const text = args.text ?? LLM_NOT_CONFIGURED_TEXT
  const aiMessage = await db.chatMessage.create({
    data: {
      organizationId: args.organizationId,
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
      organizationId: args.organizationId,
      chatMessageId: aiMessage.id,
      type: 'CHAT',
      status: 'error',
      latencyMs: null,
      inputSummary: args.input.slice(0, 240),
      errorMessage: text,
    },
  })
}
