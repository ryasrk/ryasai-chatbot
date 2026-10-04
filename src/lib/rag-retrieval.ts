import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext } from '@/lib/prisma-tenant'
const log = scopedLogger('rag')
import {
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
} from '@/lib/embeddings'
import { getVectorStoreRuntimeConfig, searchVectorStore, UnsupportedVectorProviderError } from '@/lib/vector-stores'
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
import { stampRetrievedRanks } from '@/lib/retrieval-rank'
// Namespace import for the one export added after `./rag` was already mocked with a
// partial surface in several test files: a named import of a name a mock omits throws at
// module-evaluation time ("Export named ... not found"), which surfaces as an unrelated
// file failing. Reading it off the namespace degrades to `tokenize` under such a mock.
import * as ragTokens from './rag'
const scoringTokens = (text: string): string[] =>
  (ragTokens.tokenizeForScoring ?? ragTokens.tokenize)(text)
import { cosineSimilarity } from '@/lib/embeddings'
import { RANKING_VERSION, bm25Rank, lexicalFirst, toRanking } from '@/lib/rag-ranking'

// Re-exported so callers that already depend on this module need no second import.
export { RANKING_VERSION }
import { recordRetrievalCache, recordRetrievalTiming } from '@/lib/rag-metrics'

let _cacheHits = 0
let _cacheMisses = 0

export function getRagCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = _cacheHits + _cacheMisses
  return { hits: _cacheHits, misses: _cacheMisses, hitRate: total === 0 ? 0 : _cacheHits / total }
}

function ragCacheKey(query: string, topK: number, documentIds: string[] | null | undefined, skipRerank = false): string | null {
  // ponytail: org-scoped cache key — prevents cross-tenant data disclosure
  // (org A reading org B's cached retrieved chunks for the same query string).
  //
  // The no-context case gets an UNUSABLE key, never a shared one. This used to fall back to
  // the literal 'global', which is exactly the leak the org segment exists to prevent: every
  // context-less caller shared one cache entry. That is reachable — MEASURED, `getOrgContext()`
  // returns `undefined` (not an org) on the far side of `bypassOrg()`, so a bypassed path would
  // have read and WRITTEN the shared 'global' entry. Returning null makes the caller skip the
  // cache entirely, so a missing context costs a retrieval, not a cross-tenant disclosure.
  const orgId = getOrgContext()
  if (!orgId) return null
  // THE SCOPE MUST BE PART OF THE KEY. Without it, a retrieval restricted to document A would be
  // stored under the plain query and then served to a request scoped to document B — the same class
  // of cross-context leak the org segment was added to prevent, one level down. Sorted and joined
  // so two requests naming the same documents in a different order share a cache entry instead of
  // missing it. `null` (unrestricted) is a distinct segment, not an empty one.
  const scopeSegment = documentIds && documentIds.length > 0 ? [...documentIds].sort().join(',') : '*'
  const key = `rag:${orgId}:${RANKING_VERSION}:${topK}:${scopeSegment}:${query.slice(0, 500).toLowerCase().trim()}`
  // A candidate pool (rerank deferred to the caller) is a DIFFERENT result from a reranked top-K for the same
  // query, so it must not share an entry: serving one as the other would hand a caller the wrong stage of the
  // pipeline with no error. The final-stage key is left EXACTLY as it was, so existing entries stay valid.
  return skipRerank ? `${key}:pool` : key
}

export async function invalidateRagCache(): Promise<void> {
  await cacheDel('rag:')
}

