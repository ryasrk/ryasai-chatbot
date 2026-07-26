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
    const relevantPlugins = await selectRelevantPlugins({ query, topK: 5 })
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

  return [...BUILT_IN_TOOLS, ...pluginTools, ...mcpToolDefs]
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
  const rows = await db.mcpServer.findMany({
    where: { isEnabled: true },
    select: { id: true, chatEnabled: true, agenticEnabled: true },
  })
  return new Map(rows.map((r) => [r.id, { chatEnabled: r.chatEnabled, agenticEnabled: r.agenticEnabled }]))
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
