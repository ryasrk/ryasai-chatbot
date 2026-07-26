import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireExternalApiKey } from '@/lib/api-keys'
import { handleApiError } from '@/lib/session'
import { runNonStreamingChatCompletion, runStreamingChatCompletion } from '@/lib/tool-router'
import { rateLimit } from '@/lib/redis'

interface ChatCompletionBody {
  model?: string
  messages?: Array<{ role?: string; content?: string }>
  stream?: boolean
  session_id?: string
}

interface ChatCompletionPayload {
  id: string
  object: string
  created: number
  model: string
  session_id: string
  answer: string
  citations: unknown[]
  chart_data: unknown
  tool_runs: Array<{
    id: string
    type: string
    status: string
    latency_ms: number | null
    rest_api_endpoint_id: string | null
  }>
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  let apiKeyId: string | null = null

  try {
    const identity = await requireExternalApiKey(req)
    apiKeyId = identity.apiKeyId

    // ponytail: Redis burst-protection rate limit — falls back to DB-based limiting
    // in requireExternalApiKey when Redis is down (rateLimit returns null).
    const rl = await rateLimit(`api:${apiKeyId}`, identity.requestLimitPerMinute ?? 60)
    if (rl && !rl.allowed) {
      await writeApiLog({ apiKeyId, status: 429, latencyMs: Date.now() - started, errorMessage: 'Rate limit exceeded' })
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429, headers: { 'X-RateLimit-Remaining': '0', ...corsHeaders } },
      )
    }

    const body = (await req.json().catch(() => ({}))) as ChatCompletionBody
    const question = latestUserMessage(body.messages ?? [])
    if (!question) {
      await writeApiLog({
        apiKeyId,
        status: 400,
        latencyMs: Date.now() - started,
        errorMessage: 'messages must contain at least one role=user.',
      })
      return NextResponse.json(
        { ok: false, error: 'messages must contain at least one role=user.' },
        { status: 400, headers: corsHeaders },
      )
    }

    const admin = await db.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!admin) {
      await writeApiLog({
        apiKeyId,
        status: 500,
        latencyMs: Date.now() - started,
        errorMessage: 'Admin singleton not found.',
      })
      return NextResponse.json(
        { ok: false, error: 'Admin singleton not found.' },
        { status: 500, headers: corsHeaders },
      )
    }

    const session = body.session_id
      ? await findSession(body.session_id)
      : await db.chatSession.create({
          data: {
            userId: admin.id,
            title: question.slice(0, 60) || 'External API Chat',
          },
        })

    if (!session) {
      await writeApiLog({
        apiKeyId,
        status: 404,
        latencyMs: Date.now() - started,
        errorMessage: 'Session not found.',
      })
      return NextResponse.json(
        { ok: false, error: 'Session not found.' },
        { status: 404, headers: corsHeaders },
      )
    }

    await db.chatMessage.create({
      data: {
        sessionId: session.id,
        userId: admin.id,
        sender: 'user',
        text: question,
      },
    })

    const recentMessages = await db.chatMessage.findMany({
      where: { sessionId: session.id, sender: { in: ['user', 'ai'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sender: true, text: true },
    })
    const chatHistory = recentMessages
      .reverse()
      .filter((m) => m.text && m.text.trim())
      .map((m) => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }))

    if (body.stream) {
      const streaming = await runStreamingChatCompletion({
        question,
        userId: admin.id,
        sessionId: session.id,
        chatHistory,
      })

      const completionId = `chatcmpl_${session.id}_${started}`
      const created = Math.floor(Date.now() / 1000)
      const model = body.model ?? 'default'
      const encoder = new TextEncoder()

      const sseStream = new ReadableStream({
        async start(controller) {
          let fullAnswer = ''
          try {
            for await (const token of streaming.stream) {
              fullAnswer += token
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
                  })}\n\n`,
                ),
              )
            }

            const aiMessage = await db.chatMessage.create({
              data: {
                sessionId: session.id,
                userId: admin.id,
                sender: 'ai',
                text: fullAnswer,
                status: 'complete',
                citations: JSON.stringify(streaming.citations),
                chartData: streaming.chartData ? JSON.stringify(streaming.chartData) : null,
                integrationId: streaming.integrationId ?? null,
              },
            })

            const latencyMs = Date.now() - started
            const toolRuns = await Promise.all(
              streaming.toolRuns.map((toolRun) =>
                db.toolRun.create({
                  data: {
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

            await db.chatSession.update({
              where: { id: session.id },
              data: { updatedAt: new Date() },
            })

            await writeApiLog({ apiKeyId, status: 200, latencyMs })

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  session_id: session.id,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  citations: streaming.citations,
                  chart_data: streaming.chartData,
                  tool_runs: toolRuns.map((toolRun) => ({
                    id: toolRun.id,
                    type: toolRun.type,
                    status: toolRun.status,
                    latency_ms: toolRun.latencyMs,
                    rest_api_endpoint_id: toolRun.restApiEndpointId,
                  })),
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          } catch (e) {
            const message = e instanceof Error ? e.message : 'Stream failed.'
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: `[error: ${message}]` }, finish_reason: 'stop' }],
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            await writeApiLog({ apiKeyId, status: 503, latencyMs: Date.now() - started, errorMessage: message })
            controller.close()
          }
        },
      })

      return new NextResponse(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          ...corsHeaders,
        },
      })
    }

    const completion = await runNonStreamingChatCompletion({
      question,
      userId: admin.id,
      sessionId: session.id,
      chatHistory,
    })

    const aiMessage = await db.chatMessage.create({
      data: {
        sessionId: session.id,
        userId: admin.id,
        sender: 'ai',
        text: completion.answer,
        status: 'complete',
        citations: JSON.stringify(completion.citations),
        chartData: completion.chartData ? JSON.stringify(completion.chartData) : null,
        integrationId: completion.integrationId ?? null,
      },
    })

    const latencyMs = Date.now() - started
    const toolRuns = await Promise.all(
      completion.toolRuns.map((toolRun) =>
        db.toolRun.create({
          data: {
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

    await db.chatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    })

    await writeApiLog({ apiKeyId, status: 200, latencyMs })

    const payload: ChatCompletionPayload = {
      id: `chatcmpl_${aiMessage.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'default',
      session_id: session.id,
      answer: completion.answer,
      citations: completion.citations,
      chart_data: completion.chartData,
      tool_runs: toolRuns.map((toolRun) => ({
        id: toolRun.id,
        type: toolRun.type,
        status: toolRun.status,
        latency_ms: toolRun.latencyMs,
        rest_api_endpoint_id: toolRun.restApiEndpointId,
      })),
    }

    return NextResponse.json(payload, { headers: corsHeaders })
  } catch (e) {
    const status = statusForExternalChatError(e)
    await writeApiLog({
      apiKeyId,
      status,
      latencyMs: Date.now() - started,
      errorMessage: e instanceof Error ? e.message : 'External chat failed',
    })
    if (status === 503) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'AI provider not configured. Open AI Configuration and fill in the model API endpoint before using chat completion.',
        },
        { status, headers: corsHeaders },
      )
    }
    return handleApiError(e, 'Failed to process external chat completion.')
  }
}

export function statusForExternalChatError(error: unknown): number {
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

export function buildSseDataStream(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

function latestUserMessage(messages: Array<{ role?: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content.trim()
    }
  }
  return ''
}

async function findSession(sessionId: string) {
  return db.chatSession.findFirst({
    where: { id: sessionId },
    select: { id: true },
  })
}

async function writeApiLog(args: {
  apiKeyId: string | null
  status: number
  latencyMs: number
  errorMessage?: string
}) {
  await db.apiRequestLog.create({
    data: {
      apiKeyId: args.apiKeyId,
      endpoint: 'POST /api/v1/chat/completions',
      status: args.status,
      latencyMs: args.latencyMs,
      errorMessage: args.errorMessage ?? null,
    },
  })
}
