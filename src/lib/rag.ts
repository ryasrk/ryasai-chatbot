/**
 * RAG utilities — shared by document upload + retrieval routes.
 * ----------------------------------------------------------------------------
 * PRAGMATIC SANDBOX IMPLEMENTATION:
 * The original spec (§3.3) calls for BGE-M3 dense embeddings stored in
 * ChromaDB with hybrid BM25 + dense retrieval. Neither BGE-M3 nor ChromaDB
 * are available in this sandbox, so we implement a lightweight keyword-
 * overlap scorer that preserves the same API surface (chunk + keywords).
 * The retrieval function in `search/route.ts` documents this clearly.
 */
import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('rag')
import {
  combineHybridScore,
  cosineSimilarity,
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
} from '@/lib/embeddings'
import { getVectorStoreRuntimeConfig, searchVectorStore } from '@/lib/vector-stores'
import { searchFtsChunkIds } from '@/lib/rag-fts'
import {
  extractDocxTextFromBuffer,
  extractPdfTextFromBuffer,
  extractXlsxTextFromBuffer,
} from '@/lib/document-parsers'
import {
  RAG_CHUNK_SIZE,
  RAG_CHUNK_OVERLAP,
  RAG_MAX_PER_DOCUMENT,
  RAG_CACHE_TTL_MS,
  RAG_CACHE_MAX_ENTRIES,
  RAG_MAX_CHUNKS_PER_UPLOAD,
} from '@/lib/constants'

/** Indonesian + English stopword set (lowercased). */
export const STOPWORDS = new Set<string>([
  // Indonesian
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'atau',
  'ini', 'itu', 'adalah', 'akan', 'tidak', 'juga', 'dalam', 'agar', 'karena',
  'oleh', 'sebagai', 'para', 'telah', 'namun', 'bisa', 'dapat', 'harus',
  'kepada', 'tentang', 'setelah', 'sebelum', 'antara', 'hingga', 'serta',
  'tetapi', 'apa', 'bagaimana', 'kapan', 'mana', 'siapa', 'berapa', 'dimana',
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'have',
  'has', 'had', 'not', 'but', 'from', 'into', 'onto', 'over', 'under',
  // common short words
  'a', 'an', 'of', 'in', 'to', 'is', 'it', 'on', 'as', 'at', 'by', 'be',
  'do', 'if', 'or', 'we', 'you', 'they', 'he', 'she', 'my', 'our',
])

/** Tokenize a string into retrieval terms: lowercase, >=4 chars, no stopwords, no digits-only. */
export function tokenize(text: string): string[] {
  if (!text) return []
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    if (w.length < 4) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

/**
 * Extract top-N keywords from a chunk of text by term frequency.
 * Returns a comma-separated string suitable for the `keywords` column.
 */
export function extractKeywords(text: string, topN = 8): string {
  if (!text) return ''
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const freq = new Map<string, number>()
  for (const w of words) {
    if (w.length < 4) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  return sorted.map(([w]) => w).join(',')
}

export interface RetrievalScore {
  total: number
  lexicalTotal: number
  contentHits: number
  keywordHits: number
  phraseHits: number
  semanticSimilarity: number
  semanticScore: number
}

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
  scoreBreakdown: RetrievalScore
}

export function sortRetrievedChunks<T extends { score: number; chunkIndex: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)
}

export function selectTopRetrievedChunks<T extends { score: number; chunkIndex: number; documentId: string }>(
  rows: T[],
  topK: number,
  maxPerDocument = RAG_MAX_PER_DOCUMENT,
): T[] {
  const selected: T[] = []
  const perDocument = new Map<string, number>()

  for (const row of sortRetrievedChunks(rows)) {
    const count = perDocument.get(row.documentId) ?? 0
    if (count >= maxPerDocument) continue
    selected.push(row)
    perDocument.set(row.documentId, count + 1)
    if (selected.length >= topK) break
  }

  return selected
}

// ---------------------------------------------------------------------------
// Query-level cache — avoids re-scoring all chunks for repeat questions.
// ponytail: in-memory Map with TTL, per-instance not distributed.
// Ceiling: cleared on server restart. Cache key includes topK so different
// topK values don't collide. Upgrade to Redis when deploying >1 instance.
// ---------------------------------------------------------------------------

const _ragCache = new Map<string, { result: Awaited<ReturnType<typeof retrieveRelevantChunks>>; ts: number }>()

// ponytail: cache hit/miss counters — per-instance, not distributed.
let _cacheHits = 0
let _cacheMisses = 0

export function getRagCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = _cacheHits + _cacheMisses
  return { hits: _cacheHits, misses: _cacheMisses, hitRate: total === 0 ? 0 : _cacheHits / total }
}

