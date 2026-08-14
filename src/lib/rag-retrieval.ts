import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext } from '@/lib/prisma-tenant'
const log = scopedLogger('rag')
import {
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
} from '@/lib/embeddings'
import { getVectorStoreRuntimeConfig, searchVectorStore } from '@/lib/vector-stores'
import { searchFtsChunkIds } from '@/lib/rag-fts'
import { dualLevelRetrieval } from '@/lib/knowledge-graph'
import { buildCitationTrail, type CitationTrail } from '@/lib/citation-trail'
import { cacheGet, cacheSet, cacheDel } from '@/lib/redis'
import {
  RAG_CACHE_TTL_MS,
  RAG_MAX_CHUNKS_PER_UPLOAD,
} from '@/lib/constants'
import {
  tokenize, scoreChunk,
  selectTopRetrievedChunks,
  type RetrievedChunk,
} from './rag'
import { cosineSimilarity } from '@/lib/embeddings'
import { bm25Rank, fuseRankings, toRanking } from '@/lib/rag-ranking'

let _cacheHits = 0
let _cacheMisses = 0

export function getRagCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = _cacheHits + _cacheMisses
  return { hits: _cacheHits, misses: _cacheMisses, hitRate: total === 0 ? 0 : _cacheHits / total }
}

function ragCacheKey(query: string, topK: number): string {
  // ponytail: org-scoped cache key — prevents cross-tenant data disclosure
  // (org A reading org B's cached retrieved chunks for the same query string).
  const orgId = getOrgContext() ?? 'global'
  return `rag:${orgId}:${topK}:${query.slice(0, 500).toLowerCase().trim()}`
}

export async function invalidateRagCache(): Promise<void> {
  await cacheDel('rag:')
}

export async function retrieveRelevantChunks(args: {
  query: string
  topK: number
  _skipDecompose?: boolean
}): Promise<{ chunks: RetrievedChunk[]; queryTokens: string[]; candidatesScanned: number; graphContext: string; citationTrail?: CitationTrail[] }> {
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

  // Sub-query decomposition: complex multi-part questions → parallel retrieval + merge.
  if (!args._skipDecompose) {
    const { decomposeQuery, mergeRetrievedResults } = await import('@/lib/hyde')
    const subQueries = decomposeQuery(args.query)
    if (subQueries.length > 1) {
      const subResults = await Promise.all(
        subQueries.map((q) => retrieveRelevantChunks({ query: q, topK: args.topK, _skipDecompose: true })),
      )
      const merged = mergeRetrievedResults(subResults)
      _cacheMisses += 1
      await cacheSet(cacheKey, merged, Math.floor(RAG_CACHE_TTL_MS / 1000))
      return merged
    }
  }

  // HyDE: embed a hypothetical answer instead of the raw query for vector search.
  let vectorQuery = args.query
  if (process.env.HYDE === 'true') {
    const { generateHypotheticalDocument } = await import('@/lib/hyde')
    vectorQuery = await generateHypotheticalDocument(args.query)
  }

  // ponytail: rerank ON by default — precision is the metric users judge, and a
  // cross-encoder (RERANKER_URL) costs ~100ms while the LLM fallback is skipped
  // entirely when chunks.length <= topK. Opt OUT with RAG_LLM_RERANK=false.
  // (Was opt-in for years while CLAUDE.md claimed the opposite — the drift
  // meant the flagship precision feature never ran anywhere.)
  const rerankEnabled = process.env.RAG_LLM_RERANK !== 'false'
  const retrievalTopK = rerankEnabled ? args.topK * 3 : args.topK

  const [kgResult, cogneeGraphContext] = await Promise.all([
    dualLevelRetrieval({ query: args.query, topK: args.topK }),
    recallGraphContext(args.query),
  ])

  // The knowledge graph is fused in as a third retriever rather than post-hoc
  // boosted. The old code multiplied KG-local hits by 1.3 and scored KG-only
  // chunks at lexical*0.8 — two hand-tuned constants that only made sense while
  // every leg shared one additive scale, and which would be nonsense now that
  // fused scores are RRF (~0.016) and raw lexical scores are counts (~0-30).
  const retrievalResult = await retrieveAndFuse({
    vectorQuery,
    queryTokens,
    topK: retrievalTopK,
    kgRanking: kgResult.allChunkIds,
  })

  const mergedChunks = retrievalResult.chunks
  const graphContext = kgResult.graphContext || cogneeGraphContext

  const finalChunks = rerankEnabled
    ? await dispatchRerank(args.query, mergedChunks, args.topK)
    : selectTopRetrievedChunks(mergedChunks, args.topK)

  const citationTrail = buildCitationTrail(args.query, kgResult, finalChunks)

  const result = {
    chunks: finalChunks, queryTokens,
    candidatesScanned: retrievalResult.candidatesScanned, graphContext,
    citationTrail: citationTrail.length > 0 ? citationTrail : undefined,
  }

  _cacheMisses += 1
  log.debug('RAG cache miss', { query: args.query.slice(0, 50), topK: args.topK, candidatesScanned: retrievalResult.candidatesScanned })
  await cacheSet(cacheKey, result, Math.floor(RAG_CACHE_TTL_MS / 1000))

  return result
}

