/**
 * Cognee — core engine: settings cache, client init, shared helpers.
 * Depends on: external (llm-config, embeddings, db). No deps on other cognee split files.
 *
 * TENANCY
 * ----------------------------------------------------------------------------
 * Everything here is keyed by organizationId. Cognee used to hold one global
 * client + one global ownerId + one global settings cache, which meant a single
 * shared store: org B recalled org A's documents, org A's settings applied to
 * org B for the 10s cache window, and whichever org initialised first supplied
 * the LLM API key that every other org's cognify then billed to.
 *
 * No org context => cognee is a no-op. Fail closed: a background worker that
 * forgets to enterWithOrg gets nothing rather than everyone's data.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { getEmbeddingRuntimeConfig } from '@/lib/embeddings'
import { getOrgContext } from '@/lib/prisma-tenant'
import { db } from '@/lib/db'
import type { CogneeHttpOptions } from './cognee-http'

interface CogneeSettings {
  enabled: boolean
  dbProvider: 'local' | 'postgres'
  dbUrl: string | null
  batchSize: number
  maxRetries: number
  /**
   * Origin of a cognee API server (v1.5.4) when one is configured, else null.
   *
   * Two backends exist and they are NOT interchangeable at runtime:
   *   - 'server'  — HTTP to cognee 1.5.4 (docs/cognee-http-migration.md)
   *   - nothing else. The in-process SDK path was REMOVED on 2026-09-24.
   *
   * The server wins when COGNEE_SERVER_URL is set, because its write path is the
   * one that actually works: measured 19.9s write / 4.3s recall returning the
   * token, against the TS binding's 0.2.0 false-success and the local kuzu
   * backend's unusable graph search.
   */
  serverUrl: string | null
}

export type CogneeBackend = 'server'

const DISABLED_SETTINGS: CogneeSettings = {
  enabled: false,
  dbProvider: 'local',
  dbUrl: null,
  batchSize: 50,
  maxRetries: 3,
  serverUrl: null,
}

const _settingsCache = new Map<string, { settings: CogneeSettings; at: number }>()
const SETTINGS_TTL = 10000 // 10s cache

/**
 * The graph backend this deployment will actually use.
 *
 * `getCogneeClientWithRetry` sets exactly these two names (`kuzu` in local mode, `postgres`
 * otherwise), and callers need to know which one BEFORE paying for a search that the backend
 * cannot serve.
 */
export async function getCogneeGraphProvider(): Promise<'kuzu' | 'postgres' | null> {
  const settings = await getCogneeSettings().catch(() => null)
  if (!settings) return null
  return settings.dbProvider === 'postgres' ? 'postgres' : 'kuzu'
}

/**
 * Can this graph backend serve `NATURAL_LANGUAGE` (LLM-generated Cypher)?
 *
 * MEASURED: no, on kuzu. The SDK accepts the name but the search fails every time with
 * "NATURAL_LANGUAGE search generated Cypher that this graph backend rejected on all 3
 * attempt(s)" — and it is the ONLY strategy that fails, so the cost is paid on every turn
 * for nothing (recorded 6039ms for the doomed attempt, plus its LLM call). It is skipped on
 * kuzu now; `null` (settings unreadable) keeps it OPTIMISTIC, because an unknown backend must
 * not silently lose a strategy that might work.
 *
 * GRAPH_COMPLETION was measured as a replacement and is WORSE: it failed after 193341ms with
 * an embedding HTTP error, so it is not swapped in. CHUNKS_LEXICAL was measured WORKING (41ms)
 * and is added where NATURAL_LANGUAGE is dropped.
 */
export function supportsNaturalLanguageSearch(provider: 'kuzu' | 'postgres' | null): boolean {
  return provider !== 'kuzu'
}

/**
 * Which backend memory calls go through, and the HTTP options when it is a server.
 *
 * One place decides, so `cognee-memory.ts` and `cognee-knowledge-graph.ts` cannot
 * drift into using different backends for a write and its matching read.
 */
