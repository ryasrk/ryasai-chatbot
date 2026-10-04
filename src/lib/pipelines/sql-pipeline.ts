/**
 * The Text-to-SQL pipeline, written ONCE for both transports.
 *
 * WHY THIS MODULE EXISTS. `runSqlBranch` (non-streaming: /api/v1, scheduler, agentic loop) and `prepareSqlStream`
 * (streaming: the web chat) each carried their own copy of integration selection, the repair loop, the guardrail and
 * the audit trail, and the copies drifted every time one was fixed. MEASURED on 2026-10-04, the streaming copy — the
 * one users actually reach — had NO `GUARDRAIL_BLOCK` / `SQL_EXECUTE` audit rows and no `queryHistory` (CLAUDE.md
 * principle #4), no SQL tool rate limit, no `withToolSandbox` timeout, dropped `integration.contextPrompt` and
 * `textColumns`; the non-streaming copy let a `generateSql` throw escape the repair loop and had no transient-error
 * retry. Each transport now only decides the SHAPE of its output (whole answer vs token stream); everything that
 * decides which SQL runs, and what is recorded about it, lives here.
 */
import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext, requireOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import { connectorRegistry, describeSchema } from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import {
  SQL_REPAIR_ATTEMPTS,
  SQL_REPAIR_MIN_REMAINING_MS,
  SQL_REPAIR_TOTAL_BUDGET_MS,
} from '@/lib/constants'
import { generateSql } from '@/lib/ai'
import { getPromptSettings, resolveSqlRulesPrompt } from '@/lib/prompt-settings'
import { resolveIntegrationForQuestion, tokenize } from '@/lib/smart-router'
import { withToolSandbox } from '@/lib/tool-sandbox'
import { checkToolRateLimit } from '@/lib/tool-rate-limit'
import {
  withSqlConcurrency,
  safeParseColumns,
  safeParseSampleRow,
} from '@/lib/tool-utils'
import type { QueryResult } from '@/lib/connectors'
import { filterSchemaForPolicy, loadSqlAccessPolicy, resolveUserRole } from '@/lib/access-scope'

const log = scopedLogger('sql-pipeline')

/**
 * SQL turns per minute per organization. Default 10 (the limit the non-streaming path always had); since both chat
 * transports share this pipeline it also bounds the web chat, so an install with many concurrent users raises it
 * with `TOOL_RATE_LIMIT_SQL_PER_MINUTE`. An invalid value falls back to the default rather than to "unlimited".
 */
export function sqlRateLimitPerMinute(): number {
  const n = Number(process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE)
  return Number.isInteger(n) && n > 0 ? n : 10
}

/** Connection-level failures worth ONE immediate retry; a SQL error is the repair loop's job, not this. */
const TRANSIENT_DB_ERROR = /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i

export interface SqlPipelineArgs {
  question: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
  memoryContext?: string
  /** The API-key scope's allowed integrations; `null`/absent = every source. Applied to EVERY lookup below. */
  integrationIds?: string[] | null
}

type ResolvedIntegration = NonNullable<Awaited<ReturnType<typeof loadIntegration>>>

export interface SqlPipelineExecuted {
  kind: 'executed'
  integration: { id: string; name: string }
  finalSql: string
  result: QueryResult
  /** The generator's stated population (rule 17), forwarded to the answer so it can name what it measured. */
  sqlExplanation: string
  /** Caller prefix + the integration's admin-authored `contextPrompt`; used for SQL generation AND the answer. */
  systemPromptPrefix: string | undefined
  attempts: number
}

export interface SqlPipelineFailed {
  kind: 'failed'
  integration: { id: string; name: string }
  lastError: string
  systemPromptPrefix: string | undefined
}

export type SqlPipelineOutcome =
  | SqlPipelineExecuted
  | SqlPipelineFailed
  /** Several sources and the question named none of them: refuse and name the candidates rather than guess. */
  | { kind: 'ambiguous'; candidates: string[] }
  /** No active integration with a reflected schema inside the scope. */
  | { kind: 'unavailable' }
  /** The integration is restricted and the user's role is granted no table in it. */
  | { kind: 'forbidden'; integration: { id: string; name: string } }
  | { kind: 'rate_limited'; integration: { id: string; name: string } }