function ragCacheKey(query: string, topK: number): string {
  return `${topK}:${query.slice(0, 500).toLowerCase().trim()}`
}

// ponytail: invalidate cache when documents are added/removed. Called from
// document upload + delete routes. Simple clear-all is fine at current scale.
export function invalidateRagCache(): void {
  _ragCache.clear()
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export async function retrieveRelevantChunks(args: {
  query: string
  topK: number
}): Promise<{ chunks: RetrievedChunk[]; queryTokens: string[]; candidatesScanned: number; graphContext: string }> {
  const queryTokens = tokenize(args.query)
  if (queryTokens.length === 0) {
    return { chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }
  }

  // ponytail: check cache first — avoids re-scoring all chunks for repeat questions
  const cacheKey = ragCacheKey(args.query, args.topK)
  const cached = _ragCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < RAG_CACHE_TTL_MS) {
    _cacheHits += 1
    log.debug('RAG cache hit', { query: args.query.slice(0, 50), topK: args.topK })
    return cached.result
  }

  // ponytail: when RAG_LLM_RERANK=true, retrieve 3x candidates for LLM reranking.
  // Ceiling: adds 1 LLM call per RAG query (~500ms latency). Off by default.
  const rerankEnabled = process.env.RAG_LLM_RERANK === 'true'
  const retrievalTopK = rerankEnabled ? args.topK * 3 : args.topK

  // Run graph recall in parallel with vector/lexical retrieval
  const [retrievalResult, graphContext] = await Promise.all([
    retrieveFromVectorAndLexical(args.query, retrievalTopK, queryTokens),
    recallGraphContext(args.query),
  ])

  const finalChunks = rerankEnabled
    ? await rerankWithLlm(args.query, retrievalResult.chunks, args.topK)
    : retrievalResult.chunks

  const result = {
    chunks: finalChunks,
    queryTokens,
    candidatesScanned: retrievalResult.candidatesScanned,
    graphContext,
  }

  _cacheMisses += 1
  log.debug('RAG cache miss', { query: args.query.slice(0, 50), topK: args.topK, candidatesScanned: retrievalResult.candidatesScanned })

  // ponytail: cache the result — evict oldest when at capacity
  if (_ragCache.size >= RAG_CACHE_MAX_ENTRIES) {
    const oldest = _ragCache.keys().next().value
    if (oldest) _ragCache.delete(oldest)
  }
  _ragCache.set(cacheKey, { result, ts: Date.now() })

  return result
}

// ponytail: LLM reranker — asks the LLM to rank chunks by relevance to the query.
// Returns top-K after reranking. Falls back to original order on any error.
async function rerankWithLlm(
  query: string,
  chunks: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= topK) return chunks
  if (chunks.length === 0) return chunks

  try {
    const { getLlmRuntimeConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getLlmRuntimeConfig()
    if (!cfg) return chunks.slice(0, topK)

    const chunkList = chunks
      .map((c, i) => `[${i}] ${c.content.slice(0, 300)}`)
      .join('\n\n')

    const systemPrompt =
      'You are a retrieval reranker. Given a query and text chunks, rank them by relevance. ' +
      'Answer ONLY with a JSON array of chunk indices, most relevant first. Example: [2, 0, 4, 1, 3]'

    const userMessage = `Query: ${query}\n\nChunks:\n${chunkList}\n\nRank these chunks by relevance to the query. Output JSON array of indices only.`

    const raw = await chatOnce(
      cfg,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      0,
      'rag-rerank',
    )

    // Parse the JSON array of indices
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
    // Fallback: if reranking produced fewer than topK, fill from remaining chunks
    if (reranked.length < topK) {
      const used = new Set(indices.filter((i) => i >= 0 && i < chunks.length))
      for (let i = 0; i < chunks.length && reranked.length < topK; i++) {
        if (!used.has(i)) reranked.push(chunks[i])
      }
    }

    return reranked
  } catch (e) {
    // ponytail: graceful degradation — falls back to original order when LLM reranker unavailable
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
  const vectorScores = await resolveVectorScores({
    vector: queryEmbedding?.vector ?? null,
    topK,
  })
  // ponytail: graceful degradation — falls back to lexical search when vector store unavailable
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
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      score: scoreBreakdown.total,
      scoreBreakdown,
    })
  }

  return {
    chunks: selectTopRetrievedChunks(scored, topK),
    candidatesScanned,
  }
}

async function recallGraphContext(query: string): Promise<string> {
  // ponytail: graceful degradation — falls back to empty string when cognee unavailable
  try {
    const { recallKnowledgeGraph } = await import('@/lib/cognee')
    return await recallKnowledgeGraph({ query, topK: 5 })
  } catch {
    return ''
  }
}

