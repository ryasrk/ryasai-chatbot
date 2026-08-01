import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireExternalApiKey } from '@/lib/api-keys'
import { handleApiError, writeAudit } from '@/lib/session'
import { getAvailableTools } from '@/lib/tool-registry'
import { planQuery, executePlan, synthesizeAnswer } from '@/lib/planner'
import { rememberChatTurn } from '@/lib/cognee'
import { rateLimit } from '@/lib/redis'
import { getOrgContext } from '@/lib/prisma-tenant'

async function writeApiLog(args: {
  apiKeyId: string | null
  status: number
  latencyMs: number
  errorMessage?: string
}) {
  const orgId = getOrgContext()
  if (!orgId) return
  await db.apiRequestLog.create({
    data: {
      organizationId: orgId,
      apiKeyId: args.apiKeyId,
      endpoint: 'POST /api/v1/agent/run',
      status: args.status,
      latencyMs: args.latencyMs,
      errorMessage: args.errorMessage ?? null,
    },
  }).catch(() => {})
}

interface AgentRunBody {
  question?: string
  sessionId?: string
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  let apiKeyId: string | null = null
  let agentRun: { id: string } | null = null

  try {
    const identity = await requireExternalApiKey(req)
    apiKeyId = identity.apiKeyId

    // ponytail: Redis burst-protection rate limit — falls back to DB-based limiting
    // in requireExternalApiKey when Redis is down (rateLimit returns null).
    const rl = await rateLimit(`api:${apiKeyId}`, identity.requestLimitPerMinute ?? 60)
    if (rl && !rl.allowed) {
      await writeApiLog({ apiKeyId, status: 429, latencyMs: Date.now() - started, errorMessage: 'Rate limit exceeded' })
      return NextResponse.json(
        { ok: false, error: 'Rate limit exceeded' },
        { status: 429, headers: { 'X-RateLimit-Remaining': '0' } },
      )
    }

    const body = (await req.json().catch(() => ({}))) as AgentRunBody
    const question = (body.question ?? '').trim()
    if (!question) {
      await writeApiLog({
        apiKeyId,
        status: 400,
        latencyMs: Date.now() - started,
        errorMessage: 'question is required.',
      })
      return NextResponse.json(
        { ok: false, error: 'question is required.' },
        { status: 400 },
      )
    }

    const admin = await db.user.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    const availableTools = await getAvailableTools(question, 'agentic')

    // 1) Plan
    agentRun = await db.agentRun.create({
      data: {
        organizationId: identity.organizationId,
        userId: admin?.id ?? undefined,
        sessionId: body.sessionId ?? undefined,
        question,
        planJson: '',
        status: 'planning',
      },
    })

    const plan = await planQuery({ question, availableTools })
    await db.agentRun.update({
      where: { id: agentRun.id },
      data: { planJson: JSON.stringify(plan), status: 'executing' },
    })

    // 2) Execute
    const stepResults = await executePlan({
      plan,
      userId: admin?.id ?? 'system',
      sessionId: body.sessionId,
    })

    // 3) Synthesize
    const answer = await synthesizeAnswer({
      question,
      stepResults,
      plan,
    })

    await db.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: 'complete',
        resultJson: JSON.stringify(stepResults),
        latencyMs: Date.now() - started,
      },
    })

    await writeAudit({
      userId: admin?.id ?? undefined,
      action: 'AGENT_RUN',
      severity: 'info',
      detail: {
        agentRunId: agentRun.id,
        question,
        steps: plan.steps.length,
        synthesis: plan.needsSynthesis,
        latencyMs: Date.now() - started,
      },
    })

    await rememberChatTurn({
      userMessage: question,
      aiMessage: answer,
      toolRuns: stepResults.map((r) => ({ type: r.tool, status: r.ok ? 'success' : 'error', latencyMs: r.latencyMs })),
    })

    return NextResponse.json({
      ok: true,
      agentRunId: agentRun.id,
      answer,
      plan,
      stepResults,
    })
  } catch (e) {
    if (agentRun) {
      await db.agentRun.update({
        where: { id: agentRun.id },
        data: { status: 'error', errorMessage: e instanceof Error ? e.message : String(e) },
      }).catch(() => {})
    }
    await writeApiLog({
      apiKeyId,
      status: 500,
      latencyMs: Date.now() - started,
      errorMessage: String(e),
    })
    return handleApiError(e, 'Agent run failed.')
  }
}