/** `inScope` is a separate parameter so the structural scope audit (tool-router-scope-forward.test.ts) can see it. */
function loadIntegration(base: Record<string, unknown>, inScope: Record<string, unknown>) {
  return db.integration.findFirst({
    where: { ...base, ...inScope },
    include: { schemas: { orderBy: { tableName: 'asc' } } },
  })
}

/**
 * Which integration answers this question — the ONE implementation both transports use.
 *
 * A client-named integration outside the scope never loads; selection then continues among the IN-SCOPE sources
 * only, so a key can never be routed to a database it may not read. With several candidates the question
 * is scored, and an unclear score REFUSES instead of taking the oldest source, which once answered a Sales question
 * from the HR database without any error (trial/25-wrong-db-proof.ts).
 */
async function resolveIntegration(
  args: SqlPipelineArgs,
): Promise<{ integration: ResolvedIntegration | null } | { ambiguous: string[] }> {
  // `null` = unrestricted, so the filter is spread CONDITIONALLY: `in: []` would match nothing and lock out
  // every key created before the integration axis existed.
  const scopeIds = args.integrationIds && args.integrationIds.length > 0 ? args.integrationIds : null
  const inScope = scopeIds ? { id: { in: scopeIds } } : {}

  if (args.integrationId) {
    const named = await loadIntegration({ id: args.integrationId, status: 'active' }, inScope)
    // A stale or out-of-scope id falls through to the scoped disambiguation below rather than answering nothing.
    if (named) return { integration: named }
  }

  const active = await db.integration.findMany({
    where: { status: 'active', ...inScope },
    orderBy: { name: 'asc' },
    select: { name: true },
  })
  if (active.length <= 1) {
    return { integration: active.length === 1 ? await loadIntegration({ status: 'active' }, inScope) : null }
  }
  const choice = await resolveIntegrationForQuestion(
    tokenize(args.question),
    args.question,
    'refuse',
    args.integrationIds,
  )
  if (!choice) return { ambiguous: active.map((n) => n.name) }
  return { integration: await loadIntegration({ id: choice.integrationId, status: 'active' }, inScope) }
}

/**
 * The integration's admin-edited `contextPrompt`, appended to the caller's prefix so BOTH the SQL generation and the
 * answer respect it. Capped at 2000 chars so a runaway prompt cannot eat the context window.
 */
export function withIntegrationContextPrompt(prefix: string | undefined, contextPrompt: string | null): string | undefined {
  const intPrompt = contextPrompt && contextPrompt.trim()
    ? `\n\nContext guidance:\n${contextPrompt.slice(0, 2000)}`
    : ''
  if (prefix) return `${prefix}${intPrompt}`
  return intPrompt ? intPrompt.replace(/^\s+/, '') : undefined
}

async function audit(userId: string, action: string, severity: 'info' | 'warning' | 'critical', detail: unknown) {
  await db.auditLog.create({
    data: {
      organizationId: requireOrgContext(),
      userId,
      action,
      severity,
      detail: JSON.stringify(detail),
    },
  })
}

async function executeWithTransientRetry(
  integrationId: string,
  run: () => Promise<QueryResult>,
): Promise<QueryResult> {
  const once = () => withSqlConcurrency(integrationId, () => withToolSandbox('sql', run))
  try {
    return await once()
  } catch (e) {
    if (!TRANSIENT_DB_ERROR.test(e instanceof Error ? e.message : String(e))) throw e
    await new Promise((r) => setTimeout(r, 1000))
    return once()
  }
}

