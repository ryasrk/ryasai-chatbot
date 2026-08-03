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
import { decryptConfig } from '@/lib/crypto'
import { connectorRegistry } from '@/lib/connectors'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'

interface RouteCtx {
  params: Promise<{ id: string }>
}

const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest, ctx: RouteCtx) {
  try {
    await getActiveUser()
    const { id } = await ctx.params
    const refresh = new URL(req.url).searchParams.get('refresh') === '1'

    const integration = await db.integration.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, provider: true, status: true, encryptedConfig: true, organizationId: true },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    let rows = await db.integrationSchema.findMany({ // nosemgrep
      where: { integrationId: id },
      orderBy: { tableName: 'asc' },
    })

    // ponytail: no cron — refresh on demand and surface staleness to the log.
    const oldestReflectedAt = rows[0]?.reflectedAt
    const stale = !!oldestReflectedAt && Date.now() - oldestReflectedAt.getTime() > SCHEMA_CACHE_TTL_MS
    if (stale) {
      console.log(`[schema] integration ${id} cached schema is older than 24h (reflectedAt ${oldestReflectedAt.toISOString()}) — call ?refresh=1 to re-reflect`)
    }

    if (refresh) {
      try {
        const connector = connectorRegistry.getConnector(
          id,
          integration.provider,
          decryptConfig(integration.encryptedConfig),
        )
        const tables = await connector.fetchSchema()
        await db.integrationSchema.deleteMany({ where: { integrationId: id } })
        await db.integrationSchema.createMany({
          data: tables.map((t) => ({
            organizationId: integration.organizationId,
            integrationId: id,
            tableName: t.tableName,
            columns: JSON.stringify(t.columns ?? []),
            rowCount: t.rowCount ?? null,
            sampleRow: t.sampleRow ? JSON.stringify(t.sampleRow) : null,
          })),
        })
        invalidateSourceEmbeddingCache()
        console.log(`[schema] integration ${id} re-reflected via ?refresh=1 (${tables.length} tables)`)
        rows = await db.integrationSchema.findMany({ // nosemgrep
          where: { integrationId: id },
          orderBy: { tableName: 'asc' },
        })
      } catch (e) {
        console.error(`[schema] refresh failed for integration ${id}:`, e)
        return NextResponse.json(
          { ok: false, error: 'Schema refresh failed. Check the connection and re-run the test.' },
          { status: 502 },
        )
      }
    }

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
