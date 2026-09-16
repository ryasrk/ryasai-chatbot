import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { hasPlan } from '@/lib/plan-gating'
import { rememberChatTurn } from '@/lib/cognee'
import { db } from '@/lib/db'
import { runAgentOrchestrator } from '@/lib/agent-orchestrator'
import { getUnifiedTools } from '@/lib/unified-tools'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'analyst')
    if (!hasPlan(user.plan, 'pro')) {
      return NextResponse.json({ error: 'Agent features require a Pro plan or higher.' }, { status: 403 })
    }
    const body = (await req.json().catch(() => ({}))) as { message?: string; conversationId?: string; sessionId?: string; timezone?: string }
    const message = (body.message ?? '').trim()
    const tz = body.timezone || 'UTC'
    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let sessionId = body.sessionId ?? body.conversationId ?? null
    let sessionCreatedAt: Date = new Date()
    if (!sessionId) {
      const session = await db.chatSession.create({
        data: {
          title: `[Agent] ${new Date().toLocaleString('en-US')}`,
          userId: user.userId,
          organizationId: user.organizationId,
        },
      })
      sessionId = session.id
      sessionCreatedAt = session.createdAt
    } else {
      const existing = await db.chatSession.findUnique({ where: { id: sessionId }, select: { createdAt: true } })
      if (existing) sessionCreatedAt = existing.createdAt
    }

    await db.chatMessage.create({
      data: { sessionId, userId: user.userId, sender: 'user', text: message, organizationId: user.organizationId },
    }).catch(() => null)

    // Load chat history (last 10 messages, exclude agent sender to avoid duplication)
    const recentMessages = await db.chatMessage.findMany({
      where: { sessionId, sender: { in: ['user', 'ai'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sender: true, text: true, createdAt: true },
    }).catch(() => [])
    const fmtOptsHist: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }
    const chatHistory = recentMessages
      .reverse()
      .filter((m) => m.text && m.text.trim())
      .map((m) => {
        const ts = m.createdAt.toLocaleString('en-US', fmtOptsHist)
        const role = m.sender === 'user' ? 'user' as const : 'assistant' as const
        return { role, content: `[${ts} ${tz}] ${m.text}` }
      })

    const conversationId = sessionId
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }

        try {
          send('thinking', { content: 'Analyzing request...' })

          // ponytail: the ReAct orchestrator replaces the static upfront DAG. It calls
          // tools through the LLM's native function-calling protocol, observes the real
          // results, and decides the NEXT action from them — so a step that returns
          // nothing can be adapted around instead of failing a pre-committed plan.
          // Admin/MCP/plugin actions still flow through the same tool ids, and the
          // confirmation gate is preserved (a gated tool halts the loop and the prompt
          // is relayed to the user; "confirm yes" re-enters with the gate satisfied).
          const fmtOpts: Intl.DateTimeFormatOptions = { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
          const sessionStart = sessionCreatedAt.toLocaleString('en-US', fmtOpts)
          const currentTime = new Date().toLocaleString('en-US', fmtOpts)
          const contextualizedMessage = `[Session started: ${sessionStart} ${tz}]\n[Current time: ${currentTime} ${tz}]\n\n${message}`

          // The announced tool list is emitted once up front so the UI keeps its
          // "Plan" affordance: the orchestrator has no fixed plan, so the tool ids
          // it CAN reach is the honest equivalent of a plan preview.
          const announcedTools = await getUnifiedTools({
            query: message,
            context: 'agentic',
            isAdmin: user.role === 'admin',
          })
          send('plan', {
            steps: announcedTools.map((t, i) => ({ id: `tool${i + 1}`, tool: t.id, input: {} })),
          })

          const orchestratorResult = await runAgentOrchestrator({
            question: contextualizedMessage,
            userId: user.userId,
            organizationId: user.organizationId,
            sessionId: conversationId,
            context: 'agentic',
            isAdmin: user.role === 'admin',
            chatHistory,
            onEvent: (ev) => {
              if (ev.type === 'thinking') {
                send('thinking', { content: ev.data.content ?? 'Thinking...' })
              } else if (ev.type === 'tool_start') {
                send('tool_start', {
                  stepId: ev.data.stepId,
                  tool: ev.data.toolId,
                  input: ev.data.arguments ?? {},
                })
              } else if (ev.type === 'tool_end') {
                send('tool_end', {
                  stepId: ev.data.stepId,
                  tool: ev.data.toolId,
                  status: ev.data.status === 'success' ? 'success' : 'error',
                  output: ev.data.output,
                  error: ev.data.error,
                  latencyMs: ev.data.latencyMs,
                })
              }
            },
          })

          const fullAnswer = orchestratorResult.answer

          if (orchestratorResult.confirmationRequired) {
            send('confirmation_required', { message: orchestratorResult.confirmationRequired.message })
          }

          send('answer', { content: fullAnswer })
          send('done', { conversationId })

          await db.chatMessage.create({
            data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: fullAnswer, status: 'complete', organizationId: user.organizationId },
          }).catch(() => null)
          await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)

          await writeAudit({
            userId: user.userId,
            action: 'AGENT_DASHBOARD',
            severity: 'info',
            detail: { message, conversationId, iterations: orchestratorResult.iterations, toolRuns: orchestratorResult.toolRuns.length },
          })

          await rememberChatTurn({
            sessionId: conversationId,
            userMessage: message,
            aiMessage: fullAnswer,
            toolRuns: orchestratorResult.toolRuns.map((r) => ({ type: r.type, status: r.status, latencyMs: r.latencyMs ?? 0 })),
          })
        } catch (e) {
          send('error', { message: e instanceof Error ? e.message : 'An internal error occurred.' })
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
    return handleApiError(e, 'Agentic dashboard failed.')
  }
}