export async function runSqlPipeline(args: SqlPipelineArgs): Promise<SqlPipelineOutcome> {
  const started = Date.now()
  const resolved = await resolveIntegration(args)
  if ('ambiguous' in resolved) return { kind: 'ambiguous', candidates: resolved.ambiguous }
  const integration = resolved.integration
  if (!integration || integration.schemas.length === 0) return { kind: 'unavailable' }
  const ref = { id: integration.id, name: integration.name }

  // Rate-limit BEFORE burning LLM calls: the repair loop can make up to SQL_REPAIR_ATTEMPTS+1 generations.
  const orgId = getOrgContext()
  if (orgId) {
    const rl = await checkToolRateLimit('sql', orgId, sqlRateLimitPerMinute())
    if (!rl.allowed) return { kind: 'rate_limited', integration: ref }
  }

  // Per-role access (access-scope.ts). The generator only ever SEES granted tables and columns; the AST guard below
  // independently rejects anything outside the grant, so a prompt-injected or hallucinated table still cannot run.
  const role = await resolveUserRole(args.userId)
  const policy = await loadSqlAccessPolicy(integration, role)

  const systemPromptPrefix = withIntegrationContextPrompt(args.systemPromptPrefix, integration.contextPrompt)
  // Resolved once per turn, not per repair attempt: the value cannot change mid-request.
  const sqlRules = resolveSqlRulesPrompt((await getPromptSettings(db)).sqlRulesPrompt)

  const reflectedTables = integration.schemas.map((schema) => ({
    tableName: schema.tableName,
    columns: safeParseColumns(schema.columns),
    rowCount: schema.rowCount ?? undefined,
    sampleRow: safeParseSampleRow(schema.sampleRow),
    description: schema.description,
  }))
  const schemaTables = filterSchemaForPolicy(reflectedTables, policy)
  if (schemaTables.length === 0) {
    await audit(args.userId, 'ACCESS_DENIED', 'warning', { integrationId: integration.id, role, reason: 'no granted table' })
    return { kind: 'forbidden', integration: ref }
  }
  // EVERY reflected column, not just granted ones: the AST guard needs them to attribute an unqualified column to the
  // table that really has it (a restricted column must not hide behind an unqualified name).
  const schemaColumns = new Map(
    reflectedTables.map((t) => [t.tableName.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase()))]),
  )
  const schemaDescription = describeSchema(schemaTables)
  // Free-text columns for the stale-profile fallback: what the model wrongly filters on without query hints.
  const textColumns = [
    ...new Set(
      schemaTables
        .flatMap((t) => t.columns)
        .filter((c) => /char|text|string/i.test(String(c.type)) && !c.primaryKey)
        .map((c) => c.name),
    ),
  ]

  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  // Error-correction loop: a wrong column, a dialect quirk or a guardrail rejection is fixable when the error is
  // fed back to the generator, so a failure is a retry rather than a dead end.
  let lastSqlError = ''
  const attemptedSql: string[] = []
  let sqlExplanation = ''

  for (let attempt = 0; attempt <= SQL_REPAIR_ATTEMPTS; attempt++) {
    // Attempt 0 always runs; a retry starts only when one attempt's worst case still fits the turn's budget, so the
    // user gets the diagnosed failure instead of a route timeout.
    if (attempt > 0 && Date.now() - started + SQL_REPAIR_MIN_REMAINING_MS() > SQL_REPAIR_TOTAL_BUDGET_MS()) {
      log.warn('sql repair loop: not enough budget left for another attempt', {
        elapsedMs: Date.now() - started,
        budgetMs: SQL_REPAIR_TOTAL_BUDGET_MS(),
        attemptsDone: attempt,
      })
      break
    }
    const feedback = attempt > 0
      ? `The previous SQL was:\n${attemptedSql[attemptedSql.length - 1]}\nIt failed with error:\n${lastSqlError}`
      : undefined

    // Inside a try: a provider blip, dead BYOK key or timeout throws, and on the streaming transport an escaped
    // throw ended the turn with the SSE connection open and zero frames sent.
    let candidate: Awaited<ReturnType<typeof generateSql>>
    try {
      candidate = await generateSql({
        question: args.question,
        schemaDescription,
        provider: integration.provider,
        memoryContext: args.memoryContext,
        systemPromptPrefix,
        repairFeedback: feedback,
        textColumns,
        businessContext: integration.businessContext,
        sqlRules,
      })
    } catch (e) {
      // A transient provider blip must not end the turn; the repair loop retries.
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(`<generation failed: ${lastSqlError}>`)
      continue
    }
    // Captured BEFORE the guard so a repaired retry replaces it, matching the SQL that finally runs.
    sqlExplanation = typeof candidate.explanation === 'string' ? candidate.explanation.trim() : ''

    const guard = validateAndSanitizeLlmSql(candidate.sql, { provider: integration.provider, policy, schemaColumns })
    if (!guard.ok) {
      lastSqlError = guard.reason ?? 'SQL rejected by guardrail'
      attemptedSql.push(candidate.sql)
      await audit(args.userId, guard.violation === 'access' ? 'ACCESS_DENIED' : 'GUARDRAIL_BLOCK', 'critical', {
        role,
        integrationId: integration.id,
        naturalQuery: args.question,
        generatedSql: candidate.sql,
        reason: guard.reason,
        detectedNodes: guard.detectedNodes,
        attempt,
      })
      continue
    }

    const sanitizedSql = guard.sanitized
    let result: QueryResult
    try {
      result = await executeWithTransientRetry(integration.id, () => connector.executeQuery(sanitizedSql))
    } catch (e) {
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(sanitizedSql)
      await db.queryHistory.create({
        data: {
          organizationId: requireOrgContext(),
          integrationId: integration.id,
          userId: args.userId,
          naturalQuery: args.question,
          generatedSql: sanitizedSql,
          success: false,
          errorMessage: `attempt ${attempt + 1}: ${lastSqlError}`,
        },
      })
      await audit(args.userId, 'SQL_EXECUTE_ERROR', 'warning', {
        integrationId: integration.id,
        sql: sanitizedSql,
        error: lastSqlError,
        attempt,
      })
      continue
    }

    await db.queryHistory.create({
      data: {
        organizationId: requireOrgContext(),
        integrationId: integration.id,
        userId: args.userId,
        naturalQuery: args.question,
        generatedSql: sanitizedSql,
        rowCount: result.rowCount,
        executionMs: result.executionMs,
        success: true,
      },
    })
    await audit(args.userId, 'SQL_EXECUTE', 'info', {
      integrationId: integration.id,
      sql: sanitizedSql,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      attempts: attemptedSql.length + 1,
    })
    return {
      kind: 'executed',
      integration: ref,
      finalSql: sanitizedSql,
      result,
      sqlExplanation,
      systemPromptPrefix,
      attempts: attemptedSql.length + 1,
    }
  }

  return { kind: 'failed', integration: ref, lastError: lastSqlError, systemPromptPrefix }
}

