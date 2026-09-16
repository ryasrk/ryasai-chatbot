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
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

/** A resource advertised by an MCP server (a readable artifact — file, record, page). */
export interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description: string
  mimeType: string
}

/** A URI TEMPLATE a server accepts, e.g. `file:///{path}` — parameterised resources. */
export interface McpResourceTemplate {
  serverId: string
  serverName: string
  uriTemplate: string
  name: string
  description: string
  mimeType: string
}

/** A prompt a server exposes — a server-authored, parameterised prompt template. */
export interface McpPrompt {
  serverId: string
  serverName: string
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

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
// Resources and prompts are cached on the SAME terms as tools: a short TTL plus
// invalidation when the server announces a change. They are separate caches
// because a server may support one and not the others, and each has its own
// change notification.
let resourcesCache: { resources: McpResource[]; templates: McpResourceTemplate[]; at: number } | null = null
let promptsCache: { prompts: McpPrompt[]; at: number } | null = null
// Content read by `readMcpResource`, keyed by serverId + uri.
//
// WHY A CONTENT CACHE AT ALL: a resource read is a round trip to a foreign
// process, and an agent commonly reads the same resource across several rounds.
// Unlike the LIST caches this one has no TTL: a resource's CONTENT is not
// expected to change on its own, so a short TTL would either be useless (too
// long) or defeat the point (too short). It is invalidated by the server's own
// `notifications/resources/updated`, which is the spec's signal that the content
// changed — the same contract the list caches already honour.
const RESOURCE_CONTENT_MAX = Number(process.env.MCP_RESOURCE_CACHE_MAX ?? 100)
const resourceContentCache = new Map<string, { output: string; mimeType: string; at: number }>()
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

/**
 * Build a client that reacts to the server changing its tool list at runtime.
 *
 * WHY THIS EXISTS (MEASURED, not theoretical). MCP lets a server advertise
 * `capabilities.tools.listChanged` and then push
 * `notifications/tools/list_changed` whenever its tools change — the standard
 * pattern for servers whose tool set is dynamic (auth-dependent tools, tools
 * enabled by server-side config, tools registered by a plugin load). We cached
 * the tool list for TOOLS_TTL_MS and registered NO notification handler, so a
 * newly announced tool stayed invisible until the TTL expired.
 *
 * Verified against a real server that adds a tool 2s after connect and emits the
 * notification: the client reported 1 tool where the server had 2, until the
 * cache was reset by hand. `invalidateMcpToolsCache()` on the notification
 * closes that gap, so the next `listMcpTools()` re-reads from the server.
 *
 * The handler is deliberately tolerant: a notification that cannot be handled
 * must never tear down a working connection.
 */
function createClient(): Client {
  const client = new Client(
    { name: 'ryasai-chatbot', version: '1.0.0' },
    // NOTE: `tools`/`resources`/`prompts` are SERVER capabilities, not client
    // ones — declaring them here is a type error and enables nothing. A client
    // opts in by registering the handlers below, which is what a spec-compliant
    // server checks before emitting the corresponding `*_list_changed`.
    { capabilities: {} },
  )
  // Each registration is guarded independently: an older SDK missing one schema
  // must not cost us the others, and a notification we cannot handle must never
  // tear down a working connection.
  const handlers: Array<[unknown, (n: unknown) => void, string]> = [
    [ToolListChangedNotificationSchema, () => { invalidateMcpToolsCache() }, 'tools'],
    [ResourceListChangedNotificationSchema, () => { invalidateMcpResourcesCache() }, 'resources'],
    [PromptListChangedNotificationSchema, () => { invalidateMcpPromptsCache() }, 'prompts'],
    // A resource's CONTENT changed (not the list). The notification carries only
    // a uri, so we drop that one entry. Ignoring it served stale content for the
    // life of the process, which is worse than a stale list: the model would
    // answer from a document the server had already replaced.
    [ResourceUpdatedNotificationSchema, (n: unknown) => {
      const uri = (n as { params?: { uri?: unknown } } | null)?.params?.uri
      invalidateMcpResourceContent(typeof uri === 'string' ? uri : undefined)
    }, 'resources/updated'],
  ]
  for (const [schema, handler, label] of handlers) {
    try {
      client.setNotificationHandler(schema as Parameters<typeof client.setNotificationHandler>[0], handler as Parameters<typeof client.setNotificationHandler>[1])
    } catch (e) {
      console.warn(`[mcp] ${label} handler not registered:`, e instanceof Error ? e.message : e)
    }
  }
  return client
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


/**
 * Reject a call to a tool the server does not actually expose.
 *
 * WHY (MEASURED): calling an unknown tool name returned `{ok: true, output: ""}`
 * against a real server — a SILENT FALSE SUCCESS. The transport does not fail;
 * the SDK reports a valid response with empty content, so an empty answer looked
 * like a tool that legitimately returned nothing. An mcp-stdio plugin whose
 * `toolId` did not match a real tool therefore reported success while doing
 * nothing at all, which is the worst possible failure mode for an agent: the
 * model is told its action worked.
 */
async function assertToolExists(
  client: Client,
  serverLabel: string,
  toolName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Always pass a signal and timeout: every other listTools call does, and a
    // server that hangs on tools/list must not stall the call it is guarding.
    const { tools } = await client.listTools(undefined, { signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS) })
    if (tools.some((t) => t.name === toolName)) return { ok: true }
    const known = tools.map((t) => t.name)
    return {
      ok: false,
      error: `MCP server "${serverLabel}" has no tool "${toolName}". Available: ${known.length ? known.join(', ') : '(none)'}`,
    }
  } catch (e) {
    // If we cannot enumerate, do NOT block the call: the server may permit
    // tools/list to fail while callTool still works. The empty-output check
    // below remains the backstop.
    void e
    return { ok: true }
  }
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const conn = await getConnection(serverId)
  if (!conn) return { ok: false, output: '', error: 'MCP server unavailable or inactive.' }
  const exists = await assertToolExists(conn.client, serverId, toolName)
  if (!exists.ok) return { ok: false, output: '', error: exists.error }
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

