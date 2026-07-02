import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireExternalApiKey } from '@/lib/api-keys'
import { handleApiError } from '@/lib/session'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'

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

export async function POST(req: NextRequest) {
  const started = Date.now()
  let companyId: string | null = null
  let apiKeyId: string | null = null

  try {
    const identity = await requireExternalApiKey(req)
    companyId = identity.companyId
    apiKeyId = identity.apiKeyId

    const body = (await req.json().catch(() => ({}))) as ChatCompletionBody
    const question = latestUserMessage(body.messages ?? [])
    if (!question) {
      await writeApiLog({
        companyId,
        apiKeyId,
        status: 400,
        latencyMs: Date.now() - started,
        errorMessage: 'messages harus berisi minimal satu role=user.',
      })
      return NextResponse.json(
        { ok: false, error: 'messages harus berisi minimal satu role=user.' },
        { status: 400 },
      )
    }

    const admin = await db.user.findFirst({
      where: { companyId, role: 'admin', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!admin) {
      await writeApiLog({
        companyId,
        apiKeyId,
        status: 500,
        latencyMs: Date.now() - started,
        errorMessage: 'Admin singleton tidak ditemukan.',
      })
      return NextResponse.json(
        { ok: false, error: 'Admin singleton tidak ditemukan.' },
        { status: 500 },
      )
    }

    const session = body.session_id
      ? await findSession(body.session_id, companyId)
      : await db.chatSession.create({
          data: {
            companyId,
            userId: admin.id,
            title: question.slice(0, 60) || 'External API Chat',
          },
        })

    if (!session) {
      await writeApiLog({
        companyId,
        apiKeyId,
        status: 404,
        latencyMs: Date.now() - started,
        errorMessage: 'Session tidak ditemukan.',
      })
      return NextResponse.json(
        { ok: false, error: 'Session tidak ditemukan.' },
        { status: 404 },
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

    const completion = await runNonStreamingChatCompletion({
      question,
      companyId,
      userId: admin.id,
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
    })

    const latencyMs = Date.now() - started
    const toolRuns = await Promise.all(
      completion.toolRuns.map((toolRun) =>
        db.toolRun.create({
          data: {
            companyId: identity.companyId,
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

    await writeApiLog({ companyId, apiKeyId, status: 200, latencyMs })

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

    if (body.stream) {
      return new NextResponse(
        buildSseDataStream([
          {
            id: payload.id,
            object: 'chat.completion.chunk',
            created: payload.created,
            model: payload.model,
            session_id: payload.session_id,
            choices: [
              {
                index: 0,
                delta: { content: payload.answer },
                finish_reason: null,
              },
            ],
            citations: payload.citations,
            chart_data: payload.chart_data,
            tool_runs: payload.tool_runs,
          },
          {
            id: payload.id,
            object: 'chat.completion.chunk',
            created: payload.created,
            model: payload.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ]),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        },
      )
    }

    return NextResponse.json(payload)
  } catch (e) {
    if (companyId) {
      const status = statusForExternalChatError(e)
      await writeApiLog({
        companyId,
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
              'AI provider belum dikonfigurasi. Buka AI Configuration dan isi endpoint model API sebelum menggunakan chat completion.',
          },
          { status },
        )
      }
    }
    return handleApiError(e, 'Gagal memproses chat completion eksternal.')
  }
}

export function statusForExternalChatError(error: unknown): number {
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

async function findSession(sessionId: string, companyId: string) {
  return db.chatSession.findFirst({
    where: { id: sessionId, companyId },
    select: { id: true },
  })
}

async function writeApiLog(args: {
  companyId: string
  apiKeyId: string | null
  status: number
  latencyMs: number
  errorMessage?: string
}) {
  await db.apiRequestLog.create({
    data: {
      companyId: args.companyId,
      apiKeyId: args.apiKeyId,
      endpoint: 'POST /api/v1/chat/completions',
      status: args.status,
      latencyMs: args.latencyMs,
      errorMessage: args.errorMessage ?? null,
    },
  })
}
