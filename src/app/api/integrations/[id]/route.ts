import { enterWithOrg } from '@/lib/prisma-tenant'
/**
 * Spec §5.1 — Integration detail / update / delete endpoints.
 * ----------------------------------------------------------------------------
 * GET    /api/integrations/[id]   — single integration detail + reflected schema (masked config)
 * PATCH  /api/integrations/[id]   — toggle status active/inactive (and rename)
 * DELETE /api/integrations/[id]   — remove integration + drop connector from registry pool
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { decryptConfig, maskConfig } from '@/lib/crypto'
import { connectorRegistry } from '@/lib/connectors'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({ // nosemgrep
      where: { id },
      include: {
        schemas: {
          orderBy: { tableName: 'asc' },
        },
      },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    const masked = maskConfig(decryptConfig(integration.encryptedConfig))

    const tables = integration.schemas.map((s) => ({
      id: s.id,
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount,
      sampleRow: s.sampleRow ? safeParseJson(s.sampleRow) : undefined,
      reflectedAt: s.reflectedAt,
    }))

    return NextResponse.json({
      ok: true,
      data: {
        id: integration.id,
        name: integration.name,
        type: integration.type,
        provider: integration.provider,
        status: integration.status,
        lastTestedAt: integration.lastTestedAt,
        lastTestOk: integration.lastTestOk,
        createdAt: integration.createdAt,
        updatedAt: integration.updatedAt,
        config: masked,
        businessContext: integration.businessContext,
        tables,
        tableCount: tables.length,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load integration details.')
  }
}

interface PatchBody {
  status?: 'active' | 'inactive' | 'error'
  name?: string
  businessContext?: string
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as PatchBody

    const existing = await db.integration.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, status: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    const data: { status?: string; name?: string; businessContext?: string } = {}
    if (body.status) {
      const s = body.status.toLowerCase()
      if (s !== 'active' && s !== 'inactive' && s !== 'error') {
        return NextResponse.json(
          { ok: false, error: "Status must be 'active', 'inactive', or 'error'." },
          { status: 400 },
        )
      }
      data.status = s
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim()
    }
    if (typeof body.businessContext === 'string') {
      data.businessContext = body.businessContext
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await db.integration.update({
      where: { id },
      data,
    }).catch((e: unknown) => {
      if (isPrismaNotFound(e)) return null
      throw e
    })
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_UPDATE',
      severity: 'info',
      detail: { integrationId: id, before: existing, after: data },
    })

    return NextResponse.json({
      ok: true,
      data: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        updatedAt: updated.updatedAt,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to update integration.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params

    const existing = await db.integration.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, provider: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    // Drop connector pool first — spec §3.2
    connectorRegistry.drop(id)

    const result = await db.integration.deleteMany({ where: { id } })
    if (result.count === 0) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_DELETE',
      severity: 'warning',
      detail: { integrationId: id, name: existing.name, provider: existing.provider },
    })

    return NextResponse.json({ ok: true, data: { id, deleted: true } })
  } catch (e) {
    return handleApiError(e, 'Failed to delete integration.')
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
