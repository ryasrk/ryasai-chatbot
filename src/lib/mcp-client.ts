/**
 * MCP (Model Context Protocol) client manager.
 * ----------------------------------------------------------------------------
 * Connects to externally-administered MCP servers (stdio / sse / http transports),
 * lists their tools, and calls tools by name. Connections are cached per server
 * (lazy init, LRU-bounded) and reused across calls. A 60s TTL cache wraps the
 * aggregated tool list so the planner doesn't re-fetch on every query.
 *
 * envJson and headersJson are AES-256-GCM encrypted at rest (encrypted in the
 * API routes via encryptConfig); they are decrypted here only at connect time.
 *
 * Production hardening:
 * - AbortSignal.timeout() on all SDK calls (connect, listTools, callTool)
 * - onclose handler on transports → proactive failure detection
 * - LRU cap on connection cache (default 20, configurable via MCP_MAX_CONNECTIONS)
 * - Single-flight dedup on tools-cache cold miss
 * - Test connections are NOT cached (closed after listTools)
 * - DNS-rebinding protection via dns.lookup before TCP connect
 * - Non-text content blocks serialized (no silent data loss)
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

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
  headersJson: string
  isEnabled: boolean
}

interface CachedConnection {
  client: Client
  serverName: string
  failed: boolean
}

// ponytail: LRU-bounded connection cache. Map preserves insertion order, so
// deleting the first key evicts the oldest. Default 20 stdio children / SSE
// connections is generous for a single-tenant app.
const MAX_CONNECTIONS = Number(process.env.MCP_MAX_CONNECTIONS ?? 20)
const connections = new Map<string, CachedConnection>()

let toolsCache: { tools: McpTool[]; at: number } | null = null
let toolsCachePromise: Promise<McpTool[]> | null = null
const TOOLS_TTL_MS = 60_000

const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 15_000)
const LIST_TOOLS_TIMEOUT_MS = Number(process.env.MCP_LIST_TOOLS_TIMEOUT_MS ?? 10_000)
const CALL_TOOL_TIMEOUT_MS = Number(process.env.MCP_CALL_TOOL_TIMEOUT_MS ?? 30_000)

// Minimal view of the callTool result — the SDK's union return type is far
// wider than what we consume (text content + isError flag).
interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
}

export async function listMcpTools(): Promise<McpTool[]> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.tools
  if (toolsCachePromise) return toolsCachePromise
  toolsCachePromise = listMcpToolsUncached()
  try {
    const tools = await toolsCachePromise
    toolsCache = { tools, at: Date.now() }
    return tools
  } finally {
    toolsCachePromise = null
  }
}

async function listMcpToolsUncached(): Promise<McpTool[]> {
  const servers = await db.mcpServer.findMany({ where: { isEnabled: true } })
  const all: McpTool[] = []
  for (const s of servers) {
    const conn = await getConnection(s.id, s)
    if (!conn) continue
    try {
      const { tools } = await conn.client.listTools(undefined, { signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS) })
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
  if (!conn) return { ok: false, output: '', error: 'MCP server unavailable or inactive.' }
  try {
    const result = (await conn.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal: AbortSignal.timeout(CALL_TOOL_TIMEOUT_MS) },
    )) as unknown as McpCallResult
    const output = extractText(result.content)
    if (result.isError) {
      return { ok: false, output: '', error: output || 'MCP tool returned an error.' }
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
  const row = await db.mcpServer.findUnique({ where: { id: serverId } })
  if (!row) return { ok: false, error: 'MCP server not found.' }
  if (!row.isEnabled) return { ok: false, error: 'MCP server is disabled.' }

  const transport = await buildTransport(row)
  if (!transport) return { ok: false, error: `Invalid transport config (command: ${row.command || 'empty'}, url: ${row.url || 'empty'}).` }

  const client = new Client(
    { name: 'ryasai-chatbot', version: '1.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
    const { tools } = await client.listTools(undefined, { signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS) })
    // ponytail: test connections are NOT cached — close immediately to avoid
    // leaking stdio children / SSE sockets from repeated test clicks.
    await safeClose(client)
    return {
      ok: true,
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[mcp] test failed for "${row.name}":`, msg)
    await safeClose(client)
    const target = row.transport === 'stdio' ? row.command : row.url
    return { ok: false, error: target ? `${target}: ${msg}` : msg }
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
  toolsCachePromise = null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function evictIfNeeded(): void {
  while (connections.size >= MAX_CONNECTIONS) {
    const oldest = connections.keys().next().value
    if (!oldest) break
    const conn = connections.get(oldest)
    if (conn) void safeClose(conn.client)
    connections.delete(oldest)
  }
}

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

  const transport = await buildTransport(r)
  if (!transport) return null

  // ponytail: set onclose BEFORE connect so transport-level close events
  // (SSE drop, stdio exit) proactively mark the connection as failed.
  transport.onclose = () => {
    const c = connections.get(serverId)
    if (c) c.failed = true
  }

  const client = new Client(
    { name: 'ryasai-chatbot', version: '1.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
    evictIfNeeded()
    const conn: CachedConnection = { client, serverName: r.name, failed: false }
    connections.set(serverId, conn)
    return conn
  } catch (e) {
    console.warn(`[mcp] connect failed for "${r.name}":`, e)
    await safeClose(client)
    return null
  }
}

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .some((dir) => {
      try {
        return statSync(join(dir, cmd)).isFile()
      } catch {
        return false
      }
    })
}

/**
 * Pick the runner to actually spawn. Prefers bunx over npx; everything else is
 * spawned exactly as stored.
 *
 * ponytail: every MCP README says `npx -y <pkg>`, and that is what the installer
 * parses and stores. Two problems with running it literally. The stock
 * `oven/bun:1-slim` runtime had no Node at all, so npx was ENOENT and no stdio
 * server could start — the Dockerfile now installs Node, but an older or
 * stripped image still won't have it. And npx runs the server as a grandchild
 * (npx -> node -> server), so closing the transport leaves the real process
 * behind; bunx execs it directly and dies with the transport. Measured on the
 * install integration test: bunx 4.1s and a clean exit, npx never exited.
 *
 * bunx is argv-compatible with npx down to tolerating `-y`, and ships with the
 * runtime this app runs on. Falls back to npx if bunx somehow isn't on PATH.
 *
 * Only npx has a substitute. uvx/python have no bun equivalent — a server
 * needing those requires the real runtime, which the prod stage now installs.
 */