/** Parse LLM reranker response into sorted {index, score} pairs. Returns null on parse failure. */
export function parseRerankerScores(raw: string, chunkCount: number): { index: number; score: number }[] | null {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return parsed
    .filter((item): item is { index: number; score: number } =>
      typeof item?.index === 'number' && typeof item?.score === 'number'
      && item.index >= 0 && item.index < chunkCount && item.score >= 3,
    )
    .sort((a, b) => b.score - a.score)
}

async function dispatchRerank(
  query: string,
  chunks: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= topK) return chunks
  const { crossEncoderRerank } = await import('@/lib/reranker')
  const cross = await crossEncoderRerank(query, chunks, topK)
  if (cross) return cross
  return rerankWithLlm(query, chunks, topK)
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
      'You are a retrieval reranker. Given a query and text chunks, score each chunk\'s relevance to the query from 0 to 10.\n' +
      '10 = directly answers the query, 7 = contains relevant info, 4 = partially relevant, 1 = not relevant.\n' +
      'Output ONLY a JSON array of {index, score} pairs. Example: [{"index":0,"score":8},{"index":1,"score":3}]'
    const userMessage = `Query: ${query}\n\nChunks:\n${chunkList}\n\nScore each chunk. Output JSON array of {index, score} pairs only.`

    const raw = await chatOnce(cfg, [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], 0, 'rag-rerank')

    const scored = parseRerankerScores(raw, chunks.length)
    if (!scored) return chunks.slice(0, topK)

    const reranked: RetrievedChunk[] = []
    const used = new Set<number>()
    for (const item of scored) {
      if (used.has(item.index)) continue
      used.add(item.index)
      reranked.push(chunks[item.index])
      if (reranked.length >= topK) break
    }
    if (reranked.length < topK) {
      for (let i = 0; i < chunks.length && reranked.length < topK; i++) {
        if (!used.has(i)) {
          used.add(i)
          reranked.push(chunks[i])
        }
      }
    }
    return reranked
  } catch (e) {
    log.warn('LLM rerank failed, using original order', { error: e instanceof Error ? e.message : String(e) })
    return chunks.slice(0, topK)
  }
}

/**
 * True hybrid retrieval: run the vector and lexical retrievers independently,
 * union their candidates, then fuse the two (three, with the KG) rankings.
 *
 * The previous version was NOT hybrid. It picked candidates with
 *   vectorScores.size > 0 ? vectorCandidates : lexicalCandidates
 * so whenever pgvector returned anything the FTS leg never ran at all — lexical
 * scoring only re-ranked the vector's own candidates. A chunk that was an exact
 * keyword match but semantically distant could not be retrieved, no matter how
 * well it matched, because nothing ever put it in the pool.
 */