export async function getCogneeBackend(): Promise<{
  kind: CogneeBackend
  serverUrl: string | null
} | null> {
  const settings = await getCogneeSettings().catch(() => null)
  if (!settings) return null
  if (settings.serverUrl) return { kind: 'server', serverUrl: settings.serverUrl }
  // NO IN-PROCESS FALLBACK — see getCogneeClient below for why the SDK was removed.
  // With no server configured memory is OFF, and `null` says so. Returning a fake
  // 'inprocess' would send every caller down a path whose first statement is
  // `await import('@cognee/cognee-ts')`, which now fails at runtime and would read
  // as "memory is broken" instead of "memory is not configured".
  return null
}

/** HTTP options for the configured server, or null when there is none. */
export async function getCogneeServerOptions(): Promise<CogneeHttpOptions | null> {
  const backend = await getCogneeBackend()
  if (!backend?.serverUrl) return null
  return {
    baseUrl: backend.serverUrl,
    timeoutMs: COGNEE_CALL_TIMEOUT_MS,
    apiKey: process.env.COGNEE_SERVER_API_KEY?.trim() || undefined,
  }
}

// BACKEND CHOICE for cognee. Two paths exist and the server wins when configured.
//
// `COGNEE_SERVER_URL` set  -> HTTP to a cognee 1.5.4 API server (the DEFAULT path
//                             we now ship — see docs/cognee-http-migration.md)
// `COGNEE_SERVER_URL` unset -> memory is OFF (no in-process fallback exists)
//
// Why the server is the primary path, all MEASURED:
//   - Server 1.5.4: `remember` 19.9s then a recall 4.3s that RETURNED the token.
//     Real work, verifiable result.
//   - TS binding 0.2.0: `remember()` returns {"status":"PipelineRunCompleted"} in
//     ~25ms and writes NOTHING, then marks the dataset completed — a mark that
//     PERSISTS in cognee.db, so downgrading does not recover. Only deleting the
//     store did. A false success is worse than the `has()` bug, which at least
//     returned a wrong boolean instead of losing data silently.
//   - TS binding on kuzu: NATURAL_LANGUAGE fails on every attempt (~7s plus its
//     own LLM call) and GRAPH_COMPLETION was measured failing after 193341ms, so
//     the graph — the reason cognee is here at all — barely worked in-process.
//
// That history is why the bindings were the FALLBACK and never the default. They are
// now gone entirely (see getCogneeClient), so the choice above is permanent rather
// than a preference. scripts/cognee-upgrade-check.md still applies to anyone
// proposing to bring them back.
export async function getCogneeSettings(): Promise<CogneeSettings> {
  const orgId = getOrgContext()
  if (!orgId) return DISABLED_SETTINGS

  const cached = _settingsCache.get(orgId)
  if (cached && Date.now() - cached.at < SETTINGS_TTL) return cached.settings

  // ponytail: COGNEE_ENABLED is a kill switch, not a second toggle. Only the
  // literal "false" forces cognee off process-wide — the scheduler worker sets it
  // (ladybugdb's graph file lock cannot be shared between processes), and a
  // hardened deployment can too. Any other value defers to the org's Settings
  // toggle, which is the switch an admin actually sees.
  //
  // It used to be ANDed with the DB flag, so an admin who enabled cognee in
  // Settings on a server whose env var was merely *unset* got a silent no-op
  // plus a UI telling them to ask an administrator — who was themselves.
  const envKilled = process.env.COGNEE_ENABLED === 'false'

  // No AppConfig row = nothing configured yet (pre-setup). Nobody has opted in,
  // so keep the old fail-closed rule there: external graph writes and LLM spend
  // need an explicit "true".
  const envEnabled = process.env.COGNEE_ENABLED === 'true'

  const envFallback = (): CogneeSettings => ({
    enabled: envEnabled,
    dbProvider: process.env.COGNEE_DB_PROVIDER?.toLowerCase() === 'postgres' ? 'postgres' : 'local',
    dbUrl: process.env.COGNEE_DB_URL ?? null,
    batchSize: parseInt(process.env.COGNEE_BATCH_SIZE ?? '50', 10),
    maxRetries: parseInt(process.env.COGNEE_MAX_RETRIES ?? '3', 10),
    serverUrl: process.env.COGNEE_SERVER_URL?.trim() || null,
  })

  // ORPHANED FIELDS, kept for API compatibility. `dbProvider` and `dbUrl` used to tell
  // the in-process SDK which storage to open (kuzu+lancedb, or pgvector over a DB URL).
  // The bindings are gone and the store belongs to the cognee v1.6.0 server, whose
  // backends are set by docker-compose.yml — so these two values are now INERT: read from
  // env and from the org row, surfaced to the UI, and able to change nothing.
  //
  // Left in place rather than deleted because `/api/cognee` still accepts and echoes them
  // and the Settings card renders them; removing the fields is an API change that needs a
  // deliberate decision, not a side effect of a transport migration. Flagged HERE so the
  // next reader does not spend an afternoon proving that toggling them has no effect.
  let settings: CogneeSettings
  try {
    // Org-scoped by the tenant extension — this is THIS org's config.
    const config = await db.appConfig.findFirst()
    settings = config
      ? {
          enabled: !envKilled && config.cogneeEnabled,
          dbProvider: config.cogneeDbProvider === 'postgres' ? 'postgres' : 'local',
          dbUrl: config.cogneeDbUrl ?? process.env.COGNEE_DB_URL ?? null,
          batchSize: config.cogneeBatchSize || parseInt(process.env.COGNEE_BATCH_SIZE ?? '50', 10),
          maxRetries: config.cogneeMaxRetries || parseInt(process.env.COGNEE_MAX_RETRIES ?? '3', 10),
          // Deliberately NOT org-settable: the server address is a deployment
          // fact (the sidecar's hostname), not a per-tenant preference. One
          // org pointing memory at a different server would be a cross-tenant
          // leak of exactly the kind this module already had to fix.
          serverUrl: process.env.COGNEE_SERVER_URL?.trim() || null,
        }
      : envFallback()
  } catch {
    settings = envFallback()
  }

  _settingsCache.set(orgId, { settings, at: Date.now() })
  return settings
}

