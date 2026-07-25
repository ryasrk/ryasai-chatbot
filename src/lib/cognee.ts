/**
 * Cognee integration — memory + knowledge graph layer.
 * ----------------------------------------------------------------------------
 * Provides:
 *   - rememberChatTurn()  — fire-and-forget chat memory write
 *   - recallContext()     — graph + session recall for router/planner prompts
 *   - cognifyDocument()   — single-doc entity extraction + graph build
 *   - cognifyBatch()      — batch cognify for scalability (millions of docs)
 *   - recallKnowledgeGraph() — graph-grounded retrieval for RAG outer ring
 *   - forgetAll() / forgetKnowledgeGraph() — GDPR reset
 *   - cogneeHealth() / cogneeStats() — monitoring
 *   - resetCognee() — full state reset (admin)
 *
 * Scaling strategy:
 *   - Dev: SQLite + LanceDB + Kuzu (zero services)
 *   - Prod: Postgres + pgvector (single DB, scales to millions)
 *   - Batch cognify: process 50 docs per cognify call (reduces LLM calls)
 *   - Incremental: only cognify new documents (skip already-processed)
 *   - Fire-and-forget: never block user response on memory write
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

async function getCogneeSettings(): Promise<CogneeSettings> {
  if (_cachedSettings && Date.now() - _settingsAt < SETTINGS_TTL) return _cachedSettings

  // Check env var first (backward compat), then DB
  const envEnabled = process.env.COGNEE_ENABLED === 'true'

  let settings: CogneeSettings
  try {
    const config = await db.appConfig.findFirst()
    if (config) {
      settings = {
        enabled: envEnabled || config.cogneeEnabled,
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

async function isCogneeEnabled(): Promise<boolean> {
  return (await getCogneeSettings()).enabled
}

function cogneeBatchSize(settings: CogneeSettings): number {
  return settings.batchSize
}

function cognifyMaxRetries(settings: CogneeSettings): number {
  return settings.maxRetries
}

export function datasetFor(): string {
  return 'default'
}

export function kbDatasetFor(): string {
  return 'default:kb'
}

let _cognee: any | null = null
let _initFailed = false
let _initFailedAt = 0
let _warming = false
let _ownerId: string | null = null

const INIT_RETRY_MS = 30000 // retry init after 30s if it failed

async function getCogneeClient(): Promise<any> {
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
function resetClientCache(): void {
  _cognee = null
  _initFailed = false
  _initFailedAt = 0
  _warming = false
  _ownerId = null
}

// ---------------------------------------------------------------------------
// Chat memory (fire-and-forget)
// ---------------------------------------------------------------------------

export interface ChatTurnMemory {
  sessionId?: string
  userId?: string
  userMessage: string
  aiMessage: string
  toolRuns: Array<{ type: string; status: string; latencyMs: number }>
}

export async function rememberChatTurn(args: ChatTurnMemory): Promise<void> {
  if (!(await isCogneeEnabled())) return
  const c = await getCogneeClient()
  if (!c) return
  try {
    const text = JSON.stringify({
      type: 'chat_turn',
      user: args.userMessage,
      assistant: args.aiMessage,
      tools: args.toolRuns,
      sessionId: args.sessionId,
      ts: Date.now(),
    })

    await c.remember(
      [{ type: 'text', text }],
      datasetFor(),
    )
  } catch (err) {
    console.warn('[cognee] remember failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Recall (graph + session)
// ---------------------------------------------------------------------------

export async function recallContext(args: {
  query: string
  sessionId?: string
}): Promise<string> {
  if (!(await isCogneeEnabled())) return ''
  const c = await getCogneeClient()
  if (!c) return ''

  const graphResult = await recallFromGraph(c, args.query)
  const sessionResult = args.sessionId
    ? await recallFromSession(c, args.query, args.sessionId)
    : ''

  const merged = [sessionResult, graphResult].filter(Boolean).join('\n')
  return merged
}

async function recallFromGraph(c: any, query: string): Promise<string> {
  const strategies = [
    { searchType: 'SUMMARIES', topK: 5 },
    { searchType: 'CHUNKS', topK: 5 },
    { searchType: 'GRAPH_ENTITIES', topK: 10 },
    { searchType: 'GRAPH_RELATIONSHIPS', topK: 10 },
  ]
  for (const strategy of strategies) {
    try {
      const result = await c.search(query, {
        datasets: [datasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: _ownerId ?? undefined,
      })
      const formatted = formatSearchResponse(result)
      if (formatted) return formatted
    } catch {
      // try next strategy
    }
  }
  // Last resort: no dataset filter
  try {
    const result = await c.search(query, { topK: 5, userId: _ownerId ?? undefined })
    return formatSearchResponse(result)
  } catch {
    return ''
  }
}

async function recallFromSession(c: any, query: string, sessionId: string): Promise<string> {
  try {
    const result = await c.search(query, {
      sessionId,
      topK: 3,
      userId: _ownerId ?? undefined,
    })
    return formatSearchResponse(result)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Knowledge graph — cognify documents
// ---------------------------------------------------------------------------

/**
 * Cognify a single document — extracts entities + relationships, builds graph.
 * Uses retry logic for transient FK constraint errors.
 * Tracks cognify status in Document table for incremental processing.
 */
