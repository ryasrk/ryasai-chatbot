import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeEndpointPath } from '@/lib/rest-api-connectors'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface CreateEndpointBody {
  method?: string
  path?: string
  description?: string
  parameterSchema?: unknown
  sampleRequest?: unknown
  sampleResponse?: unknown
  isEnabled?: boolean
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const connector = await db.restApiConnector.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector tidak ditemukan.' },
        { status: 404 },
      )
    }

    const items = await db.restApiEndpoint.findMany({
      where: { connectorId: connector.id },
      orderBy: [{ method: 'asc' }, { path: 'asc' }],
    })
    return NextResponse.json({ ok: true, items })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat endpoint REST connector.')
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json(
        { ok: false, error: 'Hanya admin yang dapat membuat endpoint whitelist.' },
        { status: 403 },
      )
    }

    const { id } = await ctx.params
    const connector = await db.restApiConnector.findFirst({
      where: { id, companyId: user.companyId },
      select: { id: true, name: true },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector tidak ditemukan.' },
        { status: 404 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as CreateEndpointBody
    const method = (body.method ?? '').trim().toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return NextResponse.json(
        { ok: false, error: 'Method harus GET, POST, PUT, PATCH, atau DELETE.' },
        { status: 400 },
      )
    }

    const path = normalizeEndpointPath(body.path ?? '')
    if (path === '/') {
      return NextResponse.json(
        { ok: false, error: 'Path endpoint wajib diisi.' },
        { status: 400 },
      )
    }

    const item = await db.restApiEndpoint.create({
      data: {
        connectorId: connector.id,
        method,
        path,
        description: stringOrNull(body.description),
        parameterSchema: jsonOrNull(body.parameterSchema),
        sampleRequest: jsonOrNull(body.sampleRequest),
        sampleResponse: jsonOrNull(body.sampleResponse),
        isEnabled: body.isEnabled ?? true,
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'REST_ENDPOINT_CREATE',
      severity: 'info',
      detail: {
        connectorId: connector.id,
        connectorName: connector.name,
        endpointId: item.id,
        method: item.method,
        path: item.path,
      },
    })

    return NextResponse.json({ ok: true, data: item }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat endpoint whitelist.')
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return JSON.stringify(value)
}
