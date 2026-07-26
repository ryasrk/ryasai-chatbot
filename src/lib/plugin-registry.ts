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
import { z } from 'zod'

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

// ponytail: Zod schema — single source of truth for manifest validation.
// Reused by parsePluginManifest (loose, for execution) and normalizeManifest (strict, for registration).
const PluginManifestSchema = z.object({
  paramDescription: z.string().default(''),
  executorType: z.literal('webhook'),
  endpoint: z.string().url(),
  method: z.enum(['GET', 'POST']).transform((s) => s.toUpperCase()),
  authType: z.enum(['NONE', 'BEARER', 'API_KEY_HEADER']),
  authCredentials: z.string().optional(),
  timeoutMs: z.number().finite().int().min(1000).max(120000).default(15000),
  description: z.string().default(''),
})

/** Safe JSON parse + field validation. Returns null on invalid input. */
export function parsePluginManifest(json: string): PluginManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const result = PluginManifestSchema.safeParse(parsed)
  if (!result.success) return null
  return result.data as PluginManifest
}

/**
 * Validate + normalize a manifest from user input (POST/PATCH body).
 * Stricter than parsePluginManifest: rejects bad URLs, wrong methods, SSRF hosts.
 * Returns { error } on invalid, or a clean PluginManifest on valid.
 */
export function normalizeManifest(input: unknown): PluginManifest | { error: string } {
  // Method comes in as arbitrary string — coerce to uppercase before enum check.
  const coerced = input && typeof input === 'object'
    ? { ...(input as Record<string, unknown>), method: String((input as Record<string, unknown>).method ?? '').trim().toUpperCase() }
    : input
  const result = PluginManifestSchema.safeParse(coerced)
  if (!result.success) {
    const first = result.error.issues[0]
    return { error: first ? `Invalid manifest: ${first.path.join('.')} — ${first.message}` : 'Invalid manifest.' }
  }
  const m = result.data as PluginManifest

  // SSRF + protocol check (Zod's z.string().url() allows http/https only, but double-check host)
  try {
    const url = new URL(m.endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'Endpoint must use http or https.' }
    }
    if (isBlockedHost(url.hostname)) {
      return { error: 'Endpoint points to a blocked internal host.' }
    }
  } catch {
    return { error: 'Invalid webhook endpoint.' }
  }

  return m
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
    return { ok: false, output: '', error: 'Invalid plugin manifest.', latencyMs: 0 }
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
    let bodyStr: string | undefined
    if (hasBody && args.input) {
      try {
        bodyStr = JSON.stringify(JSON.parse(args.input))
      } catch {
        bodyStr = JSON.stringify({ input: args.input })
      }
    } else if (hasBody) {
      bodyStr = JSON.stringify({})
    }
    const response = await fetch(url, {
      method: manifest.method,
      headers,
      body: bodyStr,
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
        error: `Plugin timeout after ${manifest.timeoutMs || 15000}ms.`,
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
