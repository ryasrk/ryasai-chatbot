export interface PluginManifestShape {
  paramDescription: string
  executorType: string
  endpoint: string
  method: string
  authType: string
  authCredentials?: string
  timeoutMs: number
  description: string
}

export interface PluginRow {
  id: string
  toolId: string
  name: string
  description: string
  manifest: PluginManifestShape | null
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  category?: string
  subcategory?: string
  keywords?: string
  createdAt: string
  updatedAt: string
}

export interface McpServerRow {
  id: string
  name: string
  description: string
  transport: string
  command: string
  args: string
  url: string
  hasEnvVars: boolean
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface TestResult {
  ok: boolean
  output: string
  error?: string
  latencyMs: number
}

export interface McpTestState {
  status: 'testing' | 'success' | 'error'
  tools?: Array<{ name: string; description: string }>
  error?: string
}
