import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/integration-api/test — server-side proxy for the API explorer's
 * Request Builder (Integration API view → Test tab).
 *
 * Body: { method, url, headers?, params?, body? }
 * Response: { ok, status?, statusText?, headers?, body?, latencyMs?, error? }
 *
 * Why a proxy at all (browser could fetch directly)? CORS: third-party APIs
 * rarely allow cross-origin calls from the app's origin. The proxy makes the
 * explorer usable against real endpoints.
 *
 * ponytail: this route previously existed and was lost. Guardrails kept from
 * the original design plus the SSRF lessons from across this codebase:
 *   - session + admin only (it is an arbitrary-outbound-request oracle)
 *   - URL must be absolute http(s)
 *   - SSRF blocklist (sync + async DNS-rebinding check) — same guards as the
 *     REST connector and plugin executors
 *   - 30s timeout, response capped
 */
const PROXY_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 200_000

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const payload = (await req.json().catch(() => ({}))) as {
      method?: string
      url?: string
      headers?: Record<string, string>
      params?: Record<string, string>
      body?: string
    }

    const method = (payload.method ?? 'GET').trim().toUpperCase()
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
      return NextResponse.json({ ok: false, error: `Unsupported method: ${method}.` }, { status: 400 })
    }

    const rawUrl = (payload.url ?? '').trim()
    if (!rawUrl) return NextResponse.json({ ok: false, error: 'URL is required.' }, { status: 400 })
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return NextResponse.json({ ok: false, error: 'URL is invalid.' }, { status: 400 })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json({ ok: false, error: 'Only http(s) URLs are allowed.' }, { status: 400 })
    }

    // SSRF guard — never let the proxy reach internal/private ranges.
    const { isBlockedHost, isBlockedHostAsync } = await import('@/lib/llm-config')
    if (isBlockedHost(parsed.hostname) || (await isBlockedHostAsync(parsed.hostname))) {
      return NextResponse.json({ ok: false, error: 'Blocked: private or internal host.' }, { status: 403 })
    }

    // Query params from the builder merge onto the URL.
    if (payload.params) {
      for (const [k, v] of Object.entries(payload.params)) {
        if (k.trim()) parsed.searchParams.set(k, v)
      }
    }

    // Header hygiene: drop hop-by-hop and host headers the client shouldn't control.
    const forwardHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(payload.headers ?? {})) {
      const lower = k.toLowerCase()
      if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower.startsWith('sec-')) continue
      if (k.trim() && typeof v === 'string') forwardHeaders[k] = v
    }
    const hasBody = method !== 'GET' && method !== 'HEAD' && typeof payload.body === 'string' && payload.body.length > 0
    if (hasBody && !Object.keys(forwardHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      forwardHeaders['Content-Type'] = 'application/json'
    }

    const started = Date.now()
    let response: Response
    try {
      response = await fetch(parsed.toString(), {
        method,
        headers: forwardHeaders,
        body: hasBody ? payload.body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
    } catch (e) {
      const latencyMs = Date.now() - started
      const msg = e instanceof Error ? e.message : String(e)
      const isTimeout = /timeout|aborted/i.test(msg)
      return NextResponse.json({
        ok: false,
        error: isTimeout ? `Request timed out after ${PROXY_TIMEOUT_MS / 1000}s.` : `Request failed: ${msg}`,
        latencyMs,
      })
    }

    const rawText = await response.text().catch(() => '')
    const bodyText = rawText.slice(0, MAX_RESPONSE_CHARS)
    const latencyMs = Date.now() - started

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => { responseHeaders[k] = v })

    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_API_TEST',
      severity: 'info',
      detail: { method, host: parsed.host, path: parsed.pathname, status: response.status, latencyMs },
    }).catch(() => {})

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      headers: responseHeaders,
      body: bodyText,
      latencyMs,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to send request.')
  }
}
