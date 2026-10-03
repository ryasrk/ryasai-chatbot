import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import { LlmProviderError } from '@/lib/llm-client-utils'
import { DEFAULT_EMBEDDING_MODEL } from '@/lib/constants'

export interface LlmRuntimeConfig {
  id: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface PublicLlmConfig {
  configured: boolean
  provider: string
  baseUrl: string
  model: string
  apiKeyMasked: string | null
  availableModels: string[]
  lastModelSyncAt: string | null
  embeddingProvider: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKeyMasked: string | null
  embeddingAvailableModels: string[]
  lastEmbeddingModelSyncAt: string | null
  updatedAt: string | null
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https.')
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error('Base URL points to a blocked internal host.')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * Operator-declared hosts that are allowed even though they resolve to a private
 * address — for SELF-HOSTED inference (Ollama, vLLM, LM Studio, a local
 * sentence-transformers server, an on-prem gateway).
 *
 * WHY: the SSRF blocklist above is correct for a SaaS deployment talking to a
 * public API, but it makes the supported self-hosted topology impossible — the
 * only escape was `LLM_ALLOW_BLOCKED_HOSTS`, a TEST marker that production
 * refuses to boot with (env-schema). So a customer running their own embedding
 * model could not configure it at all.
 *
 * Format: comma-separated hostnames or IPs, e.g. `ollama,10.0.0.7,embed.internal`.
 * Matching is EXACT after lowercasing (and port is ignored) — never a suffix or
 * wildcard, so `evil-ollama.com` does not match `ollama` and a typo cannot open
 * a whole /8. An operator who opts a host in has taken responsibility for it;
 * the default remains closed.
 */
export function allowedHosts(): string[] {
  return (process.env.LLM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Decode the IPv4 address embedded in an IPv4-mapped / IPv4-compatible IPv6 literal, or return null when
 * the host is not one of those forms. Input may carry brackets and a zone id.
 *
 * Only the `::`-prefixed 32-bit forms are decoded, which is what `::ffff:127.0.0.1` and `::127.0.0.1`
 * canonicalise to. A native IPv6 address (e.g. `fe80::1`) returns null and is handled by the regex checks.
 */
function embeddedIpv4(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (!h.includes('::')) return null
  const parts = h.split('::')
  if (parts.length !== 2) return null
  let tail = parts.slice(1).join('::')
  if (!tail) return null
  // Accept ONLY the two encoded-IPv4 shapes. Everything else (`fd00::1`, `fe80::1`, `2001:...::8888`) is a
  // real IPv6 address whose tail merely LOOKS like a small number, and treating it as IPv4 produced
  // `0.0.0.1`-style values that the IPv4 blocklist correctly ignores -- which silently unblocked the
  // unique-local and link-local prefixes this function is also responsible for. An earlier revision did
  // exactly that and regressed `fd00::1`; the shape check is the fix.
  //
  //   ::ffff:a.b.c.d  /  ::a.b.c.d   -> dotted tail is the IPv4 value
  //   ::ffff:hhhh[:hhhh]            -> hex tail, exactly two 16-bit groups, embedded value decoded
  let body = tail
  if (body.startsWith('ffff:')) body = body.slice('ffff:'.length)
  const isDotted = body.includes('.')
  if (isDotted) {
    const quad = body.split('.')
    if (quad.length !== 4 || !quad.every((q) => /^\d{1,3}$/.test(q) && Number(q) <= 255)) return null
    // A dotted tail only denotes IPv4 when the address is 32-bit: with the marker, or `::a.b.c.d`.
    return quad.join('.')
  }
  const hextets = body.split(':').filter(Boolean)
  // Require the marker for the hex shape, or exactly two groups (the `::7f00:1` form). One bare group is a
  // genuine IPv6 suffix, never an encoded IPv4.
  const marked = tail.startsWith('ffff:')
  if (!marked && hextets.length !== 2) return null
  if (hextets.length === 0 || hextets.length > 2) return null
  const nums: number[] = []
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null
    nums.push(parseInt(hextet, 16))
  }
  const value = hextets.length === 2 ? ((nums[0] << 16) >>> 0) + nums[1] : nums[0]
  const octets = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  return octets.join('.')
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // Explicit operator allowlist wins over the blocklist. Checked BEFORE the
  // test hatch so self-hosted deployments behave identically in dev and prod.
  if (allowedHosts().includes(h)) return false
  if (blockedHostAllowlistEnabled()) {
    // E2E/test only: the mock LLM + license validator run on localhost. This
    // flag is refused in production via env-schema validation.
    return false
  }
  if (h === 'localhost') return true
  if (h === '::1' || h === '::') return true
  // IPv6 forms that DECODE to a loopback/private IPv4 address. String equality above is not enough:
  // `URL` canonicalises `[::ffff:127.0.0.1]` to the hex form `[::ffff:7f00:1]`, which matches neither
  // '::1' nor the IPv4 regexes, so it was dialled. Measured before this fix: a request to
  // http://[::ffff:127.0.0.1]/ reached the transport. The address is therefore PARSED, not pattern-matched:
  // the last two hextets of any `::ffff:a.b.c.d` / `::a.b.c.d` form are the embedded IPv4 value.
  const v4mapped = embeddedIpv4(h)
  if (v4mapped) return isBlockedHost(v4mapped)
  // Cloud metadata endpoints
  if (h === 'metadata.google.internal') return true
  if (h === 'metadata.aws.internal') return true
  if (h === 'metadata.azure.com') return true
  if (/^127\./.test(h)) return true
  if (/^0\.0\.0\.0$/.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h)) return true
  if (/^fd[0-9a-f]/.test(h)) return true
  if (/^fe[89ab][0-9a-f]/.test(h)) return true
  return false
}

/**
 * Is this ADDRESS private, loopback, link-local or otherwise not a public destination?
 *
 * Split out of `isBlockedHost` for the DNS step in `isBlockedHostAsync`, which must judge a RESOLVED ADDRESS without
 * re-consulting the operator allowlist. Asking `isBlockedHost` that question gave the wrong answer: that function
 * checks `allowedHosts().includes(h)` first, so an address the operator had allowlisted came back "not blocked", and
 * every hostname resolving to it inherited the exemption. Being a pure address predicate, this function has no
 * allowlist and no test hatch — callers decide which names or addresses are exempt.
 */
export function isPrivateAddress(address: string): boolean {
  const h = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost') return true
  if (h === '::1' || h === '::') return true
  const v4mapped = embeddedIpv4(h)
  if (v4mapped) return isPrivateAddress(v4mapped)
  if (h === 'metadata.google.internal') return true
  if (h === 'metadata.aws.internal') return true
  if (h === 'metadata.azure.com') return true
  if (/^127\./.test(h)) return true
  if (/^0\.0\.0\.0$/.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h)) return true
  if (/^fd[0-9a-f]/.test(h)) return true
  if (/^fe[89ab][0-9a-f]/.test(h)) return true
  return false
}

/**
 * Test escape hatch for the SSRF blocklist. Reads env lazily so tests can set
 * it after import. NEVER enable in production — env-schema rejects the
 * combination explicitly.
 */
function blockedHostAllowlistEnabled(): boolean {
  if (process.env.LLM_ALLOW_BLOCKED_HOSTS !== 'true') return false
  if (process.env.NODE_ENV !== 'production') return true
  // ponytail: a PRODUCTION BUILD under test (`next build` + `bun .next/standalone/
  // server.js`, i.e. `bunx playwright test -c playwright.prod.config.ts`) runs
  // with NODE_ENV=production but still points at the localhost mock LLM on :4545
  // and mock license validator on :4546. Without this escape the whole prod-build
  // e2e suite dies at boot in env-schema before a single spec runs, so the
  // artifact we actually ship was never testable.
  //
  // This is a SEPARATE, explicit marker — deliberately NOT derived from
  // NODE_ENV — so a real deployment cannot reach it by accident: it requires
  // the operator to set E2E_TEST_MODE=true AND the SSRF hatch AND to bypass
  // env-schema, rather than merely having NODE_ENV=production. E2E_TEST_MODE is
  // also asserted absent in the production-boot test (env-schema.test.ts).
  return process.env.E2E_TEST_MODE === 'true'
}

/**
 * Async DNS-rebinding check — resolves the hostname to all IPs and blocks
 * if any resolved IP is private/loopback/link-local. Use BEFORE TCP connect
 * to prevent SSRF via domains that resolve to internal addresses.
 *
 * Fast path: if isBlockedHost() already blocks the string, skip DNS.
 * ponytail: DNS TOCTOU is a known ceiling — a domain could resolve to a
 * public IP at check time then to 169.254.169.254 at connect time.
 * Full fix requires pinning the resolved IP in the TCP socket, which
 * Node's fetch/http don't expose. The check closes the common case.
 */
export async function isBlockedHostAsync(hostname: string): Promise<boolean> {
  // The operator allowlist is consulted FIRST, and its absence is what makes the
  // rest of this function meaningful. Without this early return the allowlist only
  // ever covered the LITERAL hostname, so a host the operator opted in -- `ollama`,
  // `embed.internal`, or the documented `localhost` -- was allowed here and then
  // immediately re-blocked by the DNS step below, because the name resolves to a
  // private address and that address is not itself in the allowlist.
  //
  // Measured before the fix: with LLM_ALLOWED_HOSTS=localhost,
  //   isBlockedHost('localhost')      -> false  (allowlisted, correct)
  //   isBlockedHostAsync('localhost') -> TRUE   (contradicted the allowlist)
  // The inconsistency was invisible to the synchronous callers and made the
  // self-hosted topology the doc comment above promises impossible to configure:
  // a user set the host, saved it, and every request failed with "Base URL points
  // to a blocked internal host" with no hint that the allowlist had been ignored.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  // The allowlist exempts the NAME the operator wrote. It must NOT be consulted again for the RESOLVED address —
  // see the `isPrivateAddress` call below for why that distinction is the whole defence.
  if (allowedHosts().includes(h)) return false
  if (isBlockedHost(hostname)) return true
  // Skip DNS for IP literals — already checked by isBlockedHost
  if (/^\[?[\d.]+\]?$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) return false
  try {
    const { lookup } = await import('node:dns/promises')
    const results = await lookup(hostname, { all: true })
    /*
     * `isPrivateAddress`, NOT `isBlockedHost` — and this is THE fix for a live exemption bypass.
     *
     * `isBlockedHost` consults the operator allowlist FIRST (line ~120: `if (allowedHosts().includes(h)) return false`).
     * Calling it with the RESOLVED ADDRESS therefore asks "is this address allowlisted", and for the documented
     * self-hosted topology the answer is yes: an operator who sets `LLM_ALLOWED_HOSTS=127.0.0.1` — or simply keeps the
     * shipped `localhost,127.0.0.1` — has allowlisted exactly the address that every `*.nip.io` / `lvh.me` name
     * resolves to. MEASURED, verified independently of the agent that found it:
     *
     *   allowlist "127.0.0.1"            -> isBlockedHostAsync('lvh.me')              = false   (dialled)
     *   allowlist "127.0.0.1,localhost"  -> isBlockedHostAsync('c2.127.0.0.1.nip.io') = false   (dialled)
     *   (cloud metadata via the same wildcard DNS still correctly blocks — `isPrivateAddress` is not the only layer)
     *
     * The consequence: any hostname an attacker can point at a private address (`lvh.me`, `<anything>.nip.io`,
     * `<anything>.sslip.io`, a DNS-rebinding name) inherits the exemption and the request is dialled — which is
     * exactly what this DNS step exists to stop. The allowlist is a statement about a NAME, so it is applied to the
     * name and never re-applied to what that name resolves to.
     *
     * The name-is-allowlisted case returns above, so a legitimately configured self-hosted endpoint is unaffected:
     * `localhost` and `127.0.0.1.nip.io` are still exempt when the operator listed them.
     */
    return results.some((r) => isPrivateAddress(r.address))
  } catch {
    // DNS resolution failed — fail open (let the transport try and fail)
    return false
  }
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}••••••${secret.slice(-4)}`
}

function parseModels(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function decryptApiKey(encryptedApiKey: string): string {
  const config = decryptConfig(encryptedApiKey)
  const apiKey = config.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Invalid LLM API key.')
  }
  return apiKey
}

export async function getLlmRuntimeConfig(): Promise<LlmRuntimeConfig | null> {
  // Same fail-closed rule as getEmbeddingRuntimeConfig: with no org context,
  // `findFirst()` scans the WHOLE table and returns whichever tenant's config
  // happens to be first — a different org's baseUrl, model and API key
  // (proven at runtime, trial/55). Routes call enterWithOrg first; background
  // work that does not would otherwise spend a stranger's credentials.
  if (!getOrgContext()) {
    console.warn('[llm-config] getLlmRuntimeConfig called without an org context — refusing to read another tenant\'s config')
    return null
  }
  const row = await db.llmConfig.findFirst({
    where: { purpose: 'chat' },
  }) ?? await db.llmConfig.findFirst()
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
}

export async function getAgentLlmConfig(): Promise<LlmRuntimeConfig | null> {
  if (!getOrgContext()) {
    console.warn('[llm-config] getAgentLlmConfig called without an org context — refusing to read another tenant\'s config')
    return null
  }
  const row = await db.llmConfig.findFirst({
    where: { purpose: 'agent' },
  })
  if (!row) {
    // Fallback to chat config if agent config not set
    return getLlmRuntimeConfig()
  }
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
}

// ---------------------------------------------------------------------------
// Role-specific LLM config — LightRAG pattern.
// 4 roles: EXTRACT (entity-relation extraction), QUERY (answer synthesis),
// KEYWORD (keyword generation), VLM (multimodal).
// Each role can have its own model (fast/cheap for extraction, strong for answers).
// Falls back to chat config when no role-specific row exists.
// ponytail: uses the existing `purpose` field on LlmConfig — no schema change needed.
// Configure via LlmConfig rows with purpose = 'extract' | 'query' | 'keyword' | 'vlm'.
// ---------------------------------------------------------------------------

export type LlmRole = 'extract' | 'query' | 'keyword' | 'vlm' | 'chat' | 'agent'

/*
 * KEYED BY ORG **AND** ROLE. The org half is not optional.
 *
 * It was `Map<LlmRole, ...>` — one entry per role for the WHOLE PROCESS. MEASURED with two orgs holding
 * different configs: org-A resolved `https://A.example/model-A`, and org-B then resolved
 * `https://A.example/model-A` too — org A's endpoint AND API KEY, for up to 30 seconds, inside org B's
 * request. Every caller of `getRoleLlmConfig` was exposed (intent-pipeline, hyde, knowledge-graph, rag
 * rerank, embeddings, alignment-check, reflexion, simple-pipeline, source-init), including paths reached
 * from the scoped external API.
 *
 * `getLlmRuntimeConfig` refuses to read without an org context; this cache bypassed that guard by short-
 * circuiting before it. Putting the org in the key restores the same isolation, and a null key (no org
 * context) skips the cache entirely rather than sharing one entry.
 */
const _roleCache = new Map<string, { config: LlmRuntimeConfig | null; ts: number }>()
const ROLE_CACHE_TTL = 30_000 // 30s — config rarely changes mid-session

/** Cache key, or null when there is no org context — in which case NO cache is used. */
function roleCacheKey(role: LlmRole): string | null {
  const orgId = getOrgContext()
  return orgId ? `${orgId}:${role}` : null
}

export async function getRoleLlmConfig(role: LlmRole): Promise<LlmRuntimeConfig | null> {
  // Fast path: chat and agent use existing resolvers
  if (role === 'chat') return getLlmRuntimeConfig()
  if (role === 'agent') return getAgentLlmConfig()

  // Check cache. A null key means there is no org context: skip the cache entirely rather than fall
  // through to a shared entry, which is the cross-tenant bug this key exists to prevent.
  const key = roleCacheKey(role)
  if (key) {
    const cached = _roleCache.get(key)
    if (cached && Date.now() - cached.ts < ROLE_CACHE_TTL) return cached.config
  }

  // Look for a role-specific config row
  const row = await db.llmConfig.findFirst({ where: { purpose: role } })
  if (!row) {
    // Fall back to chat config — role-specific is opt-in
    const fallback = await getLlmRuntimeConfig()
    if (key) _roleCache.set(key, { config: fallback, ts: Date.now() })
    return fallback
  }

  const config: LlmRuntimeConfig = {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
  if (key) _roleCache.set(key, { config, ts: Date.now() })
  return config
}

export function invalidateRoleConfigCache(): void {
  _roleCache.clear()
}

/**
 * THE chat config row, resolved the same way by every caller.
 *
 * WHY THIS EXISTS. `getPublicLlmConfig()` (what the AI Configuration screen reads) used a bare
 * `findFirst()`, while `PUT` (what that screen SAVES to) used `findFirst({ purpose: 'chat' })`. Those
 * agree only by luck: this install has TWO `LlmConfig` rows — one `purpose: 'chat'` with an EMPTY
 * `availableModels`, and one `purpose: 'agent'` holding 37 synced models and the newer model name.
 * Postgres has no implicit ORDER BY for an unfiltered `findFirst`, so the screen could read one row and
 * write another, and which one it read was the planner's choice rather than the code's.
 *
 * The `purpose: 'chat'` filter is the authority: it is what the runtime uses for chat
 * (`getLlmRuntimeConfig`) and what the writer already targeted. The fallback keeps single-row installs
 * working, where no row carries a purpose at all.
 */
export async function resolveChatConfigRow() {
  return (
    (await db.llmConfig.findFirst({ where: { purpose: 'chat' } })) ??
    (await db.llmConfig.findFirst())
  )
}

/**
 * The MEMORY config row, if the org has deliberately set one.
 *
 * WHY MEMORY CAN HAVE ITS OWN MODEL. The cognee sidecar runs its own entity/relation extraction
 * pipeline against the customer's provider. Extraction is a different job from answering: it is
 * high-volume, structurally repetitive and quality-tolerant — the schema is what matters, not prose.
 * An operator with a cheap fast model beside an expensive answering model has every reason to want
 * them separate, and until now there was no way to express that: the sidecar's credentials were a
 * COPY of the chat row (`pushCogneeProviderConfig`), so pointing memory at a second model meant
 * editing `.env.cognee` and restarting the container by hand.
 *
 * FALLS BACK TO CHAT, deliberately, and that fallback is not a convenience: every install that
 * upgraded into this feature has no `purpose: 'memory'` row, and their memory works today. Returning
 * null instead would read as "memory is unconfigured" and stop extraction on installs that were
 * fine. `getMemoryLlmConfig` below is the expression callers should use; this one answers the
 * narrower question "did somebody deliberately choose a memory model?".
 *
 * Returns null when unset, and also when there is no org context — the same fail-closed rule the
 * other resolvers hold, because an unscoped `findFirst()` returns whichever tenant sorts first.
 */
export async function resolveMemoryConfigRow() {
  if (!getOrgContext()) return null
  return db.llmConfig.findFirst({ where: { purpose: 'memory' } })
}

/**
 * The credentials the memory sidecar should use: the memory row when one exists, else the chat row.
 *
 * `source` is returned rather than inferred by the caller so the UI can say WHICH model memory is
 * actually using. That distinction is the whole point of this pair: "memory has its own model" and
 * "memory is following chat" are different states, and a screen that renders them identically would
 * make the new feature invisible on every install that has not used it yet.
 */
export async function getMemoryLlmConfig(): Promise<
  (LlmRuntimeConfig & { source: 'memory' | 'chat' }) | null
> {
  const memoryRow = await resolveMemoryConfigRow()
  if (memoryRow) {
    return {
      id: memoryRow.id,
      provider: memoryRow.provider,
      baseUrl: memoryRow.baseUrl,
      apiKey: decryptApiKey(memoryRow.encryptedApiKey),
      model: memoryRow.model,
      source: 'memory',
    }
  }
  const chat = await getLlmRuntimeConfig()
  return chat ? { ...chat, source: 'chat' } : null
}

/**
 * The model a retrieval query would ACTUALLY be embedded with, right now.
 *
 * This is deliberately the same expression the write path uses (`getEmbeddingRuntimeConfig`),
 * so a screen comparing it against the stamp stored on the chunks is comparing like with like.
 * Returns null when there is no org context or no config row — "cannot tell", never a guess.
 *
 * WHY IT EXISTS: a stored `embeddingModel` that disagrees with this value makes
 * `retrieveRelevantChunks` skip every chunk (`chunk.embeddingModel === queryEmbedding.model`),
 * so semantic scoring silently drops to 0 and search degrades to lexical-only. That condition
 * is invisible in the UI today; this resolver is the missing half of the comparison.
 */
export async function resolveConfiguredEmbeddingModel(): Promise<string | null> {
  if (!getOrgContext()) return null
  const row = await resolveChatConfigRow()
  if (!row) return null
  return (row.embeddingModel ?? '').trim() || DEFAULT_EMBEDDING_MODEL
}

export async function getPublicLlmConfig(): Promise<PublicLlmConfig> {
  const row = await resolveChatConfigRow()
  if (!row) {
    return {
      configured: false,
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: '',
      model: '',
      apiKeyMasked: null,
      availableModels: [],
      lastModelSyncAt: null,
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: '',
      embeddingModel: '',
      embeddingApiKeyMasked: null,
      embeddingAvailableModels: [],
      lastEmbeddingModelSyncAt: null,
      updatedAt: null,
    }
  }

  let apiKeyMasked: string | null = null
  try {
    apiKeyMasked = maskSecret(decryptApiKey(row.encryptedApiKey))
  } catch (e) {
    console.warn('[llm-config] decryptApiKey failed:', e)
    apiKeyMasked = '••••'
  }

  let embeddingApiKeyMasked: string | null = null
  if (row.encryptedEmbeddingApiKey) {
    try {
      embeddingApiKeyMasked = maskSecret(decryptApiKey(row.encryptedEmbeddingApiKey))
    } catch (e) {
      console.warn('[llm-config] decryptEmbeddingApiKey failed:', e)
      embeddingApiKeyMasked = '••••'
    }
  }

  return {
    configured: true,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyMasked,
    availableModels: parseModels(row.availableModels),
    lastModelSyncAt: row.lastModelSyncAt?.toISOString() ?? null,
    embeddingProvider: row.embeddingProvider ?? 'OPENAI_COMPATIBLE',
    embeddingBaseUrl: row.embeddingBaseUrl ?? row.baseUrl,
    // Derived from the one fact in constants.ts, never a fresh literal. This
    // value is what the Settings page DISPLAYS and what a save would persist
    // into `LlmConfig.embeddingModel`; the embedder then sends it as the
    // request's `model` and stamps it onto every new chunk. A blank box used to
    // resolve to OpenAI's `text-embedding-3-small` (1536 dims) beside a
    // `vector(384)` column and a 384-dim bundled sidecar, so the displayed
    // setting, the stored stamp and the vectors already in the table could
    // never agree — retrieval only compares a chunk whose stamp equals the
    // query's, so every similarity was 0 and search silently went lexical-only.
    embeddingModel: row.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL,
    embeddingApiKeyMasked,
    embeddingAvailableModels: parseModels(row.embeddingAvailableModels),
    lastEmbeddingModelSyncAt: row.lastEmbeddingModelSyncAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function fetchProviderModels(args: {
  baseUrl: string
  apiKey: string
}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(args.baseUrl)
  const apiKey = args.apiKey.trim()
  if (!apiKey) throw new Error('API key is required to fetch the model list.')

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    // Throw the CLASSIFIED error, not a bare status. `fetchProviderModels` is what a customer hits
    // when they paste a key and press "sync models", so this is the first feedback their credential
    // ever gets — and it used to discard the provider's body entirely, leaving us unable to say
    // anything but "HTTP 401". `classifyProviderFailure` already turns that body into an actionable
    // hint ("re-enter the key", "add credit", "pick a model your provider serves"), and
    // `toTypedError` already forwards `hint` to the client, so the only missing piece was the body.
    //
    // The body is read here and NOT echoed to the caller: `LlmProviderError` redacts it before
    // anyone sees it, because provider errors can echo the key prefix.
    const body = await res.text().catch(() => '')
    throw new LlmProviderError(res.status, body)
  }

  const payload = (await res.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>
    models?: unknown[]
  }

  const fromData = Array.isArray(payload.data)
    ? payload.data.map((m) => m.id ?? m.name).map(String)
    : []
  const fromModels = Array.isArray(payload.models)
    ? payload.models.map((m) => {
        if (typeof m === 'string') return m
        if (m && typeof m === 'object' && 'id' in m) return String((m as { id: unknown }).id)
        if (m && typeof m === 'object' && 'name' in m) return String((m as { name: unknown }).name)
        return ''
      })
    : []

  return Array.from(new Set([...fromData, ...fromModels].filter(Boolean))).sort()
}