export async function retrieveRelevantChunks(args: {
  query: string
  topK: number
  _skipDecompose?: boolean
  /**
   * Return the fused CANDIDATE POOL (up to `topK * 3`) without running the reranker, so a caller that merges several
   * retrievals can rerank ONCE over the union instead of once per retrieval. Only honoured while the reranker is
   * enabled: with it off the pool and the final list are the same size and there is nothing to defer.
   */
  _skipRerank?: boolean
  /**
   * Restrict retrieval to these documents. `null`/absent = every document, which keeps every
   * existing caller behaving exactly as before.
   *
   * Applied AT THE QUERY, not as a post-filter: filtering after ranking would return fewer than
   * `topK` results even when more allowed chunks exist, and would let a disallowed chunk influence
   * the reflection step before being dropped.
   */
  documentIds?: string[] | null
  /**
   * Aborted when the caller stops needing this retrieval. Checked before the RERANK, which is the stage that costs a
   * model call: a speculative retrieval cancelled after routing sent the turn to SQL would otherwise still pay for the
   * rerank before the abort reached the reflection loop. MEASURED: on compound/DAG turns that unused rerank was
   * 3.1-3.6 s and made those turns SLOWER than not speculating at all.
   */
  signal?: AbortSignal
}): Promise<{
  chunks: RetrievedChunk[]
  queryTokens: string[]
  candidatesScanned: number
  graphContext: string
  citationTrail?: CitationTrail[]
  /** Chunks skipped for semantic scoring because their embedding model differs from the query's. */
  embeddingMismatch?: number
  /** The embedding model the QUERY used, or null when no embedding was resolved at all. */
  embeddingModelUsed?: string | null
}> {
  const queryTokens = tokenize(args.query)
  if (queryTokens.length === 0) {
    return { chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }
  }

  // null when there is no org context: skip the cache rather than share an entry.
  // Resolved once per call, so the value that keys the cache entry is provably the
  // same one that orders the result — resolving twice would let a mid-call change
  // write a ranking under a key that no longer describes it.
  const skipRerank = args._skipRerank === true && ragRerankEnabled()
  const cacheKey = ragCacheKey(args.query, args.topK, args.documentIds, skipRerank)
  if (cacheKey) {
    const cached = await cacheGet<Awaited<ReturnType<typeof retrieveRelevantChunks>>>(cacheKey)
    if (cached) {
      _cacheHits += 1
      // Counter only. A hit performs no retrieval work, so putting its near-zero
      // duration in the latency histogram would drag p50 down in proportion to the
      // hit rate — retrieval would look faster the busier the cache got.
      recordRetrievalCache(true)
      log.debug('RAG cache hit', { query: args.query.slice(0, 50), topK: args.topK })
      return cached
    }
  }
  const retrievalStartedAt = Date.now()

  // Sub-query decomposition: complex multi-part questions → parallel retrieval + merge.
  if (!args._skipDecompose) {
    const { decomposeQuery, mergeRetrievedResults } = await import('@/lib/hyde')
    const subQueries = decomposeQuery(args.query)
    if (subQueries.length > 1) {
      // Gather pools, then judge their union once. Truncating each sub-query
      // before merging can discard evidence needed by a compound question.
      const subResults = await Promise.all(
        subQueries.map((query) => retrieveRelevantChunks({
          ...args, query, _skipDecompose: true, _skipRerank: true,
        })),
      )
      const merged = mergeRetrievedResults(subResults)
      args.signal?.throwIfAborted()
      merged.chunks = skipRerank
        ? merged.chunks
        : ragRerankEnabled()
          ? await dispatchRerank(args.query, merged.chunks, args.topK)
          : selectTopRetrievedChunks(merged.chunks, args.topK)
      _cacheMisses += 1
      /*
       * This branch RETURNS EARLY, so it never reached the stamp at the end of this function — a decomposed
       * (compound) question came back with no rank at all. Stamp the merged order here, which is the order
       * this path actually returns.
       */
      stampRetrievedRanks(merged.chunks)
      if (cacheKey) await cacheSet(cacheKey, merged, Math.floor(RAG_CACHE_TTL_MS / 1000))
      // No timing sample here on purpose: this is a composite of the sub-retrievals,
      // each of which already recorded its own. Sampling both would count one user
      // question as 1 + N retrievals in the histogram and skew the p50 upward on
      // exactly the complex questions the A/B comparison is about.
      return merged
    }
  }

  // Leaf retrieval: this is the unit that runs the retrievers and therefore the one
  // whose duration and result count are comparable across runs.
  recordRetrievalCache(false)

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
  const rerankEnabled = ragRerankEnabled()
  // A wider pool gives the reranker access to evidence beyond the lexical head.
  // Bound operator overrides so malformed values cannot create an unbounded query.
  const configuredMultiplier = Number(process.env.RAG_POOL_MULTIPLIER ?? 8)
  const poolMultiplier = Number.isFinite(configuredMultiplier)
    ? Math.min(16, Math.max(1, Math.floor(configuredMultiplier)))
    : 8
  const retrievalTopK = rerankEnabled ? args.topK * poolMultiplier : args.topK

  const [kgResult, cogneeGraphContext] = await Promise.all([
    dualLevelRetrieval({ query: args.query, topK: args.topK }),
    recallGraphContext(args.query, args.documentIds),
  ])

  // The knowledge graph contributes candidates after the lexical head, alongside the
  // vector leg (see `lexicalFirst`), never ahead of an exact term match.
  const retrievalResult = await retrieveAndFuse({
    vectorQuery,
    queryTokens,
    topK: retrievalTopK,
    balancePool: rerankEnabled,
    kgRanking: kgResult.allChunkIds,
    documentIds: args.documentIds,
  })

  const mergedChunks = retrievalResult.chunks
  const graphContext = kgResult.graphContext || cogneeGraphContext

  // Before the rerank, which is the next model call. Fusion above is local work and is not interrupted.
  args.signal?.throwIfAborted()
  const finalChunks = skipRerank
    ? mergedChunks
    : rerankEnabled
      ? await dispatchRerank(args.query, mergedChunks, args.topK)
      : selectTopRetrievedChunks(mergedChunks, args.topK)

  /*
   * Stamp the 1-based position in the order actually RETURNED. The UI labels these "Match #N" from array
   * position, and MEASURED IN UAT that position and the displayed score described two different rankings, so
   * a reader could not tell which one the product used. Written here, where the order is final, the label and
   * the order cannot drift apart again.
   */
  stampRetrievedRanks(finalChunks)

  const citationTrail = buildCitationTrail(args.query, kgResult, finalChunks)

  const result = {
    chunks: finalChunks, queryTokens,
    candidatesScanned: retrievalResult.candidatesScanned, graphContext,
    citationTrail: citationTrail.length > 0 ? citationTrail : undefined,
  }

  _cacheMisses += 1
  // Measured to the END of this function, so the number covers what a caller waits
  // for (both legs, the graph, fusion and the reranker) rather than only the legs.
  recordRetrievalTiming({
    rankingVersion: RANKING_VERSION,
    ms: Date.now() - retrievalStartedAt,
    candidatesScanned: retrievalResult.candidatesScanned,
    returned: finalChunks.length,
    vectorHits: retrievalResult.vectorHits,
    vectorAttempted: retrievalResult.vectorAttempted,
  })
  log.debug('RAG cache miss', { query: args.query.slice(0, 50), topK: args.topK, candidatesScanned: retrievalResult.candidatesScanned })
  if (cacheKey) await cacheSet(cacheKey, result, Math.floor(RAG_CACHE_TTL_MS / 1000))

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

/** Whether the LLM/cross-encoder reranker is on. One predicate, so a caller deferring the rerank cannot disagree with it. */
export function ragRerankEnabled(): boolean {
  return process.env.RAG_LLM_RERANK !== 'false'
}

/**
 * Rerank an already-merged candidate pool down to `topK`. The deferred half of `_skipRerank`: the caller merges
 * several pools and pays for ONE rerank over the union.
 */
export async function rerankMergedChunks(query: string, chunks: RetrievedChunk[], topK: number): Promise<RetrievedChunk[]> {
  return dispatchRerank(query, chunks, topK)
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

    /*
     * THE RERANKER IS SHOWN THE CHUNK'S OWN TEXT, not the retrieval `content`.
     *
     * MEASURED ON PRODUCTION: every chunk carried a 377-character `contextPrefix` (the document summary that
     * `CONTEXTUAL_RETRIEVAL` prepends), while this window is 300 characters — so every candidate was presented to
     * the model as the SAME header text, with its passage never visible. It scored what it could see, which is why
     * it endorsed 2.24 chunks of ~12 on average and why identical documents were indistinguishable to it. `ownContent`
     * is the text without that prefix; falling back to `content` keeps installs without contextual retrieval exactly
     * as they were (MEASURED locally: `ownContent` is absent there, and the reranker already saw the real text).
     */
    const chunkList = chunks.map((c, i) => `[${i}] ${(c.ownContent ?? c.content).slice(0, 300)}`).join('\n\n')
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
    // Select only endorsed chunks; diversity may relax when no other document
    // can fill a slot, but rejected evidence never pads a partial endorsement.
    for (const item of scored) {
      if (used.has(item.index)) continue
      used.add(item.index)
      const chunk = chunks[item.index]
      /*
       * Carry the RERANKER's judgement on the chunk. MEASURED IN UAT: without it this array was ordered by the
       * LLM while every chunk still reported its RETRIEVAL score, so `POST /api/documents/search` returned
       * `[0.3333, 1, 0.5, 0.1111]` — an array that is correctly ordered and a visible score that contradicts it.
       * The UI then labelled it "Match #1…#4", with the best chunk shown as Match #3.
       */
      reranked.push({ ...chunk, rerankScore: item.score })
    }
    /*
     * A TOTAL rejection is NOT a ranking, so it does not get to empty the result.
     *
     * "The reranker endorsed 3 of 12" is a judgement worth honouring: those three are the ones it read and scored.
     * "The reranker endorsed NONE" is a different event — every score fell below the floor, or the model returned
     * numbers the parser rejects — and honouring it would answer "I found nothing" from a corpus that contains the
     * answer. That is the evidence-sufficiency failure this codebase has already been bitten by, so the fused order
     * is returned instead, truncated to what the caller asked for.
     */
    if (reranked.length === 0) return chunks.slice(0, topK)
    return selectTopRetrievedChunks(reranked.map((chunk, index) => ({
      chunk, documentId: chunk.documentId, chunkIndex: index, score: chunk.rerankScore!,
    })), topK).map((row) => row.chunk)
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
  balancePool?: boolean
  /**
   * Restrict both legs (vector and lexical) to these documents. Threaded explicitly rather than
   * read from a module-level value so a caller cannot accidentally run unscoped by forgetting to
   * set it — the type requires the decision.
   */
  documentIds?: string[] | null
  kgRanking?: string[]
}): Promise<{
  chunks: RetrievedChunk[]
  candidatesScanned: number
  /**
   * How many chunks the VECTOR leg actually contributed, and whether a vector was
   * even attempted. Reported because a dead vector leg is this subsystem's signature
   * failure: the dimension mismatch, the SSRF-blocked embedder and the unset
   * RAG-column each produced a healthy-looking answer with the leg silently empty.
   * Result quality cannot distinguish "no semantic match" from "no semantic leg".
   */
  vectorHits: number
  vectorAttempted: boolean
  /**
   * Chunks skipped for semantic scoring because their stored embedding model differs from the query's.
   *
   * The comment above names this subsystem's signature failure — "the dimension mismatch … produced a
   * healthy-looking answer with the leg silently empty". This count is that failure made legible: MEASURED IN UAT,
   * `semanticSimilarity` was 0 on every result of every query because 384-dimensional vectors were being compared
   * against a 1536-dimensional query. `vectorAttempted: true` with a large `embeddingMismatch` is the exact shape.
   */
  embeddingMismatch?: number
  embeddingModelUsed?: string | null
}> {
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

  let candidates = await loadVectorCandidateChunks(candidateIds, args.documentIds)
  if (candidates.length === 0) {
    // Neither retriever produced anything (no embeddings yet, empty FTS index).
    candidates = await loadAllCandidateChunks(args.documentIds)
  }
  if (candidates.length === 0) {
    return { chunks: [], candidatesScanned: 0, vectorHits: vectorRanking.length, vectorAttempted: Boolean(queryEmbedding) }
  }

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
      tokens: scoringTokens(chunk.content).concat(
        (chunk.keywords ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
      ),
    })),
  )
  const bm25Scores = new Map(bm25.map((entry) => [entry.id, entry.score]))

  // Balance membership only in rerank pools. Without a judge, keep the measured
  // lexical-first order over the full union and let diversity selection truncate.
  const fused = lexicalFirst(toRanking(bm25), [...vectorRanking, ...(args.kgRanking ?? [])], args.balancePool ? topK : undefined)

  const scored: RetrievedChunk[] = []
  /*
   * Chunks skipped for semantic scoring because their stored embedding model differs from the query's.
   *
   * MEASURED IN UAT, twice: `semanticSimilarity` was 0 on EVERY result of EVERY query. The stored vectors are
   * 384-dimensional (`paraphrase-multilingual-MiniLM-L12-v2`) while the configured model is `text-embedding-3-small`
   * (1536). The comparison inside the loop is where that becomes a silent zero: retrieval falls back to lexical-only
   * and nothing anywhere says so. Counting it here makes the condition observable instead of invisible.
   */
  let embeddingMismatched = 0
  for (const { id, score } of fused) {
    const chunk = byId.get(id)
    if (!chunk) continue
    const lexicalScore = scoreChunk(queryTokens, chunk)
    const vectorScore = vectorScores.get(id)
    const embeddingUsable = Boolean(queryEmbedding && chunk.embeddingModel === queryEmbedding.model)
    if (queryEmbedding && !embeddingUsable) embeddingMismatched += 1
    const chunkEmbedding = embeddingUsable ? parseEmbeddingJson(chunk.embeddingJson) : null
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
      ...(ownContentOf(chunk) ? { ownContent: ownContentOf(chunk) } : {}),
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

  return {
    chunks: selectTopRetrievedChunks(scored, topK),
    candidatesScanned: candidates.length,
    vectorHits: vectorRanking.length,
    vectorAttempted: Boolean(queryEmbedding),
    // Non-zero means semantic scoring was INERT for this query — reported rather than left to be inferred from a
    // wall of `semanticSimilarity: 0` values.
    embeddingMismatch: embeddingMismatched,
    embeddingModelUsed: queryEmbedding?.model ?? null,
  }
}

