/**
 * Outbound HTTP for admin-configured endpoints (REST data sources, plugin webhooks, OAuth2 token URLs), with the
 * SSRF check applied to EVERY hop and the response read to a bound.
 *
 * WHY (measured against a mock API and a mock "internal" server, 2026-10-03): the REST executor and the plugin
 * webhook checked only the FIRST url, then called `fetch` with its default `redirect: 'follow'`. A permitted host
 * answering `302 Location: http://127.0.0.1/...` was followed, and the internal server's body came back as the API
 * answer. Both also read the whole body before keeping 8,000 characters: a 300 MB response raised RSS by 304 MB.
 * `web-fetch.ts` already followed redirects by hand for exactly this reason; this is the same discipline for the
 * paths that carry a tenant's credentials.
 *
 * Credentials are dropped once a redirect leaves the original origin, so a permitted API cannot bounce the tenant's
 * bearer token or API key to a third party either.
 */

export class BlockedHostError extends Error {
  readonly code = 'BLOCKED_HOST'
  constructor(readonly hostname: string, hop: number) {
    // Same wording the callers have always returned for a blocked first hop, so their messages do not change.
    super(hop === 0 ? 'Endpoint points to a blocked internal host.' : 'Endpoint redirected to a blocked internal host.')
    this.name = 'BlockedHostError'
  }
}

export class TooManyRedirectsError extends Error {
  readonly code = 'TOO_MANY_REDIRECTS'
  constructor(limit: number) {
    super(`Too many redirects (limit ${limit}).`)
    this.name = 'TooManyRedirectsError'
  }
}

/** Header names that carry a credential and must not follow a redirect to another origin. */
function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'authorization' || n === 'proxy-authorization' || n === 'cookie'
    || n.includes('api-key') || n.includes('apikey') || n.includes('token') || n.includes('secret')
}

export const MAX_REDIRECT_HOPS = 5

/**
 * `fetch`, with every hop's host checked against the SSRF blocklist BEFORE it is requested.
 *
 * Redirects are followed by hand (at most `MAX_REDIRECT_HOPS`). A 303 — and a 301/302 answering a POST — continues
 * as a GET without a body, as browsers and `fetch` do. Throws `BlockedHostError` / `TooManyRedirectsError`; callers
 * already turn thrown errors into their own failure shape.
 */
export async function guardedFetch(
  input: string,
  init: Omit<RequestInit, 'redirect' | 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  // Imported lazily: llm-config pulls in the database client, and this module is also used by code paths whose
  // tests load it without one.
  const { isBlockedHost, isBlockedHostAsync } = await import('@/lib/llm-config')
  const originalOrigin = new URL(input).origin
  let url = new URL(input)
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  let headers: Record<string, string> = { ...(init.headers ?? {}) }

  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedHostError(url.hostname, hop)
    if (isBlockedHost(url.hostname) || await isBlockedHostAsync(url.hostname)) throw new BlockedHostError(url.hostname, hop)

    // A string, as every caller passed before: some fetch wrappers and test fakes only handle strings.
    const res = await fetch(url.toString(), { ...init, method, body, headers, redirect: 'manual' })
    const location = res.headers?.get?.('location') ?? null
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res

    // The redirect's own body is never read; release it so the connection is reused or closed.
    await res.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECT_HOPS) throw new TooManyRedirectsError(MAX_REDIRECT_HOPS)

    const next = new URL(location, url)
    if (next.origin !== originalOrigin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !isCredentialHeader(k)))
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'))
    }
    url = next
  }
}

/**
 * Read at most `maxBytes` of a response body as text, then close the connection.
 *
 * Callers keep only a short prefix (8,000 characters), so reading further is pure memory and bandwidth.
 * Decoding stops on a byte boundary; a multi-byte character cut at the bound is dropped by the decoder.
 */
export async function readTextBounded(res: Response, maxBytes: number): Promise<string> {
  // A response without a stream (some fakes, some polyfills) still answers text(); bound that instead.
  if (!res.body) return typeof res.text === 'function' ? (await res.text()).slice(0, maxBytes) : ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let received = 0
  let finished = false
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read()
      if (done) { finished = true; break }
      const room = maxBytes - received
      const chunk = value.byteLength > room ? value.subarray(0, room) : value
      received += chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* already released */ }
  }
}
