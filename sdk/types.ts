/**
 * Public SDK types — mirror src/lib/plugin-registry.ts PluginManifest.
 * Duplicated (not imported) so the SDK has zero app-internal dependencies.
 */

export type PluginAuthType = 'NONE' | 'BEARER' | 'API_KEY_HEADER'
export type PluginMethod = 'GET' | 'POST'
export type PluginExecutorType = 'webhook'

export interface PluginManifest {
  paramDescription: string
  executorType: PluginExecutorType
  endpoint: string
  method: PluginMethod
  authType: PluginAuthType
  authCredentials?: string
  timeoutMs: number
  description: string
}

/** Inbound request delivered to a plugin handler. */
export interface PluginRequest {
  toolId: string
  /** Free-form input string from the planner (often JSON). */
  input: string
  /** Correlation id for tracing. */
  requestId?: string
}

/** Outbound response a handler returns. */
export interface PluginResponse {
  ok: boolean
  output: string
  error?: string
  latencyMs?: number
}

/** Minimal HTTP req shape for the webhook adapter — framework-agnostic. */
export interface HttpLikeRequest {
  method?: string
  url?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

/** Minimal HTTP res shape — Express/Next.js/Node http compatible. */
export interface HttpLikeResponse {
  status: (code: number) => HttpLikeResponse
  setHeader: (name: string, value: string | string[]) => void
  json: (body: unknown) => void
  end: (body?: string) => void
}
