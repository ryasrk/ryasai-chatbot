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

interface CogneeSettings {
  enabled: boolean
  dbProvider: 'local' | 'postgres'
  dbUrl: string | null
  batchSize: number
  maxRetries: number
}

const DISABLED_SETTINGS: CogneeSettings = {
  enabled: false,
  dbProvider: 'local',
  dbUrl: null,
  batchSize: 50,
  maxRetries: 3,
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

// VERSION FENCE for @cognee/cognee-ts. Do NOT bump this dependency without reading
// scripts/cognee-upgrade-check.md — MEASURED on 0.2.0 (2026-09-15):
//
//   - `remember()` returns {"status":"PipelineRunCompleted"} in ~25ms and writes NOTHING to
//     the graph. Only add_pipeline runs (confirmed in pipeline_runs); no cognify. Memory is
//     silently lost while the API reports success — worse than the `has()` bug, which at
//     least returned a wrong boolean instead of a false success.
//   - It ALSO marks the dataset completed, and that mark PERSISTS in cognee.db. So downgrading
//     back to 0.1.3 does not recover: cognify then logs "dataset already completed;
//     short-circuiting" and refuses to process new data. The only recovery is deleting the
//     store. Measured: same store after revert gave write_ms=416 / no recall;
//     a clean store gave write_ms=15142 / recall OK.
//   - It fixes NEITHER problem that motivated the look: `datasets.has()` still reports a
//     present dataset as missing, and NATURAL_LANGUAGE still fails on kuzu (~7s).
//
// The one real gain was HYBRID_COMPLETION (measured OK, 1303ms, 4542 chars — ~2.6x richer
// than CHUNKS), which is worthless while writes do not land. Revisit when upstream's remember
// path demonstrably populates the graph; verify with a WRITE-then-RECALL probe, never by
// checking that `remember()` returned status-completed.
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
  })

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

export async function getCogneeClient(): Promise<any> {
  return getCogneeClientWithRetry(false)
}

/**
 * @param retriedAfterQuarantine internal — set only by the self-heal path so the rebuild
 *   gets exactly one attempt. Callers use `getCogneeClient()`.
 */
async function getCogneeClientWithRetry(retriedAfterQuarantine: boolean): Promise<any> {
  // ponytail: graceful degradation — returns null when cognee SDK init fails, callers fall back to no-op
  const orgId = getOrgContext()
  if (!orgId) return null

  const entry = entryFor(orgId)
  if (entry.client) return entry.client
  if (entry.initFailedAt && Date.now() - entry.initFailedAt < INIT_RETRY_MS) return null
  // A rebuild is a fresh attempt that deliberately runs while `warming` is already true
  // (the first attempt set it). Without this exemption the self-heal recursed straight
  // into this guard and returned null -- the retry looked present in code but never ran,
  // which is how the recovery tests caught a real defect in the recovery itself.
  if (entry.warming && !retriedAfterQuarantine) return null

  try {
    entry.warming = true
    const settings = await getCogneeSettings()
    const { Cognee } = await import('@cognee/cognee-ts')

    // This org's LLM config — not whichever org happened to boot first.
    const llm = await getLlmRuntimeConfig()

    const usePostgres = settings.dbProvider === 'postgres'
    const { dataDir, systemDir } = storeDirsFor(orgId)

    const settingsObj: Record<string, unknown> = {
      dataRootDirectory: dataDir,
      systemRootDirectory: systemDir,
    }

    if (usePostgres) {
      if (!settings.dbUrl) {
        throw new Error('Cognee DB provider is postgres but no DB URL configured. Set it in Settings.')
      }
      settingsObj.relationalDbUrl = settings.dbUrl
      settingsObj.graphDatabaseProvider = 'postgres'
      settingsObj.vectorDbProvider = 'pgvector'
      settingsObj.vectorDbUrl = settings.dbUrl
    } else {
      settingsObj.relationalDbUrl = `sqlite:${systemDir}/cognee.db?mode=rwc`
      settingsObj.graphDatabaseProvider = 'kuzu'
      settingsObj.vectorDbProvider = 'lancedb'
    }

    if (llm) {
      settingsObj.llmApiKey = llm.apiKey
      settingsObj.llmEndpoint = llm.baseUrl
      settingsObj.llmModel = llm.model
      settingsObj.llmProvider = llm.provider === 'ANTHROPIC_COMPATIBLE' ? 'anthropic' : 'openai'
      const emb = await getEmbeddingRuntimeConfig()
      settingsObj.embeddingProvider = 'openai'
      settingsObj.embeddingApiKey = emb?.apiKey ?? llm.apiKey
      settingsObj.embeddingEndpoint = emb?.baseUrl ?? llm.baseUrl
      settingsObj.embeddingModel = emb?.model ?? 'text-embedding-3-small'
    }

    const c = new Cognee(settingsObj)
    // Bounded: a native warm() that never returns must not hang the caller forever.
    await withDeadline(c.warm(), 'warm')
    entry.ownerId = await withDeadline(c.ownerId(), 'ownerId')
    entry.client = c
    entry.initFailedAt = 0
    return c
  } catch (err) {
    // SELF-HEAL, local mode only. A torn store (see isStoreCorruption) fails every init
    // forever, so retrying alone never recovers; quarantining the store and rebuilding
    // does. Deliberately ONE retry: if the fresh store fails too, the problem is not the
    // store and looping would destroy data on each attempt.
    // `usePostgres` lives inside the try block and is not visible here. Recomputing the
    // provider from settings is the honest equivalent: store quarantine only applies to the
    // LOCAL file-backed store, and a postgres deployment has no `.cognee` directory to move.
    const localStore = (await getCogneeSettings().catch(() => null))?.dbProvider !== 'postgres'
    // `!retriedAfterQuarantine` is the ONE-retry guard. It was accidentally dropped during
    // an edit and the recovery test caught it as an infinite quarantine loop: the rebuild's
    // own failure carries the same corruption signature, so without this the retry recurses
    // and quarantines a fresh store on every pass.
    if (localStore && isStoreCorruption(err) && !retriedAfterQuarantine) {
      try {
        quarantineStore(orgId, storeDirsFor(orgId))
        // retriedAfterQuarantine=true bypasses the warming guard; `warming` stays true so a
        // concurrent caller still sees an in-flight init rather than starting a second one.
        return await getCogneeClientWithRetry(true)
      } catch (rebuildErr) {
        console.warn('[cognee] rebuild after quarantine also failed:', rebuildErr)
      }
    }
    console.warn('[cognee] init failed:', err)
    entry.initFailedAt = Date.now()
    return null
  } finally {
    entry.warming = false
  }
}

/**
 * Cognee's own user id for the calling org's client. Every search must pass it —
 * it used to be a module-global `_ownerId` set by whichever org initialised first.
 */
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
