/**
 * Frozen contract for the retrieval-arm benchmark (see docs/entity-hop-retrieval-plan.md).
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * Several arms are implemented in parallel and compared against each other. If each
 * arm invents its own corpus shape, its own split, or its own notion of "budget", the
 * comparison silently measures the difference between two harnesses instead of the
 * difference between two retrievers. Every arm therefore consumes these types and
 * nothing else, and the split is computed here rather than in each arm.
 *
 * Scope: offline. No DB, no org context, no network other than a local embedding
 * fixture that produces a committed cache file. Each arm is a pure function from a
 * question to a ranked document-id list.
 */

export type Tier = 'easy' | 'medium' | 'hard' | 'complex'

/** One benchmark question, as produced by cognee-question-gen.ts. */
export interface ArmQuestion {
  id: string
  tier: Tier
  question: string
  answer: string
  /** The exact documents a correct retriever must return. Grading is all-or-nothing on this set. */
  evidenceDocIds: string[]
}

export interface ArmCorpusDoc {
  id: string
  text: string
}

/**
 * Inputs every arm may read. `embeddings` is absent when no vector cache exists —
 * an arm that needs it must report NOT COMPUTABLE rather than inventing vectors.
 */
export interface ArmContext {
  /** docId -> text. */
  texts: Record<string, string>
  /** Stable document order, so "top-k" is reproducible. */
  docIds: string[]
  /** docId -> vector, from the committed cache. Present only for vector arms. */
  embeddings?: Record<string, number[]>
  /** Model name that produced `embeddings`, for the report. */
  embeddingModel?: string
  /**
   * Question text -> vector, same model and same unit norm as `embeddings`.
   *
   * This exists because `rank()` receives the question as a STRING, so a vector arm
   * cannot compute cosine top-k from document vectors alone. Embedding the question
   * inside `rank()` would put a network call inside the timed region and make the
   * 50 ms latency budget meaningless, so query vectors are precomputed offline and
   * committed exactly like document vectors.
   *
   * A missing entry is a hard error, never a silent fall back to lexical: a hybrid
   * row labelled hybrid that actually ran lexical-only is the defect this benchmark
   * exists to catch.
   */
  queryEmbeddings?: Record<string, number[]>
  /** Model name for `queryEmbeddings`. Must equal `embeddingModel`. */
  queryEmbeddingModel?: string
}

export interface ScoredDoc {
  docId: string
  score: number
}

/**
 * An arm is one retriever. `rank` returns doc ids, best first, at most `budget`
 * long. It must be deterministic: the same question and context always give the
 * same list, in the same order.
 */
export interface Arm {
  readonly id: string
  readonly kind: 'lexical' | 'vector' | 'hybrid' | 'entity-hop'
  /** False when a required input is missing; the harness then reports NOT COMPUTABLE. */
  ready(ctx: ArmContext): boolean
  rank(question: string, ctx: ArmContext, budget: number): string[]
}

/**
 * Every arm is graded at the same window. 10 matches the recorded cognee and
 * supermemory runs, so any row added later stays comparable to them.
 */
export const ARM_BUDGET = 10

/**
 * Dev/held-out split, fixed here so no arm can choose its own. Tuning reads dev
 * only; every reported number in the plan is produced on held-out.
 *
 * SPLIT BY DISTINCT QUESTION TEXT, NOT BY ROW INDEX.
 * ----------------------------------------------------------------------------
 * The generated set has 1000 rows but only 569 distinct question TEXTS: the
 * template plus a repeated start entity produces the same sentence for different
 * chains (e.g. "Starting from W-01, follow two intermediate records: which serial
 * is reached at the end of that chain?" appears 9 times over 9 different evidence
 * sets). An index-parity split therefore puts the SAME SENTENCE on both sides —
 * measured: 146 of 569 texts straddle the split — so a "held-out" score would be
 * partly a memorisation score, and the identical rows also masquerade as extra
 * statistical power.
 *
 * Grouping by text and alternating GROUPS keeps the two halves text-disjoint.
 * Ties are resolved by first occurrence, so the result is reproducible from the
 * committed file order alone.
 *
 * Note that the same text can also carry DIFFERENT evidence sets (353 of the 431
 * duplicate rows do). A retriever cannot satisfy both from one ranking, so those
 * rows cap the achievable score. That is a generator defect, reported by
 * `duplicateStats()` rather than hidden by this function.
 */
