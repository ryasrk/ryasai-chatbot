import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireExternalApiKey } from '@/lib/api-keys'
import { handleApiError, writeAudit } from '@/lib/session'
import { runAgentOrchestrator } from '@/lib/agent-orchestrator'
import { rememberChatTurn } from '@/lib/cognee'
import { rateLimit } from '@/lib/redis'
import { enterWithOrg, getOrgContext } from '@/lib/prisma-tenant'
import { resolveScope } from '@/lib/api-key-scope'
import { logSwallowed } from '@/lib/logger'

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
  }).catch(logSwallowed('v1/agent/run: apiRequestLog.create'))
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

    /*
     * ENTER THE ORG HERE, explicitly.
     *
     * `requireExternalApiKey` calls `enterWithOrg` internally, but `AsyncLocalStorage.enterWith()` does NOT
     * propagate back to the caller's frame — MEASURED by the audit with a standalone probe: a route that
     * never enters resolves `undefined`, while one that does resolves its own org. So every DB query in THIS
     * handler ran with no org context, and the tenant extension skips injection entirely when the context is
     * empty (`prisma-tenant.ts`: `if (!orgId) return query(args)`).
     *
     * CONSEQUENCE, proven on the live database inside a transaction the audit rolled back: a FOREIGN org's
     * document was returned by the unscoped query here. That is a cross-tenant read, not merely a missing
     * scope — and `db.user.findFirst` below had the same exposure, which is why it could pick another
     * tenant's user as the run's actor.
     *
     * `src/app/api/v1/chat/completions/route.ts` already did this; the two routes had diverged.
     */
    enterWithOrg(identity.organizationId)

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

    agentRun = await db.agentRun.create({
      data: {
        organizationId: identity.organizationId,
        userId: admin?.id ?? undefined,
        sessionId: body.sessionId ?? undefined,
        question,
        planJson: '',
        status: 'executing',
      },
    })

    // API-key callers are external automation — never expose admin.* tools.
    // The ReAct orchestrator picks and sequences tools dynamically, so there is
    // no upfront plan to persist; the iteration count is the honest equivalent.
    const orchestratorResult = await runAgentOrchestrator({
      question,
      userId: admin?.id ?? 'system',
      organizationId: identity.organizationId,
      sessionId: body.sessionId,
      context: 'agentic',
      isAdmin: false,
      /*
       * The key's tool scope, finally enforced on THIS path.
       *
       * It was stored, validated and rendered in the admin UI while nothing consulted it: `scopeAllowsTool`
       * had zero production callers, so a key created with `allowedTools: ['RAG']` could still be handed SQL
       * and run it. `resolveScope` runs first so a malformed stored value fails CLOSED instead of being read
       * as "unrestricted" — the same convention the chat route uses.
       */
      allowedTools: resolveScope(identity.scope).tools,
      // The DOCUMENT scope, so the tools that run are scoped and not merely filtered. Without it a granted
      // tool could still read documents the key was restricted away from — measured reachable on this route.
      documentIds: resolveScope(identity.scope).documentIds,
    })

    const answer = orchestratorResult.answer
    const stepResults = orchestratorResult.toolRuns

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
        iterations: orchestratorResult.iterations,
        toolRuns: stepResults.length,
        latencyMs: Date.now() - started,
      },
    })

    // FIRE AND FORGET — the answer is already computed, so the memory write must not be on
    // the path that returns it. MEASURED against the cognee v1.6.0 sidecar: one chat-turn
    // write took 5.6-9.7s on a warm dataset and 228s on the first write of a NEW one while
    // the pipeline compiles. This exact `await` kept an SSE stream open past a 30s test
    // timeout (the UI sat on "Thinking..."), and the identical bug was already fixed in
    // tool-router.ts and chat/sessions/[id]/send/route.ts. Errors are logged inside
    // rememberChatTurn, so a memory failure stays visible and still never reaches the caller.
    void rememberChatTurn({
      userMessage: question,
      aiMessage: answer,
      toolRuns: stepResults.map((r) => ({ type: r.type, status: r.status, latencyMs: r.latencyMs ?? 0 })),
    })

    return NextResponse.json({
      ok: true,
      agentRunId: agentRun.id,
      answer,
      iterations: orchestratorResult.iterations,
      stepResults,
    })
  } catch (e) {
    if (agentRun) {
      await db.agentRun.update({
        where: { id: agentRun.id },
        data: { status: 'error', errorMessage: e instanceof Error ? e.message : String(e) },
      }).catch(logSwallowed('v1/agent/run: agentRun.update (error status)'))
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