/**
 * The two-rule note naming the OTHER connected sources.
 *
 * MEASURED IN UAT with three databases: "Berapa banyak data yang tersimpan di sistem?" was answered "total 45 baris"
 * from ONE of them while the three held 104 rows; and "Bandingkan jumlah pengiriman dengan jumlah pesanan" reported
 * the shipment count relabelled as orders. The model cannot name a missing source it does not know exists.
 */
/** What the user is told when their role has no grant in the chosen source. Names no table: that would leak schema. */
export function forbiddenSourceMessage(integrationName: string): string {
  return `Your role does not have access to the data in ${integrationName}. Ask an administrator to grant access to the tables you need.`
}

export function buildCrossSourceNote(integrationName: string, integrationNames: string[] | undefined): string {
  const otherSources = (integrationNames ?? []).filter((n) => n !== integrationName)
  if (otherSources.length === 0) return ''
  return (
    `Other connected data sources in this workspace: ${otherSources.join(', ')}. ` +
    `This answer uses ${integrationName} ONLY. Two rules follow, and BOTH apply:\n` +
    `1. If the question asks you to compare or combine this result with something those sources would hold, say ` +
    `plainly that THIS ANSWER COVERS ONLY ${integrationName} and name what was not included. Never present a ` +
    `figure from this source as if it described another one.\n` +
    `2. If the question asks about "all", "every", "the system", "the workspace", or the TOTAL amount of data, ` +
    `then this source CANNOT answer it alone: state that the figure covers only ${integrationName}, name the ` +
    `other sources (${otherSources.join(', ')}) that were NOT included, and offer to run it per source. Never ` +
    `present a count from ${integrationName} as the count for the workspace.\n\n`
  )
}
