/**
 * Cognee — core engine: settings cache, client init, shared helpers.
 * Depends on: external (llm-config, embeddings, db). No deps on other cognee split files.
 */
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { getEmbeddingRuntimeConfig } from '@/lib/embeddings'
import { db } from '@/lib/db'

interface CogneeSettings {
  enabled: boolean
  dbProvider: 'local' | 'postgres'
  dbUrl: string | null
  batchSize: number
  maxRetries: number
}

let _cachedSettings: CogneeSettings | null = null
let _settingsAt = 0
const SETTINGS_TTL = 10000 // 10s cache

export async function getCogneeSettings(): Promise<CogneeSettings> {
  if (_cachedSettings && Date.now() - _settingsAt < SETTINGS_TTL) return _cachedSettings

  // Check env var first (backward compat), then DB.
  // ponytail: default to true when neither env nor DB explicitly disables —
  // cognee.init fails gracefully if @cognee/cognee-ts can't start, so enabling
  // by default is safe (falls back to no-op).
  const envEnabled = process.env.COGNEE_ENABLED !== 'false'

  let settings: CogneeSettings
  try {
    const config = await db.appConfig.findFirst()
    if (config) {
      settings = {
        enabled: envEnabled && config.cogneeEnabled,
        dbProvider: (config.cogneeDbProvider === 'postgres' ? 'postgres' : 'local'),
        dbUrl: config.cogneeDbUrl ?? process.env.COGNEE_DB_URL ?? null,
        batchSize: config.cogneeBatchSize || parseInt(process.env.COGNEE_BATCH_SIZE ?? '50', 10),
        maxRetries: config.cogneeMaxRetries || parseInt(process.env.COGNEE_MAX_RETRIES ?? '3', 10),
      }
    } else {
      settings = {
        enabled: envEnabled,
        dbProvider: process.env.COGNEE_DB_PROVIDER?.toLowerCase() === 'postgres' ? 'postgres' : 'local',
        dbUrl: process.env.COGNEE_DB_URL ?? null,
        batchSize: parseInt(process.env.COGNEE_BATCH_SIZE ?? '50', 10),
        maxRetries: parseInt(process.env.COGNEE_MAX_RETRIES ?? '3', 10),
      }
    }
  } catch {
    settings = {
      enabled: envEnabled,
      dbProvider: process.env.COGNEE_DB_PROVIDER?.toLowerCase() === 'postgres' ? 'postgres' : 'local',
      dbUrl: process.env.COGNEE_DB_URL ?? null,
      batchSize: parseInt(process.env.COGNEE_BATCH_SIZE ?? '50', 10),
      maxRetries: parseInt(process.env.COGNEE_MAX_RETRIES ?? '3', 10),
    }
  }

  _cachedSettings = settings
  _settingsAt = Date.now()
  return settings
}

/** Invalidate cached settings — call after UI updates cognee config. */
export function invalidateCogneeSettings(): void {
  _cachedSettings = null
  _settingsAt = 0
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

let _cognee: any | null = null
let _initFailed = false
let _initFailedAt = 0
let _warming = false
export let _ownerId: string | null = null

const INIT_RETRY_MS = 30000 // retry init after 30s if it failed

export async function getCogneeClient(): Promise<any> {
  // ponytail: graceful degradation — returns null when cognee SDK init fails, callers fall back to no-op
  if (_cognee) return _cognee
  if (_initFailed && Date.now() - _initFailedAt < INIT_RETRY_MS) return null
  if (_warming) return null

  _initFailed = false // clear stale failure flag

  try {
    _warming = true
    const settings = await getCogneeSettings()
    const { Cognee } = await import('@cognee/cognee-ts')

    const llm = await getLlmRuntimeConfig()

    const usePostgres = settings.dbProvider === 'postgres'

    const dataDir = process.env.COGNEE_DATA_DIR ?? '.cognee/data'
    const systemDir = process.env.COGNEE_SYSTEM_DIR ?? '.cognee/system'

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
    _ownerId = await c.ownerId()
    _cognee = c
    return c
  } catch (err) {
    console.warn('[cognee] init failed:', err)
    _initFailed = true
    _initFailedAt = Date.now()
    return null
  } finally {
    _warming = false
  }
}

/** Reset the cognee client cache — forces re-init on next call. */
export function resetClientCache(): void {
  _cognee = null
  _initFailed = false
  _initFailedAt = 0
  _warming = false
  _ownerId = null
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
