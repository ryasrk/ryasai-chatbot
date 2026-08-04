/**
 * Tool registry — the catalog of tools the planner can choose from.
 * Built-in tools (sql/rag/rest/chat) + relevant Plugin rows from DB.
 * Plugins are selected by semantic relevance to the query, not all injected.
 */
import { db } from '@/lib/db'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { listMcpTools } from '@/lib/mcp-client'

export interface ToolDef {
  id: string
  description: string
  paramDescription: string
  requiresDataSource: 'integration' | 'document' | 'rest' | 'none'
  category?: string
  subcategory?: string
}

export const BUILT_IN_TOOLS: ToolDef[] = [
  {
    id: 'sql',
    description:
      'Query structured data from connected databases (sales, inventory, customers, invoices, numbers, totals, lists from a database).',
    paramDescription: '{ "question": "natural language question about the data" }',
    requiresDataSource: 'integration',
  },
  {
    id: 'rag',
    description:
      'Search company documents (SOPs, policies, guidelines, regulations, procedures) for relevant text passages.',
    paramDescription: '{ "query": "search query describing what to find" }',
    requiresDataSource: 'document',
  },
  {
    id: 'rest',
    description:
      'Call a whitelisted external REST API endpoint (CRM, HRIS, ticketing, inventory service, or other operational systems).',
    paramDescription: '{ "question": "what you need from the API" }',
    requiresDataSource: 'rest',
  },
  {
    id: 'chat',
    description:
      'General conversation, greetings, or questions that need no internal data source. Use when the question does not require SQL, documents, or external APIs.',
    paramDescription: '{ "message": "the message to respond to" }',
    requiresDataSource: 'none',
  },
]

// ponytail: admin tools — registered so the LLM planner decides when to use them,
// not hardcoded regex. Side-effectful tools (generate_api_key, set_prompt, toggle_*)
// require user confirmation before executing.
export const ADMIN_TOOLS: ToolDef[] = [
  {
    id: 'admin:generate_api_key',
    description: 'Generate a new API key for external API access. Use when the user asks to create, generate, or make an API key.',
    paramDescription: '{ "label": "optional name for the key" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:show_monitoring',
    description: 'Show system monitoring metrics (tool runs, latency, failed requests, integrations, documents) for the last 24 hours.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:show_audit_log',
    description: 'Show recent audit log entries (last 10 security events).',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:list_integrations',
    description: 'List all registered database integrations with their provider and status.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:list_plugins',
    description: 'List all registered plugins with their tool ID and status.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:list_schedules',
    description: 'List all scheduled runs with their cron expression and next run time.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:show_prompt',
    description: 'Show the current system prompt and tool toggle status (SQL, RAG, REST on/off).',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:set_prompt',
    description: 'Update the system prompt. REQUIRES user confirmation. Use when the user asks to change, set, or update the system prompt.',
    paramDescription: '{ "prompt": "the new system prompt text" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:toggle_tool',
    description: 'Enable or disable a built-in tool (SQL, RAG, or REST). REQUIRES user confirmation. Use when the user asks to turn on/off a tool.',
    paramDescription: '{ "tool": "sql|rag|rest", "action": "enable|disable" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:toggle_integration',
    description: 'Enable or disable a database integration by name or ID. REQUIRES user confirmation.',
    paramDescription: '{ "integration": "name or ID", "action": "enable|disable" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:toggle_document',
    description: 'Enable or disable a document for RAG retrieval by name or ID. REQUIRES user confirmation.',
    paramDescription: '{ "document": "name or ID", "action": "enable|disable" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:routing_scores',
    description: 'Show the smart router routing scores and circuit breaker status for each tool.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
       id: 'admin:reindex_status',
    description: 'Show the current knowledge base document count and reindex status.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:mcp_install',
    description: 'Install/register an MCP server (Model Context Protocol). Use when the user asks to add, install, set up, connect, or register an MCP server. Accepts a server name, optional URL (GitHub repo, docs page, or direct MCP endpoint), and optional package name. REQUIRES user confirmation before executing (spawns a child process for stdio transport).',
    paramDescription: '{ "name": "server name", "url": "optional GitHub/docs URL or MCP endpoint", "package": "optional npm/pip package name", "transport": "optional: stdio|sse|http", "confirm": "yes to confirm" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:mcp_set_credentials',
    description: 'Set or update credentials (env vars/API keys/tokens) for an MCP server. Use when the user asks to set, update, or add credentials, API keys, or tokens for an MCP server.',
    paramDescription: '{ "server": "MCP server name", "credentials": "KEY=value, KEY=value" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:mcp_list',
    description: 'List all registered MCP servers with their transport, endpoint, and enabled status.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:mcp_test',
    description: 'Test the connection to an MCP server and list its available tools. Use when the user asks to test, check, or verify an MCP server connection.',
    paramDescription: '{ "server": "MCP server name or ID" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:mcp_remove',
    description: 'Remove/delete an MCP server registration. REQUIRES user confirmation. Use when the user asks to remove, delete, or uninstall an MCP server.',
    paramDescription: '{ "server": "MCP server name or ID", "confirm": "yes to confirm" }',
    requiresDataSource: 'none',
    category: 'admin',
  },
  {
    id: 'admin:seed_plugins',
    description: 'Seed/register prebuilt plugins (weather, translate, calculator, news, web search, etc.) for this organization. Use when the user says plugins are empty, missing, or asks to restore/reset prebuilt plugins.',
    paramDescription: '{}',
    requiresDataSource: 'none',
    category: 'admin',
  },
]

