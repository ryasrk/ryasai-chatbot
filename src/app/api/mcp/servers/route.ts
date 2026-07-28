import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { encryptConfig } from '@/lib/crypto'
import { isBlockedHost } from '@/lib/llm-config'
import { invalidateMcpToolsCache } from '@/lib/mcp-client'

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'http'])

interface CreateBody {
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

function validateTransportConfig(body: CreateBody): { ok: true } | { ok: false; error: string } {
  const transport = (body.transport ?? '').trim()
  if (!VALID_TRANSPORTS.has(transport)) {
    return { ok: false, error: 'transport must be "stdio", "sse", or "http".' }
  }
  if (transport === 'stdio') {
    if (!body.command || !body.command.trim()) {
      return { ok: false, error: 'command is required for stdio transport.' }
    }
  } else {
    if (!body.url || !body.url.trim()) {
      return { ok: false, error: 'url is required for sse/http transport.' }
    }
    let url: URL
    try {
      url = new URL(body.url.trim())
    } catch {
      return { ok: false, error: 'url is invalid.' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'url must use http or https.' }
    }
    if (isBlockedHost(url.hostname)) {
      return { ok: false, error: 'url points to a blocked internal host.' }
    }
  }
  return { ok: true }
}

function normalizeArgs(raw: unknown): string {
  if (Array.isArray(raw)) return JSON.stringify(raw.map(String))
  return '[]'
}

function encodeEnv(envVars: Record<string, unknown> | undefined): string {
  if (!envVars || typeof envVars !== 'object') return '{}'
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(envVars)) {
    if (typeof v === 'string') clean[k] = v
    else if (v !== null && v !== undefined) clean[k] = String(v)
  }
  if (Object.keys(clean).length === 0) return '{}'
  return encryptConfig(clean)
}

export function sanitizeServer(row: {
  id: string
  name: string
  description: string
  transport: string
  command: string
  args: string
  url: string
  envJson: string
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    hasEnvVars: row.envJson && row.envJson !== '{}',
    isEnabled: row.isEnabled,
    chatEnabled: row.chatEnabled,
    agenticEnabled: row.agenticEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function GET() {
  try {
    await getActiveUser()
    const servers = await db.mcpServer.findMany({
      where: {},
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ ok: true, servers: servers.map(sanitizeServer) })
  } catch (e) {
    return handleApiError(e, 'Failed to load MCP server list.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as CreateBody

    const name = (body.name ?? '').trim()
    if (!name) {
      return NextResponse.json({ ok: false, error: 'MCP server name is required.' }, { status: 400 })
    }

    const check = validateTransportConfig(body)
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: check.error }, { status: 400 })
    }

    const transport = (body.transport as string).trim()
    const server = await db.mcpServer.create({
      data: {
        name,
        description: (body.description ?? '').trim(),
        transport,
        command: (body.command ?? '').trim(),
        args: normalizeArgs(body.args),
        url: transport === 'stdio' ? '' : (body.url ?? '').trim(),
        envJson: encodeEnv(body.envVars),
        isEnabled: body.isEnabled ?? true,
        chatEnabled: typeof body.chatEnabled === 'boolean' ? body.chatEnabled : true,
        agenticEnabled: typeof body.agenticEnabled === 'boolean' ? body.agenticEnabled : true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        transport: true,
        command: true,
        args: true,
        url: true,
        envJson: true,
        isEnabled: true,
        chatEnabled: true,
        agenticEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    invalidateMcpToolsCache()
    await writeAudit({
      userId: user.userId,
      action: 'MCP_SERVER_CREATE',
      severity: 'warning',
      detail: { id: server.id, name: server.name, transport },
    })

    return NextResponse.json({ ok: true, server: sanitizeServer(server) }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Failed to create MCP server.')
  }
}
