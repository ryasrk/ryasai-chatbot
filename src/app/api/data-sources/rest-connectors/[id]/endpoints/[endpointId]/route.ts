import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

interface RouteContext {
  params: Promise<{ id: string; endpointId: string }>
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()

    const { id, endpointId } = await ctx.params

    // Verify the connector belongs to the company
    const connector = await db.restApiConnector.findFirst({
      where: { id },
      select: { id: true, name: true },
    })
    if (!connector) {
      return NextResponse.json(
        { ok: false, error: 'REST connector tidak ditemukan.' },
        { status: 404 },
      )
    }

    // Verify the endpoint belongs to this connector
    const endpoint = await db.restApiEndpoint.findFirst({
      where: { id: endpointId, connectorId: connector.id },
      select: { id: true, method: true, path: true },
    })
    if (!endpoint) {
      return NextResponse.json(
        { ok: false, error: 'Endpoint tidak ditemukan.' },
        { status: 404 },
      )
    }

    await db.restApiEndpoint.delete({ where: { id: endpoint.id } })

    await writeAudit({
      userId: user.userId,
      action: 'REST_ENDPOINT_DELETE',
      severity: 'warning',
      detail: {
        connectorId: connector.id,
        connectorName: connector.name,
        endpointId: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
      },
    })

    return NextResponse.json({ ok: true, data: { id: endpoint.id, deleted: true } })
  } catch (e) {
    return handleApiError(e, 'Gagal menghapus endpoint whitelist.')
  }
}
