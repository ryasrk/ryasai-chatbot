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
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'
import { ALLOWED_MCP_CMDS } from '@/lib/admin-tools'
import { z } from 'zod'
import { createHash } from 'node:crypto'

export interface PluginManifest {
  paramDescription: string
  /**
   * Optional JSON Schema for this plugin's arguments.
   *
   * WHY IT EXISTS: without it, every plugin's arguments collapse into ONE string
   * field called `input`, and the model has to guess the shape — it must emit a
   * stringified JSON object and hope the plugin parses it the way it meant. That
   * is the same defect class as blind MCP argument coercion, and it blocks
   * boolean/array/nested parameters outright (the GET serializer in
   * `executePlugin` still documents that nested objects stringify to
   * "[object Object]").
   *
   * A manifest that declares `parameters` gets that schema passed to the model
   * verbatim — the same lossless passthrough MCP tools already enjoy — so typed
   * arguments survive. Manifests without it keep the legacy single-`input`
   * contract, so existing plugins are unaffected.
   */
  /**
   * Manifest format version. Absent means 1 (the original webhook-only format),
   * so every previously-registered plugin keeps parsing unchanged. Present and
   * unrecognised is REJECTED rather than ignored: a manifest written for a newer
   * format may rely on fields we would silently drop, and running a partially
   * understood executor is worse than refusing it.
   */
  manifestVersion?: number
  parameters?: Record<string, unknown>
  /**
   * `webhook` posts to an HTTP endpoint (the original and still the default).
   *
   * `mcp-stdio` runs a LOCAL MCP SERVER process — the industry-standard way to
   * package a tool (the same shape MCP servers and ChatGPT-style connectors use),
   * as opposed to a bespoke webhook contract. It is deliberately restricted to
   * the same interpreter allowlist the MCP installer uses, so a plugin cannot
   * nominate an arbitrary executable.
   */
  executorType: 'webhook' | 'mcp-stdio'
  /** `executorType: 'mcp-stdio'` only: the executable (must be allowlisted). */
  command?: string
  /** `executorType: 'mcp-stdio'` only: arguments, including the script path. */
  args?: string[]
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
  // A malformed schema must NOT invalidate the manifest: one bad plugin would
  // otherwise be dropped from the catalogue entirely, which is a worse failure
  // than ignoring a schema we could not read. A non-object value falls back to
  // `undefined`, i.e. the legacy single-`input` contract.
  parameters: z
    .preprocess(
      (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined),
      z.record(z.string(), z.unknown()).optional(),
    )
    .optional(),
  manifestVersion: z.number().int().min(1).max(2).optional(),
  executorType: z.enum(['webhook', 'mcp-stdio']).default('webhook'),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  // Optional at the schema level: an mcp-stdio manifest has no endpoint. The
  // webhook requirement is enforced in normalizeManifest below, where the
  // executorType is known, so the error message can say WHY it is required.
  endpoint: z.string().url().optional(),
  // Defaulted rather than required: an mcp-stdio manifest has no HTTP method at
  // all, and making it required rejected every valid stdio manifest (caught by
  // trial/zz-plugin2.ts). For webhooks the default keeps the historical POST.
  method: z.enum(['GET', 'POST', 'HEAD']).transform((s) => s.toUpperCase()).default('POST'),
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
  // Method arrives as an arbitrary string — upper-case it before the enum check.
  // Only inject a value when the caller SUPPLIED one: writing `''` for an absent
  // method defeated the schema default and rejected every mcp-stdio manifest,
  // which has no HTTP method at all (caught by trial/zz-plugin2.ts).
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const coerced = input && typeof input === 'object'
    ? {
        ...src,
        ...(src.method === undefined || src.method === null
          ? {}
          : { method: String(src.method).trim().toUpperCase() }),
      }
    : input
  const result = PluginManifestSchema.safeParse(coerced)
  if (!result.success) {
    const first = result.error.issues[0]
    return { error: first ? `Invalid manifest: ${first.path.join('.')} — ${first.message}` : 'Invalid manifest.' }
  }
  const m = result.data as PluginManifest

