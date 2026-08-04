/**
 * RAG evaluation — golden-set scoring plus the IR metrics needed to tell whether
 * a retrieval change actually helped.
 *
 * Ranking changes are not eyeball-verifiable: a change that fixes 8 queries and
 * breaks 5 looks like an improvement in every example you happen to check. This
 * is the only way to answer "did BM25 + RRF make it better?".
 *
 * WHAT TO MEASURE
 *   recall@k    — did the right document reach the pool at all? Retrieval's job.
 *                 If recall is low, no reranker can rescue it.
 *   precision@k — how much of what we returned was relevant? Prompt noise.
 *   MRR         — how high was the FIRST relevant hit? Models weight early
 *                 context most, so rank 1 vs rank 5 matters at equal recall.
 *   grounded    — did the expected text actually reach the context window?
 */

export interface RagEvalCase {
  question: string
  /** Substring of the expected document name. Legacy single-source form. */
  expectedSource?: string
  /** Substring that must appear in the retrieved text for the answer to be grounded. */
  expectedText?: string
  /**
   * Document-name substrings that count as relevant. Preferred over
   * expectedSource — recall is meaningless with only one known answer.
   */
  relevantSources?: string[]
}

export interface RagEvalResult {
  ok: boolean
  grounded: boolean
  latencyMs: number
  topSource?: string
  topScore?: number
  /** Fraction of this question's relevant sources that were retrieved. */
  recall?: number
  /** Fraction of returned chunks belonging to a relevant source. */
  precision?: number
  /** 1/rank of the first relevant hit, 0 if none. */
  reciprocalRank?: number
}

export interface RagEvalSummary {
  total: number
  precisionAtK: number
  recallAtK: number
  mrr: number
  groundedRate: number
  avgLatencyMs: number
}

export function summarizeRagEval(results: RagEvalResult[]): RagEvalSummary {
  const total = Math.max(1, results.length)
  return {
    total: results.length,
    // Kept as the hit-rate (share of questions that found something relevant) so
    // existing callers do not silently change meaning.
    precisionAtK: round(results.filter((result) => result.ok).length / total),
    recallAtK: round(mean(results.map((r) => r.recall))),
    mrr: round(mean(results.map((r) => r.reciprocalRank))),
    groundedRate: round(results.filter((result) => result.grounded).length / total),
    avgLatencyMs: Math.round(
      results.reduce((sum, result) => sum + result.latencyMs, 0) / total,
    ),
  }
}

export function isGrounded(content: string, expectedText?: string): boolean {
  if (!expectedText?.trim()) return true
  return content.toLowerCase().includes(expectedText.trim().toLowerCase())
}

/** Relevant-source list for a case, tolerating the legacy single-source field. */
export function relevantSourcesFor(testCase: RagEvalCase): string[] {
  const sources = testCase.relevantSources?.length
    ? testCase.relevantSources
    : testCase.expectedSource
      ? [testCase.expectedSource]
      : []
  return sources.map((s) => s.trim().toLowerCase()).filter(Boolean)
}

function isRelevant(documentName: string, relevant: string[]): boolean {
  const name = documentName.toLowerCase()
  return relevant.some((source) => name.includes(source))
}

/**
 * Score one question's retrieved chunks against its expected sources.
 * `retrieved` MUST be in rank order — MRR depends on it.
 */
export function scoreRetrieval(
  retrieved: Array<{ documentName: string }>,
  relevant: string[],
): { recall: number; precision: number; reciprocalRank: number; hit: boolean } {
  if (relevant.length === 0) {
    // No labelled sources: the only honest statement is whether anything came
    // back. Leave the ranking metrics at 0 rather than inventing 1.0s that would
    // inflate the summary.
    return { recall: 0, precision: 0, reciprocalRank: 0, hit: retrieved.length > 0 }
  }
  if (retrieved.length === 0) {
    return { recall: 0, precision: 0, reciprocalRank: 0, hit: false }
  }

  const matchedSources = new Set<string>()
  let relevantCount = 0
  let firstRelevantRank = 0

  retrieved.forEach((chunk, index) => {
    if (!isRelevant(chunk.documentName, relevant)) return
    relevantCount += 1
    if (firstRelevantRank === 0) firstRelevantRank = index + 1
    for (const source of relevant) {
      if (chunk.documentName.toLowerCase().includes(source)) matchedSources.add(source)
    }
  })

  return {
    recall: matchedSources.size / relevant.length,
    precision: relevantCount / retrieved.length,
    reciprocalRank: firstRelevantRank === 0 ? 0 : 1 / firstRelevantRank,
    hit: relevantCount > 0,
  }
}

/**
 * Is variant B better than variant A? Lets a retrieval change be accepted or
 * rejected on evidence instead of vibes.
 *
 * ponytail: a plain threshold, not a significance test — a 20-50 case golden set
 * has no statistical power for one, and pretending otherwise is worse than an
 * honest "moved by X". Ceiling: paired bootstrap over per-question scores once
 * the set reaches a few hundred cases.
 */
export function compareRagEval(
  before: RagEvalSummary,
  after: RagEvalSummary,
  minDelta = 0.02,
): { verdict: 'better' | 'worse' | 'inconclusive'; deltas: Record<string, number> } {
  const deltas = {
    recallAtK: round(after.recallAtK - before.recallAtK),
    mrr: round(after.mrr - before.mrr),
    groundedRate: round(after.groundedRate - before.groundedRate),
    precisionAtK: round(after.precisionAtK - before.precisionAtK),
  }
  // Recall and MRR are the retrieval-quality signals; the rest is context.
  const primary = deltas.recallAtK + deltas.mrr
  if (primary >= minDelta) return { verdict: 'better', deltas }
  if (primary <= -minDelta) return { verdict: 'worse', deltas }
  return { verdict: 'inconclusive', deltas }
}

function mean(values: Array<number | undefined>): number {
  const present = values.filter((v): v is number => typeof v === 'number')
  if (present.length === 0) return 0
  return present.reduce((sum, v) => sum + v, 0) / present.length
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