/**
 * The chunk's text WITHOUT its context prefix, or undefined when it has none. The prefix is stripped only when
 * `content` really starts with it (it is concatenated that way at load time), so a row whose stored prefix does not
 * match is left alone rather than sliced at a wrong offset.
 */
export function ownContentOf(chunk: { content: string; contextPrefix: string | null }): string | undefined {
  const prefix = chunk.contextPrefix
  if (!prefix || !chunk.content.startsWith(prefix)) return undefined
  return chunk.content.slice(prefix.length)
}

async function recallGraphContext(query: string, documentIds?: string[] | null): Promise<string> {
  try {
    const { recallKnowledgeGraph } = await import('@/lib/cognee')
    /*
     * `documentIds` is forwarded as cognee `nodeNames`, and this is the ONLY place the graph leg can be
     * scoped: the recall returns TEXT with no per-document metadata, and `KgRelation` carries a `chunkId` but
     * no `documentId`, so nothing downstream can filter it.
     *
     * MEASURED NEED: a recall restricted to one document still returned relations from OTHER documents, and
     * those reached the answer prompt as `CONTEXT (KNOWLEDGE GRAPH)` — so a scoped API key could read another
     * document's facts. The document-chunk legs were already scoped at the query; this was the one that leaked.
     *
     * `null`/absent means unrestricted, matching every other use of this argument.
     */
    return await recallKnowledgeGraph({ query, topK: 5, nodeNames: documentIds ?? undefined })
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

/**
 * Minimum rows a vector leg must return before we accept it as complete.
 *
 * HNSW applies the org filter AFTER its approximate scan, so a query for N
 * neighbours returns far fewer than N when the org is a minority of the shared
 * table — the scan never enters the org's region and the filter discards what
 * it did find. Measured (trial/92, 20k vectors across 100 orgs, each 1% of the
 * table, asking for 80): the DEFAULT hnsw.ef_search of 40 returned **0 rows**;
 * ef_search=1000, the maximum, returned 5. pgvector documents the shape of this
 * ("filtering is applied after the index is scanned… only 4 rows will match on
 * average" at 10% selectivity) and requires hnsw.iterative_scan — added in
 * 0.8.0 — to keep scanning until enough rows survive the filter. 0.6.0 has no
 * such option.
 *
 * Without this check the failure was invisible: `pgScores.size > 0` counted as
 * success, so a partial (or empty) vector leg silently won and the external
 * vector store — which is exact — was never tried. Fusion then treated the
 * survivors as the whole candidate set.
 *
 * So an under-filled vector leg is a FAILURE, not a result.
 */
const MIN_VECTOR_LEG_ROWS = 8

async function resolveVectorScores(args: { vector: number[] | null; topK: number }): Promise<Map<string, number>> {
  if (!args.vector) return new Map()

  const wanted = Math.max(args.topK * 8, 16)
  let pgScores = new Map<string, number>()
  try {
    // Fire-and-forget: never make a user query wait on an index build.
    void ensureVectorIndexes()
    pgScores = await pgvectorSimilaritySearch(args.vector, wanted)
    if (pgScores.size >= Math.min(wanted, MIN_VECTOR_LEG_ROWS)) return pgScores
    if (pgScores.size > 0) {
      // Partial. Prefer a complete answer from the external store when one is
      // configured; keep these rows as a floor when it is not.
      log.warn('pgvector returned fewer rows than requested (HNSW filter truncation)', {
        requested: wanted,
        received: pgScores.size,
      })
    }
  } catch (e) {
    // WARN, not debug. At the default LOG_LEVEL=info a `debug` here is invisible, and
    // this is the one path where retrieval silently loses half its inputs: the leg comes
    // back empty, fusion proceeds with BM25 alone, and every downstream signal (answers,
    // citations, similarity scores) still looks healthy. MEASURED cost of this being
    // invisible: a dimension mismatch and an SSRF-blocked embedder each took hours to
    // find, and both presented as "retrieval works, it just isn't very good".
    log.warn('pgvector search unavailable, trying external vector store', { error: e instanceof Error ? e.message : String(e) })
  }

  try {
    const config = await getVectorStoreRuntimeConfig()
    if (!config) return pgScores
    const hits = await searchVectorStore({ config, vector: args.vector, limit: wanted })
    if (hits.length === 0) return pgScores
    return new Map(hits.map((hit) => [hit.chunkId, hit.score]))
  } catch (e) {
    // A MISCONFIGURED PROVIDER MUST NOT DEGRADE INTO "NO RESULTS". Every other failure here is legitimately
    // absorbed: an unreachable store should fall back to pgvector rather than fail the whole search, because
    // pgvector results are still real. An UNSUPPORTED provider is different in kind -- it is a configuration
    // error that no retry will fix, and swallowing it made the two look identical: zero hits, HTTP 200, and a
    // model that answers as if the corpus were empty. Propagated so the caller can name the provider.
    if (e instanceof UnsupportedVectorProviderError) throw e
    log.warn('resolveVectorScores failed', { error: e instanceof Error ? e.message : String(e) })
    return pgScores
  }
}

/**
 * Does this Postgres have hnsw.iterative_scan (pgvector 0.8.0+)?
 *
 * `null` = not probed yet. Probed once per process: the answer cannot change
 * without a server restart, and the probe costs a round trip per query if
 * repeated. When true we get a real fix for HNSW filter truncation; when false
 * we fall back to the largest ef_search the server accepts.
 */
let _iterativeScanSupported: boolean | null = null

async function hasIterativeScan(): Promise<boolean> {
  if (_iterativeScanSupported !== null) return _iterativeScanSupported
  try {
    /*
     * `current_setting(name, true)` — the SECOND ARGUMENT is the fix, not a nicety.
     *
     * `SHOW hnsw.iterative_scan` on a build without that GUC (pgvector < 0.8.0, which is what this install has)
     * raises 42704. The catch below handled it, so the FUNCTION was correct — but Postgres still reported the error
     * to the driver, and Prisma logs every server error it sees at `prisma:error` level. MEASURED effect on this
     * install: `Raw query failed. Code: 42704. unrecognized configuration parameter "hnsw.iterative_scan"` printed
     * once per process, and it appeared in the retrieval log path — which cost real time during this investigation,
     * because it reads as "the vector search just failed" when in fact the vector search returned a FULL result set
     * (96 of 96) on every query measured. That is the worst kind of noise: a message that describes a failure which
     * is not happening, on the path where a real failure would matter most.
     *
     * `missing_ok = true` returns NULL for an unknown parameter instead of raising, so the probe answers the same
     * question with no server error and nothing to log.
     */
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT current_setting('hnsw.iterative_scan', true) AS v`)
    const value = rows[0]?.v
    _iterativeScanSupported = typeof value === 'string' && value.length > 0
  } catch {
    // A driver/permission failure is a different thing from "unsupported": still answer false (the safe branch).
    _iterativeScanSupported = false
  }
  return _iterativeScanSupported
}

/** Test seam — resets the cached capability probe. */
export function _resetIterativeScanProbe(): void {
  _iterativeScanSupported = null
}

/**
 * Test seam — forgets the memoised index build.
 *
 * `retrieveRelevantChunks` fires `void ensureVectorIndexes()` on its vector path,
 * so by the time a later test calls the function the memo is populated and it
 * returns the cached promise WITHOUT issuing DDL. A test that wants to observe the
 * DDL has to clear the memo first; otherwise the assertion silently measures the
 * memo instead of the statement.
 */
export function _resetVectorIndexBuild(): void {
  _vectorIndexBuild = null
}

async function pgvectorSimilaritySearch(queryVector: number[], limit: number): Promise<Map<string, number>> {
  const vectorStr = `[${queryVector.join(',')}]`
  const orgId = getOrgContext()

  // HNSW filters AFTER the approximate scan, so `ef_search` (default 40) must
  // exceed `limit` for the org's rows to survive. On pgvector >= 0.8.0
  // iterative_scan does this properly — keep scanning until the filter yields
  // enough rows. On 0.6.x the only lever is ef_search, capped at 1000 by the
  // server (a larger value is rejected with 22023), so we ask for as much as
  // the server allows and let resolveVectorScores treat a short result as a
  // failure rather than a success.
  const iterative = await hasIterativeScan()
  const efSearch = Math.min(Math.max(limit * 4, 100), 1000)
  const setLocal = iterative
    ? `SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL hnsw.ef_search = ${efSearch};`
    : `SET LOCAL hnsw.ef_search = ${efSearch};`

  try {
    // SET LOCAL only applies inside a transaction, so the two must share one.
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(setLocal)
      // Org-scoped (prevents cross-tenant ranking interference) + HNSW index
      // makes the ORDER BY embedding <=> a bounded ANNS scan, not full-corpus O(n).
      const rows = await tx.$queryRaw<Array<{ id: string; similarity: number }>>`
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
    })
  } catch (e) {
    // A rejected SET LOCAL (older/newer GUC name) must not lose the query.
    log.debug('pgvector ef_search transaction failed, retrying with plain query', {
      error: e instanceof Error ? e.message : String(e),
    })
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

async function loadVectorCandidateChunks(
  chunkIds: string[],
  documentIds?: string[] | null,
): Promise<CandidateChunk[]> {
  const rows = await db.documentChunk.findMany({
    where: {
      id: { in: chunkIds },
      // The scope filter is applied to the DOCUMENT relation, so a chunk can never be returned by
      // naming it directly — the caller supplies chunk ids from a vector search that knows nothing
      // about scopes, and this is the only place that can refuse them.
      document: {
        status: 'ready',
        isEnabled: true,
        ...(documentIds && documentIds.length > 0 ? { id: { in: documentIds } } : {}),
      },
    },
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

async function loadAllCandidateChunks(documentIds?: string[] | null): Promise<CandidateChunk[]> {
  const docs = await db.document.findMany({
    where: {
      status: 'ready',
      isEnabled: true,
      // Same reasoning as above: the fallback path scans every document, so it must scan only the
      // allowed ones. Omitting this would make the FTS-miss path an unrestricted side door.
      ...(documentIds && documentIds.length > 0 ? { id: { in: documentIds } } : {}),
    },
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

