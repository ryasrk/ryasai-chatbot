/**
 * Spec §3.2 / §5.1 — Return cached reflected schema (tables + columns + rowCount).
 * ----------------------------------------------------------------------------
 * GET /api/integrations/[id]/schema
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true, name: true, provider: true, status: true },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integrasi tidak ditemukan.' },
        { status: 404 },
      )
    }

    const rows = await db.integrationSchema.findMany({
      where: { integrationId: id },
      orderBy: { tableName: 'asc' },
    })

    const tables = rows.map((r) => ({
      id: r.id,
      tableName: r.tableName,
      columns: safeParseColumns(r.columns),
      rowCount: r.rowCount,
      reflectedAt: r.reflectedAt,
    }))

    return NextResponse.json({
      ok: true,
      data: {
        integrationId: integration.id,
        name: integration.name,
        provider: integration.provider,
        status: integration.status,
        tableCount: tables.length,
        tables,
      },
    })
  } catch (e) {
    console.error('[GET /api/integrations/[id]/schema]', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Gagal memuat skema integrasi.' },
      { status: 500 },
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
