/**
 * Spec §3.3 / §5.1 / §4.3 / §7 — Text-to-SQL execution against a configured integration.
 * ----------------------------------------------------------------------------
 * POST /api/integrations/[id]/query
 *   body: { naturalQuery: string }
 *
 * Pipeline:
 *   1. Load integration + cached IntegrationSchema rows.
 *   2. Convert cached rows → ReflectedTable[] (parse columns JSON).
 *   3. describeSchema() → compact schema prompt.
 *   4. generateSql() → raw LLM SQL.
 *   5. validateAndSanitizeLlmSql() — AST guardrail (spec §4.3).
 *   6. If blocked: GUARDRAIL_BLOCK audit (critical), return { ok:false, reason, generatedSql }.
 *   7. If ok: connector.executeQuery(sanitizedSql), record QueryHistory, write SQL_EXECUTE
 *      audit log, return { ok:true, sql, rows, rowCount, executionMs }.
 *   8. Graceful English error messages per spec §8.
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
  type ReflectedTable,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import { generateSql } from '@/lib/ai'
import { withSqlConcurrency } from '@/lib/tool-utils'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface QueryBody {
  naturalQuery?: string
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as QueryBody
    const naturalQuery = (body.naturalQuery ?? '').trim()

    if (!naturalQuery) {
      return NextResponse.json(
        { ok: false, error: 'Question cannot be empty.' },
        { status: 400 },
      )
    }

    const integration = await db.integration.findFirst({ // nosemgrep
      where: { id },
      include: { schemas: { orderBy: { tableName: 'asc' } } },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    if (integration.status !== 'active') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Sorry, the connection to your ERP Database is disconnected. Please contact admin or re-enable this integration on the Integrations page.',
        },
        { status: 409 },
      )
    }

    if (integration.schemas.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Database schema has not been reflected. Please run a connection test first so the system can map tables & columns.',
        },
        { status: 409 },
      )
    }

    // Convert cached IntegrationSchema rows → ReflectedTable[] for the LLM prompt.
    const reflectedTables: ReflectedTable[] = integration.schemas.map((s) => ({
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(s.sampleRow),
    }))
    const schemaDescription = describeSchema(reflectedTables)

    // 1. Generate SQL via LLM
    let generatedSql = ''
    let llmExplanation = ''
    try {
      const llm = await generateSql({
        question: naturalQuery,
        schemaDescription,
        provider: integration.provider,
      })
      generatedSql = llm.sql
      llmExplanation = llm.explanation
    } catch (e) {
      console.error('[query] generateSql failed', e)
      await writeAudit({
        userId: user.userId,
        action: 'SQL_GENERATE_ERROR',
        severity: 'warning',
        detail: { integrationId: integration.id, naturalQuery, error: e instanceof Error ? e.message : String(e) },
      })
      return NextResponse.json(
        {
          ok: false,
          error:
            'Sorry, the AI service is currently unable to process your question. Please try again later.',
        },
        { status: 502 },
      )
    }

    // 2. Guardrail — AST validation (spec §4.3)
    const guard = validateAndSanitizeLlmSql(generatedSql)
    if (!guard.ok) {
      await writeAudit({
        userId: user.userId,
        action: 'GUARDRAIL_BLOCK',
        severity: 'critical',
        detail: {
          integrationId: integration.id,
          naturalQuery,
          generatedSql,
          reason: guard.reason,
          detectedNodes: guard.detectedNodes,
        },
      })
      return NextResponse.json(
        {
          ok: false,
          reason: guard.reason ?? 'Query rejected by security guardrail.',
          generatedSql,
        },
        { status: 403 },
      )
    }

    const sanitizedSql = guard.sanitized

    // 3. Execute the validated SQL via the connector
    const connector = connectorRegistry.getConnector(
      integration.id,
      integration.provider,
      decryptConfig(integration.encryptedConfig),
    )

    try {
      const result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sanitizedSql))

      // Record query history — spec §7
      await db.queryHistory.create({
        data: {
          organizationId: user.organizationId,
          integrationId: integration.id,
          userId: user.userId,
          naturalQuery,
          generatedSql: sanitizedSql,
          rowCount: result.rowCount,
          executionMs: result.executionMs,
          success: true,
        },
      })

      await writeAudit({
        userId: user.userId,
        action: 'SQL_EXECUTE',
        severity: 'info',
        detail: {
          integrationId: integration.id,
          naturalQuery,
          sql: sanitizedSql,
          rowCount: result.rowCount,
          executionMs: result.executionMs,
        },
      })

      return NextResponse.json({
        ok: true,
        sql: sanitizedSql,
        explanation: llmExplanation,
        rows: result.rows,
        rowCount: result.rowCount,
        executionMs: result.executionMs,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db.queryHistory.create({
        data: {
          organizationId: user.organizationId,
          integrationId: integration.id,
          userId: user.userId,
          naturalQuery,
          generatedSql: sanitizedSql,
          success: false,
          errorMessage: msg,
        },
      })
      await writeAudit({
        userId: user.userId,
        action: 'SQL_EXECUTE_ERROR',
        severity: 'warning',
        detail: { integrationId: integration.id, naturalQuery, sql: sanitizedSql, error: msg },
      })
      console.error('[query] executeQuery failed', e)
      const tableMissing = /no such table|relation .* does not exist|table .* doesn'?t exist/i.test(msg)
      return NextResponse.json(
        {
          ok: false,
          error: tableMissing
            ? 'Database table not found. The schema may be outdated. Please re-run the connection test on the Integrations page to update the schema.'
            : 'Sorry, the query failed to execute. Please try a different question or contact admin.',
          sql: sanitizedSql,
        },
        { status: tableMissing ? 409 : 502 },
      )
    }
  } catch (e) {
    return handleApiError(
      e,
      'Sorry, an unexpected error occurred while processing your request. Please try again.',
    )
  }
}

function safeParseColumns(raw: string): Array<{ name: string; type: string; primaryKey?: boolean; notNull?: boolean; foreignKey?: string; distinctValues?: string[] }> {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((c) => ({
        name: String(c?.name ?? ''),
        type: String(c?.type ?? ''),
        primaryKey: Boolean(c?.primaryKey) || undefined,
        notNull: Boolean(c?.notNull) || undefined,
        foreignKey: c?.foreignKey ? String(c.foreignKey) : undefined,
        distinctValues: Array.isArray(c?.distinctValues) ? c.distinctValues.map(String) : undefined,
      }))
    }
    return []
  } catch {
    return []
  }
}

function safeParseSampleRow(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    return undefined
  } catch {
    return undefined
  }
}
