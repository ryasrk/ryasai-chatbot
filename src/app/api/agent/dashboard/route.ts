import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { hasPlan } from '@/lib/plan-gating'
import { rememberChatTurn } from '@/lib/cognee'
import { db } from '@/lib/db'
import { planQuery, executePlan, formatStepContext, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { streamAnswer } from '@/lib/ai'
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

          // ponytail: all actions — including MCP install/credentials/list/test/remove —
          // are handled by the LLM planner via admin:* tools. The planner sees the
          // conversation history and decides which tool to invoke based on context.
          // Confirmation flows through the planner: when the user says "confirm yes",
          // the planner emits confirm:"yes" in the tool input, and executePlan passes
          // isConfirmed=true to the admin tool. No regex pre-checks, no pending state.
          const availableTools = await getAvailableTools(message, 'agentic', { isAdmin: user.role === 'admin' })
          const fmtOpts: Intl.DateTimeFormatOptions = { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
          const sessionStart = sessionCreatedAt.toLocaleString('en-US', fmtOpts)
          const currentTime = new Date().toLocaleString('en-US', fmtOpts)
          const contextualizedMessage = `[Session started: ${sessionStart} ${tz}]\n[Current time: ${currentTime} ${tz}]\n\n${message}`

          const plan = await planQuery({ question: contextualizedMessage, availableTools, sessionId: conversationId, chatHistory })

          send('plan', {
            steps: plan.steps.map((s) => ({ id: s.id, tool: s.tool, input: s.input, dependsOn: s.dependsOn ?? [] })),
          })

          const stepStartTimes = new Map<string, number>()
          const results: PlanStepResult[] = await executePlan({
            plan,
            userId: user.userId,
            sessionId: conversationId,
            isAdmin: user.role === 'admin',
            onStatus: (stepId, tool, status) => {
              if (status === 'running') {
                stepStartTimes.set(stepId, Date.now())
                send('tool_start', { stepId, tool })
              } else {
                const latencyMs = Date.now() - (stepStartTimes.get(stepId) ?? Date.now())
                send('tool_end', { stepId, tool, status: status === 'done' ? 'success' : 'error', latencyMs })
              }
            },
          })

          const synthesisContext = formatStepContext(results)
          let fullAnswer = ''
          // ponytail: streamAnswer routes to configured LLM endpoint (fail-closed if unconfigured).
          // source 'SQL' is a neutral generic label for multi-source synthesis context.
          for await (const token of streamAnswer({ question: contextualizedMessage, context: synthesisContext, source: 'SQL', chatHistory })) {
            fullAnswer += token
            send('token', { content: token })
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
            detail: { message, conversationId, steps: plan.steps.length },
          })

          await rememberChatTurn({
            sessionId: conversationId,
            userMessage: message,
            aiMessage: fullAnswer,
            toolRuns: results.map((r) => ({ type: r.tool, status: r.ok ? 'success' : 'error', latencyMs: r.latencyMs })),
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