export function scoreChunk(
  queryTokens: string[],
  chunk: { content: string; keywords?: string | null },
): RetrievalScore {
  const contentTokens = tokenize(chunk.content)
  const contentSet = new Set(contentTokens)
  const keywordSet = new Set(
    (chunk.keywords ?? '')
      .split(',')
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean),
  )

  let contentHits = 0
  let keywordHits = 0
  for (const token of queryTokens) {
    if (contentSet.has(token)) contentHits += 1
    if (keywordSet.has(token)) keywordHits += 1
  }

  const phraseHits = countPhraseHits(contentTokens, queryTokens)
  return {
    contentHits,
    keywordHits,
    phraseHits,
    lexicalTotal: contentHits + keywordHits * 2 + phraseHits * 3,
    semanticSimilarity: 0,
    semanticScore: 0,
    total: contentHits + keywordHits * 2 + phraseHits * 3,
  }
}

export function applySemanticScore(
  lexicalScore: RetrievalScore,
  queryEmbedding: number[],
  chunkEmbedding: number[],
): RetrievalScore {
  const hybrid = combineHybridScore({
    lexicalTotal: lexicalScore.lexicalTotal,
    semanticSimilarity: cosineSimilarity(queryEmbedding, chunkEmbedding),
  })
  return {
    ...lexicalScore,
    total: hybrid.total,
    semanticSimilarity: hybrid.semanticSimilarity,
    semanticScore: hybrid.semanticScore,
  }
}

export function applyVectorStoreScore(
  lexicalScore: RetrievalScore,
  vectorScore: number,
): RetrievalScore {
  const hybrid = combineHybridScore({
    lexicalTotal: lexicalScore.lexicalTotal,
    semanticSimilarity: vectorScore,
  })
  return {
    ...lexicalScore,
    total: hybrid.total,
    semanticSimilarity: hybrid.semanticSimilarity,
    semanticScore: hybrid.semanticScore,
  }
}

async function resolveQueryEmbedding(
  query: string,
): Promise<{ vector: number[]; model: string } | null> {
  // ponytail: graceful degradation — falls back to lexical-only scoring when embedding API unavailable
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

async function resolveVectorScores(args: {
  vector: number[] | null
  topK: number
}): Promise<Map<string, number>> {
  // ponytail: graceful degradation — falls back to empty scores (lexical fallback) when vector store unavailable
  if (!args.vector) return new Map()
  try {
    const config = await getVectorStoreRuntimeConfig()
    if (!config) return new Map()
    const hits = await searchVectorStore({
      config,
      vector: args.vector,
      limit: Math.max(args.topK * 8, 16),
    })
    return new Map(hits.map((hit) => [hit.chunkId, hit.score]))
  } catch (e) {
    log.warn('resolveVectorScores failed', { error: e instanceof Error ? e.message : String(e) })
    return new Map()
  }
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

async function loadVectorCandidateChunks(
  chunkIds: string[],
): Promise<CandidateChunk[]> {
  const rows = await db.documentChunk.findMany({
    where: {
      id: { in: chunkIds },
      document: { status: 'ready', isEnabled: true },
    },
    select: {
      id: true,
      chunkIndex: true,
      content: true,
      keywords: true,
      embeddingJson: true,
      embeddingModel: true,
      document: { select: { id: true, name: true } },
    },
  })
  const order = new Map(chunkIds.map((id, index) => [id, index]))
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => ({
      chunkId: row.id,
      documentId: row.document.id,
      documentName: row.document.name,
      chunkIndex: row.chunkIndex,
      content: row.content,
      keywords: row.keywords,
      embeddingJson: row.embeddingJson,
      embeddingModel: row.embeddingModel,
    }))
}

async function loadAllCandidateChunks(): Promise<CandidateChunk[]> {
  const docs = await db.document.findMany({
    where: { status: 'ready', isEnabled: true },
    select: {
      id: true,
      name: true,
      chunks: {
        take: RAG_MAX_CHUNKS_PER_UPLOAD,
        select: {
          id: true,
          chunkIndex: true,
          content: true,
          keywords: true,
          embeddingJson: true,
          embeddingModel: true,
        },
      },
    },
  })
  return docs.flatMap((doc) =>
    doc.chunks.map((chunk) => ({
      chunkId: chunk.id,
      documentId: doc.id,
      documentName: doc.name,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      keywords: chunk.keywords,
      embeddingJson: chunk.embeddingJson,
      embeddingModel: chunk.embeddingModel,
    })),
  )
}

async function loadLexicalCandidateChunks(
  queryTokens: string[],
  topK: number,
): Promise<CandidateChunk[]> {
  const ftsIds = await searchFtsChunkIds({
    queryTokens,
    limit: Math.max(topK * 12, 32),
  })
  let candidates = ftsIds.length > 0 ? await loadVectorCandidateChunks(ftsIds) : []
  if (candidates.length === 0) {
    candidates = await loadAllCandidateChunks()
  }
  return candidates
}

function countPhraseHits(contentTokens: string[], queryTokens: string[]): number {
  if (queryTokens.length < 2 || contentTokens.length < 2) return 0

  let hits = 0
  for (let size = Math.min(4, queryTokens.length); size >= 2; size -= 1) {
    for (let start = 0; start <= queryTokens.length - size; start += 1) {
      const phrase = queryTokens.slice(start, start + size)
      if (containsTokenPhrase(contentTokens, phrase)) hits += 1
    }
  }
  return hits
}

function containsTokenPhrase(contentTokens: string[], phrase: string[]): boolean {
  for (let start = 0; start <= contentTokens.length - phrase.length; start += 1) {
    if (phrase.every((token, offset) => contentTokens[start + offset] === token)) {
      return true
    }
  }
  return false
}

const DEFAULT_MAX_CHUNK_CHARS = RAG_CHUNK_SIZE
const DEFAULT_OVERLAP_CHARS = RAG_CHUNK_OVERLAP

/**
 * Split text into semantic-ish chunks on double-newlines, with a hard ceiling
 * for long single-paragraph documents.
 */
export function chunkText(
  content: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS
  const overlapChars = Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars)
  if (!content) return []
  return content
    .split(/\n\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .flatMap((chunk) => splitLongChunk(chunk, maxChars, overlapChars))
}

function splitLongChunk(content: string, maxChars: number, overlapChars: number): string[] {
  if (content.length <= maxChars) return [content]

  const chunks: string[] = []
  let current = ''
  for (const word of content.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      chunks.push(current)
      const overlap = trailingWordsWithin(current, overlapChars)
      current = overlap ? `${overlap} ${word}` : word
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function trailingWordsWithin(content: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const words = content.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let length = 0
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]
    const nextLength = length + word.length + (kept.length > 0 ? 1 : 0)
    if (nextLength > maxChars) break
    kept.unshift(word)
    length = nextLength
  }
  return kept.join(' ')
}

/** Detect document type from filename. Falls back to 'txt'. */
export function detectDocType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  // fallback: try last extension
  const idx = lower.lastIndexOf('.')
  if (idx >= 0) return lower.slice(idx + 1)
  return 'txt'
}

