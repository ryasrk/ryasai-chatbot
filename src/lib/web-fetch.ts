/**
 * Web fetch utility — fetches any URL and returns readable text content.
 * Used by the planner's web_fetch built-in tool so the LLM can read
 * installation instructions, documentation pages, etc.
 *
 * SSRF-hardened: blocks internal hosts via the same isBlockedHost /
 * isBlockedHostAsync checks used by mcp-client.ts and llm-config.ts.
 *
 * For HTML pages, strips tags and collapses whitespace. For raw text
 * (GitHub README markdown, JSON, etc.), returns as-is.
 */
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

const MAX_CONTENT_LENGTH = 10_000
const FETCH_TIMEOUT_MS = 15_000

export async function fetchUrlForPlanner(url: string): Promise<{ ok: boolean; content: string; title?: string; error?: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, content: '', error: 'Invalid URL.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, content: '', error: 'URL must use http or https.' }
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, content: '', error: 'Host is blocked (internal/private address).' }
  }
  if (await isBlockedHostAsync(parsed.hostname)) {
    return { ok: false, content: '', error: 'Host is blocked (DNS rebinding detected).' }
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ryasai-chatbot/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })

    if (!res.ok) {
      return { ok: false, content: '', error: `Fetch failed: HTTP ${res.status}` }
    }

    const contentType = res.headers.get('content-type') ?? ''
    let text = await res.text()

    // Strip HTML tags if it's HTML
    if (contentType.includes('text/html') || text.includes('<html') || text.includes('<!DOCTYPE')) {
      text = stripHtml(text)
    }

    const content = text.trim().slice(0, MAX_CONTENT_LENGTH)
    return { ok: true, content }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, content: '', error: `Fetch error: ${msg}` }
  }
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

export async function webSearch(query: string, maxResults = 8): Promise<{ ok: boolean; results: SearchResult[]; error?: string }> {
  const trimmed = query.trim()
  if (!trimmed) return { ok: false, results: [], error: 'Search query is empty.' }

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