export async function cognifyDocument(args: {
  documentId: string
  documentName: string
  chunks: Array<{ content: string; chunkIndex: number }>
}): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false

  const settings = await getCogneeSettings()
  const dataset = kbDatasetFor()
  const text = args.chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((chunk) => chunk.content)
    .join('\n\n')

  // Add data to dataset first — this creates the dataset record
  try {
    await c.add([{ type: 'text', text }], dataset)
  } catch (err) {
    console.warn('[cognee] add failed for document:', args.documentId, err)
    await updateDocumentCognifyStatus(args.documentId, 'failed', String(err))
    return false
  }

  // Cognify with retry — FK constraint errors are transient in SQLite backend
  const maxRetries = cognifyMaxRetries(settings)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await updateDocumentCognifyStatus(args.documentId, 'processing', undefined)
      await c.cognify(dataset)
      await updateDocumentCognifyStatus(args.documentId, 'completed', undefined)
      return true
    } catch (err) {
      const errStr = String(err)
      const isTransient = errStr.includes('FOREIGN KEY') || errStr.includes('constraint') || errStr.includes('locked')
      if (attempt < maxRetries && isTransient) {
        console.warn(`[cognee] cognify attempt ${attempt}/${maxRetries} failed (transient), retrying...`)
        await sleep(1000 * attempt)
        continue
      }
      console.warn(`[cognee] cognify failed after ${attempt} attempts:`, err)
      await updateDocumentCognifyStatus(args.documentId, 'failed', errStr.slice(0, 500))
      return false
    }
  }
  return false
}

/**
 * Batch cognify — process multiple documents in a single cognify call.
 * This is the scalability path: instead of 1 cognify per document (expensive),
 * we batch up to COGNEE_BATCH_SIZE documents into one cognify pipeline run.
 * Only processes documents with cognifyStatus != 'completed'.
 */
export async function cognifyBatch(args: {
  documents: Array<{
    documentId: string
    documentName: string
    chunks: Array<{ content: string; chunkIndex: number }>
  }>
}): Promise<{ processed: number; failed: number; skipped: number }> {
  if (!(await isCogneeEnabled())) return { processed: 0, failed: 0, skipped: 0 }
  const c = await getCogneeClient()
  if (!c) return { processed: 0, failed: 0, skipped: 0 }

  const settings = await getCogneeSettings()
  const dataset = kbDatasetFor()
  const batchSize = cogneeBatchSize(settings)
  const maxRetries = cognifyMaxRetries(settings)

  // Filter out already-completed documents (incremental processing)
  const docIds = args.documents.map((d) => d.documentId)
  const completed = await db.document.findMany({
    where: { id: { in: docIds }, cognifyStatus: 'completed' },
    select: { id: true },
  }).catch(() => [])
  const completedSet = new Set(completed.map((d) => d.id))

  const pending = args.documents.filter((d) => !completedSet.has(d.documentId))
  if (pending.length === 0) {
    return { processed: 0, failed: 0, skipped: args.documents.length }
  }

  let processed = 0
  let failed = 0

  // Process in batches
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const texts = batch.map((doc) => ({
      type: 'text' as const,
      text: doc.chunks
        .slice()
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((chunk) => chunk.content)
        .join('\n\n'),
    }))

    // Mark all as processing
    await Promise.all(
      batch.map((doc) =>
        updateDocumentCognifyStatus(doc.documentId, 'processing', undefined),
      ),
    )

    // Add batch to dataset
    try {
      await c.add(texts, dataset)
    } catch (err) {
      console.warn('[cognee] batch add failed:', err)
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'failed', String(err).slice(0, 500)),
        ),
      )
      failed += batch.length
      continue
    }

    // Cognify with retry
    let batchSuccess = false
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await c.cognify(dataset)
        batchSuccess = true
        break
      } catch (err) {
        const errStr = String(err)
        const isTransient = errStr.includes('FOREIGN KEY') || errStr.includes('constraint') || errStr.includes('locked')
        if (attempt < maxRetries && isTransient) {
          console.warn(`[cognee] batch cognify attempt ${attempt}/${maxRetries} failed (transient), retrying...`)
          await sleep(1000 * attempt)
          continue
        }
        console.warn(`[cognee] batch cognify failed after ${attempt} attempts:`, err)
        break
      }
    }

    if (batchSuccess) {
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'completed', undefined),
        ),
      )
      processed += batch.length
    } else {
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'failed', 'batch cognify failed'),
        ),
      )
      failed += batch.length
    }
  }

  return { processed, failed, skipped: completedSet.size }
}

/**
 * Recall knowledge graph — graph-grounded retrieval for RAG outer ring.
 * Returns entity summaries + relationship context for multi-hop reasoning.
 */
