/**
 * Spec §3.2 / §5.1 — Return cached reflected schema (tables + columns + rowCount).
 * ----------------------------------------------------------------------------
 * GET /api/integrations/[id]/schema
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await getActiveUser()
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({
      where: { id },
      select: { id: true, name: true, provider: true, status: true },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
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
      sampleRow: r.sampleRow ? safeParseJson(r.sampleRow) : undefined,
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
    return handleApiError(e, 'Failed to load integration schema.')
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

function safeParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    return undefined
  } catch {
    return undefined
  }
}
