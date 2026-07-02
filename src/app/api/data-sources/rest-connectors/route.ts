import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { encryptConfig } from '@/lib/crypto'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

interface CreateConnectorBody {
  name?: string
  baseUrl?: string
  authType?: string
  authConfig?: Record<string, unknown>
  timeoutMs?: number
}

export async function GET() {
  try {
    const user = await getActiveUser()
    const items = await db.restApiConnector.findMany({
      where: { companyId: user.companyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        authType: true,
        isActive: true,
        timeoutMs: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { endpoints: true, requestLogs: true } },
      },
    })

    return NextResponse.json({ ok: true, items })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat REST API connectors.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json(
        { ok: false, error: 'Hanya admin yang dapat membuat REST connector.' },
        { status: 403 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as CreateConnectorBody
    const parsed = parseConnectorInput(body)
    if ('error' in parsed) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
    }

    const connector = await db.restApiConnector.create({
      data: {
        companyId: user.companyId,
        name: parsed.name,
        baseUrl: parsed.baseUrl,
        authType: parsed.authType,
        encryptedAuthConfig:
          parsed.authType === 'NONE' ? null : encryptConfig(parsed.authConfig),
        timeoutMs: parsed.timeoutMs,
      },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        authType: true,
        isActive: true,
        timeoutMs: true,
        createdAt: true,
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'REST_CONNECTOR_CREATE',
      severity: 'warning',
      detail: { connectorId: connector.id, name: connector.name, authType: connector.authType },
    })

    return NextResponse.json({ ok: true, data: connector }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat REST API connector.')
  }
}

function parseConnectorInput(body: CreateConnectorBody):
  | {
      name: string
      baseUrl: string
      authType: 'NONE' | 'BEARER' | 'API_KEY_HEADER'
      authConfig: Record<string, unknown>
      timeoutMs: number
    }
  | { error: string } {
  const name = (body.name ?? '').trim()
  if (!name) return { error: 'Nama connector wajib diisi.' }

  let baseUrl: string
  try {
    const url = new URL((body.baseUrl ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'Base URL harus menggunakan http atau https.' }
    }
    baseUrl = url.toString().replace(/\/$/, '')
  } catch {
    return { error: 'Base URL tidak valid.' }
  }

  const authType = (body.authType ?? 'NONE').trim().toUpperCase()
  if (authType !== 'NONE' && authType !== 'BEARER' && authType !== 'API_KEY_HEADER') {
    return { error: 'Auth type harus NONE, BEARER, atau API_KEY_HEADER.' }
  }

  const timeoutMs =
    typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
      ? Math.min(Math.max(Math.floor(body.timeoutMs), 1000), 120000)
      : 30000

  return {
    name,
    baseUrl,
    authType,
    authConfig: body.authConfig ?? {},
    timeoutMs,
  }
}
