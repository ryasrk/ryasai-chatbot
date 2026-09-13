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

/**
 * Thrown when a caller-supplied path would resolve OUTSIDE the connector's configured base URL. Typed so the
 * route can answer 400 while an unreachable host stays a different failure.
 */
export class EndpointPathEscapeError extends Error {
  readonly code = 'ENDPOINT_PATH_ESCAPE'
  constructor(readonly path: string) {
    super(
      `Endpoint path escapes the connector base URL: ${path}. Paths must be relative to the configured base URL.`,
    )
    this.name = 'EndpointPathEscapeError'
  }
}

/**
 * Build the full request URL, REFUSING to leave the connector's base origin.
 *
 * THIS USED TO BE AN ESCAPE HATCH. `new URL(path.slice(1), base)` resolves a RELATIVE path against the base, but a
 * path that is an ABSOLUTE url (`https://attacker.example.net/collect`) or backslash-leading
 * (`\attacker.example.net/collect`, which the WHATWG parser normalises to a protocol-relative reference) WINS
 * over the base outright. So the admin-configured `baseUrl` was not a host restriction at all: the caller chose
 * the host. The route is admin-only, but it attaches the connector's DECRYPTED credential to the request -- so a
 * tenant bearer/basic/api-key could be delivered to a third party, with the response rendered back.
 *
 * The origin is now compared after resolution, and a mismatch is a typed error rather than a request.
 * `normalizeEndpointPath` is applied FIRST so the check sees the same string the request will use.
 */
export function buildEndpointUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  const base = new URL(withTrailingSlash(baseUrl))
  const normalised = normalizeEndpointPath(path)
  const url = new URL(normalised.slice(1), withTrailingSlash(baseUrl))
  // Compare ORIGIN (scheme + host + port), not the whole url: a path that merely differs in case or adds a query
  // is legitimate, whereas a different host is not.
  if (url.origin !== base.origin) throw new EndpointPathEscapeError(path)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export async function buildAuthHeaders(
  authType: string,
  config: Record<string, unknown>,
): Promise<Record<string, string>> {
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
  if (normalized === 'BASIC') {
    const username = stringValue(config.username)
    const password = stringValue(config.password)
    if (!username && !password) return {}
    const encoded = Buffer.from(`${username}:${password}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  if (normalized === 'OAUTH2') {
    const tokenUrl = stringValue(config.tokenUrl)
    const clientId = stringValue(config.clientId)
    const clientSecret = stringValue(config.clientSecret)
    const scope = stringValue(config.scope)
    if (!tokenUrl || !clientId || !clientSecret) return {}
    // ponytail: no token cache, fetch fresh each call — add cache when throughput matters
    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    body.set('client_id', clientId)
    body.set('client_secret', clientSecret)
    if (scope) body.set('scope', scope)
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!tokenRes.ok) throw new Error(`OAuth2 token fetch failed (HTTP ${tokenRes.status}).`)
    const tokenData = (await tokenRes.json()) as { access_token?: string }
    const accessToken = stringValue(tokenData.access_token)
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
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
