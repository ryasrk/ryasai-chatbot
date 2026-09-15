/**
 * Web fetch utility — fetches any URL and returns readable text content.
 * Used by the planner's web_fetch built-in tool so the LLM can read
 * installation instructions, documentation pages, etc.
 *
 * SSRF-hardened: blocks internal hosts via the same isBlockedHost /
 * isBlockedHostAsync checks used by mcp-client.ts and llm-config.ts.
 *
 * Redirects are followed MANUALLY (redirect:'manual' + bounded hop loop): every
 * hop's target gets the full scheme + hostname-blocklist + async-DNS re-check
 * BEFORE its request is issued. With redirect:'follow', a single 302 from an
 * attacker-controlled host used to reach http://169.254.169.254/ unchecked —
 * the guard only ever inspected the initial hostname.
 *
 * For HTML pages, strips tags and collapses whitespace. For raw text
 * (GitHub README markdown, JSON, etc.), returns as-is.
 */
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

const MAX_CONTENT_LENGTH = 10_000
const FETCH_TIMEOUT_MS = 15_000

// ponytail: Residual DNS-rebinding risk. isBlockedHostAsync resolves each
// hop's hostname right before that hop's request, but the fetch then
// RE-resolves internally — an adversarial DNS server can still flip its answer
// between our check and the TCP connect (classic TOCTOU). Pinning the resolved
// IP (connect by IP + Host header / custom dispatcher) is not cleanly feasible
// here: this codebase builds under Node (Turbopack) but RUNS under Bun, whose
// fetch ignores undici Dispatchers and exposes no custom-lookup hook, and
// hand-rolled socket plumbing would fork TLS/certificate verification. The
// per-hop re-validation shrinks the attack window from "anywhere in the whole
// chain" to "within a single connection setup" and closes the unauthenticated
// redirect vector entirely. Revisit if Bun gains undici-compatible dispatchers.
const MAX_REDIRECT_HOPS = 5

/**
 * Read at most `MAX_CONTENT_LENGTH` bytes from the body, then CANCEL the rest.
 *
 * `await res.text()` drained the entire response before the truncation at the return
 * statement, so the cap bounded only the value we handed back -- a large page was fully
 * buffered in memory first (and fully transferred). Reachable from the planner's
 * `web_fetch` tool and `POST /api/fetch-url`, i.e. against URLs the caller chooses.
 *
 * We read chunk by chunk and cancel the stream once the budget is spent, so the transfer
 * actually stops instead of being drained into memory.
 */
async function readBounded(res: Response, limit = MAX_CONTENT_LENGTH): Promise<string> {
  if (!res.body) return await res.text()

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let out = ''
  let bytes = 0
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      // `stream: true` keeps multi-byte characters intact across chunk boundaries.
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    // Stop the transfer rather than draining a body we will not use.
    await reader.cancel().catch(() => {})
  }
  out += decoder.decode()
  return out
}

export async function fetchUrlForPlanner(url: string): Promise<{ ok: boolean; content: string; title?: string; error?: string }> {
  let current: URL
  try {
    current = new URL(url)
  } catch {
    return { ok: false, content: '', error: 'Invalid URL.' }
  }

  // One shared deadline across the whole redirect chain — a slow-loris chain of
  // 5 hops each taking 14s must not turn into a 70s request.
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS)

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // --- Per-hop validation: EVERY hop gets the full guard suite, not just hop 0.
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return { ok: false, content: '', error: 'URL must use http or https.' }
    }

    if (isBlockedHost(current.hostname)) {
      return { ok: false, content: '', error: 'Host is blocked (internal/private address).' }
    }
    if (await isBlockedHostAsync(current.hostname)) {
      return { ok: false, content: '', error: 'Host is blocked (DNS rebinding detected).' }
    }

    // Policy: https→http redirects ARE allowed. This is a credential-free,
    // read-only text fetch (no cookies/auth headers are ever attached), so the
    // downgrade leaks no secrets; refusing it would break the occasional legacy
    // mirror while adding nothing security-wise. Non-http(s) schemes remain
    // rejected at every hop.
    let res: Response
    try {
      res = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ryasai-chatbot/1.0)' },
        signal: deadline,
        redirect: 'manual',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: '', error: `Fetch error: ${msg}` }
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_REDIRECT_HOPS) {
        return { ok: false, content: '', error: `Too many redirects (limit ${MAX_REDIRECT_HOPS}).` }
      }
      const location = res.headers.get('location')
      if (!location) {
        return { ok: false, content: '', error: `Fetch failed: HTTP ${res.status} redirect without Location header.` }
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, content: '', error: 'Redirect target is not a valid URL.' }
      }
      if (next.username || next.password) {
        return { ok: false, content: '', error: 'Redirect target must not contain embedded credentials.' }
      }
      current = next
      continue
    }

    if (!res.ok) {
      return { ok: false, content: '', error: `Fetch failed: HTTP ${res.status}` }
    }

    const contentType = res.headers.get('content-type') ?? ''
    let text: string
    try {
      text = await readBounded(res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: '', error: `Fetch error: ${msg}` }
    }

    // Strip HTML tags if it's HTML
    let title: string | undefined
    if (contentType.includes('text/html') || text.includes('<html') || text.includes('<!DOCTYPE')) {
      // Grab <title> before stripping — the return type has always advertised it
      // and never populated it.
      title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 300) || undefined
      text = stripHtml(text)
    }

    const content = text.trim().slice(0, MAX_CONTENT_LENGTH)
    // Omit `title` entirely when there is none. It used to be emitted unconditionally, so a
    // non-HTML response returned `{ title: undefined }` while the type advertises
    // `title?: string` -- an optional key that is always present is not optional, and callers
    // doing `'title' in result` got the wrong answer.
    return title ? { ok: true, content, title } : { ok: true, content }
  }

  // Unreachable: every loop iteration either continues (bounded by hop cap),
  // returns success, or returns an error.
  return { ok: false, content: '', error: 'Too many redirects.' }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Web search — DuckDuckGo HTML search (no API key needed).