export async function recallKnowledgeGraph(args: {
  query: string
  topK?: number
}): Promise<string> {
  if (!(await isCogneeEnabled())) return ''
  const c = await getCogneeClient()
  if (!c) return ''

  const topK = args.topK ?? 5
  const strategies = [
    { searchType: 'SUMMARIES', topK },
    { searchType: 'CHUNKS', topK },
    { searchType: 'GRAPH_ENTITIES', topK: topK * 2 },
    { searchType: 'GRAPH_RELATIONSHIPS', topK: topK * 2 },
  ]

  const results: string[] = []
  for (const strategy of strategies) {
    try {
      const result = await c.search(args.query, {
        datasets: [kbDatasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: _ownerId ?? undefined,
      })
      const formatted = formatSearchResponse(result)
      if (formatted) results.push(formatted)
    } catch {
      // try next strategy
    }
  }

  // Deduplicate similar results
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const r of results) {
    const key = r.slice(0, 100)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(r)
    }
  }

  return deduped.join('\n')
}

// ---------------------------------------------------------------------------
// Knowledge graph — recall with structured output for RAG integration
// ---------------------------------------------------------------------------

export interface GraphSearchResult {
  text: string
  source: 'summary' | 'chunk' | 'entity' | 'relationship'
  score?: number
}

export async function recallKnowledgeGraphStructured(args: {
  query: string
  topK?: number
}): Promise<GraphSearchResult[]> {
  if (!(await isCogneeEnabled())) return []
  const c = await getCogneeClient()
  if (!c) return []

  const topK = args.topK ?? 5
  const results: GraphSearchResult[] = []

  const strategies: Array<{ searchType: string; topK: number; source: GraphSearchResult['source'] }> = [
    { searchType: 'SUMMARIES', topK, source: 'summary' },
    { searchType: 'CHUNKS', topK, source: 'chunk' },
    { searchType: 'GRAPH_ENTITIES', topK: topK * 2, source: 'entity' },
    { searchType: 'GRAPH_RELATIONSHIPS', topK: topK * 2, source: 'relationship' },
  ]

  for (const strategy of strategies) {
    try {
      const result = await c.search(args.query, {
        datasets: [kbDatasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: _ownerId ?? undefined,
      })
      const items = extractSearchItems(result)
      for (const item of items) {
        results.push({
          text: item.text,
          source: strategy.source,
          score: item.score,
        })
      }
    } catch {
      // try next strategy
    }
  }

  // Deduplicate by text content
  const seen = new Set<string>()
  return results.filter((r) => {
    const key = r.text.slice(0, 100)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Forget / reset
// ---------------------------------------------------------------------------

export async function forgetAll(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false
  try {
    await c.forget({ kind: 'all' })
    // Reset all document cognify statuses
    await db.document.updateMany({
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] forget failed:', err)
    return false
  }
}

export async function forgetKnowledgeGraph(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false
  try {
    await c.forget({ kind: 'dataset', dataset: { name: kbDatasetFor() } })
    // Reset document cognify statuses for KB dataset
    await db.document.updateMany({
      where: { cognifyStatus: { not: null } },
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] forgetKnowledgeGraph failed:', err)
    return false
  }
}

/** Full reset — deletes .cognee/ state and re-initializes. Admin only. */
export async function resetCognee(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  try {
    // Forget all cognee data
    const c = await getCogneeClient()
    if (c) {
      try { await c.forget({ kind: 'all' }) } catch {}
    }
    // Reset client cache so next call re-initializes
    resetClientCache()
    // Reset all document cognify statuses
    await db.document.updateMany({
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] reset failed:', err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Health + stats
// ---------------------------------------------------------------------------

export async function cogneeHealth(): Promise<{
  enabled: boolean
  connected: boolean
  mode: 'local' | 'postgres' | 'disabled'
}> {
  const settings = await getCogneeSettings()
  if (!settings.enabled) return { enabled: false, connected: false, mode: 'disabled' }
  const client = await getCogneeClient()
  return { enabled: true, connected: !!client, mode: settings.dbProvider }
}

export async function cogneeStats(): Promise<{
  enabled: boolean
  connected: boolean
  mode: 'local' | 'postgres' | 'disabled'
  documents: { total: number; cognified: number; pending: number; failed: number }
  batchSize: number
  maxRetries: number
}> {
  const health = await cogneeHealth()
  const settings = await getCogneeSettings()
  if (!health.enabled) {
    return { ...health, documents: { total: 0, cognified: 0, pending: 0, failed: 0 }, batchSize: 0, maxRetries: 0 }
  }

  const docs = await db.document.groupBy({
    by: ['cognifyStatus'],
    _count: { id: true },
  }).catch(() => [])

  const cognified = docs.find((d) => d.cognifyStatus === 'completed')?._count.id ?? 0
  const failed = docs.find((d) => d.cognifyStatus === 'failed')?._count.id ?? 0
  const processing = docs.find((d) => d.cognifyStatus === 'processing')?._count.id ?? 0
  const total = docs.reduce((sum, d) => sum + d._count.id, 0)
  const pending = total - cognified - failed - processing

  return {
    ...health,
    documents: { total, cognified, pending, failed },
    batchSize: settings.batchSize,
    maxRetries: settings.maxRetries,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatSearchResponse(result: any): string {
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

function extractSearchItems(result: any): ExtractedItem[] {
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
