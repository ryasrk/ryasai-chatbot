import { combineHybridScore, cosineSimilarity } from '@/lib/embeddings'
import {
  RAG_MAX_PER_DOCUMENT,
} from '@/lib/constants'

/**
 * ponytail: SINGLE SOURCE for stopwords. This set used to be duplicated in
 * smart-router-helpers.ts with 168 of its own entries, and the two copies had
 * already drifted: the router's copy listed `data`, `total`, `count`, `table`,
 * `amount`, `row`, `column` as stopwords — exactly the words users type when
 * asking about a database — so a question like "total amount per table" was
 * stripped to nothing before integration scoring. Routing and retrieval must
 * agree on what a meaningful token is; smart-router-helpers.ts now imports
 * this set and `isMeaningfulToken` instead of keeping its own list.
 */
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
  // Short function words that the old `length < 4` cutoff used to hide. Now that
  // 2-3 char tokens are kept (acronyms: sql, api, roi, ppn, pt), these have to be
  // named explicitly or every query matches every chunk on "the/per/via" noise.
  'me', 'us', 'am', 'so', 'no', 'up', 'out', 'via', 'per', 'all', 'any', 'can',
  'may', 'get', 'got', 'its', 'his', 'her', 'him', 'own', 'off', 'now', 'new',
  'how', 'why', 'who', 'what', 'when', 'where', 'which', 'whom', 'whose',
  'ada', 'ya', 'ke', 'kan', 'pun', 'lah', 'nya', 'bagi', 'saja', 'atas',
  'jika', 'saya', 'anda', 'kami', 'kita', 'mereka', 'sudah', 'belum', 'lagi',
])

/**
 * Is this word worth indexing/matching?
 *
 * ponytail: noise suppression is the STOPWORDS list's job, not a length cutoff.
 * The old `length < 4` rule silently deleted every acronym a business chatbot
 * cares about — sql, api, roi, ceo, ppn, pt, npwp — plus every year and amount,
 * making them unmatchable in both lexical scoring and the FTS query built from
 * these tokens. Ceiling: a hand-maintained list; swap for a real stemmer/IDF
 * cutoff if the corpus grows past a few languages.
 */
export function isMeaningfulToken(word: string): boolean {
  if (word.length < 2) return false
  if (STOPWORDS.has(word)) return false
  // Bare digits: keep 2+ (years, amounts, quantities), drop single digits.
  if (/^\d+$/.test(word)) return word.length >= 2
  return true
}

/**
 * Tokens for BM25 SCORING: keeps repeats (term frequency) and hyphenated identifiers.
 *
 * `tokenize` dedupes, which is right for a query and wrong for a document: every term
 * frequency becomes 1 and BM25 degrades to a weighted set overlap. It also splits
 * "INV-4471" into "inv"/"4471" and drops the joined form, which is the token an exact
 * identifier lookup turns on. Measured on the benchmark (docs/retrieval-production-
 * integration-plan.md §12): keeping both moves real-prose answer@1 from 0.8347 to 0.9504
 * and synthetic recall@10 from 0.3848 to 0.4342. Keeping TF WITHOUT the joined form
 * was worse on synthetic (0.2551), so the two changes ship together.
 */
export function tokenizeForScoring(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []) {
    const parts = raw.includes('-') ? raw.split('-').filter(Boolean) : [raw]
    if (parts.length > 1) out.push(raw)
    for (const part of parts) if (isMeaningfulToken(part)) out.push(part)
  }
  return out
}

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
    if (!isMeaningfulToken(w)) continue
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
    if (!isMeaningfulToken(w)) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  return sorted.map(([w]) => w).join(',')
}

export interface RetrievalScore {
  /**
   * Ordering score. After hybrid retrieval this is the RRF-fused rank score
   * (~0.01-0.05), NOT comparable to the raw counts below — those are reporting
   * only. Never add it to lexicalTotal or semanticScore.
   */
  total: number
  lexicalTotal: number
  contentHits: number
  keywordHits: number
  phraseHits: number
  semanticSimilarity: number
  semanticScore: number
  /** Okapi BM25 score for the lexical leg. Absent when scored outside retrieval. */
  bm25?: number
}

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
  scoreBreakdown: RetrievalScore
  /**
   * The score the RERANKER gave this chunk, when a reranker ran.
   *
   * WHY THIS EXISTS. MEASURED IN UAT: `POST /api/documents/search` returned scores in the order
   * `[0.3333, 1, 0.5, 0.1111]` — clearly not descending — while the Chat UI labelled the same list
   * "Match #1, #2, #3…". The cause was not a missing sort: `dispatchRerank` DOES order the array by the LLM's
   * relevance judgement, but it reuses the retrieved objects unchanged, so each chunk still carried its RETRIEVAL
   * score. The array order and the `score` field therefore described two different rankings, and a reader had no way
   * to tell which one the product was using. The best-matching chunk appeared as "Match #3".
   *
   * `score` is deliberately NOT overwritten: `citation-trail.ts` derives a relevance number from it and `hyde.ts`
   * plus `intent-pipeline.ts` dedupe by comparing it, so replacing it with an LLM 0-10 would change those meanings
   * silently. The reranker's own number is recorded ALONGSIDE instead, which is what the caller needs to explain
   * the order it was given.
   */
  rerankScore?: number
  /**
   * The chunk's OWN text, without the document-level `contextPrefix` that `content` carries for retrieval and for the
   * answer prompt.
   *
   * WHY IT EXISTS. MEASURED ON PRODUCTION: every chunk of `kebijakan.txt` has a ~377-character prefix ("From
   * kebijakan.txt[HR]: <document summary>"), and a citation snippet is the first 240 characters of `content` — so all
   * three "sources" of one answer showed the SAME summary and none showed the passage that matched. `content` stays
   * prefixed (the model benefits from the context); only the human-facing snippet uses this. Absent when the chunk has
   * no prefix, in which case `content` already IS the chunk's own text.
   */
  ownContent?: string
  /**
   * 1-based position in the order actually returned, so a consumer can label "Match #N" truthfully without
   * re-deriving it from a field that may describe a different ranking.
   */
  rank?: number
  /**
   * The reranker's verdict on the endorsed set as a whole: does it hold everything the query needs? Set only when the
   * merged judge is on (RAG_MERGED_JUDGE=on) and the model answered it; the sufficiency judge then need not run.
   */
  rerankVerdict?: boolean
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
  // Prefer document diversity, then fill unused slots from capped documents.
  // A single-document corpus must still return enough evidence to answer.
  if (!Number.isFinite(topK) || topK < 1) return []
  topK = Math.floor(topK)
  const sorted = sortRetrievedChunks(rows)
  const selected: T[] = []
  const perDocument = new Map<string, number>()
  const deferred: T[] = []

  for (const row of sorted) {
    const count = perDocument.get(row.documentId) ?? 0
    if (count >= maxPerDocument) {
      // Hold it back, but do not throw it away: it becomes eligible if no fresh document can fill the slot.
      deferred.push(row)
      continue
    }
    selected.push(row)
    perDocument.set(row.documentId, count + 1)
    if (selected.length >= topK) return selected
  }

  for (const row of deferred) {
    if (selected.length >= topK) break
    selected.push(row)
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