/**
 * Invalidate cached settings — call after UI updates cognee config.
 * Clears the calling org only; pass `all` for process-wide (tests, reset).
 */
export function invalidateCogneeSettings(scope: 'org' | 'all' = 'org'): void {
  const orgId = getOrgContext()
  if (scope === 'all' || !orgId) _settingsCache.clear()
  else _settingsCache.delete(orgId)
}

export async function isCogneeEnabled(): Promise<boolean> {
  return (await getCogneeSettings()).enabled
}

export function cogneeBatchSize(settings: CogneeSettings): number {
  return settings.batchSize
}

export function cognifyMaxRetries(settings: CogneeSettings): number {
  return settings.maxRetries
}

interface CogneeEntry {
  client: any | null
  ownerId: string | null
  initFailedAt: number
  warming: boolean
}

const _clients = new Map<string, CogneeEntry>()

const INIT_RETRY_MS = 30000 // retry init after 30s if it failed

function entryFor(orgId: string): CogneeEntry {
  let entry = _clients.get(orgId)
  if (!entry) {
    entry = { client: null, ownerId: null, initFailedAt: 0, warming: false }
    _clients.set(orgId, entry)
  }
  return entry
}

/**
 * Per-org cognee store paths. In `local` mode all state is files on disk, so the
 * org id has to be in the path — one shared sqlite/kuzu/lancedb directory is one
 * shared knowledge graph. Sanitised because it lands in a filesystem path.
 */
function storeDirsFor(orgId: string): { dataDir: string; systemDir: string } {
  const safe = orgId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const dataRoot = process.env.COGNEE_DATA_DIR ?? '.cognee/data'
  const systemRoot = process.env.COGNEE_SYSTEM_DIR ?? '.cognee/system'
  return { dataDir: `${dataRoot}/${safe}`, systemDir: `${systemRoot}/${safe}` }
}

/**
 * How long to wait for cognee's SDK before giving up on a single call.
 *
 * WHY this exists: there was NO bound anywhere in this module (verified — the only
 * `timeout` in the whole cognee layer was a `setTimeout` sleep). A native call that
 * never settles hangs the caller forever, and the call sites do not defend themselves:
 * `recallContext` is wrapped in `.catch(() => '')`, which catches a THROW and not a
 * HANG, while `tool-router.ts` `await`s `rememberChatTurn` *after* computing the answer,
 * so one stuck SDK call stalls the user's response with nothing to show for it.
 * A deadline is the only thing that turns a hang back into the documented
 * "memory is unavailable" state the rest of the system already handles.
 *
 * 240s, not 20s — MEASURED, and the first value was wrong in a way that silently
 * destroyed memory writes. `remember()` runs cognee's cognify pipeline, which makes
 * its own LLM calls; one ordinary fact took **192s** end to end. A 20s deadline
 * therefore aborted real writes mid-flight, and the aborted pipeline kept running
 * server-side, so the NEXT write failed with "cognify for dataset ... is already
 * running" — a timeout that produced a permanent-looking breakage. The deadline must
 * sit above the slowest legitimate call, or it converts slow work into corruption.
 */