export function getTool(id: string): ToolDef | undefined {
  return BUILT_IN_TOOLS.find((t) => t.id === id)
}

/**
 * Built-in tools + relevant plugins selected by semantic matching.
 * Only top-K plugins relevant to the query are injected into context.
 * `context` filters plugin/mcp tools by their chatEnabled/agenticEnabled flags.
 */
export async function getAvailableTools(
  query?: string,
  context?: 'chat' | 'agentic',
  opts?: { isAdmin?: boolean },
): Promise<ToolDef[]> {
  let pluginTools: ToolDef[]
  if (!query) {
    const plugins = await db.plugin.findMany({ where: { isEnabled: true } })
    pluginTools = plugins
      .filter((p) => filterByContext(p, context))
      .map((p) => ({
        id: `plugin:${p.toolId}`,
        description: p.description,
        paramDescription: parseParamDescription(p.manifestJson),
        requiresDataSource: 'none' as const,
        category: p.category,
        subcategory: p.subcategory,
      }))
  } else {
    const relevantPlugins = await selectRelevantPlugins({ query, topK: 5, context })
    pluginTools = relevantPlugins
      .filter((p) => filterByContext(p, context))
      .map((p) => ({
        id: `plugin:${p.toolId}`,
        description: p.description,
        paramDescription: parseParamDescription(p.manifestJson),
        requiresDataSource: 'none' as const,
        category: p.category,
        subcategory: p.subcategory,
      }))
  }

  // ponytail: listMcpTools has a 60s TTL cache + .catch(() => []) so an MCP
  // server outage never breaks tool listing — graceful degradation.
  // Context filter for MCP applied after fetching since listMcpTools aggregates
  // across servers; we fetch the McpServer rows once to build an id→flags map.
  const mcpTools = await listMcpTools().catch(() => [])
  const mcpFlagMap = await loadMcpContextFlags()
  const mcpToolDefs: ToolDef[] = mcpTools
    .filter((t) => {
      const flags = mcpFlagMap.get(t.serverId)
      if (!flags) return true
      return passesContext(flags, context)
    })
    .map((t) => ({
      id: `mcp:${t.serverId}:${t.toolName}`,
      description: t.description || `${t.serverName} · ${t.toolName}`,
      paramDescription: JSON.stringify(t.inputSchema),
      requiresDataSource: 'none' as const,
      category: 'mcp',
      subcategory: 'mcp',
    }))

  // ponytail: admin tools only for actual admins AND agentic context.
  // Prevent non-admin org users (and API-key holders) from reaching admin.*
  // side-effectful tools through the planner.
  const adminTools = context === 'agentic' && opts?.isAdmin ? ADMIN_TOOLS : []

  return [...BUILT_IN_TOOLS, ...adminTools, ...pluginTools, ...mcpToolDefs]
}

type ContextFlags = { chatEnabled: boolean; agenticEnabled: boolean }

function filterByContext(
  p: { chatEnabled: boolean; agenticEnabled: boolean },
  context: 'chat' | 'agentic' | undefined,
): boolean {
  if (!context) return true
  return passesContext({ chatEnabled: p.chatEnabled, agenticEnabled: p.agenticEnabled }, context)
}

function passesContext(flags: ContextFlags, context: 'chat' | 'agentic' | undefined): boolean {
  if (!context) return true
  return context === 'chat' ? flags.chatEnabled : flags.agenticEnabled
}

async function loadMcpContextFlags(): Promise<Map<string, ContextFlags>> {
  try {
    const rows = await db.mcpServer.findMany({
      where: { isEnabled: true },
      select: { id: true, chatEnabled: true, agenticEnabled: true },
    })
    return new Map(rows.map((r) => [r.id, { chatEnabled: r.chatEnabled, agenticEnabled: r.agenticEnabled }]))
  } catch {
    return new Map()
  }
}

function parseParamDescription(manifestJson: string): string {
  try {
    const manifest = JSON.parse(manifestJson) as { paramDescription?: unknown }
    return typeof manifest.paramDescription === 'string'
      ? manifest.paramDescription
      : '{ "input": "text input" }'
  } catch {
    return '{ "input": "text input" }'
  }
}
