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

export async function getCogneeSettings(): Promise<CogneeSettings> {
  const orgId = getOrgContext()
  if (!orgId) return DISABLED_SETTINGS

  const cached = _settingsCache.get(orgId)
  if (cached && Date.now() - cached.at < SETTINGS_TTL) return cached.settings

  // ponytail: fail closed — cognee stays off unless COGNEE_ENABLED is explicitly
  // "true". It writes org data into an external graph store and spends LLM budget;
  // neither should switch on because an env var was left unset.
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
          enabled: envEnabled && config.cogneeEnabled,
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

export async function getCogneeClient(): Promise<any> {
  // ponytail: graceful degradation — returns null when cognee SDK init fails, callers fall back to no-op
  const orgId = getOrgContext()
  if (!orgId) return null

  const entry = entryFor(orgId)
  if (entry.client) return entry.client
  if (entry.initFailedAt && Date.now() - entry.initFailedAt < INIT_RETRY_MS) return null
  if (entry.warming) return null

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
    await c.warm()
    entry.ownerId = await c.ownerId()
    entry.client = c
    entry.initFailedAt = 0
    return c
  } catch (err) {
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
