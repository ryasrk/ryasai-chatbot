import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { normalizeBaseUrl } from '@/lib/llm-config'
import {
  buildVectorPoint,
  ensureVectorCollection,
  getVectorStoreRuntimeConfig,
  upsertVectorPoints,
  type VectorPoint,
} from '@/lib/vector-stores'

// ponytail: embeddings stored as JSON string in DocumentChunk.embeddingJson — works on both
// SQLite and Postgres (O(n) scan). pgvector migration documented in docs/postgres-migration.md
// but not implemented; add when chunk count > 10K and scan latency matters.

export type EmbeddingProvider = 'OPENAI_COMPATIBLE' | 'OPENAI' | 'OLLAMA'

// ponytail: transient retry — 429/5xx and network failures get 2 retries with
// exponential backoff; 4xx validation errors are permanent (resending garbage
// won't help) so they surface immediately.
const EMBED_RETRIES = 2
const EMBED_RETRY_BACKOFF_MS = 500
// ponytail: hard cap each embedding input (~30K chars) so oversized chunks can't
// blow the model context window (e.g. text-embedding-3-small is 8K tokens).
const MAX_EMBED_INPUT_CHARS = 30_000

export interface EmbeddingRuntimeConfig {
  provider: EmbeddingProvider
  baseUrl: string
  apiKey: string
  model: string
}

export interface HybridScore {
  total: number
  lexicalTotal: number
  semanticSimilarity: number
  semanticScore: number
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    aNorm += a[index] * a[index]
    bNorm += b[index] * b[index]
  }
  if (aNorm === 0 || bNorm === 0) return 0
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm))
}

export function combineHybridScore(args: {
  lexicalTotal: number
  semanticSimilarity?: number
}): HybridScore {
  const semanticSimilarity = Math.max(0, args.semanticSimilarity ?? 0)
  const semanticScore = Math.round(semanticSimilarity * 12 * 100) / 100
  return {
    lexicalTotal: args.lexicalTotal,
    semanticSimilarity,
    semanticScore,
    total: Math.round((args.lexicalTotal + semanticScore) * 100) / 100,
  }
}

export function parseEmbeddingResponse(
  provider: EmbeddingProvider,
  payload: unknown,
): number[][] {
  const data = asRecord(payload)
  if (provider === 'OLLAMA') {
    if (Array.isArray(data.embeddings)) return data.embeddings.map(toNumberArray).filter(hasValues)
    if (Array.isArray(data.embedding)) return [toNumberArray(data.embedding)].filter(hasValues)
    return []
  }

  if (!Array.isArray(data.data)) return []
  return data.data
    .map((item) => toNumberArray(asRecord(item).embedding))
    .filter(hasValues)
}

export async function getEmbeddingRuntimeConfig(
): Promise<EmbeddingRuntimeConfig | null> {
  const row = await db.llmConfig.findFirst({
    where: { purpose: 'chat' },
  }) ?? await db.llmConfig.findFirst()
  if (!row) return null

  const provider = normalizeEmbeddingProvider(row.embeddingProvider ?? row.provider)
  const baseUrl = normalizeBaseUrl(row.embeddingBaseUrl ?? row.baseUrl)
  const model = (row.embeddingModel ?? 'text-embedding-3-small').trim()
  if (!model) return null

  let apiKey = ''
  const encrypted = row.encryptedEmbeddingApiKey ?? row.encryptedApiKey
  if (encrypted) {
    try {
      const cfg = decryptConfig(encrypted)
      apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    } catch (e) {
      console.warn('[embeddings] decryptConfig failed:', e)
      apiKey = ''
    }
  }
  if (provider !== 'OLLAMA' && !apiKey.trim()) return null

  return { provider, baseUrl, apiKey, model }
}

/**
 * Embed `input`, returning one entry per input in the SAME order. Inputs that are
 * empty after trimming get `[]` — they are never sent to the API, and callers
 * already treat an empty vector as "skip this one".
 *
 * The alignment guarantee is the point: embedDocumentChunks pairs vectors[i] with
 * batch[i], and this used to `.filter(Boolean)` the input, so a single blank chunk
 * shifted every later vector by one — silently attaching the wrong embedding to
 * every subsequent chunk, forever. The count check below can't catch that either,
 * because it validated against the already-filtered length.
 */
