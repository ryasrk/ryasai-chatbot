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
