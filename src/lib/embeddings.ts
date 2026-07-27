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

export async function embedTexts(
  config: EmbeddingRuntimeConfig,
  input: string[],
): Promise<number[][]> {
  const cleanInput = input.map((text) => text.trim()).filter(Boolean)
  if (cleanInput.length === 0) return []

  const endpoint =
    config.provider === 'OLLAMA'
      ? `${config.baseUrl}/api/embed`
      : `${config.baseUrl}/embeddings`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, input: cleanInput }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Embedding API error (HTTP ${res.status}).`)

  return parseEmbeddingResponse(config.provider, await res.json())
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

  let embedded = 0
  const batchSize = Math.max(1, args.batchSize ?? 16)
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize)
    const vectors = await embedTexts(config, batch.map((chunk) => chunk.content))
    const vectorPoints: VectorPoint[] = []
    await Promise.all(
      batch.map((chunk, index) => {
        const vector = vectors[index]
        if (!vector || vector.length === 0) return null
        embedded += 1
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
        return db.$executeRaw`
          UPDATE "DocumentChunk"
          SET "embeddingJson" = ${JSON.stringify(vector)},
              "embedding" = ${`[${vector.join(',')}]`}::vector,
              "embeddingProvider" = ${config.provider},
              "embeddingModel" = ${config.model},
              "embeddedAt" = NOW()
          WHERE id = ${chunk.id}
        `
      }).filter(Boolean),
    )
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