const COGNEE_CALL_TIMEOUT_MS = Number(process.env.COGNEE_CALL_TIMEOUT_MS ?? 240000)

export function withDeadline<T>(promise: Promise<T>, op: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`cognee ${op} exceeded ${COGNEE_CALL_TIMEOUT_MS}ms`)),
      COGNEE_CALL_TIMEOUT_MS,
    )
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Does this init error look like a damaged on-disk store rather than a config problem?
 *
 * INCIDENT, measured end to end: on Bun 1.3.14, importing the native Neon binding while an
 * AsyncLocalStorage context was active SEGFAULTED the process. The crash left a torn
 * `graph.wal` in `.cognee/system/<org>/`, and from then on EVERY init failed with
 * `Graph database error: initialization failed: Failed to create database: std::bad_alloc`
 * — permanently, on every Bun version, for that org only. Removing the torn WAL made the
 * identical init succeed. So a single crash used to disable memory for that tenant forever,
 * and the only diagnostic was an allocation error that points at nothing on disk.
 *
 * The match is deliberately narrow: these two strings are kuzu/lancedb store-init failures.
 * A config error (missing key, unreachable embedding endpoint) must NOT be treated as store
 * damage — quarantining on a config problem would delete a healthy graph on every bad deploy.
 */
function isStoreCorruption(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err)
  return (
    /Graph database error: initialization failed/i.test(msg) ||
    /Failed to create database/i.test(msg)
  )
}

/**
 * A quarantine directory name that cannot collide with an existing one.
 *
 * A millisecond timestamp is not unique (measured: five consecutive `toISOString()`
 * calls gave two distinct strings) and `mkdirSync(recursive)` accepts an existing
 * directory, so two quarantines in one millisecond used to merge — renaming the second
 * store's bytes in beside the first's. That loses the distinction between two corrupted
 * stores and breaks the caller's promise that the bytes are preserved.
 *
 * Pure and exported so the rule is testable without racing the clock.
 */
export function uniqueQuarantineDir(systemDir: string, stamp: string): string {
  let candidate = `${systemDir}.corrupt-${stamp}`
  for (let n = 1; existsSync(candidate); n += 1) {
    candidate = `${systemDir}.corrupt-${stamp}-${n}`
  }
  return candidate
}

/**
 * Move an org's local cognee store aside so a fresh one can be built, and return where it went.
 *
 * Quarantine, never delete: the bytes may be the tenant's only copy of their graph, and a
 * false positive here would be unrecoverable. The caller rebuilds, and an operator can
 * inspect or restore the directory afterwards.
 */