// Returns structured results: title, URL, snippet for each hit.
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * The configured private SearXNG endpoint, or null when unset/malformed.
 *
 * This is an OPERATOR-set env var, never user input — which is what makes it
 * safe to skip the isBlockedHost SSRF check below. The compose service resolves
 * to a private Docker IP that the guard would (correctly) reject for any
 * user-supplied URL.
 */
export function getSearxngEndpoint(): string | null {
  const raw = (process.env.SEARXNG_URL ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Query SearXNG's JSON API. Returns null when SearXNG isn't configured or the
 * request fails, so the caller falls back to DuckDuckGo rather than hard-failing.
 *
 * Requires `json` in settings.yml `search.formats` — it is NOT on by default and
 * SearXNG answers 403 without it. install.sh --with-searxng writes that config.
 */
async function searxngSearch(
  query: string,
  maxResults: number,
): Promise<{ ok: boolean; results: SearchResult[]; error?: string } | null> {
  const base = getSearxngEndpoint()
  if (!base) return null

  // Path and params are fixed here and the origin comes from env — no part of
  // this URL is caller-controlled except the query VALUE, so the guard bypass
  // above cannot be widened into a general SSRF primitive.
  const url = new URL(`${base}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[web-fetch] SearXNG HTTP ${res.status} — falling back to DuckDuckGo`)
      return null
    }
    const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    const results: SearchResult[] = (body.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, maxResults)
      .map((r) => ({
        title: String(r.title),
        url: String(r.url),
        snippet: String(r.content ?? '').slice(0, 200),
      }))
    // An empty result set is a real answer, not a transport failure — but the
    // DuckDuckGo path may still find something, so let it try.
    if (results.length === 0) return null
    return { ok: true, results }
  } catch (e) {
    console.warn('[web-fetch] SearXNG unreachable — falling back to DuckDuckGo:', e)
    return null
  }
}

export async function webSearch(query: string, maxResults = 8): Promise<{ ok: boolean; results: SearchResult[]; error?: string }> {
  const trimmed = query.trim()
  if (!trimmed) return { ok: false, results: [], error: 'Search query is empty.' }

  // Prefer a private SearXNG when one is configured (install.sh --with-searxng).
  // Falls back to DuckDuckGo scraping if it's unset or unreachable.
  const searxng = await searxngSearch(trimmed, maxResults)
  if (searxng) return searxng

  // ponytail: DuckDuckGo HTML endpoint — free, no API key, returns parseable HTML.
  // Using the lite version for simpler HTML structure (less JS-heavy).
  const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(trimmed)}`

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })

    if (!res.ok) {
      return { ok: false, results: [], error: `Search failed: HTTP ${res.status}` }
    }

    const html = await res.text()
    const results = parseDuckDuckGoResults(html, maxResults)

    if (results.length === 0) {
      return { ok: false, results: [], error: 'No results found. Try a different query.' }
    }

    return { ok: true, results }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, results: [], error: `Search error: ${msg}` }
  }
}

/**
 * Parse DuckDuckGo lite HTML results.
 * The lite version has a simple table structure with results in <a> tags.
 */
function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // DuckDuckGo lite results are in <a class="result-link" href="...">title</a>
  // with snippets in nearby <td class="result-snippet">...</td>
  // Fallback: match all <a href="http..."> with text content
  const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const url = m[1]
    const title = stripHtml(m[2]).trim()

    // Skip DuckDuckGo internal links and sponsored content
    if (!title || url.includes('duckduckgo.com') || url.includes('duckduckgo.org')) continue
    if (url.length < 10 || title.length < 3) continue

    // Try to find a snippet near this link — look for text in the surrounding area
    const snippetStart = m.index + m[0].length
    const snippetEnd = Math.min(snippetStart + 500, html.length)
    const nearbyHtml = html.slice(snippetStart, snippetEnd)
    const snippetMatch = nearbyHtml.match(/<td[^>]*>([^<]{20,})<\/td>/i)
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim().slice(0, 200) : ''

    results.push({ title, url, snippet })
  }

  return results
}
