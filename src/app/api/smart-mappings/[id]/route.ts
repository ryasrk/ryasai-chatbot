import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeSmartMappingUpdate } from '@/lib/smart-mapping'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const update = normalizeSmartMappingUpdate(body)

    const data: Record<string, string> = {}
    if (update.sourceName) data.sourceName = update.sourceName
    if (update.entityType) data.entityType = update.entityType
    if (update.routingHint) data.routingHint = update.routingHint
    if (update.status) data.status = update.status
    if (update.fields) data.fieldsJson = JSON.stringify(update.fields)
    if (update.synonyms) data.synonymsJson = JSON.stringify(update.synonyms)

    const current = await db.smartMapping.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true },
    })
    if (!current) {
      return NextResponse.json({ ok: false, error: 'Mapping tidak ditemukan.' }, { status: 404 })
    }

    const row = await db.smartMapping.update({
      where: { id },
      data,
    })
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'SMART_MAPPING_UPDATE',
      severity: 'info',
      detail: { id, status: row.status, routingHint: row.routingHint },
    })

    return NextResponse.json({
      ok: true,
      item: {
        ...row,
        fields: safeJson(row.fieldsJson, []),
        synonyms: safeJson(row.synonymsJson, []),
      },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memperbarui smart mapping.')
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const { id } = await ctx.params
    const current = await db.smartMapping.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true, sourceName: true },
    })
    if (!current) {
      return NextResponse.json({ ok: true, deleted: false })
    }

    await db.smartMapping.delete({ where: { id } })
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'SMART_MAPPING_DELETE',
      severity: 'warning',
      detail: { id, sourceName: current.sourceName },
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Gagal menghapus smart mapping.')
  }
}

function safeJson(raw: string, fallback: unknown) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}