function quarantineStore(orgId: string, dirs: { dataDir: string; systemDir: string }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Never reuse a name: see uniqueQuarantineDir for why milliseconds are not unique.
  const quarantineDir = uniqueQuarantineDir(dirs.systemDir, stamp)
  mkdirSync(quarantineDir, { recursive: true })
  for (const dir of [dirs.systemDir, dirs.dataDir]) {
    if (!existsSync(dir)) continue
    const dest = `${quarantineDir}/${dir.split('/').pop()}`
    try {
      renameSync(dir, dest)
    } catch {
      // A cross-device rename cannot work; fall back to a copy-free removal only if the
      // rename truly failed, because leaving the bad store in place would loop the retry.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
  console.warn(`[cognee] quarantined a damaged store for org ${orgId} -> ${quarantineDir}`)
  return quarantineDir
}


/**
 * Cognee's own user id for the calling org's client. Every search must pass it —
 * it used to be a module-global `_ownerId` set by whichever org initialised first.
 */
/**
 * There is NO in-process client. Returns null, always.
 *
 * The `@cognee/cognee-ts` SDK was REMOVED from this project on 2026-09-24 when the
 * deployment moved to the cognee v1.6.0 API server. Two cognee lineages writing one
 * store is not a configuration risk, it is a corruption mechanism, and this
 * deployment already paid for it: a LanceDB collection sized 1536 while the
 * configured embedder returned 384, and a graph holding 0 nodes after a write that
 * reported success.
 *
 * Returning null is the correct shape rather than an error, because every caller
 * already reads it that way — `const c = serverOpts ? null : await getCogneeClient();
 * if (!c) return`. null means "no in-process path, take the HTTP one", and with no
 * `COGNEE_SERVER_URL` it means memory is OFF rather than half-wired.
 *
 * KEPT rather than deleted so the call sites keep compiling while the HTTP migration
 * completes, and so this explanation lives where someone would look for the SDK. If
 * you are here to re-add it: read scripts/cognee-upgrade-check.md first, then prove
 * a WRITE-then-RECALL against a fresh store before believing any success return.
 */
export async function getCogneeClient(): Promise<null> {
  return null
}

export function getCogneeOwnerId(): string | undefined {
  const orgId = getOrgContext()
  return (orgId && _clients.get(orgId)?.ownerId) || undefined
}

/** Reset the cognee client cache — forces re-init on next call. */
export function resetClientCache(scope: 'org' | 'all' = 'org'): void {
  const orgId = getOrgContext()
  if (scope === 'all' || !orgId) _clients.clear()
  else _clients.delete(orgId)
}

async function updateDocumentCognifyStatus(
  documentId: string,
  status: string | null,
  error: string | undefined,
): Promise<void> {
  try {
    await db.document.update({
      where: { id: documentId },
      data: {
        cognifyStatus: status,
        cognifyError: error ?? null,
        cognifiedAt: status === 'completed' ? new Date() : null,
      },
    })
  } catch {
    // non-fatal — document may not exist or schema may not have fields
  }
}

export { updateDocumentCognifyStatus }

export function formatSearchResponse(result: any): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (result.result) return formatSearchOutput(result.result)
  if (result.answer) return String(result.answer)
  if (result.content) return String(result.content)
  if (result.items && Array.isArray(result.items)) {
    return result.items.map((item: any) => String(item)).join('\n')
  }
  return ''
}

interface ExtractedItem {
  text: string
  score?: number
}

export function extractSearchItems(result: any): ExtractedItem[] {
  if (result == null) return []
  const items: ExtractedItem[] = []

  // Handle result.result format
  const output = result.result ?? result
  if (output == null) return []

  if (typeof output === 'string') {
    return [{ text: output }]
  }

  // Handle Items kind
  if (output.kind === 'Items' && Array.isArray(output.data)) {
    for (const item of output.data) {
      if (typeof item === 'string') {
        items.push({ text: item })
      } else if (item?.text) {
        items.push({ text: item.text, score: item.score })
      } else if (item?.content) {
        items.push({ text: item.content, score: item.score })
      } else if (item?.payload?.text) {
        items.push({ text: item.payload.text, score: item.score })
      }
    }
    return items
  }

  // Handle Texts kind
  if (output.kind === 'Texts' && Array.isArray(output.data)) {
    for (const text of output.data) {
      if (text) items.push({ text: String(text) })
    }
    return items
  }

  // Handle Text kind
  if (output.kind === 'Text' && typeof output.data === 'string') {
    return [{ text: output.data }]
  }

  // Handle array format
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') {
        items.push({ text: item })
      } else if (item?.text) {
        items.push({ text: item.text, score: item.score })
      } else if (item?.content) {
        items.push({ text: item.content, score: item.score })
      }
    }
    return items
  }

  return items
}

function formatSearchOutput(output: any): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (output.kind === 'Text' && typeof output.data === 'string') return output.data
  if (output.kind === 'Texts' && Array.isArray(output.data)) return output.data.filter(Boolean).join('\n')
  if (output.kind === 'Items' && Array.isArray(output.data)) {
    return output.data
      .map((item: any) => {
        if (typeof item === 'string') return item
        if (item?.text) return item.text
        if (item?.content) return item.content
        if (item?.payload?.text) return item.payload.text
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
