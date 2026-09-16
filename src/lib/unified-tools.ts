/**
 * Unified Agent Tool System — Frontier AI standard.
 * ----------------------------------------------------------------------------
 * Unifies Built-in (SQL/RAG/REST/Web), Plugins, MCP servers, and Admin tools
 * into a single, strictly-typed interface with full JSON Schema support.
 *
 * Provides:
 * - Deterministic function name encoding/decoding conforming to `^[a-zA-Z0-9_-]{1,64}$`
 * - Lossless JSON Schema passthrough for MCP tools
 * - Automatic circuit breaker integration to prevent cascading failures
 * - Sandboxed execution and rate limiting per tool type
 */
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'
import { fetchUrlForPlanner, webSearch } from '@/lib/web-fetch'
import { listMcpTools, callMcpTool } from '@/lib/mcp-client'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin, parsePluginManifest } from '@/lib/plugin-registry'
import { executeAdminTool } from '@/lib/admin-tools'
import { checkToolRateLimit } from '@/lib/tool-rate-limit'
import { withToolSandbox } from '@/lib/tool-sandbox'
import { toolCircuitBreaker } from '@/lib/tool-circuit-breaker'
import { logSwallowed } from '@/lib/logger'
import type { LlmToolDef } from '@/lib/llm-client'

export interface ToolExecutionContext {
  userId: string
  organizationId?: string
  sessionId?: string
  isAdmin?: boolean
  isConfirmed?: boolean
}

export interface ToolExecutionResult {
  ok: boolean
  output: string
  error?: string
  latencyMs: number
  data?: unknown
  confirmationRequired?: {
    action: string
    message: string
  }
}

export interface UnifiedTool {
  id: string
  name: string
  description: string
  parameters: Record<string, unknown> // Strict JSON Schema
  category: 'database' | 'knowledge' | 'api' | 'plugin' | 'mcp' | 'admin' | 'web' | 'chat'
  requiresDataSource?: 'integration' | 'document' | 'rest' | 'none'
  requiresConfirmation?: boolean
  execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>
}

// ---------------------------------------------------------------------------
// Canonical Function Name Encoding
// ---------------------------------------------------------------------------

/**
 * Converts any internal tool id into an OpenAI/Anthropic-compliant function name:
 * Must match `^[a-zA-Z0-9_-]{1,64}$`.
 */