async function retrieveAndFuse(args: {
  vectorQuery: string
  queryTokens: string[]
  topK: number
  kgRanking?: string[]
}): Promise<{ chunks: RetrievedChunk[]; candidatesScanned: number }> {
  const { queryTokens, topK } = args
  const poolSize = Math.max(topK * 8, 24)

  const queryEmbedding = await resolveQueryEmbedding(args.vectorQuery)

  // Both legs, always, in parallel.
  const [vectorScores, lexicalIds] = await Promise.all([
    resolveVectorScores({ vector: queryEmbedding?.vector ?? null, topK }),
    searchFtsChunkIds({ queryTokens, limit: poolSize }),
  ])

  // Vector hits in similarity order — resolveVectorScores returns them scored,
  // and both pgvector and the external stores already sort by distance.
  const vectorRanking = [...vectorScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId]) => chunkId)

  const candidateIds = [
    ...new Set([...vectorRanking, ...lexicalIds, ...(args.kgRanking ?? [])]),
  ]

  let candidates = await loadVectorCandidateChunks(candidateIds)
  if (candidates.length === 0) {
    // Neither retriever produced anything (no embeddings yet, empty FTS index).
    candidates = await loadAllCandidateChunks()
  }
  if (candidates.length === 0) return { chunks: [], candidatesScanned: 0 }

  const byId = new Map(candidates.map((chunk) => [chunk.chunkId, chunk]))

  // Lexical leg: BM25 over the union, so chunks that only the vector leg found
  // still get a real lexical score instead of being absent from that ranking.
  const bm25 = bm25Rank(
    queryTokens,
    candidates.map((chunk) => ({
      id: chunk.chunkId,
      // Keywords fold in as extra term occurrences — a lightweight BM25F: a term
      // that is both in the body and an extracted keyword legitimately scores
      // higher, without a hand-picked field weight.
      tokens: tokenize(chunk.content).concat(
        (chunk.keywords ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
      ),
    })),
  )
  const bm25Scores = new Map(bm25.map((entry) => [entry.id, entry.score]))

  const rankings = [vectorRanking, toRanking(bm25)]
  if (args.kgRanking?.length) rankings.push(args.kgRanking)
  const fused = fuseRankings(rankings)

  const scored: RetrievedChunk[] = []
  for (const { id, score } of fused) {
    const chunk = byId.get(id)
    if (!chunk) continue
    const lexicalScore = scoreChunk(queryTokens, chunk)
    const vectorScore = vectorScores.get(id)
    const chunkEmbedding =
      queryEmbedding && chunk.embeddingModel === queryEmbedding.model
        ? parseEmbeddingJson(chunk.embeddingJson)
        : null
    // The breakdown stays populated for the UI and the search-tester. It is
    // reporting only — `score` is the fused rank, which is what orders results.
    const similarity =
      typeof vectorScore === 'number'
        ? vectorScore
        : queryEmbedding && chunkEmbedding
          ? cosineSimilarity(queryEmbedding.vector, chunkEmbedding)
          : 0
    scored.push({
      chunkId: chunk.chunkId, documentId: chunk.documentId, documentName: chunk.documentName,
      chunkIndex: chunk.chunkIndex, content: chunk.content,
      score,
      scoreBreakdown: {
        ...lexicalScore,
        bm25: Math.round((bm25Scores.get(id) ?? 0) * 1000) / 1000,
        semanticSimilarity: Math.max(0, similarity),
        semanticScore: Math.round(Math.max(0, similarity) * 12 * 100) / 100,
        total: score,
      },
    })
  }

  return { chunks: selectTopRetrievedChunks(scored, topK), candidatesScanned: candidates.length }
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
    // Fire-and-forget: never make a user query wait on an index build.
    void ensureVectorIndexes()
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
  const orgId = getOrgContext()
  // Org-scoped (prevents cross-tenant ranking interference) + HNSW index makes
  // the ORDER BY embedding <=> a bounded ANNS scan instead of full-corpus O(n).
  const rows = await db.$queryRaw<Array<{ id: string; similarity: number }>>`
    SELECT id, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
    FROM "DocumentChunk"
    WHERE embedding IS NOT NULL
      AND "organizationId" = ${orgId ?? ''}
      AND "documentId" IN (
        SELECT id FROM "Document" WHERE status = 'ready' AND "isEnabled" = true
      )
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `
  return new Map(rows.map((row) => [row.id, row.similarity]))
}

