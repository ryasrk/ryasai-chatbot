import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { decryptConfig, encryptConfig, maskConfig } from '@/lib/crypto'
import { isBlockedHost } from '@/lib/llm-config'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface PatchConnectorBody {
  name?: string
  baseUrl?: string
  authType?: string
  authConfig?: Record<string, unknown>
  timeoutMs?: number
  isActive?: boolean
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const connector = await db.restApiConnector.findFirst({ // nosemgrep
      where: { id },
      include: { endpoints: { orderBy: [{ method: 'asc' }, { path: 'asc' }] } },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector not found.' },
        { status: 404 },
      )
    }

    const authConfig = connector.encryptedAuthConfig
      ? maskConfig(decryptConfig(connector.encryptedAuthConfig))
      : {}

    return NextResponse.json({
      ok: true,
      data: {
        id: connector.id,
        name: connector.name,
        baseUrl: connector.baseUrl,
        authType: connector.authType,
        authConfig,
        isActive: connector.isActive,
        timeoutMs: connector.timeoutMs,
        createdAt: connector.createdAt,
        updatedAt: connector.updatedAt,
        endpoints: connector.endpoints,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load REST connector.')
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.restApiConnector.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, encryptedAuthConfig: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'REST connector not found.' },
        { status: 404 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as PatchConnectorBody
    const data: {
      name?: string
      baseUrl?: string
      authType?: string
      encryptedAuthConfig?: string | null
      timeoutMs?: number
      isActive?: boolean
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      try {
        const url = parseBaseUrl(body.baseUrl)
        if (!url) {
          return NextResponse.json(
            { ok: false, error: 'Base URL is invalid.' },
            { status: 400 },
          )
        }
        data.baseUrl = url
      } catch (e) {
        return NextResponse.json(
          { ok: false, error: e instanceof Error ? e.message : 'Base URL is invalid.' },
          { status: 400 },
        )
      }
    }
    if (typeof body.authType === 'string') {
      const authType = body.authType.trim().toUpperCase()
      if (authType !== 'NONE' && authType !== 'BEARER' && authType !== 'API_KEY_HEADER') {
        return NextResponse.json(
          { ok: false, error: 'Auth type must be NONE, BEARER, or API_KEY_HEADER.' },
          { status: 400 },
        )
      }
      data.authType = authType
      data.encryptedAuthConfig =
        authType === 'NONE' ? null : encryptConfig(body.authConfig ?? {})
    } else if (body.authConfig) {
      data.encryptedAuthConfig = encryptConfig(body.authConfig)
    }
    if (typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)) {
      data.timeoutMs = Math.min(Math.max(Math.floor(body.timeoutMs), 1000), 120000)
    }
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await db.restApiConnector.update({
      where: { id: existing.id },
      data,
      select: {
        id: true,
        name: true,
        baseUrl: true,
        authType: true,
        isActive: true,
        timeoutMs: true,
        updatedAt: true,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'REST_CONNECTOR_UPDATE',
      severity: 'warning',
      detail: { connectorId: updated.id, beforeName: existing.name, after: data },
    })

    return NextResponse.json({ ok: true, data: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update REST connector.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.restApiConnector.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'REST connector not found.' },
        { status: 404 },
      )
    }

    await db.restApiConnector.delete({ where: { id: existing.id } })

    await writeAudit({
      userId: user.userId,
      action: 'REST_CONNECTOR_DELETE',
      severity: 'warning',
      detail: { connectorId: existing.id, name: existing.name },
    })

    return NextResponse.json({ ok: true, data: { id: existing.id, deleted: true } })
  } catch (e) {
    return handleApiError(e, 'Failed to delete REST connector.')
  }
}

function parseBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (isBlockedHost(url.hostname)) {
    throw new Error('Base URL points to a blocked internal host.')
  }
  return url.toString().replace(/\/$/, '')
}
