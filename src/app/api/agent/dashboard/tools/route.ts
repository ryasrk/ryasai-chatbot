import { getActiveUser, handleApiError } from '@/lib/session'

const DASHBOARD_TOOLS = [
  { id: 'database.connect', category: 'database', name: 'Connect Database', description: 'Connect a new database', status: 'available' },
  { id: 'database.disconnect', category: 'database', name: 'Disconnect', description: 'Disconnect database', status: 'available' },
  { id: 'database.schema', category: 'database', name: 'Inspect Schema', description: 'Inspect database schema', status: 'available' },
  { id: 'database.query', category: 'database', name: 'Test Query', description: 'Run a test query', status: 'available' },
  { id: 'database.refresh', category: 'database', name: 'Refresh Metadata', description: 'Refresh database metadata', status: 'available' },
  { id: 'knowledge.upload', category: 'knowledge', name: 'Upload', description: 'Upload new document', status: 'available' },
  { id: 'knowledge.delete', category: 'knowledge', name: 'Delete', description: 'Delete document', status: 'available' },
  { id: 'knowledge.reindex', category: 'knowledge', name: 'Reindex', description: 'Re-index knowledge base', status: 'available' },
  { id: 'knowledge.search', category: 'knowledge', name: 'Search', description: 'Search knowledge base', status: 'available' },
  { id: 'knowledge.summarize', category: 'knowledge', name: 'Summarize', description: 'Summarize document', status: 'available' },
  { id: 'api.create', category: 'api', name: 'Create Endpoint', description: 'Create REST endpoint', status: 'available' },
  { id: 'api.update', category: 'api', name: 'Update Endpoint', description: 'Update REST endpoint', status: 'available' },
  { id: 'api.test', category: 'api', name: 'Test Endpoint', description: 'Test REST endpoint', status: 'available' },
  { id: 'api.example', category: 'api', name: 'Generate Example', description: 'Generate example request', status: 'available' },
  { id: 'monitoring.traces', category: 'monitoring', name: 'Traces', description: 'View request traces', status: 'available' },
  { id: 'monitoring.metrics', category: 'monitoring', name: 'Metrics', description: 'View metrics', status: 'available' },
  { id: 'monitoring.logs', category: 'monitoring', name: 'Logs', description: 'Search logs', status: 'available' },
  { id: 'monitoring.audit', category: 'monitoring', name: 'Audit', description: 'View audit log', status: 'available' },
  { id: 'monitoring.latency', category: 'monitoring', name: 'Latency', description: 'Check API latency', status: 'available' },
  { id: 'security.apikeys', category: 'security', name: 'API Keys', description: 'Manage API keys', status: 'available' },
  { id: 'security.permissions', category: 'security', name: 'Permissions', description: 'View permissions', status: 'available' },
  { id: 'security.users', category: 'security', name: 'Users', description: 'View users', status: 'available' },
  { id: 'security.roles', category: 'security', name: 'Roles', description: 'View roles', status: 'available' },
  { id: 'provider.openai', category: 'provider', name: 'OpenAI', description: 'Configure OpenAI provider', status: 'available' },
  { id: 'provider.anthropic', category: 'provider', name: 'Anthropic', description: 'Configure Anthropic provider', status: 'available' },
  { id: 'provider.gemini', category: 'provider', name: 'Gemini', description: 'Configure Gemini provider', status: 'available' },
  { id: 'provider.ollama', category: 'provider', name: 'Ollama', description: 'Configure Ollama provider', status: 'available' },
  { id: 'provider.openrouter', category: 'provider', name: 'OpenRouter', description: 'Configure OpenRouter provider', status: 'available' },
] as const

export async function GET() {
  try {
    await getActiveUser()
    return Response.json({ tools: DASHBOARD_TOOLS })
  } catch (e) {
    return handleApiError(e, 'Failed to load tools list.')
  }
}