export function toolIdToFunctionName(id: string): string {
  // Built-in aliases for cleaner LLM tool calls
  if (id === 'sql') return 'query_database'
  if (id === 'rag') return 'search_knowledge_base'
  if (id === 'rest') return 'call_rest_api'
  if (id === 'chat') return 'direct_chat'

  const sanitized = id
    .replace(/[:/]/g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')

  return sanitized.slice(0, 64)
}

/**
 * Recovers the internal tool id from the function name.
 */
export function functionNameToToolId(name: string, availableTools?: UnifiedTool[]): string {
  if (availableTools) {
    const match = availableTools.find((t) => t.name === name)
    if (match) return match.id
  }

  if (name === 'query_database') return 'sql'
  if (name === 'search_knowledge_base') return 'rag'
  if (name === 'call_rest_api') return 'rest'
  if (name === 'direct_chat') return 'chat'

  return name.replace(/__/g, ':')
}

export function toLlmToolDef(tool: UnifiedTool): LlmToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

// ---------------------------------------------------------------------------
// Built-In Tools
// ---------------------------------------------------------------------------

export const SQL_TOOL: UnifiedTool = {
  id: 'sql',
  name: toolIdToFunctionName('sql'),
  description:
    'Query structured relational data from connected databases (sales, orders, customers, inventory, invoices, financial figures). Input must be a clear natural language question.',
  category: 'database',
  requiresDataSource: 'integration',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Natural language question to query against the connected SQL database tables',
      },
    },
    required: ['question'],
  },
  async execute(params, context) {
    const start = Date.now()
    const question = String(params.question || params.query || '')
    if (!question.trim()) {
      return { ok: false, output: '', error: 'Question parameter is required for query_database', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question,
        userId: context.userId,
        sessionId: context.sessionId,
      })
      const failed = completion.toolRuns.find((tr) => tr.status === 'error' || tr.status === 'blocked')
      if (failed) {
        return {
          ok: false,
          output: completion.answer || '',
          error: failed.errorMessage ?? 'Database query execution failed',
          latencyMs: Date.now() - start,
        }
      }
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const RAG_TOOL: UnifiedTool = {
  id: 'rag',
  name: toolIdToFunctionName('rag'),
  description:
    'Search company documents, SOPs, policies, procedures, and internal regulations for grounded factual evidence.',
  category: 'knowledge',
  requiresDataSource: 'document',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query describing the specific document topics or knowledge needed',
      },
      topK: {
        type: 'integer',
        description: 'Maximum number of document passages to retrieve (default: 5, max: 15)',
      },
    },
    required: ['query'],
  },
  async execute(params, context) {
    const start = Date.now()
    const query = String(params.query || params.question || '')
    if (!query.trim()) {
      return { ok: false, output: '', error: 'Query parameter is required for search_knowledge_base', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question: query,
        userId: context.userId,
        sessionId: context.sessionId,
      })
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const REST_TOOL: UnifiedTool = {
  id: 'rest',
  name: toolIdToFunctionName('rest'),
  description:
    'Call whitelisted external operational REST APIs (e.g. ERP, CRM, HRIS, shipping/inventory service).',
  category: 'api',
  requiresDataSource: 'rest',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Natural language request for what to fetch or submit to connected REST APIs',
      },
    },
    required: ['question'],
  },
  async execute(params, context) {
    const start = Date.now()
    const question = String(params.question || params.query || '')
    if (!question.trim()) {
      return { ok: false, output: '', error: 'Question parameter is required for call_rest_api', latencyMs: 0 }
    }

    try {
      const completion = await runNonStreamingChatCompletion({
        question,
        userId: context.userId,
        sessionId: context.sessionId,
      })
      return { ok: true, output: completion.answer, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const WEB_SEARCH_TOOL: UnifiedTool = {
  id: 'web_search',
  name: 'web_search',
  description:
    'Search the live internet for current events, news, or external factual knowledge not in local databases. Returns URLs, titles, and snippets.',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up on the web',
      },
    },
    required: ['query'],
  },
  async execute(params) {
    const start = Date.now()
    const query = String(params.query || params.search || '')
    if (!query.trim()) {
      return { ok: false, output: '', error: 'Query parameter is required for web_search', latencyMs: 0 }
    }

    try {
      const res = await webSearch(query)
      if (!res.ok) {
        return { ok: false, output: '', error: res.error, latencyMs: Date.now() - start }
      }
      const formatted = res.results
        .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
        .join('\n\n')
      return { ok: true, output: formatted, latencyMs: Date.now() - start }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const WEB_FETCH_TOOL: UnifiedTool = {
  id: 'web_fetch',
  name: 'web_fetch',
  description:
    'Fetch and extract human-readable text content from any public HTTP/HTTPS URL (documentation pages, GitHub, articles).',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL to fetch content from',
      },
    },
    required: ['url'],
  },
  async execute(params) {
    const start = Date.now()
    const url = String(params.url || params.link || '')
    if (!url.trim()) {
      return { ok: false, output: '', error: 'URL parameter is required for web_fetch', latencyMs: 0 }
    }

    try {
      const res = await fetchUrlForPlanner(url)
      return {
        ok: res.ok,
        output: res.ok ? res.content : '',
        error: res.ok ? undefined : res.error,
        latencyMs: Date.now() - start,
      }
    } catch (e) {
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - start }
    }
  },
}