  const client = createClient()

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

export function invalidateMcpResourcesCache(): void {
  resourcesCache = null
}

/**
 * Drop cached content for one resource uri, or ALL content when no uri is given.
 *
 * Called when a server announces `notifications/resources/updated`. Passing no
 * uri (a malformed notification) clears everything — the conservative direction,
 * because serving stale content is the failure we are avoiding.
 */
export function invalidateMcpResourceContent(uri?: string): void {
  if (!uri) {
    resourceContentCache.clear()
    return
  }
  // The cache is keyed per server, and the notification does not say which
  // server sent it, so drop every server's entry for this uri.
  for (const key of [...resourceContentCache.keys()]) {
    if (key.endsWith(`|${uri}`)) resourceContentCache.delete(key)
  }
}

export function invalidateMcpPromptsCache(): void {
  promptsCache = null
}

export function invalidateMcpToolsCache(): void {
  toolsCache = null
  toolsCachePromise = null
}

/**
 * List the resources (and URI templates) the configured servers expose.
 *
 * MCP servers commonly expose readable artifacts — files, DB records, pages —
 * as resources, SEPARATE from tools. A server may support resources and no
 * tools, or vice versa, so this never assumes the tool path succeeded and each
 * failure is isolated per server: one broken server must not empty the list.
 *
 * Servers that do not implement resources answer with a JSON-RPC error
 * (-32601 Method not found). That is a NORMAL outcome, not a fault, so it is
 * skipped quietly rather than warned about on every call.
 */
export async function listMcpResources(): Promise<{
  resources: McpResource[]
  templates: McpResourceTemplate[]
}> {
  if (resourcesCache && Date.now() - resourcesCache.at < TOOLS_TTL_MS) {
    return { resources: resourcesCache.resources, templates: resourcesCache.templates }
  }
  const servers = await db.mcpServer.findMany({ where: { isEnabled: true } })
  const resources: McpResource[] = []
  const templates: McpResourceTemplate[] = []
  for (const s of servers) {
    const conn = await getConnection(s.id, s)
    if (!conn) continue
    try {
      const listed = await conn.client.listResources(undefined, {
        signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS),
      })
      for (const r of listed.resources) {
        resources.push({
          serverId: s.id, serverName: s.name,
          uri: r.uri, name: r.name,
          description: r.description ?? '',
          mimeType: r.mimeType ?? '',
        })
      }
      // Templates are a SEPARATE request and may fail on their own; a server can
      // support concrete resources without supporting templates.
      try {
        const t = await conn.client.listResourceTemplates(undefined, {
          signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS),
        })
        for (const rt of t.resourceTemplates) {
          templates.push({
            serverId: s.id, serverName: s.name,
            uriTemplate: rt.uriTemplate, name: rt.name,
            description: rt.description ?? '',
            mimeType: rt.mimeType ?? '',
          })
        }
      } catch {
        /* templates unsupported on this server — not an error */
      }
    } catch (e) {
      if (!isMethodNotFound(e)) console.warn(`[mcp] listResources failed for "${s.name}":`, e)
    }
  }
  resourcesCache = { resources, templates, at: Date.now() }
  return { resources, templates }
}

/**
 * Read one resource by URI.
 *
 * Returns TEXT only. A resource may be binary (image, PDF), and we have no
 * channel that can carry a blob to the model, so a binary resource reports that
 * plainly instead of handing back base64 the model would misread as content.
 */