export async function embedTexts(
  config: EmbeddingRuntimeConfig,
  input: string[],
): Promise<number[][]> {
  const prepared = input.map((text) => text.trim().slice(0, MAX_EMBED_INPUT_CHARS))
  const sendIndexes: number[] = []
  const cleanInput: string[] = []
  prepared.forEach((text, index) => {
    if (text) {
      sendIndexes.push(index)
      cleanInput.push(text)
    }
  })
  if (cleanInput.length === 0) return []

  const endpoint =
    config.provider === 'OLLAMA'
      ? `${config.baseUrl}/api/embed`
      : `${config.baseUrl}/embeddings`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= EMBED_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(EMBED_RETRY_BACKOFF_MS * 2 ** (attempt - 1))

    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, input: cleanInput }),
        signal: AbortSignal.timeout(60000),
      })
    } catch (e) {
      // network-level failure — transient, retry
      lastError = e instanceof Error ? e : new Error(String(e))
      continue
    }

    if (!res.ok) {
      const err = new Error(`Embedding API error (HTTP ${res.status}).`)
      if (!isRetryableStatus(res.status)) throw err
      lastError = err
      continue
    }

    // Parse + validate outside the retry path so alignment errors propagate
    // immediately instead of being masked by retries.
    const payload = await res.json().catch(() => ({}))
    const vectors = validateEmbeddingResponse(config.provider, cleanInput.length, payload)
    // Scatter back onto the original indexes so vectors[i] belongs to input[i].
    const aligned: number[][] = input.map(() => [])
    sendIndexes.forEach((originalIndex, sentIndex) => {
      aligned[originalIndex] = vectors[sentIndex]
    })
    return aligned
  }
  throw lastError ?? new Error('Embedding API request failed.')
}

