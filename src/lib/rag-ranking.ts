/**
 * Lexical ranking (Okapi BM25) + rank fusion (Reciprocal Rank Fusion).
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Retrieval used to rank with:
 *
 *   lexical = contentHits + keywordHits*2 + phraseHits*3      // unbounded count
 *   total   = lexical + cosineSimilarity*12                   // capped at 12
 *
 * Two things are wrong with that. Raw term counts have no IDF (a hit on "the
 * policy" counts the same as a hit on "npwp") and no length normalisation (a
 * long chunk wins by volume). And adding an unbounded integer to a 0-12 float
 * means the lexical leg dominates: for a 4-token query, phrase hits alone can
 * contribute 18, so cosine similarity is a tiebreaker rather than a ranking
 * signal — "hybrid search" that is really keyword search with a nudge.
 *
 * BM25 fixes the first. RRF fixes the second by fusing on RANK instead of
 * score, so retrievers with incommensurable scales combine without any
 * hand-tuned weight. Both are pure functions over ids, which also makes adding
 * a fourth retriever a one-line change at the call site.
 */

// Standard Okapi parameters. k1 controls term-frequency saturation, b controls
// how strongly length normalisation applies.
const K1 = 1.2
const B = 0.75

export interface Bm25Doc {
  id: string
  /** Tokenised text, already lowercased/stopworded by rag.tokenize. Duplicates matter. */
  tokens: string[]
}

export interface RankedId {
  id: string
  score: number
}

/**
 * Score `docs` against `queryTokens` with Okapi BM25, best first.
 *
 * ponytail: IDF is computed over the CANDIDATE POOL, not the whole corpus — no
 * extra query, no df bookkeeping, and within a pool the relative rarity of a
 * term is what decides the ordering anyway. Ceiling: a term common in the pool
 * but rare corpus-wide gets under-weighted. Upgrade to real corpus df (one
 * grouped count query per search, or a maintained stats table) if evaluation
 * shows pool-local IDF mis-ranking.
 */
export function bm25Rank(queryTokens: string[], docs: Bm25Doc[]): RankedId[] {
  if (queryTokens.length === 0 || docs.length === 0) return []

  const n = docs.length
  const lengths = docs.map((doc) => doc.tokens.length)
  const avgdl = lengths.reduce((sum, len) => sum + len, 0) / n || 1

  // Term frequency per doc + document frequency per query term, in one pass.
  const uniqueQueryTokens = [...new Set(queryTokens)]
  const termFreqs: Array<Map<string, number>> = docs.map((doc) => {
    const freq = new Map<string, number>()
    for (const token of doc.tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
    return freq
  })

  const docFreq = new Map<string, number>()
  for (const token of uniqueQueryTokens) {
    let df = 0
    for (const freq of termFreqs) if (freq.has(token)) df += 1
    docFreq.set(token, df)
  }

  const scored: RankedId[] = docs.map((doc, index) => {
    const freq = termFreqs[index]
    const docLength = lengths[index] || 1
    let score = 0
    for (const token of uniqueQueryTokens) {
      const tf = freq.get(token) ?? 0
      if (tf === 0) continue
      const df = docFreq.get(token) ?? 0
      // Smoothed IDF — the +0.5 terms keep it positive even when every doc in
      // the pool contains the term (the unsmoothed form goes negative there).
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      const denom = tf + K1 * (1 - B + (B * docLength) / avgdl)
      score += idf * ((tf * (K1 + 1)) / denom)
    }
    return { id: doc.id, score }
  })

  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 *   fused(d) = Σ over retrievers  1 / (k + rank(d))
 *
 * `rankings` is a list of ordered id lists, best first. A document missing from
 * a retriever simply contributes nothing for it — no imputation, no penalty.
 *
 * k dampens the head so a single retriever's #1 cannot run away with the result;
 * 60 is the value from the paper and the de-facto default in Elasticsearch and
 * Vespa. Absolute fused scores are tiny (~0.016 for a lone rank-1 hit) and only
 * meaningful relative to each other — never mix them with a raw score.
 */
export const RRF_K = 60

export function fuseRankings(rankings: string[][], k: number = RRF_K): RankedId[] {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // rank is 1-based; index 0 is the top hit.
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/** Ids of a scored list in rank order — the shape fuseRankings consumes. */
export function toRanking(scored: RankedId[]): string[] {
  return scored.map((entry) => entry.id)
}
