import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { encryptConfig } from '@/lib/crypto'
import { isBlockedHost } from '@/lib/llm-config'
import { invalidateMcpToolsCache, disconnectMcpServer } from '@/lib/mcp-client'
import { sanitizeServer } from '../route'

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'http'])

interface RouteContext {
  params: Promise<{ id: string }>
}

interface PatchBody {
  name?: string
  description?: string
  transport?: string
  command?: string
  args?: unknown
  url?: string
  envVars?: Record<string, unknown>
  isEnabled?: boolean
  chatEnabled?: boolean
  agenticEnabled?: boolean
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    await getActiveUser()
    const { id } = await ctx.params
    const server = await db.mcpServer.findUnique({ where: { id } })
    if (!server) {
      return NextResponse.json({ ok: false, error: 'MCP server tidak ditemukan.' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, server: sanitizeServer(server) })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat MCP server.')
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const existing = await db.mcpServer.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'MCP server tidak ditemukan.' }, { status: 404 })
    }

    const body = (await req.json().catch(() => ({}))) as PatchBody
    const data: {
      name?: string
      description?: string
      transport?: string
      command?: string
      args?: string
      url?: string
      envJson?: string
      isEnabled?: boolean
      chatEnabled?: boolean
      agenticEnabled?: boolean
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.description === 'string') data.description = body.description.trim()
    if (typeof body.isEnabled === 'boolean') data.isEnabled = body.isEnabled
    if (typeof body.chatEnabled === 'boolean') data.chatEnabled = body.chatEnabled
    if (typeof body.agenticEnabled === 'boolean') data.agenticEnabled = body.agenticEnabled
    if (typeof body.command === 'string') data.command = body.command.trim()

    if (typeof body.args !== 'undefined') {
      data.args = Array.isArray(body.args) ? JSON.stringify(body.args.map(String)) : '[]'
    }

    const transport = typeof body.transport === 'string' ? body.transport.trim() : undefined
    if (transport) {
      if (!VALID_TRANSPORTS.has(transport)) {
        return NextResponse.json({ ok: false, error: 'transport harus "stdio", "sse", atau "http".' }, { status: 400 })
      }
      data.transport = transport
    }

    if (typeof body.url === 'string') {
      const urlRaw = body.url.trim()
      if (urlRaw) {
        let url: URL
        try {
          url = new URL(urlRaw)
        } catch {
          return NextResponse.json({ ok: false, error: 'url tidak valid.' }, { status: 400 })
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return NextResponse.json({ ok: false, error: 'url harus menggunakan http atau https.' }, { status: 400 })
        }
        if (isBlockedHost(url.hostname)) {
          return NextResponse.json({ ok: false, error: 'url menuju host internal yang diblokir.' }, { status: 400 })
        }
      }
      data.url = urlRaw
    }

    // envVars present in the body (even empty {}) → re-encrypt; absent → preserve.
    if (body.envVars !== undefined) {
      const clean: Record<string, string> = {}
      if (body.envVars && typeof body.envVars === 'object') {
        for (const [k, v] of Object.entries(body.envVars)) {
          if (typeof v === 'string') clean[k] = v
          else if (v !== null && v !== undefined) clean[k] = String(v)
        }
      }
      data.envJson = Object.keys(clean).length > 0 ? encryptConfig(clean) : '{}'
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: false, error: 'Tidak ada field yang dikirim untuk diperbarui.' }, { status: 400 })
    }

    const updated = await db.mcpServer
      .update({ where: { id }, data, select: { id: true, name: true, transport: true, chatEnabled: true, agenticEnabled: true } })
      .catch((e: unknown) => {
        if (isPrismaNotFound(e)) return null
        throw e
      })
    if (!updated) {
      return NextResponse.json({ ok: false, error: 'MCP server tidak ditemukan.' }, { status: 404 })
    }

    // Drop the cached connection + tool list so the next call reconnects fresh.
    await disconnectMcpServer(id)
    await writeAudit({
      userId: user.userId,
      action: 'MCP_SERVER_UPDATE',
      severity: 'info',
      detail: { id: updated.id, name: updated.name, changes: Object.keys(data) },
    })

    return NextResponse.json({ ok: true, server: { id: updated.id, name: updated.name, transport: updated.transport, chatEnabled: updated.chatEnabled, agenticEnabled: updated.agenticEnabled } })
  } catch (e) {
    return handleApiError(e, 'Gagal memperbarui MCP server.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    const { id } = await ctx.params
    const existing = await db.mcpServer.findUnique({
      where: { id },
      select: { id: true, name: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'MCP server tidak ditemukan.' }, { status: 404 })
    }

    await db.mcpServer.delete({ where: { id } }).catch((e: unknown) => {
      if (isPrismaNotFound(e)) return null
      throw e
    })

    await disconnectMcpServer(id)
    await writeAudit({
      userId: user.userId,
      action: 'MCP_SERVER_DELETE',
      severity: 'warning',
      detail: { id: existing.id, name: existing.name },
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Gagal menghapus MCP server.')
  }
}
