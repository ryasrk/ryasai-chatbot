import { createHash } from 'node:crypto'
import { guardedFetch, readTextBounded } from '@/lib/guarded-fetch'

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
    return { Authorization: `Bearer ${await oauthAccessToken({ tokenUrl, clientId, clientSecret, scope })}` }
  }
  throw new Error(`Unsupported REST API auth type: ${authType}`)
}

// ---------------------------------------------------------------------------
// OAuth2 client-credentials tokens: cached, shared, and fetched through the SSRF guard.
//
// MEASURED (mock identity provider, 20 token requests/s): every API call fetched a NEW token, so 100 concurrent
// calls made 100 token requests, the provider answered 429 to 80 of them, and those 80 calls failed. A
// client-credentials token is valid for its `expires_in`, so it is cached per credential set until shortly before
// it expires, and concurrent callers share ONE in-flight request. The token URL also went straight to `fetch`
// without the SSRF check the endpoint gets, so the tenant's client secret could be posted to an internal host.
// ---------------------------------------------------------------------------
type OAuthCreds = { tokenUrl: string; clientId: string; clientSecret: string; scope: string }
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const tokenInFlight = new Map<string, Promise<string>>()
/** Refresh this long before the provider's expiry, so a token is never sent in its last seconds. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000
/** Used when the provider omits `expires_in`. Short, because a guessed lifetime can be wrong. */
const TOKEN_DEFAULT_TTL_MS = 5 * 60_000

function tokenCacheKey(c: OAuthCreds): string {
  return createHash('sha256').update(`${c.tokenUrl}\0${c.clientId}\0${c.clientSecret}\0${c.scope}`).digest('hex')
}

async function oauthAccessToken(c: OAuthCreds): Promise<string> {
  const key = tokenCacheKey(c)
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const pending = tokenInFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    body.set('client_id', c.clientId)
    body.set('client_secret', c.clientSecret)
    if (c.scope) body.set('scope', c.scope)
    const tokenRes = await guardedFetch(c.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    const text = await readTextBounded(tokenRes, 64 * 1024)
    if (!tokenRes.ok) throw new Error(`OAuth2 token fetch failed (HTTP ${tokenRes.status}).`)
    let data: { access_token?: unknown; expires_in?: unknown }
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      throw new Error('OAuth2 token endpoint did not return JSON.')
    }
    const token = stringValue(data.access_token)
    if (!token) throw new Error('OAuth2 token response has no access_token.')
    const lifetimeMs = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in * 1000 : TOKEN_DEFAULT_TTL_MS
    // Refresh a minute early; a token that lives under two minutes is reused for half its life instead.
    const cacheFor = lifetimeMs > 2 * TOKEN_EXPIRY_MARGIN_MS ? lifetimeMs - TOKEN_EXPIRY_MARGIN_MS : lifetimeMs / 2
    tokenCache.set(key, { token, expiresAt: Date.now() + cacheFor })
    return token
  })()
  tokenInFlight.set(key, request)
  try {
    return await request
  } finally {
    tokenInFlight.delete(key)
  }
}

/** Forget a cached token — called when the API rejects it (401), so the next call fetches a fresh one. */
export function invalidateOAuthToken(config: Record<string, unknown>): void {
  tokenCache.delete(tokenCacheKey({
    tokenUrl: stringValue(config.tokenUrl),
    clientId: stringValue(config.clientId),
    clientSecret: stringValue(config.clientSecret),
    scope: stringValue(config.scope),
  }))
}

/** Test seam: start from an empty token cache. */
export function _clearOAuthTokenCache(): void {
  tokenCache.clear()
  tokenInFlight.clear()
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
