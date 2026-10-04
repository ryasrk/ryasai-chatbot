/**
 * MCP connection plumbing that holds no state: building a transport from a server row (stdio, SSE or streamable
 * HTTP, with the SSRF/DNS-rebinding host check before any TCP connect), decrypting the stored env and headers only
 * at connect time, the filesystem roots this install advertises, and rendering a tool result as text.
 * `mcp-client.ts` owns the connection cache, the list caches and the subscriptions.
 */
import { statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { decryptConfig } from '@/lib/crypto'
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

export type McpServerRow = {
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

// Minimal view of the callTool result — the SDK's union return type is far
// wider than what we consume (text content + isError flag).
export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
}

/**
 * A filesystem root this install exposes to MCP servers.
 *
 * MCP `roots` are how a CLIENT tells a server which directories it may work in.
 * They exist so a server can orient itself (and refuse paths outside them)
 * instead of being handed absolute paths with no context.
 */
export interface McpRoot {
  uri: string
  name: string
}

/**
 * The roots we advertise to servers.
 *
 * WHY AN ENV-VAR ALLOWLIST AND NOT SOMETHING WIDER: a root is an explicit
 * grant — whatever we list, we are telling a foreign process it may read. The
 * safe default is to advertise NOTHING rather than to guess at the host's
 * filesystem, so this is opt-in via `MCP_ROOTS` (colon-separated paths, the
 * same convention as PATH). An install that never sets it answers `roots: []`,
 * which is a truthful "I grant you no directories" and keeps a server from
 * assuming it may reach anywhere.
 *
 * Paths are resolved and required to be absolute and existing, so a typo cannot
 * silently advertise a root that does not exist — a server would then fail on a
 * path it was told was valid.
 */
export function listMcpRoots(): McpRoot[] {
  const raw = process.env.MCP_ROOTS ?? ''
  const out: McpRoot[] = []
  for (const entry of raw.split(':').map((p) => p.trim()).filter(Boolean)) {
    let resolved: string
    try {
      resolved = resolve(entry)
    } catch {
      console.warn(`[mcp] ignoring unreadable MCP_ROOTS entry: ${entry}`)
      continue
    }
    if (!resolved.startsWith('/')) {
      console.warn(`[mcp] ignoring non-absolute MCP_ROOTS entry: ${entry}`)
      continue
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(resolved)
    } catch {
      console.warn(`[mcp] ignoring MCP_ROOTS entry that does not exist: ${entry}`)
      continue
    }
    if (!stat.isDirectory()) {
      console.warn(`[mcp] ignoring MCP_ROOTS entry that is not a directory: ${entry}`)
      continue
    }
    out.push({ uri: `file://${resolved}`, name: basename(resolved) || resolved })
  }
  return out
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

export async function buildTransport(row: McpServerRow): Promise<Transport | null> {
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

export function extractText(content: McpCallResult['content']): string {
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

export async function safeClose(client: Client): Promise<void> {
  try {
    await client.close()
  } catch {
    // best-effort — the connection may already be dead
  }
}
