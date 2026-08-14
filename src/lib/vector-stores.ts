import crypto from 'crypto'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { normalizeBaseUrl } from '@/lib/llm-config'

export type VectorStoreProvider = 'INTERNAL' | 'QDRANT' | 'MILVUS' | 'PINECONE' | 'CHROMA'

export interface VectorStoreRuntimeConfig {
  provider: VectorStoreProvider
  baseUrl: string
  apiKey: string
  collectionName: string
  vectorSize: number
  distance: string
}

export interface VectorPoint {
  id: string
  vector: number[]
  payload: Record<string, string | number | boolean | null>
}

export interface VectorSearchHit {
  chunkId: string
  score: number
}

export function vectorPointId(input: string): string {
  const hex = crypto.createHash('sha1').update(input).digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function buildVectorPoint(args: {
  chunkId: string
  vector: number[]
  payload: Record<string, string | number | boolean | null>
}): VectorPoint {
  return {
    id: vectorPointId(args.chunkId),
    vector: args.vector,
    payload: { ...args.payload, chunkId: args.chunkId },
  }
}

export function buildQdrantSearchBody(
  vector: number[],
  limit: number,
) {
  return {
    vector,
    limit,
    with_payload: true,
  }
}

export function buildMilvusSearchBody(
  collectionName: string,
  vector: number[],
  limit: number,
) {
  return {
    collectionName,
    data: [vector],
    limit,
    outputFields: ['chunkId'],
  }
}

// Pinecone: vector + topK + metadata filtering; `includeMetadata` is what makes
// the chunkId payload come back on query hits.
export function buildPineconeSearchBody(
  vector: number[],
  limit: number,
) {
  return {
    vector,
    topK: limit,
    includeMetadata: true,
  }
}

// Chroma: query_embeddings (plural, batched) + n_results; `include` controls
// which fields return — documents/metadata come back unless excluded.
export function buildChromaSearchBody(
  vector: number[],
  limit: number,
) {
  return {
    query_embeddings: [vector],
    n_results: limit,
    include: ['metadatas', 'documents', 'distances'],
  }
}

export function parseQdrantSearchResponse(payload: unknown): VectorSearchHit[] {
  const result = asRecord(payload).result
  return Array.isArray(result)
    ? result.map((item) => {
        const row = asRecord(item)
        const rowPayload = asRecord(row.payload)
        return { chunkId: String(rowPayload.chunkId ?? ''), score: Number(row.score ?? 0) }
      }).filter((hit) => hit.chunkId)
    : []
}

export function parseMilvusSearchResponse(payload: unknown): VectorSearchHit[] {
  const data = asRecord(payload).data
  return Array.isArray(data)
    ? data.map((item) => {
        const row = asRecord(item)
        const entity = asRecord(row.entity ?? row)
        return { chunkId: String(entity.chunkId ?? ''), score: Number(row.score ?? row.distance ?? 0) }
      }).filter((hit) => hit.chunkId)
    : []
}

export function parsePineconeSearchResponse(payload: unknown): VectorSearchHit[] {
  const matches = asRecord(payload).matches
  return Array.isArray(matches)
    ? matches.map((item) => {
        const row = asRecord(item)
        const metadata = asRecord(row.metadata)
        return { chunkId: String(metadata.chunkId ?? ''), score: Number(row.score ?? 0) }
      }).filter((hit) => hit.chunkId)
    : []
}

export function parseChromaSearchResponse(payload: unknown): VectorSearchHit[] {
  // Chroma returns columnar lists: ids/metadatas/distances are arrays-of-arrays
  // (one inner array per query embedding — we always send exactly one).
  const ids = asRecord(payload).ids
  const metadatas = asRecord(payload).metadatas
  const distances = asRecord(payload).distances
  if (!Array.isArray(ids) || !Array.isArray(ids[0])) return []
  const rowIds = ids[0]
  const rowMeta = Array.isArray(metadatas) && Array.isArray(metadatas[0]) ? metadatas[0] : []
  const rowDist = Array.isArray(distances) && Array.isArray(distances[0]) ? distances[0] : []
  return rowIds
    .map((chunkId, i) => {
      const meta = asRecord(rowMeta[i])
      const distance = Number(rowDist[i] ?? 0)
      // Chroma returns cosine DISTANCE (0 = identical, 2 = opposite); RRF only
      // consumes ordering, but the reported similarity should not be a raw
      // distance — convert to similarity so bigger = better, like every other
      // provider.
      return { chunkId: String(meta.chunkId ?? chunkId), score: Math.max(0, 1 - distance) }
    })
    .filter((hit) => hit.chunkId)
}

export async function getVectorStoreRuntimeConfig(
): Promise<VectorStoreRuntimeConfig | null> {
  const row = await db.vectorStoreConfig.findFirst()
  if (!row || row.provider === 'INTERNAL' || !row.baseUrl || !row.collectionName) {
    return null
  }
  let apiKey = ''
  if (row.encryptedApiKey) {
    try {
      const cfg = decryptConfig(row.encryptedApiKey)
      apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    } catch (e) {
      console.warn('[vector-stores] decryptConfig failed:', e)
      apiKey = ''
    }
  }
  return {
    provider: normalizeVectorStoreProvider(row.provider),
    baseUrl: normalizeBaseUrl(row.baseUrl),
    apiKey,
    collectionName: row.collectionName,
    vectorSize: row.vectorSize,
    distance: row.distance,
  }
}

// ponytail: memoize "collection ensured" per backend+collection so we don't fire an
// HTTP round-trip on every document embed batch after the first one in this process.
const ensuredCollections = new Set<string>()

/** Test seam — forget which collections were ensured this process. */
export function resetEnsuredCollections(): void {
  ensuredCollections.clear()
}

export async function ensureVectorCollection(config: VectorStoreRuntimeConfig) {
  if (config.provider === 'INTERNAL') return
  const key = `${config.provider}:${config.baseUrl}:${config.collectionName}`
  if (ensuredCollections.has(key)) return
  ensuredCollections.add(key)
  if (config.provider === 'QDRANT') {
    await vectorFetch(config, `/collections/${encodeURIComponent(config.collectionName)}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: config.vectorSize, distance: config.distance || 'Cosine' },
      }),
    })
  }
  if (config.provider === 'MILVUS') {
    await vectorFetch(config, '/v2/vectordb/collections/create', {
      method: 'POST',
      body: JSON.stringify({
        collectionName: config.collectionName,
        dimension: config.vectorSize,
        metricType: 'COSINE',
      }),
    }).catch((e) => { console.warn('[vector-stores] milvus collection create failed:', e) })
  }
  if (config.provider === 'PINECONE') {
    // ponytail: index creation is a CONTROL-PLANE op that takes minutes and is
    // usually done in the Pinecone console — never auto-create. Describe instead:
    // a 404 gives the operator an actionable "create it first" error.
    const described = await vectorFetchAllow404(
      config,
      `/describe_index_stats`,
      { method: 'POST', body: '{}' },
    )
    if (described.notFound) {
      throw new Error(
        `Pinecone index not reachable at ${config.baseUrl}. Create the index (dimension ${config.vectorSize}) in the Pinecone console first, then set Base URL to the index host (https://<index-name>-<project>.svc.<region>.pinecone.io).`,
      )
    }
  }
  if (config.provider === 'CHROMA') {
    // Chroma create_collection is idempotent-friendly only via get-or-create.
    await vectorFetch(
      config,
      `/api/v1/collections/${encodeURIComponent(config.collectionName)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          get_or_create: true,
          // cosine is Chroma's default; honor the configured metric
          metadata: { hnsw: { space: chromaSpace(config.distance) } },
        }),
      },
    )
  }
}

/** Chroma's `space` values map 1:1 from our distance metric names. */
function chromaSpace(distance: string): 'cosine' | 'l2' | 'ip' {
  const d = distance.toLowerCase()
  if (d === 'euclidean' || d === 'l2') return 'l2'
  if (d === 'dot' || d === 'inner' || d === 'ip') return 'ip'
  return 'cosine'
}

export async function upsertVectorPoints(
  config: VectorStoreRuntimeConfig,
  points: VectorPoint[],
) {
  if (points.length === 0) return
  if (config.provider === 'QDRANT') {
    await vectorFetch(
      config,
      `/collections/${encodeURIComponent(config.collectionName)}/points?wait=true`,
      {
        method: 'PUT',
        body: JSON.stringify({
          points: points.map((point) => ({
            id: point.id,
            vector: point.vector,
            payload: point.payload,
          })),
        }),
      },
    )
  }
  if (config.provider === 'MILVUS') {
    await vectorFetch(config, '/v2/vectordb/entities/insert', {
      method: 'POST',
      body: JSON.stringify({
        collectionName: config.collectionName,
        data: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          ...point.payload,
        })),
      }),
    })
  }
  if (config.provider === 'PINECONE') {
    await vectorFetch(config, '/vectors/upsert', {
      method: 'POST',
      body: JSON.stringify({
        vectors: points.map((point) => ({
          id: point.id,
          values: point.vector,
          metadata: point.payload,
        })),
      }),
    })
  }
  if (config.provider === 'CHROMA') {
    await vectorFetch(
      config,
      `/api/v1/collections/${encodeURIComponent(config.collectionName)}/upsert`,
      {
        method: 'POST',
        body: JSON.stringify({
          ids: points.map((point) => point.id),
          embeddings: points.map((point) => point.vector),
          // ponytail: Chroma requires non-empty metadata per doc — nulls break
          // the batch, so strip them (Qdrant/Milvus tolerate nulls).
          metadatas: points.map((point) => {
            const meta: Record<string, string | number | boolean> = {}
            for (const [k, v] of Object.entries(point.payload)) {
              if (v !== null && v !== undefined) meta[k] = v
            }
            return meta
          }),
        }),
      },
    )
  }
}

export async function searchVectorStore(args: {
  config: VectorStoreRuntimeConfig
  vector: number[]
  limit: number
}): Promise<VectorSearchHit[]> {
  if (args.config.provider === 'QDRANT') {
    const response = await vectorFetch(
      args.config,
      `/collections/${encodeURIComponent(args.config.collectionName)}/points/search`,
      {
        method: 'POST',
        body: JSON.stringify(buildQdrantSearchBody(args.vector, args.limit)),
      },
    )
    return parseQdrantSearchResponse(response)
  }
  if (args.config.provider === 'MILVUS') {
    const response = await vectorFetch(args.config, '/v2/vectordb/entities/search', {
      method: 'POST',
      body: JSON.stringify(
        buildMilvusSearchBody(
          args.config.collectionName,
          args.vector,
          args.limit,
        ),
      ),
    })
    return parseMilvusSearchResponse(response)
  }
  if (args.config.provider === 'PINECONE') {
    const response = await vectorFetch(args.config, '/query', {
      method: 'POST',
      body: JSON.stringify(buildPineconeSearchBody(args.vector, args.limit)),
    })
    return parsePineconeSearchResponse(response)
  }
  if (args.config.provider === 'CHROMA') {
    const response = await vectorFetch(
      args.config,
      `/api/v1/collections/${encodeURIComponent(args.config.collectionName)}/query`,
      {
        method: 'POST',
        body: JSON.stringify(buildChromaSearchBody(args.vector, args.limit)),
      },
    )
    return parseChromaSearchResponse(response)
  }
  return []
}

function normalizeVectorStoreProvider(provider: string): VectorStoreProvider {
  const upper = provider.trim().toUpperCase()
  if (upper === 'QDRANT' || upper === 'QDRANT_CLOUD') return 'QDRANT'
  if (upper === 'MILVUS') return 'MILVUS'
  if (upper === 'PINECONE') return 'PINECONE'
  if (upper === 'CHROMA' || upper === 'CHROMADB') return 'CHROMA'
  return 'INTERNAL'
}

async function vectorFetch(
  config: VectorStoreRuntimeConfig,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const headers = await vectorHeaders(config, init)
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Vector DB error (HTTP ${res.status}).`)
  return res.json().catch(() => ({}))
}

/** Like vectorFetch but reports 404 instead of throwing — for existence probes. */
async function vectorFetchAllow404(
  config: VectorStoreRuntimeConfig,
  path: string,
  init: RequestInit,
): Promise<{ notFound: boolean; payload: unknown }> {
  const headers = await vectorHeaders(config, init)
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60000),
  })
  if (res.status === 404) return { notFound: true, payload: null }
  if (!res.ok) throw new Error(`Vector DB error (HTTP ${res.status}).`)
  return { notFound: false, payload: await res.json().catch(() => ({})) }
}

/**
 * Per-provider auth headers. Every provider until now used Bearer, but:
 *   - Pinecone requires `Api-Key` and ignores Authorization.
 *   - Chroma (token auth) uses `X-Chroma-Token`; no-auth local Chroma works too.
 */
async function vectorHeaders(
  config: VectorStoreRuntimeConfig,
  init: RequestInit,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (config.apiKey) {
    if (config.provider === 'PINECONE') {
      headers['Api-Key'] = config.apiKey
    } else if (config.provider === 'CHROMA') {
      headers['X-Chroma-Token'] = config.apiKey
    } else {
      headers.Authorization = `Bearer ${config.apiKey}`
      headers['api-key'] = config.apiKey
    }
  }
  return headers
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
