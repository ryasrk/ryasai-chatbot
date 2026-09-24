export function chatShellGridClass() {
  return 'md:grid-cols-[auto_minmax(0,1fr)]'
}

export function chatSessionPanelWidthClass(sessionRailCollapsed: boolean) {
  return sessionRailCollapsed
    ? 'md:w-12'
    : 'md:w-[clamp(200px,18vw,260px)]'
}

export function citationDetailLabel(type: string) {
  return type === 'DATABASE' ? 'View SQL query' : 'View source details'
}

/**
 * The badge on a retrieved document citation.
 *
 * WHY NOT A PERCENTAGE. `Citation.score` is the FUSED RRF value
 * (`rag-retrieval.ts`), not a similarity: RRF sums `1 / (k + rank)` across
 * retrievers, so a document found by both legs at rank 1 scores 0.0328 and the best
 * possible result renders as "3%". It is meaningless as a percentage at any `k` — at
 * k=1 the same document would read "100%", turning an ordinal position into an
 * apparent confidence. The rows that DO mean something as a percentage
 * (`scoreBreakdown.semanticSimilarity`, `bm25`) are not what this field carries.
 *
 * So the badge reports what the number actually is: the rank the document came back
 * at. `idx` is 0-based, and this takes it directly rather than deriving a position
 * from `score`, because equal fused scores are ordered by the caller and the score
 * alone cannot recover the position.
 *
 * Returns null when the citation carries no score, so an unranked citation (a
 * DATABASE row, which has no `score`) renders no badge rather than "Match #0".
 */
export function citationRankLabel(idx: number, score: number | undefined | null): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  return `Match #${idx + 1}`
}
