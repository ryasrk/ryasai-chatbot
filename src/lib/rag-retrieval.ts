import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('rag')
import {
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
} from '@/lib/embeddings'
import { getVectorStoreRuntimeConfig, searchVectorStore } from '@/lib/vector-stores'
import { searchFtsChunkIds } from '@/lib/rag-fts'
import { dualLevelRetrieval } from '@/lib/knowledge-graph'
import { cacheGet, cacheSet, cacheDel } from '@/lib/redis'
import {
  RAG_CACHE_TTL_MS,
  RAG_MAX_CHUNKS_PER_UPLOAD,
} from '@/lib/constants'
import {
  tokenize, scoreChunk, applySemanticScore, applyVectorStoreScore,
  selectTopRetrievedChunks,
  type RetrievedChunk,
} from './rag'

let _cacheHits = 0
let _cacheMisses = 0

export function getRagCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = _cacheHits + _cacheMisses
  return { hits: _cacheHits, misses: _cacheMisses, hitRate: total === 0 ? 0 : _cacheHits / total }
}

function ragCacheKey(query: string, topK: number): string {
  return `rag:${topK}:${query.slice(0, 500).toLowerCase().trim()}`
}

export async function invalidateRagCache(): Promise<void> {
  await cacheDel('rag:')
}

export async function retrieveRelevantChunks(args: {
  query: string
  topK: number
}): Promise<{ chunks: RetrievedChunk[]; queryTokens: string[]; candidatesScanned: number; graphContext: string }> {
  const queryTokens = tokenize(args.query)
  if (queryTokens.length === 0) {
    return { chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }
  }

  const cacheKey = ragCacheKey(args.query, args.topK)
  const cached = await cacheGet<Awaited<ReturnType<typeof retrieveRelevantChunks>>>(cacheKey)
  if (cached) {
    _cacheHits += 1
    log.debug('RAG cache hit', { query: args.query.slice(0, 50), topK: args.topK })
    return cached
  }

  const rerankEnabled = process.env.RAG_LLM_RERANK !== 'false'
  const retrievalTopK = rerankEnabled ? args.topK * 3 : args.topK

  const [retrievalResult, kgResult, cogneeGraphContext] = await Promise.all([
    retrieveFromVectorAndLexical(args.query, retrievalTopK, queryTokens),
    dualLevelRetrieval({ query: args.query, topK: args.topK }),
    recallGraphContext(args.query),
  ])

  const kgChunkIds = new Set(kgResult.allChunkIds)
  let mergedChunks = retrievalResult.chunks
  if (kgChunkIds.size > 0) {
    const boosted = retrievalResult.chunks.map((chunk) =>
      kgResult.localChunks.includes(chunk.chunkId)
        ? { ...chunk, score: chunk.score * 1.3 }
        : chunk,
    )
    const existingIds = new Set(retrievalResult.chunks.map((c) => c.chunkId))
    const kgOnlyChunks = await loadVectorCandidateChunks(
      kgResult.allChunkIds.filter((id) => !existingIds.has(id)),
    )
    const kgScored = kgOnlyChunks.map((chunk) => {
      const lexicalScore = scoreChunk(queryTokens, chunk)
      return {
        chunkId: chunk.chunkId, documentId: chunk.documentId, documentName: chunk.documentName,
        chunkIndex: chunk.chunkIndex, content: chunk.content,
        score: lexicalScore.total * 0.8, scoreBreakdown: lexicalScore,
      }
    })
    mergedChunks = [...boosted, ...kgScored]
  }

  const graphContext = kgResult.graphContext || cogneeGraphContext

  const finalChunks = rerankEnabled
    ? await rerankWithLlm(args.query, mergedChunks, args.topK)
    : selectTopRetrievedChunks(mergedChunks, args.topK)

  const result = {
    chunks: finalChunks, queryTokens,
    candidatesScanned: retrievalResult.candidatesScanned, graphContext,
  }

  _cacheMisses += 1
  log.debug('RAG cache miss', { query: args.query.slice(0, 50), topK: args.topK, candidatesScanned: retrievalResult.candidatesScanned })
  await cacheSet(cacheKey, result, Math.floor(RAG_CACHE_TTL_MS / 1000))

  return result
}

