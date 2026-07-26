/**
 * MCP (Model Context Protocol) client manager.
 * ----------------------------------------------------------------------------
 * Connects to externally-administered MCP servers (stdio / sse / http transports),
 * lists their tools, and calls tools by name. Connections are cached per server
 * (lazy init) and reused across calls. A 60s TTL cache wraps the aggregated tool
 * list so the planner doesn't re-fetch on every query.
 *
 * envJson is AES-256-GCM encrypted at rest (encrypted in the API routes via
 * encryptConfig); it is decrypted here only at connect time.
 */
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { isBlockedHost } from '@/lib/llm-config'

export interface McpTool {
  serverId: string
  serverName: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

type McpServerRow = {
  id: string
  name: string
  description: string
  transport: string
  command: string
  args: string
  url: string
  envJson: string
  isEnabled: boolean
}

interface CachedConnection {
  client: Client
  serverName: string
  failed: boolean
}

// ponytail: in-process connection cache. Ceiling — a long-running server keeps
// stdio child processes alive for the process lifetime; upgrade to an LRU with
// max connections + idle timeout if many MCP servers are registered.
const connections = new Map<string, CachedConnection>()

let toolsCache: { tools: McpTool[]; at: number } | null = null
const TOOLS_TTL_MS = 60_000

// Minimal view of the callTool result — the SDK's union return type is far
// wider than what we consume (text content + isError flag).
interface McpCallResult {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

export async function listMcpTools(): Promise<McpTool[]> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.tools
  const tools = await listMcpToolsUncached()
  toolsCache = { tools, at: Date.now() }
  return tools
}

async function listMcpToolsUncached(): Promise<McpTool[]> {
  const servers = await db.mcpServer.findMany({ where: { isEnabled: true } })
  const all: McpTool[] = []
  for (const s of servers) {
    const conn = await getConnection(s.id, s)
    if (!conn) continue
    try {
      const { tools } = await conn.client.listTools()
      for (const t of tools) {
        all.push({
          serverId: s.id,
          serverName: s.name,
          toolName: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        })
      }
    } catch (e) {
      console.warn(`[mcp] listTools failed for "${s.name}":`, e)
      conn.failed = true
    }
  }
  return all
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const conn = await getConnection(serverId)
  if (!conn) return { ok: false, output: '', error: 'MCP server tidak tersedia atau nonaktif.' }
  try {
    const result = (await conn.client.callTool({
      name: toolName,
      arguments: args,
    })) as unknown as McpCallResult
    const output = extractText(result.content)
    if (result.isError) {
      return { ok: false, output: '', error: output || 'MCP tool mengembalikan error.' }
    }
    return { ok: true, output }
  } catch (e) {
    conn.failed = true
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, output: '', error }
  }
}

export async function testMcpServer(
  serverId: string,
): Promise<{ ok: boolean; toolCount?: number; tools?: Array<{ name: string; description: string }>; error?: string }> {
  const conn = await getConnection(serverId)
  if (!conn) return { ok: false, error: 'Tidak dapat terhubung ke MCP server.' }
  try {
    const { tools } = await conn.client.listTools()
    return {
      ok: true,
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
    }
  } catch (e) {
    conn.failed = true
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function disconnectMcpServer(serverId: string): Promise<void> {
  const conn = connections.get(serverId)
  if (conn) {
    await safeClose(conn.client)
    connections.delete(serverId)
  }
  invalidateMcpToolsCache()
}

export async function disconnectAllMcp(): Promise<void> {
  for (const conn of connections.values()) {
    await safeClose(conn.client)
  }
  connections.clear()
  invalidateMcpToolsCache()
}

export function invalidateMcpToolsCache(): void {
  toolsCache = null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function getConnection(
  serverId: string,
  row?: McpServerRow,
): Promise<CachedConnection | null> {
  const cached = connections.get(serverId)
  if (cached && !cached.failed) return cached
  if (cached) {
    await safeClose(cached.client)
    connections.delete(serverId)
  }

  const r = row ?? (await db.mcpServer.findUnique({ where: { id: serverId } }))
  if (!r || !r.isEnabled) return null

  const transport = buildTransport(r)
  if (!transport) return null

  const client = new Client(
    { name: 'ryasai-chatbot', version: '1.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport)
    const conn: CachedConnection = { client, serverName: r.name, failed: false }
    connections.set(serverId, conn)
    return conn
  } catch (e) {
    console.warn(`[mcp] connect failed for "${r.name}":`, e)
    await safeClose(client)
    return null
  }
}

function buildTransport(row: McpServerRow): Transport | null {
  if (row.transport === 'stdio') {
    if (!row.command) return null
    return new StdioClientTransport({
      command: row.command,
      args: parseArgs(row.args),
      env: loadEnv(row.envJson),
    })
  }
  if (row.transport === 'sse' || row.transport === 'http') {
    if (!row.url) return null
    let url: URL
    try {
      url = new URL(row.url)
    } catch {
      return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (isBlockedHost(url.hostname)) return null
    if (row.transport === 'sse') return new SSEClientTransport(url)
    return new StreamableHTTPClientTransport(url)
  }
  return null
}

function parseArgs(raw: string): string[] {
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

function loadEnv(envJson: string): Record<string, string> | undefined {
  if (!envJson || envJson === '{}') return undefined
  // Encrypted (hex) first — the API routes store envJson via encryptConfig.
  try {
    const dec = decryptConfig(envJson)
    if (dec && typeof dec === 'object') return toStringRecord(dec)
  } catch {
    // not encrypted — fall through to plain JSON
  }
  try {
    const parsed = JSON.parse(envJson)
    if (parsed && typeof parsed === 'object') return toStringRecord(parsed)
  } catch {
    // ignore
  }
  return undefined
}

function toStringRecord(obj: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v
    else if (v !== null && v !== undefined) out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function extractText(content: McpCallResult['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .slice(0, 8000)
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close()
  } catch {
    // best-effort — the connection may already be dead
  }
}