export const DIRECT_CHAT_TOOL: UnifiedTool = {
  id: 'chat',
  name: toolIdToFunctionName('chat'),
  description:
    'Respond directly to the user for general conversation, greetings, clarifications, or syntheses where no further external tools are needed.',
  category: 'chat',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The direct conversational response to present to the user',
      },
    },
    required: ['message'],
  },
  async execute(params) {
    const message = String(params.message || params.text || '')
    return { ok: true, output: message, latencyMs: 0 }
  },
}

export const CORE_BUILT_IN_TOOLS: UnifiedTool[] = [
  SQL_TOOL,
  RAG_TOOL,
  REST_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  DIRECT_CHAT_TOOL,
]

// ---------------------------------------------------------------------------
// Admin Tools Adapter
// ---------------------------------------------------------------------------

const ADMIN_TOOL_SCHEMAS: Record<string, { description: string; parameters: Record<string, unknown>; requiresConfirmation?: boolean }> = {
  'admin:generate_api_key': {
    description: 'Generate a new API key for programmatic external access. Requires administrator role and user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Friendly name or label for the API key' },
        confirm: { type: 'string', description: 'Set to "yes" when the user confirms creation' },
      },
    },
    requiresConfirmation: true,
  },
  'admin:show_monitoring': {
    description: 'View real-time system monitoring metrics (24-hour tool executions, latencies, error rates).',
    parameters: { type: 'object', properties: {} },
  },
  'admin:show_audit_log': {
    description: 'Inspect the 10 most recent security audit log records.',
    parameters: { type: 'object', properties: {} },
  },
  'admin:list_integrations': {
    description: 'List all configured database integrations with their status and provider.',
    parameters: { type: 'object', properties: {} },
  },
  'admin:list_plugins': {
    description: 'List all registered external webhook plugins.',
    parameters: { type: 'object', properties: {} },
  },
  'admin:list_schedules': {
    description: 'List all automated recurring scheduled jobs.',
    parameters: { type: 'object', properties: {} },
  },
  'admin:reindex_knowledge': {
    description: 'Check status or trigger background re-indexing of knowledge base documents.',
    parameters: { type: 'object', properties: {} },
  },
  'admin:mcp_install': {
    description: 'Install and configure a new MCP (Model Context Protocol) server package.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique identifier name for the MCP server' },
        url: { type: 'string', description: 'URL containing installation instructions' },
        instructions: { type: 'string', description: 'Fetched installation instructions text' },
        command: { type: 'string', description: 'Executable command (npx, uvx, node, python)' },
        args: { type: 'string', description: 'Command arguments' },
        confirm: { type: 'string', description: 'Set to "yes" when user confirms installation' },
      },
      required: ['name'],
    },
    requiresConfirmation: true,
  },
  'admin:mcp_remove': {
    description: 'Remove a configured MCP server.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name or ID of the MCP server to remove' },
        confirm: { type: 'string', description: 'Set to "yes" when user confirms removal' },
      },
      required: ['name'],
    },
    requiresConfirmation: true,
  },
  'admin:set_prompt': {
    description: 'Update the system prompt or RAG guidance instructions for the organization.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The new system prompt text' },
        confirm: { type: 'string', description: 'Set to "yes" when user confirms update' },
      },
      required: ['prompt'],
    },
    requiresConfirmation: true,
  },
  'admin:toggle_tool': {
    description: 'Enable or disable a tool type (sql, rag, rest) for the organization.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The tool to toggle (sql, rag, rest)' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
        confirm: { type: 'string', description: 'Set to "yes" when user confirms toggle' },
      },
      required: ['tool', 'enabled'],
    },
    requiresConfirmation: true,
  },
}

