export interface EndpointDefinition {
  id: string
  method: string
  path: string
  enabled: boolean
}

type QueryValue = string | number | boolean | null | undefined

export function normalizeEndpointPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function matchEndpoint(
  method: string,
  path: string,
  endpoints: EndpointDefinition[],
): EndpointDefinition | null {
  const wantedMethod = method.trim().toUpperCase()
  const wantedPath = normalizeEndpointPath(path)
  return (
    endpoints.find(
      (endpoint) =>
        endpoint.enabled &&
        endpoint.method.trim().toUpperCase() === wantedMethod &&
        normalizeEndpointPath(endpoint.path) === wantedPath,
    ) ?? null
  )
}

export function buildEndpointUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  const url = new URL(normalizeEndpointPath(path).slice(1), withTrailingSlash(baseUrl))
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function buildAuthHeaders(
  authType: string,
  config: Record<string, unknown>,
): Record<string, string> {
  const normalized = authType.trim().toUpperCase()
  if (normalized === 'NONE') return {}
  if (normalized === 'BEARER') {
    const token = stringValue(config.token)
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
  if (normalized === 'API_KEY_HEADER') {
    const headerName = stringValue(config.headerName) || 'X-API-Key'
    const apiKey = stringValue(config.apiKey)
    return apiKey ? { [headerName]: apiKey } : {}
  }
  throw new Error(`Unsupported REST API auth type: ${authType}`)
}

export function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeader(key) ? '••••' : value
  }
  return out
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isSensitiveHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase()
  return (
    lower === 'authorization' ||
    lower.includes('api-key') ||
    lower.includes('apikey') ||
    lower.includes('token') ||
    lower.includes('secret')
  )
}
