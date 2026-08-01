import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateApiKey, maskApiKey } from '@/lib/api-keys'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'

interface CreateApiKeyBody {
  label?: string
  requestLimitPerMinute?: number | null
  dailyRequestLimit?: number | null
}

export async function GET() {
  try {
    await getActiveUser()
    const items = await db.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        isActive: true,
        requestLimitPerMinute: true,
        dailyRequestLimit: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      ok: true,
      items: items.map((item) => ({
        ...item,
        maskedKey: maskApiKey(item.keyPrefix),
      })),
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load API keys.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')

    const body = (await req.json().catch(() => ({}))) as CreateApiKeyBody
    const label = (body.label ?? '').trim()
    if (!label) {
      return NextResponse.json(
        { ok: false, error: 'API key label is required.' },
        { status: 400 },
      )
    }

    const generated = generateApiKey()
    const item = await db.apiKey.create({
      data: {
        organizationId: user.organizationId,
        label,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        requestLimitPerMinute: normalizeLimit(body.requestLimitPerMinute),
        dailyRequestLimit: normalizeLimit(body.dailyRequestLimit),
      },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        isActive: true,
        requestLimitPerMinute: true,
        dailyRequestLimit: true,
        createdAt: true,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'API_KEY_CREATE',
      severity: 'warning',
      detail: { apiKeyId: item.id, label: item.label, keyPrefix: item.keyPrefix },
    })

    return NextResponse.json(
      {
        ok: true,
        apiKey: generated.plainText,
        item: {
          ...item,
          maskedKey: maskApiKey(item.keyPrefix),
        },
      },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Failed to create API key.')
  }
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}