// ponytail: index alignment between texts and vectors is assumed downstream
// (embedDocumentChunks pairs vectors[index] with chunk[index]), so a count or
// dimension mismatch must fail loudly rather than silently mis-align.
function validateEmbeddingResponse(
  provider: EmbeddingProvider,
  expectedCount: number,
  payload: unknown,
): number[][] {
  const vectors = parseEmbeddingResponse(provider, payload)
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Embedding API returned ${vectors.length} vectors for ${expectedCount} inputs — refusing to misalign chunk→vector pairs.`,
    )
  }
  const dimension = vectors[0]?.length ?? 0
  if (dimension === 0 || vectors.some((vector) => vector.length !== dimension)) {
    throw new Error('Embedding API returned vectors with empty or inconsistent dimensions.')
  }
  return vectors
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Declared width of DocumentChunk.embedding, e.g. 1536. The schema hardcodes
 * vector(1536) while the embedding model is operator-configurable, so anything
 * other than a 1536-dim model (text-embedding-3-large is 3072, most local models
 * are 768) made every `::vector` write throw — inside an unguarded Promise.all,
 * which killed ingestion outright. Read it once and adapt instead.
 *
 * null = unknown (non-Postgres, or the column is missing): skip the vector write.
 */
let _embeddingColumnDim: number | null | undefined
let _dimensionWarned = false

export async function getEmbeddingColumnDimension(): Promise<number | null> {
  if (_embeddingColumnDim !== undefined) return _embeddingColumnDim
  try {
    const rows = await db.$queryRaw<Array<{ coltype: string }>>`
      SELECT format_type(a.atttypid, a.atttypmod) AS coltype
      FROM pg_attribute a
      WHERE a.attrelid = '"DocumentChunk"'::regclass
        AND a.attname = 'embedding'
        AND NOT a.attisdropped
    `
    const match = rows[0]?.coltype?.match(/\((\d+)\)/)
    // Only memoise a definite answer. Caching a transient DB error would disable
    // pgvector writes for the rest of the process with no way back.
    if (match) {
      _embeddingColumnDim = Number(match[1])
      return _embeddingColumnDim
    }
    // Query succeeded but there is no such column (non-Postgres, or dropped).
    _embeddingColumnDim = null
    return null
  } catch {
    return null
  }
}

/** Test seam — forget the cached column width. */
export function resetEmbeddingColumnDimension(): void {
  _embeddingColumnDim = undefined
  _dimensionWarned = false
}

/**
 * Can this vector go into the pgvector column? When it can't we still store
 * embeddingJson, so retrieval keeps working through the cosine fallback in
 * applySemanticScore — slower, but correct, and the operator gets told once how
 * to fix it properly.
 */
async function canWriteVectorColumn(dimension: number): Promise<boolean> {
  const columnDim = await getEmbeddingColumnDimension()
  if (columnDim === null) return false
  if (columnDim === dimension) return true
  if (!_dimensionWarned) {
    _dimensionWarned = true
    console.error(
      `[embeddings] embedding model returns ${dimension} dims but DocumentChunk.embedding is vector(${columnDim}). ` +
        'Storing embeddingJson only — pgvector search is disabled until the column matches. Fix with:\n' +
        `  ALTER TABLE "DocumentChunk" DROP COLUMN embedding;\n` +
        `  ALTER TABLE "DocumentChunk" ADD COLUMN embedding vector(${dimension});\n` +
        '  (then re-run the embedding rebuild; update prisma/schema.prisma to match)',
    )
  }
  return false
}

export function parseEmbeddingJson(raw: string | null | undefined): number[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const vector = toNumberArray(parsed)
    return vector.length > 0 ? vector : null
  } catch {
    return null
  }
}

export async function embedDocumentChunks(args: {
  documentId: string
  batchSize?: number
}): Promise<{ embedded: number; skipped: number; provider: string | null; model: string | null }> {
  const config = await getEmbeddingRuntimeConfig()
  if (!config) return { embedded: 0, skipped: 0, provider: null, model: null }

  const chunks = await db.documentChunk.findMany({
    where: { documentId: args.documentId },
    orderBy: { chunkIndex: 'asc' },
    select: {
      id: true,
      content: true,
      chunkIndex: true,
      document: {
        select: {
          id: true,
          name: true,
          category: true,
        },
      },
    },
  })
  const vectorConfig = await getVectorStoreRuntimeConfig()
  if (vectorConfig) await ensureVectorCollection(vectorConfig)

  // Contextual Retrieval (Anthropic): prepend an LLM-generated document summary
  // to each chunk before embedding. Reduces retrieval failures by ~49%.
  // ponytail: one summary per document, shared across all chunks — cheap and effective.
  let contextPrefix = ''
  if (process.env.CONTEXTUAL_RETRIEVAL === 'true' && chunks.length > 0) {
    const docName = chunks[0].document.name
    const category = chunks[0].document.category
    try {
      const { getRoleLlmConfig } = await import('@/lib/llm-config')
      const { chatOnce } = await import('@/lib/llm-client')
      const cfg = await getRoleLlmConfig('query')
      if (cfg) {
        const fullText = chunks.map((c) => c.content).join('\n\n').slice(0, 8000)
        const summary = await chatOnce(
          cfg,
          [
            { role: 'system', content: 'Summarize the following document in 1-2 sentences for retrieval context.' },
            { role: 'user', content: fullText },
          ],
          0,
          'contextual-retrieval',
        )
        contextPrefix = `From ${docName}${category ? `[${category}]` : ''}: ${summary}\n\n`
      } else {
        contextPrefix = `From ${docName}:\n\n`
      }
    } catch (e) {
      console.warn('[embeddings] contextual retrieval summary failed, using static prefix:', e)
      contextPrefix = `From ${docName}:\n\n`
    }
  }

  let embedded = 0
  const batchSize = Math.max(1, args.batchSize ?? 16)
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize)
    const vectors = await embedTexts(config, batch.map((chunk) =>
      contextPrefix ? contextPrefix + chunk.content : chunk.content,
    ))
    const vectorPoints: VectorPoint[] = []
    const writes: Array<{ chunkId: string; run: Promise<unknown> }> = []
    for (const [index, chunk] of batch.entries()) {
      const vector = vectors[index]
      if (!vector || vector.length === 0) continue
      const withVectorColumn = await canWriteVectorColumn(vector.length)
      vectorPoints.push(
        buildVectorPoint({
          chunkId: chunk.id,
          vector,
          payload: {
            documentId: chunk.document.id,
            documentName: chunk.document.name,
            category: chunk.document.category ?? null,
            chunkIndex: chunk.chunkIndex,
          },
        }),
      )
      const json = JSON.stringify(vector)
      const literal = `[${vector.join(',')}]`
      const run = withVectorColumn
        ? db.$executeRaw`
            UPDATE "DocumentChunk"
            SET "embeddingJson" = ${json},
                "embedding" = ${literal}::vector,
                "embeddingProvider" = ${config.provider},
                "embeddingModel" = ${config.model},
                "embeddedAt" = NOW(),
                "contextPrefix" = COALESCE(${contextPrefix || null}::text, "contextPrefix")
            WHERE id = ${chunk.id}
          `
        : db.$executeRaw`
            UPDATE "DocumentChunk"
            SET "embeddingJson" = ${json},
                "embeddingProvider" = ${config.provider},
                "embeddingModel" = ${config.model},
                "embeddedAt" = NOW(),
                "contextPrefix" = COALESCE(${contextPrefix || null}::text, "contextPrefix")
            WHERE id = ${chunk.id}
          `
      writes.push({ chunkId: chunk.id, run })
    }

    // allSettled, not all: one rejected row used to abort the whole ingestion and
    // leave every later chunk of the document unembedded.
    const settled = await Promise.allSettled(writes.map((w) => w.run))
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') embedded += 1
      else {
        console.warn(
          `[embeddings] failed to store embedding for chunk ${writes[index].chunkId}:`,
          outcome.reason,
        )
      }
    })
    if (vectorConfig) await upsertVectorPoints(vectorConfig, vectorPoints)
  }

  return {
    embedded,
    skipped: Math.max(0, chunks.length - embedded),
    provider: config.provider,
    model: config.model,
  }
}

export async function embedCompanyDocuments(args: {
  documentId?: string
}): Promise<{
  documents: number
  embedded: number
  skipped: number
  provider: string | null
  model: string | null
}> {
  const docs = await db.document.findMany({
    where: {
      status: 'ready',
      ...(args.documentId ? { id: args.documentId } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })

  let embedded = 0
  let skipped = 0
  let provider: string | null = null
  let model: string | null = null
  for (const doc of docs) {
    const result = await embedDocumentChunks({
      documentId: doc.id,
    })
    embedded += result.embedded
    skipped += result.skipped
    provider = result.provider ?? provider
    model = result.model ?? model
  }

  return { documents: docs.length, embedded, skipped, provider, model }
}

function normalizeEmbeddingProvider(provider: string): EmbeddingProvider {
  const upper = provider.trim().toUpperCase()
  if (upper === 'OLLAMA') return 'OLLAMA'
  if (upper === 'OPENAI') return 'OPENAI'
  return 'OPENAI_COMPATIBLE'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []
}

function hasValues(values: number[]): boolean {
  return values.length > 0
}
