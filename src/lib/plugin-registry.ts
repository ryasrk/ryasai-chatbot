/**
 * S3 — Plugin/tool registry: external webhook tool executor + helpers.
 * ----------------------------------------------------------------------------
 * Lets admins register external tools (webhooks) that the AI planner can call.
 * Mirrors the executeRestRequest pattern from tool-router but simpler —
 * no REST request log table, no endpoint whitelist matching. Just:
 *   parse manifest → build auth headers → fetch → return output.
 */
import { db } from '@/lib/db'
import { decryptConfig, encryptConfig } from '@/lib/crypto'
import { isBlockedHost } from '@/lib/llm-config'

export interface PluginManifest {
  paramDescription: string
  executorType: 'webhook'
  endpoint: string
  method: string
  authType: 'NONE' | 'BEARER' | 'API_KEY_HEADER'
  authCredentials?: string
  timeoutMs: number
  description: string
}

/** Safe JSON parse + field validation. Returns null on invalid input. */
export function parsePluginManifest(json: string): PluginManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const m = parsed as Record<string, unknown>
  if (typeof m.endpoint !== 'string' || !m.endpoint) return null
  if (typeof m.method !== 'string') return null
  if (m.authType !== 'NONE' && m.authType !== 'BEARER' && m.authType !== 'API_KEY_HEADER') return null
  if (m.executorType !== 'webhook') return null
  return {
    paramDescription: typeof m.paramDescription === 'string' ? m.paramDescription : '',
    executorType: 'webhook',
    endpoint: m.endpoint,
    method: String(m.method).toUpperCase(),
    authType: m.authType,
    authCredentials: typeof m.authCredentials === 'string' ? m.authCredentials : undefined,
    timeoutMs:
      typeof m.timeoutMs === 'number' && Number.isFinite(m.timeoutMs) ? m.timeoutMs : 15000,
    description: typeof m.description === 'string' ? m.description : '',
  }
}

/**
 * Validate + normalize a manifest from user input (POST/PATCH body).
 * Stricter than parsePluginManifest: rejects bad URLs, wrong methods.
 * Returns { error } on invalid, or a clean PluginManifest on valid.
 */
export function normalizeManifest(input: unknown): PluginManifest | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Manifest plugin wajib diisi.' }
  const m = input as Record<string, unknown>

  if (m.executorType !== 'webhook') return { error: 'executorType harus "webhook".' }

  let endpoint: string
  try {
    const url = new URL(String(m.endpoint ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'Endpoint harus menggunakan http atau https.' }
    }
    if (isBlockedHost(url.hostname)) {
      return { error: 'Endpoint menuju host internal yang diblokir.' }
    }
    endpoint = url.toString()
  } catch {
    return { error: 'Endpoint webhook tidak valid.' }
  }

  const method = String(m.method ?? '').trim().toUpperCase()
  if (method !== 'GET' && method !== 'POST') return { error: 'Method harus GET atau POST.' }

  const authType = String(m.authType ?? 'NONE').trim().toUpperCase()
  if (authType !== 'NONE' && authType !== 'BEARER' && authType !== 'API_KEY_HEADER') {
    return { error: 'authType harus NONE, BEARER, atau API_KEY_HEADER.' }
  }

  const timeoutMs =
    typeof m.timeoutMs === 'number' && Number.isFinite(m.timeoutMs)
      ? Math.min(Math.max(Math.floor(m.timeoutMs), 1000), 120000)
      : 15000

  return {
    paramDescription: typeof m.paramDescription === 'string' ? m.paramDescription : '',
    executorType: 'webhook',
    endpoint,
    method,
    authType,
    authCredentials: typeof m.authCredentials === 'string' ? m.authCredentials : undefined,
    timeoutMs,
    description: typeof m.description === 'string' ? m.description : '',
  }
}

/** Encrypt a plain credential string for storage inside manifestJson. */
export function encryptPluginCredentials(plain: string): string {
  return encryptConfig({ c: plain })
}

/** Decrypt a stored credential. Falls back to plain text if not encrypted. */
export function decryptPluginCredentials(encrypted: string): string {
  try {
    const dec = decryptConfig(encrypted)
    return typeof dec.c === 'string' ? dec.c : ''
  } catch (e) {
    console.warn('[plugin-registry] decryptPluginCredentials failed, using plain text:', e)
    return encrypted
  }
}

/** Return a copy with authCredentials masked — safe for admin display. */
export function maskPluginManifest(manifest: PluginManifest): PluginManifest {
  if (manifest.authCredentials) {
    return { ...manifest, authCredentials: '••••' }
  }
  return manifest
}

export async function executePlugin(args: {
  plugin: { manifestJson: string; toolId: string }
  input: string
}): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> {
  const manifest = parsePluginManifest(args.plugin.manifestJson)
  if (!manifest) {
    return { ok: false, output: '', error: 'Plugin manifest tidak valid.', latencyMs: 0 }
  }

  // Decrypt credentials (stored encrypted at rest via encryptPluginCredentials)
  let credentials: string | undefined
  if (manifest.authCredentials) {
    credentials = decryptPluginCredentials(manifest.authCredentials)
  }

  const headers: Record<string, string> = {}
  if (manifest.authType === 'BEARER' && credentials) {
    headers['Authorization'] = `Bearer ${credentials}`
  } else if (manifest.authType === 'API_KEY_HEADER' && credentials) {
    headers['X-API-Key'] = credentials
  }

  const hasBody = manifest.method !== 'GET' && manifest.method !== 'HEAD'
  if (hasBody) headers['Content-Type'] = 'application/json'

  // ponytail: GET plugins carry input as query params (no body channel);
  // ceiling — nested object values stringify to [object Object], upgrade to
  // URLSearchParams manual serialization if a plugin needs structured values.
  let url = manifest.endpoint
  if (manifest.method === 'GET' && args.input) {
    try {
      const parsedUrl = new URL(manifest.endpoint)
      try {
        const params = JSON.parse(args.input)
        if (typeof params === 'object' && params !== null) {
          for (const [k, v] of Object.entries(params)) {
            parsedUrl.searchParams.append(k, String(v))
          }
        } else {
          parsedUrl.searchParams.append('input', String(args.input))
        }
      } catch {
        parsedUrl.searchParams.append('input', String(args.input))
      }
      url = parsedUrl.toString()
    } catch {
      // endpoint not a valid URL with query support, leave as-is
    }
  }

  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: manifest.method,
      headers,
      body: hasBody ? JSON.stringify({ input: args.input }) : undefined,
      signal: AbortSignal.timeout(manifest.timeoutMs || 15000),
    })
    const output = (await response.text()).slice(0, 8000)
    const latencyMs = Date.now() - started
    if (!response.ok) {
      return { ok: false, output: '', error: `Webhook returned HTTP ${response.status}.`, latencyMs }
    }
    return { ok: true, output, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - started
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return {
        ok: false,
        output: '',
        error: `Plugin timeout setelah ${manifest.timeoutMs || 15000}ms.`,
        latencyMs,
      }
    }
    const error = e instanceof Error ? e.message : String(e)
    return { ok: false, output: '', error, latencyMs }
  }
}

export async function listEnabledPlugins(
): Promise<Array<{ id: string; toolId: string; name: string; description: string }>> {
  return db.plugin.findMany({
    where: { isEnabled: true },
    select: { id: true, toolId: true, name: true, description: true },
  })
}
