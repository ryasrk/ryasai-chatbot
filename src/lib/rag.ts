import {
  RAG_MAX_PER_DOCUMENT,
} from '@/lib/constants'

export const STOPWORDS = new Set<string>([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'atau',
  'ini', 'itu', 'adalah', 'akan', 'tidak', 'juga', 'dalam', 'agar', 'karena',
  'oleh', 'sebagai', 'para', 'telah', 'namun', 'bisa', 'dapat', 'harus',
  'kepada', 'tentang', 'setelah', 'sebelum', 'antara', 'hingga', 'serta',
  'tetapi', 'apa', 'bagaimana', 'kapan', 'mana', 'siapa', 'berapa', 'dimana',
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'have',
  'has', 'had', 'not', 'but', 'from', 'into', 'onto', 'over', 'under',
  'a', 'an', 'of', 'in', 'to', 'is', 'it', 'on', 'as', 'at', 'by', 'be',
  'do', 'if', 'or', 'we', 'you', 'they', 'he', 'she', 'my', 'our',
])

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
    contentHits, keywordHits, phraseHits,
    lexicalTotal: contentHits + keywordHits * 2 + phraseHits * 3,
    semanticSimilarity: 0, semanticScore: 0,
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
  return { ...lexicalScore, total: hybrid.total, semanticSimilarity: hybrid.semanticSimilarity, semanticScore: hybrid.semanticScore }
}

export function applyVectorStoreScore(
  lexicalScore: RetrievalScore,
  vectorScore: number,
): RetrievalScore {
  const hybrid = combineHybridScore({
    lexicalTotal: lexicalScore.lexicalTotal,
    semanticSimilarity: vectorScore,
  })
  return { ...lexicalScore, total: hybrid.total, semanticSimilarity: hybrid.semanticSimilarity, semanticScore: hybrid.semanticScore }
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

import { combineHybridScore, cosineSimilarity } from '@/lib/embeddings'

export { chunkText, detectDocType, extractFileText } from './rag-chunking'
export { retrieveRelevantChunks, invalidateRagCache, getRagCacheStats } from './rag-retrieval'