/**
 * Build the HNSW index on DocumentChunk.embedding, once per process.
 *
 * CONCURRENTLY matters: plain CREATE INDEX takes an ACCESS EXCLUSIVE lock on
 * DocumentChunk, so on a populated table the first search after every restart
 * froze all reads AND writes — uploads included — until the build finished.
 *
 * The index is table-wide, not per-org; the old per-org memo just made N orgs
 * each re-issue the same statement.
 *
 * Returns the in-flight build so callers CAN await it (rebuild jobs), but the
 * search path deliberately does not — a missing index means a slower scan, which
 * is a far better failure mode than a blocked query.
 */
let _vectorIndexBuild: Promise<void> | null = null

export function ensureVectorIndexes(): Promise<void> {
  if (_vectorIndexBuild) return _vectorIndexBuild
  _vectorIndexBuild = db
    .$executeRawUnsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "DocumentChunk_embedding_hnsw"
      ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `)
    .then(() => undefined)
    .catch((e: unknown) => {
      // Non-fatal — vector search degrades to a sequential scan. Deliberately NOT
      // retried with a plain (blocking) CREATE INDEX: that is the failure mode
      // this function exists to avoid. Two known causes, both operator-fixable:
      //   - the driver ran it inside a transaction block (CONCURRENTLY forbids it)
      //   - a previous CONCURRENTLY build left an INVALID index needing DROP first
      _vectorIndexBuild = null
      log.warn(
        'ensureVectorIndexes failed — vector search will sequential-scan. ' +
          'Create it once by hand during a maintenance window:\n' +
          '  CREATE INDEX CONCURRENTLY IF NOT EXISTS "DocumentChunk_embedding_hnsw"\n' +
          '  ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops)\n' +
          '  WITH (m = 16, ef_construction = 64);',
        { error: e instanceof Error ? e.message : String(e) },
      )
    })
  return _vectorIndexBuild
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
  contextPrefix: string | null
}

async function loadVectorCandidateChunks(chunkIds: string[]): Promise<CandidateChunk[]> {
  const rows = await db.documentChunk.findMany({
    where: { id: { in: chunkIds }, document: { status: 'ready', isEnabled: true } },
    select: { id: true, chunkIndex: true, content: true, keywords: true, contextPrefix: true, embeddingJson: true, embeddingModel: true, document: { select: { id: true, name: true } } },
  })
  const order = new Map(chunkIds.map((id, index) => [id, index]))
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => ({
      chunkId: row.id, documentId: row.document.id, documentName: row.document.name,
      chunkIndex: row.chunkIndex,
      content: row.contextPrefix ? row.contextPrefix + row.content : row.content,
      keywords: row.keywords,
      embeddingJson: row.embeddingJson, embeddingModel: row.embeddingModel,
      contextPrefix: row.contextPrefix,
    }))
}

// ponytail: FTS-miss fallback is bounded to ~5000 chunks (10 docs × max chunks/doc)
// instead of pulling every enabled chunk of the org into memory.
const ALL_CANDIDATE_DOC_LIMIT = Math.max(1, Math.ceil(5000 / RAG_MAX_CHUNKS_PER_UPLOAD))

async function loadAllCandidateChunks(): Promise<CandidateChunk[]> {
  const docs = await db.document.findMany({
    where: { status: 'ready', isEnabled: true },
    take: ALL_CANDIDATE_DOC_LIMIT,
    select: { id: true, name: true, chunks: { take: RAG_MAX_CHUNKS_PER_UPLOAD, select: { id: true, chunkIndex: true, content: true, keywords: true, contextPrefix: true, embeddingJson: true, embeddingModel: true } } },
  })
  return docs.flatMap((doc) =>
    doc.chunks.map((chunk) => ({
      chunkId: chunk.id, documentId: doc.id, documentName: doc.name,
      chunkIndex: chunk.chunkIndex,
      content: chunk.contextPrefix ? chunk.contextPrefix + chunk.content : chunk.content,
      keywords: chunk.keywords,
      embeddingJson: chunk.embeddingJson, embeddingModel: chunk.embeddingModel,
      contextPrefix: chunk.contextPrefix,
    })),
  )
}

