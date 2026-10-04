/**
 * The unified tool CONTRACT: the shape every tool (built-in, plugin, MCP, admin) presents to the selector and the
 * planner, and the reversible encoding between a registry id (`mcp:server/tool`) and an LLM function name
 * (`^[a-zA-Z0-9_-]{1,64}$`). A leaf module, so the tool families in `unified-tools-*.ts` can share it without
 * importing `unified-tools.ts` back.
 */
import type { LlmToolDef } from '@/lib/llm-client'

export interface ToolExecutionContext {
  userId: string
  organizationId?: string
  sessionId?: string
  isAdmin?: boolean
  isConfirmed?: boolean
  /**
   * The API-key document scope, forwarded to the router by the tools that call it.
   *
   * WITHOUT THIS the tool path was the LAST unscoped entry: `SQL_TOOL`, `RAG_TOOL` and `REST_TOOL` each call
   * `runNonStreamingChatCompletion` themselves, and none passed a scope — so a key whose `allowedDocumentIds`
   * named one document still retrieved across the whole org, reached from `/api/v1/agent/run`. The
   * orchestration around these tools was scoped; the executors were not.
   */
  documentIds?: string[] | null
  /** The API-key integration scope, forwarded the same way: without it a step could query any database in the org. */
  integrationIds?: string[] | null
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