export function resolveStdioCommand(command: string): string {
  if (command === 'npx' && onPath('bunx')) return 'bunx'
  return command
}

async function buildTransport(row: McpServerRow): Promise<Transport | null> {
  if (row.transport === 'stdio') {
    if (!row.command) return null
    return new StdioClientTransport({
      command: resolveStdioCommand(row.command),
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
    // Sync string check first (fast path), then async DNS-rebinding check.
    if (isBlockedHost(url.hostname)) return null
    if (await isBlockedHostAsync(url.hostname)) return null
    const headers = loadHeaders(row.headersJson)
    const requestInit = headers ? { headers } : undefined
    if (row.transport === 'sse') return new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
    return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)
  }
  return null
}

function parseArgs(raw: string): string[] {
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.map(String) : []
  } catch (e) {
    console.warn('[mcp] parseArgs: failed to parse args JSON:', e)
    return []
  }
}

function loadEnv(envJson: string): Record<string, string> | undefined {
  if (!envJson || envJson === '{}') return undefined
  try {
    const dec = decryptConfig(envJson)
    if (dec && typeof dec === 'object') return toStringRecord(dec)
  } catch (e) {
    console.warn('[mcp] loadEnv: decryptConfig failed, trying plain JSON:', e)
  }
  try {
    const parsed = JSON.parse(envJson)
    if (parsed && typeof parsed === 'object') return toStringRecord(parsed)
  } catch (e) {
    console.warn('[mcp] loadEnv: plain JSON parse also failed:', e)
  }
  return undefined
}

function loadHeaders(headersJson: string): Record<string, string> | undefined {
  if (!headersJson || headersJson === '{}') return undefined
  try {
    const dec = decryptConfig(headersJson)
    if (dec && typeof dec === 'object') return toStringRecord(dec)
  } catch {
    // not encrypted — fall through to plain JSON
  }
  try {
    const parsed = JSON.parse(headersJson)
    if (parsed && typeof parsed === 'object') return toStringRecord(parsed)
  } catch (e) {
    console.warn('[mcp] loadHeaders: failed to parse headersJson:', e)
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
    .map((c) => {
      if (c.type === 'text' && typeof c.text === 'string') return c.text
      // ponytail: serialize non-text blocks (image, audio, resource) as JSON
      // to avoid silent data loss. The planner sees a structured string.
      return JSON.stringify(c)
    })
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
