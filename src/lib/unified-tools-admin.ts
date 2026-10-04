/**
 * Admin actions as unified tools. The schemas are the model-facing contract; execution stays in `admin-tools.ts`,
 * which re-checks role and confirmation itself — a schema here grants nothing. Split from `unified-tools.ts`.
 */
import { executeAdminTool } from '@/lib/admin-tools'
import { toolIdToFunctionName, type UnifiedTool } from '@/lib/unified-tool-core'

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
