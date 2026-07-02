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
 *   8. Graceful Indonesian error messages per spec §8.
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

interface RouteCtx {
  params: Promise<{ id: string }>
}

interface QueryBody {
  naturalQuery?: string
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as QueryBody
    const naturalQuery = (body.naturalQuery ?? '').trim()

    if (!naturalQuery) {
      return NextResponse.json(
        { ok: false, error: 'Pertanyaan tidak boleh kosong.' },
        { status: 400 },
      )
    }

    const integration = await db.integration.findFirst({
      where: { id, companyId: user.companyId },
      include: { schemas: { orderBy: { tableName: 'asc' } } },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integrasi tidak ditemukan.' },
        { status: 404 },
      )
    }

    if (integration.status !== 'active') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Maaf, koneksi ke Database ERP Anda terputus. Silakan hubungi admin atau aktifkan kembali integrasi ini di halaman Integrations.',
        },
        { status: 409 },
      )
    }

    if (integration.schemas.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Skema database belum direfleksikan. Silakan jalankan uji koneksi terlebih dahulu agar sistem dapat memetakan tabel & kolom.',
        },
        { status: 409 },
      )
    }

    // Convert cached IntegrationSchema rows → ReflectedTable[] for the LLM prompt.
    const reflectedTables: ReflectedTable[] = integration.schemas.map((s) => ({
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount ?? undefined,
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
        companyId: user.companyId,
      })
      generatedSql = llm.sql
      llmExplanation = llm.explanation
    } catch (e) {
      console.error('[query] generateSql failed', e)
      await writeAudit({
        companyId: user.companyId,
        userId: user.userId,
        action: 'SQL_GENERATE_ERROR',
        severity: 'warning',
        detail: { integrationId: integration.id, naturalQuery, error: e instanceof Error ? e.message : String(e) },
      })
      return NextResponse.json(
        {
          ok: false,
          error:
            'Maaf, layanan AI sedang tidak dapat memproses pertanyaan Anda. Silakan coba beberapa saat lagi.',
        },
        { status: 502 },
      )
    }

    // 2. Guardrail — AST validation (spec §4.3)
    const guard = validateAndSanitizeLlmSql(generatedSql)
    if (!guard.ok) {
      await writeAudit({
        companyId: user.companyId,
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
          reason: guard.reason ?? 'Kueri ditolak oleh guardrail keamanan.',
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
      const result = await connector.executeQuery(sanitizedSql)

      // Record query history — spec §7
      await db.queryHistory.create({
        data: {
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
        companyId: user.companyId,
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
          integrationId: integration.id,
          userId: user.userId,
          naturalQuery,
          generatedSql: sanitizedSql,
          success: false,
          errorMessage: msg,
        },
      })
      await writeAudit({
        companyId: user.companyId,
        userId: user.userId,
        action: 'SQL_EXECUTE_ERROR',
        severity: 'warning',
        detail: { integrationId: integration.id, naturalQuery, sql: sanitizedSql, error: msg },
      })
      console.error('[query] executeQuery failed', e)
      // Don't reflect the raw DB error to the client — it leaks schema/table names.
      return NextResponse.json(
        {
          ok: false,
          error:
            'Maaf, koneksi ke Database ERP Anda terputus atau kueri gagal dieksekusi. ' +
            'Tim teknis telah diberi notifikasi.',
          sql: sanitizedSql,
        },
        { status: 502 },
      )
    }
  } catch (e) {
    return handleApiError(
      e,
      'Maaf, terjadi kesalahan tak terduga saat memproses permintaan Anda. Silakan coba lagi.',
    )
  }
}

function safeParseColumns(raw: string): Array<{ name: string; type: string }> {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((c) => ({
        name: String(c?.name ?? ''),
        type: String(c?.type ?? ''),
      }))
    }
    return []
  } catch {
    return []
  }
}
