import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { encryptConfig, maskConfig, decryptConfig } from '@/lib/crypto'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

const VALID_TYPES = new Set(['webhook', 'email', 'telegram'])

interface RouteContext {
  params: Promise<{ id: string }>
}

function maskRow(row: {
  id: string
  name: string
  type: string
  encryptedConfig: string
  isActive: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  let masked: Record<string, unknown> = {}
  try {
    masked = maskConfig(decryptConfig(row.encryptedConfig))
  } catch {
    masked = { configured: false }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    configured: true,
    maskedConfig: masked,
  }
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    await getActiveUser()
    const { id } = await ctx.params
    const config = await db.notificationConfig.findFirst({ where: { id } })
    if (!config) {
      return NextResponse.json(
        { ok: false, error: 'Notification configuration not found.' },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true, config: maskRow(config) })
  } catch (e) {
    return handleApiError(e, 'Failed to load notification configuration.')
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()

    const { id } = await ctx.params
    const existing = await db.notificationConfig.findFirst({
      where: { id },
      select: { id: true, name: true, type: true, encryptedConfig: true, isActive: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Notification configuration not found.' },
        { status: 404 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      type?: string
      config?: Record<string, unknown>
      isActive?: boolean
    }

    const data: {
      name?: string
      type?: string
      encryptedConfig?: string
      isActive?: boolean
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()

    const changingType = typeof body.type === 'string'
    if (changingType) {
      const type = body.type!.trim()
      if (!VALID_TYPES.has(type)) {
        return NextResponse.json(
          { ok: false, error: 'Invalid type. Use: webhook | email | telegram.' },
          { status: 400 },
        )
      }
      data.type = type
    }

    // Re-encrypt when config is replaced OR type changes (type is packed into
    // the blob). If only type changes and no new config is supplied, rewrite
    // the blob with the new type and the existing credentials.
    if (body.config && typeof body.config === 'object' && Object.keys(body.config).length > 0) {
      const newType = (data.type ?? existing.type) as string
      data.encryptedConfig = encryptConfig({ type: newType, ...body.config })
    } else if (changingType) {
      try {
        const prev = decryptConfig(existing.encryptedConfig)
        prev.type = data.type as string
        data.encryptedConfig = encryptConfig(prev)
      } catch {
        // can't re-pack a corrupt blob — leave as-is, sendNotification will
        // surface the decrypt error at send time.
      }
    }

    if (typeof body.isActive === 'boolean') data.isActive = body.isActive

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await db.notificationConfig
      .update({ where: { id: existing.id }, data })
      .catch((e: unknown) => {
        if (isPrismaNotFound(e)) return null
        throw e
      })
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: 'Notification configuration not found.' },
        { status: 404 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'NOTIFICATION_CONFIG_UPDATE',
      severity: 'info',
      detail: { id: updated.id, name: updated.name, changes: Object.keys(data) },
    })

    return NextResponse.json({ ok: true, config: maskRow(updated) })
  } catch (e) {
    return handleApiError(e, 'Failed to update notification configuration.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()

    const { id } = await ctx.params
    const existing = await db.notificationConfig.findFirst({
      where: { id },
      select: { id: true, name: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Notification configuration not found.' },
        { status: 404 },
      )
    }

    // onDelete: SetNull on ScheduledRun means the FK is cleared on delete.
    const result = await db.notificationConfig.deleteMany({ where: { id } })
    if (result.count === 0) {
      return NextResponse.json(
        { ok: false, error: 'Notification configuration not found.' },
        { status: 404 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'NOTIFICATION_CONFIG_DELETE',
      severity: 'warning',
      detail: { id: existing.id, name: existing.name },
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Failed to delete notification configuration.')
  }
}
