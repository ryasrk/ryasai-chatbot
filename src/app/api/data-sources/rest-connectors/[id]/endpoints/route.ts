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
    await getActiveUser()
    const { id } = await ctx.params
    const connector = await db.restApiConnector.findFirst({ // nosemgrep
      where: { id },
      select: { id: true },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector not found.' },
        { status: 404 },
      )
    }

    const items = await db.restApiEndpoint.findMany({ // nosemgrep
      where: { connectorId: connector.id },
      orderBy: [{ method: 'asc' }, { path: 'asc' }],
    })
    return NextResponse.json({ ok: true, items })
  } catch (e) {
    return handleApiError(e, 'Failed to load REST connector endpoints.')
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()

    const { id } = await ctx.params
    const connector = await db.restApiConnector.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector not found.' },
        { status: 404 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as CreateEndpointBody
    const method = (body.method ?? '').trim().toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return NextResponse.json(
        { ok: false, error: 'Method must be GET, POST, PUT, PATCH, or DELETE.' },
        { status: 400 },
      )
    }

    const path = normalizeEndpointPath(body.path ?? '')
    if (path === '/') {
      return NextResponse.json(
        { ok: false, error: 'Endpoint path is required.' },
        { status: 400 },
      )
    }

    const item = await db.restApiEndpoint.create({
      data: {
        organizationId: user.organizationId,
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
    return handleApiError(e, 'Failed to create endpoint whitelist.')
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return JSON.stringify(value)
}