async function rerankWithLlm(
  query: string,
  chunks: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= topK) return chunks
  if (chunks.length === 0) return chunks

  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('query')
    if (!cfg) return chunks.slice(0, topK)

    const chunkList = chunks.map((c, i) => `[${i}] ${c.content.slice(0, 300)}`).join('\n\n')
    const systemPrompt =
      'You are a retrieval reranker. Given a query and text chunks, rank them by relevance. ' +
      'Answer ONLY with a JSON array of chunk indices, most relevant first. Example: [2, 0, 4, 1, 3]'
    const userMessage = `Query: ${query}\n\nChunks:\n${chunkList}\n\nRank these chunks by relevance to the query. Output JSON array of indices only.`

    const raw = await chatOnce(cfg, [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], 0, 'rag-rerank')

    const match = raw.match(/\[[\d\s,]+\]/)
    if (!match) return chunks.slice(0, topK)
    const indices = JSON.parse(match[0]) as number[]
    if (!Array.isArray(indices) || indices.length === 0) return chunks.slice(0, topK)

    const reranked: RetrievedChunk[] = []
    for (const idx of indices) {
      if (typeof idx === 'number' && idx >= 0 && idx < chunks.length) {
        reranked.push(chunks[idx])
        if (reranked.length >= topK) break
      }
    }
    if (reranked.length < topK) {
      const used = new Set(indices.filter((i) => i >= 0 && i < chunks.length))
      for (let i = 0; i < chunks.length && reranked.length < topK; i++) {
        if (!used.has(i)) reranked.push(chunks[i])
      }
    }
    return reranked
  } catch (e) {
    log.warn('LLM rerank failed, using original order', { error: e instanceof Error ? e.message : String(e) })
    return chunks.slice(0, topK)
  }
}

async function retrieveFromVectorAndLexical(
  query: string,
  topK: number,
  queryTokens: string[],
): Promise<{ chunks: RetrievedChunk[]; candidatesScanned: number }> {
  const queryEmbedding = await resolveQueryEmbedding(query)
  const vectorScores = await resolveVectorScores({ vector: queryEmbedding?.vector ?? null, topK })
  const candidates = vectorScores.size > 0
    ? await loadVectorCandidateChunks([...vectorScores.keys()])
    : await loadLexicalCandidateChunks(queryTokens, topK)

  const scored: RetrievedChunk[] = []
  let candidatesScanned = 0
  for (const chunk of candidates) {
    candidatesScanned += 1
    const lexicalScore = scoreChunk(queryTokens, chunk)
    const vectorScore = vectorScores.get(chunk.chunkId)
    const chunkEmbedding =
      queryEmbedding && chunk.embeddingModel === queryEmbedding.model
        ? parseEmbeddingJson(chunk.embeddingJson)
        : null
    const scoreBreakdown =
      typeof vectorScore === 'number'
        ? applyVectorStoreScore(lexicalScore, vectorScore)
        : queryEmbedding && chunkEmbedding
          ? applySemanticScore(lexicalScore, queryEmbedding.vector, chunkEmbedding)
          : lexicalScore
    if (scoreBreakdown.total <= 0) continue
    scored.push({
      chunkId: chunk.chunkId, documentId: chunk.documentId, documentName: chunk.documentName,
      chunkIndex: chunk.chunkIndex, content: chunk.content,
      score: scoreBreakdown.total, scoreBreakdown,
    })
  }

  return { chunks: selectTopRetrievedChunks(scored, topK), candidatesScanned }
}

async function recallGraphContext(query: string): Promise<string> {
  try {
    const { recallKnowledgeGraph } = await import('@/lib/cognee')
    return await recallKnowledgeGraph({ query, topK: 5 })
  } catch {
    return ''
  }
}

