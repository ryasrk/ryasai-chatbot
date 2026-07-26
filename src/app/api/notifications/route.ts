import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { encryptConfig, maskConfig, decryptConfig } from '@/lib/crypto'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

const VALID_TYPES = new Set(['webhook', 'email', 'telegram'])

// Strip encryptedConfig → configured boolean. Decrypt-mask for display.
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

export async function GET() {
  try {
    await getActiveUser()
    const configs = await db.notificationConfig.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ ok: true, configs: configs.map(maskRow) })
  } catch (e) {
    return handleApiError(e, 'Failed to load notification configuration.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      type?: string
      config?: Record<string, unknown>
    }

    const name = (body.name ?? '').trim()
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required.' }, { status: 400 })
    }
    const type = (body.type ?? '').trim()
    if (!VALID_TYPES.has(type)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid type. Use: webhook | email | telegram.' },
        { status: 400 },
      )
    }
    const config = body.config
    if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Config is required.' },
        { status: 400 },
      )
    }

    // Pack type into the encrypted blob so sendNotification can branch on it
    // without a separate arg.
    const encryptedConfig = encryptConfig({ type, ...config })

    const created = await db.notificationConfig.create({
      data: { name, type, encryptedConfig, isActive: true },
    })

    await writeAudit({
      userId: user.userId,
      action: 'NOTIFICATION_CONFIG_CREATE',
      severity: 'info',
      detail: { id: created.id, name, type },
    })

    return NextResponse.json({ ok: true, config: maskRow(created) }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Failed to create notification configuration.')
  }
}