export function splitQuestions(questions: ArmQuestion[]): { dev: ArmQuestion[]; heldOut: ArmQuestion[] } {
  const groups = new Map<string, ArmQuestion[]>()
  for (const q of questions) {
    const group = groups.get(q.question)
    if (group) group.push(q)
    else groups.set(q.question, [q])
  }

  const dev: ArmQuestion[] = []
  const heldOut: ArmQuestion[] = []
  // Map iteration follows insertion order, which follows the committed file, so
  // the assignment is stable across runs and across machines.
  let groupIndex = 0
  for (const group of groups.values()) {
    const target = groupIndex % 2 === 0 ? dev : heldOut
    target.push(...group)
    groupIndex += 1
  }
  return { dev, heldOut }
}

/** Duplicate-text statistics, so the generator defect is visible in every report. */
export function duplicateStats(questions: ArmQuestion[]): {
  rows: number
  distinctTexts: number
  collapsedRows: number
  /** Rows sharing a text whose evidence sets disagree — unsatisfiable from one ranking. */
  conflictingRows: number
  /** Distinct texts present on both sides of the split. Must be 0. */
  straddlingTexts: number
} {
  const groups = new Map<string, ArmQuestion[]>()
  for (const q of questions) {
    const group = groups.get(q.question)
    if (group) group.push(q)
    else groups.set(q.question, [q])
  }

  let conflictingRows = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const evidence = new Set(group.map((q) => q.evidenceDocIds.join('|')))
    if (evidence.size > 1) conflictingRows += group.length
  }

  const { dev, heldOut } = splitQuestions(questions)
  const devTexts = new Set(dev.map((q) => q.question))
  const straddlingTexts = new Set(heldOut.map((q) => q.question).filter((t) => devTexts.has(t))).size

  return {
    rows: questions.length,
    distinctTexts: groups.size,
    collapsedRows: questions.length - groups.size,
    conflictingRows,
    straddlingTexts,
  }
}

/** Tier-level and overall aggregates a harness reports for one arm. */
export interface ArmMetrics {
  arm: string
  kind: Arm['kind']
  /** Scope the numbers were computed on: 'all' | 'dev' | 'held-out'. */
  scope: string
  perTier: Record<string, TierMetric>
  overall: TierMetric
}

export interface TierMetric {
  n: number
  recall5: number
  recall10: number
  answerAt1: number
  mrr: number
  /**
   * Mean share of each question's evidence documents present in the top-k. A
   * 3-hop question that finds 2 of 3 documents scores 0.67 here and 0 on recall.
   * This is what shows whether an arm is short by one hop or missing entirely.
   */
  evidenceCoverage: number
  /**
   * Per-hop recall: share of questions whose hop h document was found, averaged.
   * hopRecall[0] is the first hop. Missing hops are not counted; short chains
   * simply have shorter arrays.
   */
  hopRecall: number[]
  latencyP50Ms: number
  latencyP90Ms: number
}

/** Loads the committed corpus and question set. */
export interface BenchmarkData {
  corpus: ArmContext
  questions: ArmQuestion[]
}

/**
 * Entity-Hop tuning knobs. Fixed here so the ablation runner and the arm agree on
 * the option names; the values are the plan's defaults, to be tuned on the DEV
 * split only.
 */
export interface EntityHopOptions {
  /** How many fused top documents seed the entity frontier. */
  seedSize: number
  /** Maximum hop depth. 2 covers medium; 3 reaches the 3-hop hard tier. */
  maxHops: number
  /** Entities appearing in more documents than this are hubs, not bridges. */
  maxDocumentFrequency: number
  /** Contribution of a hop hit is multiplied by this per additional hop. */
  decay: number
}

export const ENTITY_HOP_DEFAULTS: EntityHopOptions = {
  seedSize: 4,
  maxHops: 2,
  maxDocumentFrequency: 60,
  decay: 0.5,
}

/**
 * The options that turn individual Entity-Hop components off, so each one has to
 * earn its place by moving recall. `off: true` means the component is disabled.
 */
export interface EntityHopAblation extends EntityHopOptions {
  /** Disable the rarity weight: every bridging entity counts the same. */
  disableRarityWeight?: boolean
  /** Disable the hub cutoff: entities in many documents are used as bridges. */
  disableHubCutoff?: boolean
  /** Disable negation skipping. */
  disableNegation?: boolean
}

/**
 * Frozen export surface of `benchmark/arms/entity-hop-arm.ts`.
 *
 * The arm and its ablation runner are written in parallel, so the factory is fixed
 * here: the runner builds variants from the SAME code path the shipped arm uses, by
 * passing options. Two separate implementations would make an ablation measure the
 * difference between two files instead of the effect of one component.
 *
 * `makeEntityHopArm()` with no options must be equivalent to the exported `arm`.
 */
export type EntityHopArmFactory = (opts?: Partial<EntityHopAblation>) => Arm