async function resolveQueryEmbedding(query: string): Promise<{ vector: number[]; model: string } | null> {
  try {
    const config = await getEmbeddingRuntimeConfig()
    if (!config) return null
    const [embedding] = await embedTexts(config, [query])
    return embedding ? { vector: embedding, model: config.model } : null
  } catch (e) {
    log.warn('resolveQueryEmbedding failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

async function resolveVectorScores(args: { vector: number[] | null; topK: number }): Promise<Map<string, number>> {
  if (!args.vector) return new Map()

  try {
    const pgScores = await pgvectorSimilaritySearch(args.vector, Math.max(args.topK * 8, 16))
    if (pgScores.size > 0) return pgScores
  } catch (e) {
    log.debug('pgvector search unavailable, trying external vector store', { error: e instanceof Error ? e.message : String(e) })
  }

  try {
    const config = await getVectorStoreRuntimeConfig()
    if (!config) return new Map()
    const hits = await searchVectorStore({ config, vector: args.vector, limit: Math.max(args.topK * 8, 16) })
    return new Map(hits.map((hit) => [hit.chunkId, hit.score]))
  } catch (e) {
    log.warn('resolveVectorScores failed', { error: e instanceof Error ? e.message : String(e) })
    return new Map()
  }
}

async function pgvectorSimilaritySearch(queryVector: number[], limit: number): Promise<Map<string, number>> {
  const vectorStr = `[${queryVector.join(',')}]`
  const rows = await db.$queryRaw<Array<{ id: string; similarity: number }>>`
    SELECT id, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
    FROM "DocumentChunk"
    WHERE embedding IS NOT NULL
      AND "documentId" IN (
        SELECT id FROM "Document" WHERE status = 'ready' AND "isEnabled" = true
      )
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `
  return new Map(rows.map((row) => [row.id, row.similarity]))
}

interface CandidateChunk {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  keywords: string | null
  embeddingJson: string | null
  embeddingModel: string | null
}

async function loadVectorCandidateChunks(chunkIds: string[]): Promise<CandidateChunk[]> {
  const rows = await db.documentChunk.findMany({
    where: { id: { in: chunkIds }, document: { status: 'ready', isEnabled: true } },
    select: { id: true, chunkIndex: true, content: true, keywords: true, embeddingJson: true, embeddingModel: true, document: { select: { id: true, name: true } } },
  })
  const order = new Map(chunkIds.map((id, index) => [id, index]))
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => ({
      chunkId: row.id, documentId: row.document.id, documentName: row.document.name,
      chunkIndex: row.chunkIndex, content: row.content, keywords: row.keywords,
      embeddingJson: row.embeddingJson, embeddingModel: row.embeddingModel,
    }))
}

async function loadAllCandidateChunks(): Promise<CandidateChunk[]> {
  const docs = await db.document.findMany({
    where: { status: 'ready', isEnabled: true },
    select: { id: true, name: true, chunks: { take: RAG_MAX_CHUNKS_PER_UPLOAD, select: { id: true, chunkIndex: true, content: true, keywords: true, embeddingJson: true, embeddingModel: true } } },
  })
  return docs.flatMap((doc) =>
    doc.chunks.map((chunk) => ({
      chunkId: chunk.id, documentId: doc.id, documentName: doc.name,
      chunkIndex: chunk.chunkIndex, content: chunk.content, keywords: chunk.keywords,
      embeddingJson: chunk.embeddingJson, embeddingModel: chunk.embeddingModel,
    })),
  )
}

async function loadLexicalCandidateChunks(queryTokens: string[], topK: number): Promise<CandidateChunk[]> {
  const ftsIds = await searchFtsChunkIds({ queryTokens, limit: Math.max(topK * 12, 32) })
  let candidates = ftsIds.length > 0 ? await loadVectorCandidateChunks(ftsIds) : []
  if (candidates.length === 0) {
    candidates = await loadAllCandidateChunks()
  }
  return candidates
}