export function buildAdminUnifiedTools(): UnifiedTool[] {
  return Object.entries(ADMIN_TOOL_SCHEMAS).map(([toolId, schema]) => ({
    id: toolId,
    name: toolIdToFunctionName(toolId),
    description: schema.description,
    parameters: schema.parameters,
    category: 'admin',
    requiresConfirmation: schema.requiresConfirmation,
    async execute(params, context) {
      const start = Date.now()
      if (!context.isAdmin) {
        return { ok: false, output: '', error: 'Admin tool requires administrator privileges.', latencyMs: 0 }
      }

      const stringParams = Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      )
      const isConfirmed = context.isConfirmed || params.confirm === 'yes'

      const res = await executeAdminTool(toolId, stringParams, context.userId, isConfirmed)
      if (res.confirmationRequired) {
        return {
          ok: true,
          output: res.confirmationRequired.message,
          confirmationRequired: res.confirmationRequired,
          latencyMs: Date.now() - start,
        }
      }
      return {
        ok: res.ok,
        output: res.output,
        error: res.ok ? undefined : res.output,
        latencyMs: Date.now() - start,
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// MCP Tools Adapter (Lossless JSON Schema Passthrough)
// ---------------------------------------------------------------------------

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

export async function buildPluginUnifiedTools(args: { query: string; context?: 'chat' | 'agentic' }): Promise<UnifiedTool[]> {
  try {
    const plugins = await selectRelevantPlugins({ query: args.query, context: args.context })
    return plugins.map((plugin) => {
      const manifest = parsePluginManifest(plugin.manifestJson)
      const toolId = `plugin:${plugin.toolId}`
      const fnName = toolIdToFunctionName(toolId)

      return {
        id: toolId,
        name: fnName,
        description: `[Plugin] ${plugin.description}`,
        category: 'plugin' as const,
        // A manifest that declares a JSON Schema gets it passed through verbatim,
        // exactly like an MCP tool's `inputSchema`. Without one, fall back to the
        // legacy single-string `input` contract so existing plugins keep working.
        parameters: manifest?.parameters ?? {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: manifest?.paramDescription || plugin.description || 'Parameters for the plugin',
            },
          },
        },
        async execute(params, context) {
          const start = Date.now()
          const cb = toolCircuitBreaker.isExecutionAllowed(toolId)
          if (!cb.allowed) {
            return { ok: false, output: '', error: cb.reason, latencyMs: 0 }
          }

          const orgId = context.organizationId || getOrgContext()
          try {
            // A manifest WITH a schema takes the structured path (real types
            // preserved); without one, keep the legacy stringified blob exactly
            // as before so existing plugins behave identically.
            const res = await withToolSandbox(toolId, () =>
              manifest?.parameters
                ? executePlugin({ plugin, args: params })
                : executePlugin({
                    plugin,
                    input: typeof params.input === 'string' ? params.input : JSON.stringify(params),
                  }),
            )

            if (res.ok) {
              toolCircuitBreaker.recordSuccess(toolId)
            } else {
              toolCircuitBreaker.recordFailure(toolId, res.error)
            }

            if (orgId) {
              await db.toolRun.create({
                data: {
                  organizationId: orgId,
                  chatMessageId: null,
                  type: 'PLUGIN',
                  status: res.ok ? 'success' : 'error',
                  latencyMs: res.latencyMs,
                  inputSummary: `Plugin: ${plugin.toolId}`,
                  outputSummary: (res.output || '').slice(0, 500) || null,
                  errorMessage: res.error ?? null,
                },
              }).catch(logSwallowed('unified-tools: toolRun.create (Plugin)'))
            }

            return {
              ok: res.ok,
              output: res.output,
              error: res.error,
              latencyMs: res.latencyMs,
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
// Unified Catalog Resolver
// ---------------------------------------------------------------------------

export async function getUnifiedTools(args: {
  query: string
  context: 'chat' | 'agentic'
  isAdmin?: boolean
}): Promise<UnifiedTool[]> {
  const tools: UnifiedTool[] = [...CORE_BUILT_IN_TOOLS]

  if (args.context === 'agentic' && args.isAdmin) {
    tools.push(...buildAdminUnifiedTools())
  }

  const [pluginTools, mcpTools] = await Promise.all([
    buildPluginUnifiedTools({ query: args.query, context: args.context }),
    buildMcpUnifiedTools(),
  ])

  tools.push(...pluginTools)
  tools.push(...mcpTools)

  return tools
}
