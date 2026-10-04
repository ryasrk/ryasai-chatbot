/**
 * MCP servers as unified tools: each server tool becomes a function the selector can call, guarded by the same
 * circuit breaker, sandbox and rate limit as every other external call, plus read-only adapters for MCP resources
 * and prompts. Split from `unified-tools.ts`, which composes these with the built-in, plugin and admin families.
 */
import { getOrgContext } from '@/lib/prisma-tenant'
import {
  callMcpTool,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  listMcpTools,
  readMcpResource,
} from '@/lib/mcp-client'
import { checkToolRateLimit } from '@/lib/tool-rate-limit'
import { withToolSandbox } from '@/lib/tool-sandbox'
import { toolCircuitBreaker } from '@/lib/tool-circuit-breaker'
import { logSwallowed } from '@/lib/logger'
import { db } from '@/lib/db'
import { toolIdToFunctionName, type ToolExecutionContext, type ToolExecutionResult, type UnifiedTool } from '@/lib/unified-tool-core'

export async function buildMcpUnifiedTools(): Promise<UnifiedTool[]> {
  try {
    const rawTools = await listMcpTools()
    return rawTools.map((mcp) => {
      const toolId = `mcp:${mcp.serverId}:${mcp.toolName}`
      const fnName = toolIdToFunctionName(toolId)

      // Lossless passthrough: use the MCP server's native JSON Schema directly
      const parameters = (mcp.inputSchema && typeof mcp.inputSchema === 'object')
        ? mcp.inputSchema
        : { type: 'object', properties: {} }

      return {
        id: toolId,
        name: fnName,
        description: `[MCP: ${mcp.serverName}] ${mcp.description || mcp.toolName}`,
        parameters,
        category: 'mcp' as const,
        async execute(params, context) {
          const start = Date.now()
          const orgId = context.organizationId || getOrgContext()

          // Circuit breaker check
          const cb = toolCircuitBreaker.isExecutionAllowed(toolId)
          if (!cb.allowed) {
            return { ok: false, output: '', error: cb.reason, latencyMs: 0 }
          }

          // Rate limit check
          if (orgId) {
            const rl = await checkToolRateLimit('mcp', orgId)
            if (!rl.allowed) {
              return { ok: false, output: '', error: 'Rate limit exceeded for MCP tools. Try again in a minute.', latencyMs: 0 }
            }
          }

          try {
            const res = await withToolSandbox(toolId, () => callMcpTool(mcp.serverId, mcp.toolName, params))
            if (res.ok) {
              toolCircuitBreaker.recordSuccess(toolId)
            } else {
              toolCircuitBreaker.recordFailure(toolId, res.error)
            }

            // Observability: record ToolRun
            if (orgId) {
              await db.toolRun.create({
                data: {
                  organizationId: orgId,
                  chatMessageId: null,
                  type: 'PLUGIN',
                  status: res.ok ? 'success' : 'error',
                  latencyMs: Date.now() - start,
                  inputSummary: `MCP [${mcp.serverName}]: ${mcp.toolName}`,
                  outputSummary: (res.output || '').slice(0, 500) || null,
                  errorMessage: res.error ?? null,
                },
              }).catch(logSwallowed('unified-tools: toolRun.create (MCP)'))
            }

            return {
              ok: res.ok,
              output: res.output,
              error: res.error,
              latencyMs: Date.now() - start,
            }
          } catch (err) {
            toolCircuitBreaker.recordFailure(toolId, err)
            return {
              ok: false,
              output: '',
              error: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - start,
            }
          }
        },
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Plugin Webhooks Adapter
// ---------------------------------------------------------------------------

/**
 * Wrap a tool's executor with the guards every MCP surface shares: the circuit
 * breaker, the per-org rate limit, and a ToolRun observability row.
 *
 * WHY SHARED: tools, resources, and prompts are three MCP surfaces that must all
 * behave the same under failure. Copying this block per surface is exactly how
 * one of them ends up silently missing the breaker — a divergence this codebase
 * has already been bitten by (an alignment guard lived in one agentic loop and
 * not the other, so the same question was guarded over SSE and unguarded over
 * HTTP).
 */
function withMcpGuards(
  toolId: string,
  label: string,
  run: () => Promise<{ ok: boolean; output: string; error?: string }>,
): (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult> {
  return async (_params, context) => {
    const start = Date.now()
    const orgId = context.organizationId || getOrgContext()

    const cb = toolCircuitBreaker.isExecutionAllowed(toolId)
    if (!cb.allowed) {
      return { ok: false, output: '', error: cb.reason, latencyMs: 0 }
    }

    if (orgId) {
      const rl = await checkToolRateLimit('mcp', orgId)
      if (!rl.allowed) {
        return { ok: false, output: '', error: 'Rate limit exceeded for MCP tools. Try again in a minute.', latencyMs: 0 }
      }
    }

    let res: { ok: boolean; output: string; error?: string }
    try {
      res = await withToolSandbox(toolId, run)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toolCircuitBreaker.recordFailure(toolId, message)
      return { ok: false, output: '', error: message, latencyMs: Date.now() - start }
    }

    if (res.ok) toolCircuitBreaker.recordSuccess(toolId)
    else toolCircuitBreaker.recordFailure(toolId, res.error)

    if (orgId) {
      await db.toolRun.create({
        data: {
          organizationId: orgId,
          chatMessageId: null,
          type: 'PLUGIN',
          status: res.ok ? 'success' : 'error',
          latencyMs: Date.now() - start,
          inputSummary: label.slice(0, 500),
          outputSummary: (res.output || '').slice(0, 500) || null,
          errorMessage: res.error ?? null,
        },
      }).catch(logSwallowed('unified-tools: toolRun.create (MCP)'))
    }

    return { ok: res.ok, output: res.output, error: res.error, latencyMs: Date.now() - start }
  }
}

/**
 * Expose each MCP server's RESOURCES and PROMPTS as tools.
 *
 * WHY: a server may support resources or prompts and NO tools at all — the
 * fixture in `trial/fixtures/mcp-resources-server.mjs` covers exactly that case.
 * Without this, such a server contributes nothing to the catalogue even though
 * it has usable capability.
 *
 * Resources become ONE read tool per server with the URI as an argument (not one
 * tool per resource) so a server with 500 resources does not add 500 tool
 * definitions and exhaust the model's schema budget. Prompts become one render
 * tool each, because every prompt has its own argument list.
 */
export async function buildMcpResourceAndPromptTools(): Promise<UnifiedTool[]> {
  const out: UnifiedTool[] = []
  try {
    const { resources } = await listMcpResources()
    const byServer = new Map<string, typeof resources>()
    for (const r of resources) {
      byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r])
    }

    for (const [serverId, items] of byServer) {
      const serverName = items[0].serverName
      const toolId = `mcp-resource:${serverId}`
      const listing = items
        .map((r) => `- ${r.uri} — ${r.name}${r.description ? ` (${r.description})` : ''}`)
        .join('\n')
      out.push({
        id: toolId,
        name: toolIdToFunctionName(toolId),
        description: `[MCP: ${serverName}] Read a resource this server exposes.\n\nAvailable resources:\n${listing}`,
        parameters: {
          type: 'object',
          properties: {
            // An enum of known URIs stops the model inventing one; readMcpResource
            // still validates server-side, and we re-check before the call.
            uri: {
              type: 'string',
              enum: items.map((r) => r.uri),
              description: 'URI of the resource to read.',
            },
          },
          required: ['uri'],
        },
        category: 'mcp' as const,
        execute(params, context) {
          const uri = typeof params.uri === 'string' ? params.uri : ''
          if (!items.some((r) => r.uri === uri)) {
            return Promise.resolve({
              ok: false, output: '', latencyMs: 0,
              error: `Unknown resource URI "${uri}" for server ${serverName}. Known: ${items.map((r) => r.uri).join(', ')}`,
            })
          }
          const guarded = withMcpGuards(toolId, `MCP [${serverName}]: read resource ${uri}`, async () => {
            const res = await readMcpResource(serverId, uri)
            return { ok: res.ok, output: res.output, error: res.error }
          })
          return guarded(params, context)
        },
      })
    }

    const prompts = await listMcpPrompts()
    for (const p of prompts) {
      const toolId = `mcp-prompt:${p.serverId}:${p.name}`
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const a of p.arguments) {
        properties[a.name] = { type: 'string', description: a.description || a.name }
        if (a.required) required.push(a.name)
      }
      out.push({
        id: toolId,
        name: toolIdToFunctionName(toolId),
        description: `[MCP: ${p.serverName}] Server-provided prompt "${p.name}"${p.description ? `: ${p.description}` : ''}`,
        parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
        category: 'mcp' as const,
        execute(params, context) {
          const args: Record<string, string> = {}
          for (const a of p.arguments) {
            const v = params[a.name]
            if (typeof v === 'string') args[a.name] = v
            else if (v !== undefined) args[a.name] = String(v)
          }
          const guarded = withMcpGuards(toolId, `MCP [${p.serverName}]: prompt ${p.name}`, async () => {
            const res = await getMcpPrompt(p.serverId, p.name, args)
            return { ok: res.ok, output: res.output, error: res.error }
          })
          return guarded(params, context)
        },
      })
    }
  } catch (e) {
    logSwallowed('unified-tools: buildMcpResourceAndPromptTools')(e)
  }
  return out
}
