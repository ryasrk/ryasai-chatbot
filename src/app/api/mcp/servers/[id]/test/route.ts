import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { testMcpServer, invalidateMcpToolsCache } from '@/lib/mcp-client'

/**
 * POST /api/mcp/servers/[id]/test — connect to a saved MCP server and list tools.
 *
 * The Quick Connect panel (plugins view) calls this after creating a server.
 * It existed in the UI contract (mcp-quick-connect.tsx) but was never
 * implemented — every quick-connect ended with a 404 rendered as
 * "Connection test failed."
 *
 * ponytail: testMcpServer opens a NON-cached connection and closes it in
 * finally — repeated test clicks don't leak stdio children or SSE sockets.
 * The aggregated tools cache is invalidated so the next chat turn sees the
 * new server's tools without a restart.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params

    const server = await db.mcpServer.findFirst({
      where: { id },
      select: { id: true, name: true, isEnabled: true },
    })
    if (!server) {
      return NextResponse.json({ ok: false, error: 'MCP server not found.' }, { status: 404 })
    }

    const result = await testMcpServer(id)

    if (result.ok) {
      invalidateMcpToolsCache()
      await writeAudit({
        userId: user.userId,
        action: 'MCP_SERVER_TEST',
        severity: 'info',
        detail: { serverId: id, name: server.name, toolCount: result.toolCount ?? 0 },
      }).catch(() => {})
      return NextResponse.json({ ok: true, tools: result.tools ?? [], toolCount: result.toolCount ?? 0 })
    }

    await writeAudit({
      userId: user.userId,
      action: 'MCP_SERVER_TEST_FAILED',
      severity: 'warning',
      detail: { serverId: id, name: server.name, error: result.error ?? 'unknown' },
    }).catch(() => {})

    // ok:false with 200 — the UI contract reads { ok, error } from the body and
    // renders the diagnostic; a non-2xx would show a generic toast instead.
    return NextResponse.json({ ok: false, error: result.error ?? 'Connection test failed.' })
  } catch (e) {
    return handleApiError(e, 'Failed to test MCP server.')
  }
}
