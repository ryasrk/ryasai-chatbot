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
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { decryptConfig, maskConfig } from '@/lib/crypto'
import { connectorRegistry } from '@/lib/connectors'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({
      where: { id, companyId: user.companyId },
      include: {
        schemas: {
          orderBy: { tableName: 'asc' },
        },
      },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integrasi tidak ditemukan.' },
        { status: 404 },
      )
    }

    const masked = maskConfig(decryptConfig(integration.encryptedConfig))

    const tables = integration.schemas.map((s) => ({
      id: s.id,
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount,
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
        tables,
        tableCount: tables.length,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat detail integrasi.')
  }
}

interface PatchBody {
  status?: 'active' | 'inactive' | 'error'
  name?: string
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as PatchBody

    const existing = await db.integration.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true, name: true, status: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Integrasi tidak ditemukan.' },
        { status: 404 },
      )
    }

    const data: { status?: string; name?: string } = {}
    if (body.status) {
      const s = body.status.toLowerCase()
      if (s !== 'active' && s !== 'inactive' && s !== 'error') {
        return NextResponse.json(
          { ok: false, error: "Status harus 'active', 'inactive', atau 'error'." },
          { status: 400 },
        )
      }
      data.status = s
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim()
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Tidak ada field yang dikirim untuk diperbarui.' },
        { status: 400 },
      )
    }

    const updated = await db.integration.update({
      where: { id },
      data,
    })

    await writeAudit({
      companyId: user.companyId,
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
    return handleApiError(e, 'Gagal memperbarui integrasi.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params

    const existing = await db.integration.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true, name: true, provider: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Integrasi tidak ditemukan.' },
        { status: 404 },
      )
    }

    // Drop connector pool first — spec §3.2
    connectorRegistry.drop(id)

    await db.integration.delete({ where: { id } })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'INTEGRATION_DELETE',
      severity: 'warning',
      detail: { integrationId: id, name: existing.name, provider: existing.provider },
    })

    return NextResponse.json({ ok: true, data: { id, deleted: true } })
  } catch (e) {
    return handleApiError(e, 'Gagal menghapus integrasi.')
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
