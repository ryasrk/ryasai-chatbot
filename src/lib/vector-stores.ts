import crypto from 'crypto'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { normalizeBaseUrl } from '@/lib/llm-config'

export type VectorStoreProvider = 'INTERNAL' | 'QDRANT' | 'MILVUS'

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
  companyId: string,
) {
  return {
    vector,
    limit,
    with_payload: true,
    filter: { must: [{ key: 'companyId', match: { value: companyId } }] },
  }
}

export function buildMilvusSearchBody(
  collectionName: string,
  vector: number[],
  limit: number,
  companyId: string,
) {
  return {
    collectionName,
    data: [vector],
    limit,
    outputFields: ['chunkId'],
    filter: `companyId == "${companyId.replace(/"/g, '')}"`,
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

export async function getVectorStoreRuntimeConfig(
  companyId: string,
): Promise<VectorStoreRuntimeConfig | null> {
  const row = await db.vectorStoreConfig.findUnique({ where: { companyId } })
  if (!row || row.provider === 'INTERNAL' || !row.baseUrl || !row.collectionName) {
    return null
  }
  let apiKey = ''
  if (row.encryptedApiKey) {
    try {
      const cfg = decryptConfig(row.encryptedApiKey)
      apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    } catch {
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

export async function ensureVectorCollection(config: VectorStoreRuntimeConfig) {
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
    }).catch(() => null)
  }
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
}

export async function searchVectorStore(args: {
  config: VectorStoreRuntimeConfig
  companyId: string
  vector: number[]
  limit: number
}): Promise<VectorSearchHit[]> {
  if (args.config.provider === 'QDRANT') {
    const response = await vectorFetch(
      args.config,
      `/collections/${encodeURIComponent(args.config.collectionName)}/points/search`,
      {
        method: 'POST',
        body: JSON.stringify(buildQdrantSearchBody(args.vector, args.limit, args.companyId)),
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
          args.companyId,
        ),
      ),
    })
    return parseMilvusSearchResponse(response)
  }
  return []
}

function normalizeVectorStoreProvider(provider: string): VectorStoreProvider {
  const upper = provider.trim().toUpperCase()
  if (upper === 'QDRANT') return 'QDRANT'
  if (upper === 'MILVUS') return 'MILVUS'
  return 'INTERNAL'
}

async function vectorFetch(
  config: VectorStoreRuntimeConfig,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
    headers['api-key'] = config.apiKey
  }
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Vector DB error (HTTP ${res.status}).`)
  return res.json().catch(() => ({}))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