  // Per-executor requirements, checked here rather than in the Zod schema so the
  // error can name the executor and say what is actually missing.
  if (m.executorType === 'mcp-stdio') {
    if (!m.command) return { error: 'An mcp-stdio manifest requires a command.' }
    // Reuse the SAME allowlist the MCP installer enforces. A second copy is
    // exactly how the two paths drift and one of them ends up permitting an
    // arbitrary executable.
    if (!ALLOWED_MCP_CMDS.has(m.command)) {
      return { error: `Command "${m.command}" is not allowed. Permitted: ${[...ALLOWED_MCP_CMDS].join(', ')}.` }
    }
    return m
  }

  // webhook (the default, and the original format)
  if (!m.endpoint) return { error: 'A webhook manifest requires an endpoint.' }

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
  plugin: { manifestJson: string; toolId: string; manifestDigest?: string | null }
  /** Legacy contract: a single stringified argument blob. */
  input?: string
  /**
   * Structured arguments, used when the manifest declares a `parameters` schema.
   * Preferred over `input` because it preserves real types (numbers, booleans,
   * arrays, nested objects) that a stringified blob would flatten or corrupt.
   */
  args?: Record<string, unknown>
}): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> {
  const manifest = parsePluginManifest(args.plugin.manifestJson)
  if (!manifest) {
    return { ok: false, output: '', error: 'Invalid plugin manifest.', latencyMs: 0 }
  }

  // Integrity gate: refuse to run a manifest that changed after it was approved.
  // This matters most for an executor that spawns a process or calls an
  // endpoint — the approval was given for the definition we hashed, not for
  // whatever the row holds now. `recordedDigest` is optional on Plugin rows
  // registered before digests existed.
  const integrity = verifyManifestIntegrity(args.plugin.manifestJson, args.plugin.manifestDigest ?? null)
  if (!integrity.ok) {
    return { ok: false, output: '', error: integrity.error, latencyMs: 0 }
  }

  // `mcp-stdio` runs a LOCAL MCP SERVER as the plugin's implementation — the
  // industry-standard packaging, so a tool can be shipped as an MCP server
  // instead of a bespoke webhook. It borrows the MCP client wholesale, which
  // means it inherits the same transport, timeouts, SSRF posture and lifecycle.
  if (manifest.executorType === 'mcp-stdio') {
    return executeMcpStdioPlugin(args, manifest)
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

  // Resolve the effective arguments ONCE, preferring the structured form when
  // the caller supplied it (a manifest with a `parameters` schema). Falling back
  // to the legacy stringified blob keeps every existing plugin working.
  const effectiveArgs: Record<string, unknown> | undefined = args.args
    ?? (() => {
      if (!args.input) return undefined
      try {
        const parsed = JSON.parse(args.input)
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { input: args.input }
      } catch {
        return { input: args.input }
      }
    })()

  /**
   * Serialize a value for a query string.
   *
   * The previous implementation used `String(v)`, so a nested object became the
   * literal text "[object Object]" and an array became "a,b" — both silently
   * wrong. JSON-encoding non-primitives keeps the value recoverable server-side.
   */
  const queryValue = (v: unknown): string =>
    v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)

  // GET plugins carry arguments as query params (there is no body channel).
  let url = manifest.endpoint
  if (manifest.method === 'GET' && effectiveArgs) {
    try {
      const parsedUrl = new URL(manifest.endpoint)
      for (const [k, v] of Object.entries(effectiveArgs)) {
        if (v === undefined) continue
        parsedUrl.searchParams.append(k, queryValue(v))
      }
      url = parsedUrl.toString()
    } catch {
      // endpoint not a valid URL with query support, leave as-is
    }
  }

  const started = Date.now()
  try {
    // SSRF re-check at execution time — don't trust registration-time check alone.
    const parsedUrl = new URL(url)
    if (isBlockedHost(parsedUrl.hostname) || await isBlockedHostAsync(parsedUrl.hostname)) {
      return { ok: false, output: '', error: 'Endpoint points to a blocked internal host.', latencyMs: 0 }
    }
    let bodyStr: string | undefined
    if (hasBody) {
      bodyStr = JSON.stringify(effectiveArgs ?? {})
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

/**
 * Run an `mcp-stdio` plugin: spawn the manifest's command, call the named tool.
 *
 * The plugin's `toolId` selects the MCP TOOL on that server (a stdio server
 * commonly exposes several), so one manifest can surface a whole server. The
 * command is re-checked against the allowlist here even though
 * `normalizeManifest` already did: a manifest could have been stored before the
 * allowlist changed, and the check at the execution boundary is the one that
 * actually protects a running system.
 */
async function executeMcpStdioPlugin(
  args: {
    plugin: { manifestJson: string; toolId: string; manifestDigest?: string | null }
    input?: string
    args?: Record<string, unknown>
  },
  manifest: PluginManifest,
): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> {
  const started = Date.now()
  if (!manifest.command || !ALLOWED_MCP_CMDS.has(manifest.command)) {
    return {
      ok: false, output: '', latencyMs: Date.now() - started,
      error: `Refusing to run "${manifest.command ?? ''}": not in the permitted command set (${[...ALLOWED_MCP_CMDS].join(', ')}).`,
    }
  }

  const effectiveArgs: Record<string, unknown> = args.args
    ?? (() => {
      if (!args.input) return {}
      try {
        const parsed = JSON.parse(args.input)
        return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { input: args.input }
      } catch {
        return { input: args.input }
      }
    })()

  try {
    const { callStdioMcpTool } = await import('@/lib/mcp-client')
    const res = await callStdioMcpTool(
      { command: manifest.command, args: manifest.args ?? [], label: args.plugin.toolId },
      args.plugin.toolId,
      effectiveArgs,
    )
    return { ok: res.ok, output: res.output, error: res.error, latencyMs: Date.now() - started }
  } catch (e) {
    return {
      ok: false, output: '', latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Content digest of a manifest, used to detect a manifest that changed after it
 * was reviewed.
 *
 * WHY A DIGEST AND NOT A SIGNATURE: a manifest is authored by the customer's own
 * admin inside this install, not published by a remote third party, so there is
 * no external key we could verify against. A keyed signature would add ceremony
 * without adding a trust anchor. What we CAN catch — and what actually matters
 * for an executor that spawns processes or calls endpoints — is the manifest
 * being swapped underneath a reviewed approval, which a digest detects exactly.
 *
 * The digest deliberately covers the SECURITY-RELEVANT fields rather than the
 * raw JSON: key order and whitespace in `manifestJson` are not stable across an
 * edit round-trip, so hashing the raw text would report spurious changes.
 */
export function computeManifestDigest(manifest: PluginManifest): string {
  const material = JSON.stringify({
    manifestVersion: manifest.manifestVersion ?? 1,
    executorType: manifest.executorType,
    endpoint: manifest.endpoint ?? '',
    method: manifest.method,
    command: manifest.command ?? '',
    args: manifest.args ?? [],
    authType: manifest.authType,
    hasCredentials: Boolean(manifest.authCredentials),
    parameters: manifest.parameters ?? null,
  })
  return createHash('sha256').update(material).digest('hex')
}

/**
 * Verify a stored manifest still matches the digest recorded when it was
 * approved. Returns a reason when it does not.
 *
 * An ABSENT digest is not a failure: plugins registered before digests existed
 * have none, and refusing them would break every existing install. In that case
 * the caller records the digest for next time.
 */
export function verifyManifestIntegrity(
  manifestJson: string,
  recordedDigest: string | null,
): { ok: true; digest: string } | { ok: false; error: string; digest: string } {
  const manifest = parsePluginManifest(manifestJson)
  if (!manifest) return { ok: false, error: 'Invalid plugin manifest.', digest: '' }
  const digest = computeManifestDigest(manifest)
  if (!recordedDigest) return { ok: true, digest }
  if (digest === recordedDigest) return { ok: true, digest }
  return {
    ok: false,
    digest,
    error:
      'This plugin\'s manifest changed after it was approved, so it was not executed. '
      + 'Re-approve the plugin to accept the new definition.',
  }
}