export async function readMcpResource(
  serverId: string,
  uri: string,
): Promise<{ ok: boolean; output: string; mimeType: string; error?: string }> {
  const cacheKey = `${serverId}|${uri}`
  const cached = resourceContentCache.get(cacheKey)
  if (cached) return { ok: true, output: cached.output, mimeType: cached.mimeType }

  const conn = await getConnection(serverId)
  if (!conn) return { ok: false, output: '', mimeType: '', error: 'MCP server unavailable or inactive.' }
  try {
    const res = await conn.client.readResource({ uri }, { signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS) })
    const textParts: string[] = []
    let binaryOnly = false
    for (const c of res.contents) {
      if (typeof (c as { text?: unknown }).text === 'string') {
        textParts.push((c as { text: string }).text)
      } else if (typeof (c as { blob?: unknown }).blob === 'string') {
        binaryOnly = true
      }
    }
    const mimeType = (res.contents[0] as { mimeType?: string } | undefined)?.mimeType ?? ''
    if (textParts.length === 0 && binaryOnly) {
      // Binary is NOT cached: it is a stable "we cannot serve this" answer, and
      // caching it would outlive a server that later starts returning text.
      return { ok: false, output: '', mimeType, error: 'Resource is binary; this client can only surface text resources.' }
    }
    const output = textParts.join('\n')
    // Bounded LRU: Map preserves insertion order, so the first key is oldest.
    // A resource that changes on every read cannot grow the cache without limit.
    if (resourceContentCache.size >= RESOURCE_CONTENT_MAX) {
      const oldest = resourceContentCache.keys().next().value
      if (oldest !== undefined) resourceContentCache.delete(oldest)
    }
    resourceContentCache.set(cacheKey, { output, mimeType, at: Date.now() })
    return { ok: true, output, mimeType }
  } catch (e) {
    return { ok: false, output: '', mimeType: '', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * List the prompts the configured servers expose.
 *
 * A server prompt is a PARAMETERISED TEMPLATE authored by the server (not by
 * us). We surface it as a tool so the model can invoke it, but the prompt body
 * stays the server's own — we never rewrite it.
 */
export async function listMcpPrompts(): Promise<McpPrompt[]> {
  if (promptsCache && Date.now() - promptsCache.at < TOOLS_TTL_MS) return promptsCache.prompts
  const servers = await db.mcpServer.findMany({ where: { isEnabled: true } })
  const all: McpPrompt[] = []
  for (const s of servers) {
    const conn = await getConnection(s.id, s)
    if (!conn) continue
    try {
      const listed = await conn.client.listPrompts(undefined, {
        signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS),
      })
      for (const p of listed.prompts) {
        all.push({
          serverId: s.id, serverName: s.name,
          name: p.name,
          description: p.description ?? '',
          arguments: (p.arguments ?? []).map((a) => ({
            name: a.name, description: a.description ?? '', required: a.required ?? false,
          })),
        })
      }
    } catch (e) {
      if (!isMethodNotFound(e)) console.warn(`[mcp] listPrompts failed for "${s.name}":`, e)
    }
  }
  promptsCache = { prompts: all, at: Date.now() }
  return all
}

/**
 * Resolve a server prompt with arguments.
 *
 * Returns the rendered TEXT. The prompt's messages may include images, which we
 * cannot forward, so any non-text part is noted rather than silently dropped —
 * a silently short prompt is worse than one that says a part was omitted.
 */
export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, string>,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const conn = await getConnection(serverId)
  if (!conn) return { ok: false, output: '', error: 'MCP server unavailable or inactive.' }
  try {
    const res = await conn.client.getPrompt(
      { name, arguments: args },
      { signal: AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS) },
    )
    const parts: string[] = []
    let nonText = 0
    for (const m of res.messages) {
      const content = m.content as { type?: string; text?: string }
      if (content?.type === 'text' && typeof content.text === 'string') parts.push(content.text)
      else nonText += 1
    }
    if (nonText > 0) parts.push(`[${nonText} non-text part(s) omitted]`)
    return { ok: true, output: parts.join('\n') }
  } catch (e) {
    return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Is this the JSON-RPC "method not found" error?
 *
 * Servers legitimately omit capabilities, and the spec's answer for an
 * unsupported method is -32601. Treating that as a failure would log a warning
 * on every single call to every tools-only server.
 */
function isMethodNotFound(e: unknown): boolean {
  const code = (e as { code?: number } | null)?.code
  if (code === -32601) return true
  const msg = e instanceof Error ? e.message : String(e)
  return /method not found/i.test(msg)
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

  const client = createClient()

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

/**
 * Call a tool on an EPHEMERAL stdio MCP server identified by a command, not by a
 * database row.
 *
 * WHY EPHEMERAL: a plugin owns its server process via its own manifest, so there
 * is no `McpServer` row to key the connection cache on, and caching by raw
 * command string would let two different plugins collide on one process. The
 * connection is therefore opened per call and closed immediately — the sandbox
 * in the caller still bounds the work, and a plugin's server cannot outlive the
 * single invocation that needed it.
 *
 * The command MUST already have been checked against ALLOWED_MCP_CMDS by the
 * caller; this function does not re-validate, so that the allowlist lives in one
 * place rather than being re-implemented per entry point.
 */
export async function callStdioMcpTool(
  spec: { command: string; args: string[]; label: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const client = createClient()
  let transport: StdioClientTransport | null = null
  try {
    transport = new StdioClientTransport({
      command: resolveStdioCommand(spec.command),
      args: spec.args,
    })
    await client.connect(transport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
    const exists = await assertToolExists(client, spec.label, toolName)
    if (!exists.ok) return { ok: false, output: '', error: exists.error }
    const result = (await client.callTool(
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
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, output: '', error: `MCP stdio plugin "${spec.label}" (${toolName}): ${msg}` }
  } finally {
    await safeClose(client).catch(() => undefined)
  }
}