/**
 * Extract text from an uploaded File.
 *
 * For .md/.txt: read as UTF-8.
 * For .pdf/.docx/.xlsx: there is no binary parser in this sandbox, so we
 *   attempt `file.text()` and detect whether the result is mostly printable.
 *   If it looks like garbage binary, we store a synthetic placeholder.
 *
 * Returns `{ text, isPlaceholder }`.
 */
export async function extractFileText(
  file: File,
): Promise<{ text: string; isPlaceholder: boolean }> {
  const name = file.name
  const size = file.size
  const type = detectDocType(name)

  // Pure-text formats: read directly.
  if (type === 'txt' || type === 'md') {
    try {
      const text = await file.text()
      return { text: text ?? '', isPlaceholder: false }
    } catch (e) {
      log.warn('extractFileText read failed', { error: e instanceof Error ? e.message : String(e) })
      return {
        text: `[Text document: ${name}, ${size} bytes. Read failed.]`,
        isPlaceholder: true,
      }
    }
  }

  const binary = Buffer.from(await file.arrayBuffer())
  if (type === 'pdf') {
    const text = extractPdfTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }
  if (type === 'docx') {
    const text = extractDocxTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }
  if (type === 'xlsx') {
    const text = extractXlsxTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }

  // Binary formats: try text(), validate printable ratio.
  try {
    const raw = await file.text()
    if (raw && raw.length > 0) {
      const sample = raw.slice(0, 4096)
      const printable = (sample.match(/[\p{L}\p{N}\p{P}\s]/gu) ?? []).length
      const ratio = printable / Math.max(sample.length, 1)
      if (ratio > 0.85) {
        // Looks like real text (some PDFs embed text streams).
        return { text: raw, isPlaceholder: false }
      }
    }
  } catch {
    /* fall through to placeholder */
  }

  return {
    text: `[Binary document: ${name}, ${size} bytes. Parsed content placeholder.]`,
    isPlaceholder: true,
  }
}

function limitExtractedText(text: string): string {
  return text.replace(/\s+\n/g, '\n').trim().slice(0, 2_000_000)
}
