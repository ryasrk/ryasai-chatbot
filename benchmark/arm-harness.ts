/**
 * Shared harness for every retrieval arm (see docs/entity-hop-retrieval-plan.md).
 *
 * WHY THIS IS ONE FILE AND NOT PART OF EACH ARM
 * ----------------------------------------------------------------------------
 * Arms are implemented in parallel and then compared. If each arm graded itself,
 * a difference between two rows could come from the grader rather than the
 * retriever. Loading, splitting, grading and rendering therefore live here, and an
 * arm is only a `rank(question, ctx, budget)` function (see arm-types.ts).
 *
 * It runs entirely offline: the corpus and the questions are committed under
 * benchmark/data/, and vectors come from a committed cache. No DB, no org context.
 *
 * Usage:
 *   bun benchmark/arm-harness.ts --arm=bm25-baseline
 *   bun benchmark/arm-harness.ts                     # every registered arm
 */
import { readFileSync } from 'node:fs'
import type { Arm, ArmContext, ArmMetrics, ArmQuestion, BenchmarkData, TierMetric } from './arm-types'
import { ARM_BUDGET, duplicateStats, splitQuestions } from './arm-types'
import { buildIndex, topK } from './cognee-bm25-baseline'

export const DEFAULT_CORPUS = 'benchmark/data/cognee-1000-corpus.json'
export const DEFAULT_QUESTIONS = 'benchmark/data/cognee-1000-questions.jsonl'
export const DEFAULT_EMBEDDING_CACHE = 'benchmark/data/cognee-1000-embeddings.json'
export const DEFAULT_QUERY_EMBEDDING_CACHE = 'benchmark/data/cognee-1000-question-embeddings.json'

export function argOf(name: string, fallback: string | null = null): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/**
 * Load the committed corpus and question set, plus the vector cache when it exists.
 *
 * The cache is optional on purpose: an arm that needs vectors must report NOT
 * COMPUTABLE when it is missing, rather than silently degrading to lexical and
 * being reported as a vector result.
 */
export function loadBenchmarkData(
  corpusPath = DEFAULT_CORPUS,
  questionsPath = DEFAULT_QUESTIONS,
  embeddingCachePath = DEFAULT_EMBEDDING_CACHE,
  queryEmbeddingCachePath = process.env.BENCH_QUERY_EMBEDDINGS ?? DEFAULT_QUERY_EMBEDDING_CACHE,
): BenchmarkData {
  const corpusRaw = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
    docs: Array<{ id: string; text: string }>
  }
  const questions = readFileSync(questionsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArmQuestion)

  const texts: Record<string, string> = {}
  const docIds: string[] = []
  for (const doc of corpusRaw.docs) {
    texts[doc.id] = doc.text
    docIds.push(doc.id)
  }

  const corpus: ArmContext = { texts, docIds }

  try {
    const cache = JSON.parse(readFileSync(embeddingCachePath, 'utf8')) as {
      model: string
      dimensions: number
      vectors: Record<string, number[]>
    }
    corpus.embeddings = cache.vectors
    corpus.embeddingModel = cache.model
  } catch {
    // No cache: vector arms report NOT COMPUTABLE. Never invent vectors.
  }

  try {
    const cache = JSON.parse(readFileSync(queryEmbeddingCachePath, 'utf8')) as {
      model: string
      dimensions: number
      vectors: Record<string, number[]>
    }
    corpus.queryEmbeddings = cache.vectors
    corpus.queryEmbeddingModel = cache.model
    // A query cache built by a different model than the document cache would make
    // every cosine meaningless while still producing a plausible-looking number.
    if (corpus.embeddingModel && cache.model !== corpus.embeddingModel) {
      throw new Error(
        `query embedding model "${cache.model}" does not match document embedding model "${corpus.embeddingModel}"`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match')) throw error
    // Missing file: vector arms report NOT COMPUTABLE rather than running lexical-only.
  }

  return { corpus, questions }
}

/**
 * Keep only the FIRST row per distinct question text.
 *
 * The generated set repeats a sentence across different evidence sets (1000 rows,
 * 569 texts). A retriever cannot satisfy two different evidence sets from a single
 * ranking, so the repeated rows cap the achievable score. Deduplicating makes the
 * measurable ceiling 1.0 and is the honest way to report recall on this corpus.
 * The raw (non-deduplicated) number stays available for comparison.
 */
export function dedupeByText(questions: ArmQuestion[]): ArmQuestion[] {
  const seen = new Set<string>()
  const out: ArmQuestion[] = []
  for (const q of questions) {
    if (seen.has(q.question)) continue
    seen.add(q.question)
    out.push(q)
  }
  return out
}

/** 1-based rank of the question's final hop document, or 0 when absent. */
export function finalHopRank(ranked: string[], evidenceDocIds: string[]): number {
  const finalDoc = evidenceDocIds[evidenceDocIds.length - 1]
  const index = ranked.indexOf(finalDoc)
  return index < 0 ? 0 : index + 1
}

/** Every evidence document must be inside the top-k, not merely one of them. */
export function evidenceHitAtK(ranked: string[], evidenceDocIds: string[], k: number): boolean {
  const window = new Set(ranked.slice(0, k))
  return evidenceDocIds.every((id) => window.has(id))
}

/** Share of evidence documents found in the top-k. Partial credit, for diagnosis only. */
export function evidenceCoverageAtK(ranked: string[], evidenceDocIds: string[], k: number): number {
  if (evidenceDocIds.length === 0) return 1
  const window = new Set(ranked.slice(0, k))
  return evidenceDocIds.filter((id) => window.has(id)).length / evidenceDocIds.length
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

/**
 * Grade one arm over one question scope.
 *
 * Latency is measured here rather than inside the arm so every row is timed the
 * same way. It is retrieval-only: no LLM, no embedding call for the query (the
 * arms take their vectors from the cache).
 */
export function gradeArm(
  arm: Arm,
  questions: ArmQuestion[],
  ctx: ArmContext,
  scope: string,
  budget = ARM_BUDGET,
): ArmMetrics {
  const perTier = new Map<string, Array<{
    hit5: boolean
    hit10: boolean
    answerAt1: boolean
    rr: number
    coverage: number
    hopHits: boolean[]
    ms: number
  }>>()

  const maxHops = Math.max(...questions.map((q) => q.evidenceDocIds.length), 1)

  // Warm-up, not counted. An arm that builds its index lazily would otherwise put
  // that cost inside whichever question happens to be first, and the plan's 50 ms
  // budget is about steady-state retrieval. Production builds its index in the
  // database too, so counting construction here would overstate the arm's latency.
  // Arms are required to be deterministic, so the discarded result costs nothing.
  if (questions.length > 0) arm.rank(questions[0].question, ctx, budget)

  for (const question of questions) {
    const started = performance.now()
    const ranked = arm.rank(question.question, ctx, budget)
    const ms = performance.now() - started

    const rank = finalHopRank(ranked, question.evidenceDocIds)
    const window = new Set(ranked.slice(0, budget))
    const row = {
      hit5: evidenceHitAtK(ranked, question.evidenceDocIds, 5),
      hit10: evidenceHitAtK(ranked, question.evidenceDocIds, budget),
      answerAt1: rank === 1,
      rr: rank > 0 ? 1 / rank : 0,
      coverage: evidenceCoverageAtK(ranked, question.evidenceDocIds, budget),
      hopHits: question.evidenceDocIds.map((id) => window.has(id)),
      ms,
    }
    const list = perTier.get(question.tier)
    if (list) list.push(row)
    else perTier.set(question.tier, [row])
  }

  const toMetric = (rows: NonNullable<ReturnType<typeof perTier.get>>): TierMetric => {
    const hopRecall: number[] = []
    for (let hop = 0; hop < maxHops; hop++) {
      const withHop = rows.filter((r) => r.hopHits.length > hop)
      if (withHop.length === 0) break
      hopRecall.push(mean(withHop.map((r) => (r.hopHits[hop] ? 1 : 0))))
    }
    const latencies = rows.map((r) => r.ms)
    return {
      n: rows.length,
      recall5: mean(rows.map((r) => (r.hit5 ? 1 : 0))),
      recall10: mean(rows.map((r) => (r.hit10 ? 1 : 0))),
      answerAt1: mean(rows.map((r) => (r.answerAt1 ? 1 : 0))),
      mrr: mean(rows.map((r) => r.rr)),
      evidenceCoverage: mean(rows.map((r) => r.coverage)),
      hopRecall,
      latencyP50Ms: Math.round(percentile(latencies, 50) * 1000) / 1000,
      latencyP90Ms: Math.round(percentile(latencies, 90) * 1000) / 1000,
    }
  }

  const tiers = ['easy', 'medium', 'hard', 'complex']
  const metrics: Record<string, TierMetric> = {}
  for (const tier of tiers) {
    const rows = perTier.get(tier)
    if (rows?.length) metrics[tier] = toMetric(rows)
  }
  const allRows = [...perTier.values()].flat()

  return {
    arm: arm.id,
    kind: arm.kind,
    scope,
    perTier: metrics,
    overall: toMetric(allRows),
  }
}

/** Table renderer, so every arm's row is printed by the same code. */
export function renderArmMetrics(metrics: ArmMetrics[]): string {
  const lines: string[] = []
  lines.push('| arm | scope | tier | n | recall@5 | recall@10 | answer@1 | MRR | coverage | p50 ms |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const m of metrics) {
    const rows: Array<[string, TierMetric]> = [
      ...Object.entries(m.perTier),
      ['ALL', m.overall],
    ]
    for (const [tier, t] of rows) {
      lines.push(
        `| ${m.arm} | ${m.scope} | ${tier} | ${t.n} | ${t.recall5.toFixed(4)} | ${t.recall10.toFixed(4)} | ` +
          `${t.answerAt1.toFixed(4)} | ${t.mrr.toFixed(4)} | ${t.evidenceCoverage.toFixed(4)} | ${t.latencyP50Ms.toFixed(2)} |`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Arm registry. Each entry is a module that exports an `arm` satisfying arm-types.ts.
 *
 * A module that does not exist yet is REPORTED, not skipped and not stubbed. A stub
 * exporting a low score would be indistinguishable from a real retriever that
 * performs badly, which is the failure mode this whole benchmark exists to avoid.
 */
const ARM_MODULES: Array<{ file: string; id: string }> = [
  { file: './arms/hybrid-arm', id: 'lexical-first-hybrid' },
  { file: './arms/entity-hop-arm', id: 'entity-hop' },
]

export async function loadAllArms(): Promise<{ arms: Arm[]; missing: string[] }> {
  // The lexical baseline ships with the harness: it is the reference every other
  // arm is measured against, so it must never be absent from a comparison run.
  const arms: Arm[] = [bm25BaselineArm]
  const missing: string[] = []
  for (const entry of ARM_MODULES) {
    try {
      const mod = (await import(entry.file)) as { arm?: Arm }
      if (mod.arm) arms.push(mod.arm)
      else missing.push(`${entry.id} (module has no \`arm\` export)`)
    } catch (error) {
      missing.push(`${entry.id} (${error instanceof Error ? error.message.split('\n')[0] : 'import failed'})`)
    }
  }
  return { arms, missing }
}

export interface RunOptions {
  corpusPath?: string
  questionsPath?: string
  embeddingCachePath?: string
  queryEmbeddingCachePath?: string
  /** 'held-out' (default, reported) | 'dev' (tuning only) | 'all'. */
  scope?: string
  /**
   * Collapse repeated question texts to one row each. Default false so the raw
   * number is what a caller gets unless it asks otherwise; `--dedupe=text` on the
   * CLI and the harness banner both make the choice visible.
   */
  dedupe?: boolean
}

/** Grade every ready arm on the requested split and return the numbers. */
export async function runArms(
  arms: Arm[],
  opts: RunOptions = {},
): Promise<{
  metrics: ArmMetrics[]
  notComputable: string[]
  ctx: ArmContext
  n: Record<string, number>
  duplicates: ReturnType<typeof duplicateStats>
  deduped: boolean
}> {
  const data = loadBenchmarkData(opts.corpusPath, opts.questionsPath, opts.embeddingCachePath, opts.queryEmbeddingCachePath)
  const scope = opts.scope ?? 'held-out'
  const source = opts.dedupe ? dedupeByText(data.questions) : data.questions
  const { dev, heldOut } = splitQuestions(source)
  const questions = scope === 'dev' ? dev : scope === 'all' ? source : heldOut

  const metrics: ArmMetrics[] = []
  const notComputable: string[] = []
  for (const arm of arms) {
    if (!arm.ready(data.corpus)) {
      notComputable.push(`${arm.id} (${arm.kind})`)
      continue
    }
    metrics.push(gradeArm(arm, questions, data.corpus, scope))
  }

  return {
    metrics,
    notComputable,
    ctx: data.corpus,
    n: { dev: dev.length, heldOut: heldOut.length, all: source.length },
    duplicates: duplicateStats(data.questions),
    deduped: Boolean(opts.dedupe),
  }
}

/** The BM25 baseline, wrapped as an Arm so it grades through the same path. */
const baselineIndexCache = new Map<string, ReturnType<typeof buildIndex>>()
export function buildCachedBaselineIndex(ctx: ArmContext) {
  const key = `${ctx.docIds.length}`
  const cached = baselineIndexCache.get(key)
  if (cached) return cached
  const index = buildIndex(ctx.texts)
  baselineIndexCache.set(key, index)
  return index
}

export const bm25BaselineArm: Arm = {
  id: 'bm25-baseline',
  kind: 'lexical',
  ready: () => true,
  rank: (question, ctx, budget) => topK(buildCachedBaselineIndex(ctx), question, budget),
}

async function main(): Promise<number> {
  const only = argOf('arm')
  const scope = argOf('scope', 'held-out')!
  const out = argOf('out-json')
  const loaded = await loadAllArms()
  const arms = only ? loaded.arms.filter((a) => a.id === only) : loaded.arms
  if (only && arms.length === 0) {
    console.error(`no arm with id "${only}". Known: ${loaded.arms.map((a) => a.id).join(', ')}`)
    return 2
  }

  const dedupe = argOf('dedupe', '') === 'text'
  const { metrics, notComputable, ctx, n, duplicates, deduped } = await runArms(arms, {
    scope,
    dedupe,
    embeddingCachePath: argOf('embeddings', DEFAULT_EMBEDDING_CACHE)!,
    queryEmbeddingCachePath: argOf('query-embeddings', process.env.BENCH_QUERY_EMBEDDINGS ?? DEFAULT_QUERY_EMBEDDING_CACHE)!,
  })

  console.log(`\n=== RETRIEVAL ARMS — scope=${scope} (dev ${n.dev} / held-out ${n.heldOut}) ===`)
  const vectorState = ctx.embeddings
    ? `docs yes (${ctx.embeddingModel}) · queries ${ctx.queryEmbeddings ? 'yes' : 'NO — vector arms report NOT COMPUTABLE'}`
    : 'none (vector arms are NOT COMPUTABLE)'
  console.log(`corpus ${ctx.docIds.length} docs · budget top-${ARM_BUDGET} · vectors: ${vectorState}`)
  console.log(
    `rows ${duplicates.rows} · distinct question texts ${duplicates.distinctTexts} · ` +
      `${duplicates.collapsedRows} rows collapse onto a repeated text (${duplicates.conflictingRows} of them carry a DIFFERENT evidence set, so one ranking cannot satisfy both) · ` +
      `texts straddling the split ${duplicates.straddlingTexts} · dedupe=${deduped ? 'text' : 'off'}`,
  )
  if (duplicates.straddlingTexts > 0) {
    console.log('WARNING: the split is not text-disjoint — held-out is partly memorisation.')
  }
  console.log('')
  console.log(renderArmMetrics(metrics))
  if (loaded.missing.length) {
    console.log(`\nARMS NOT PRESENT: ${loaded.missing.join(', ')}`)
  }
  if (notComputable.length) {
    console.log(`\nNOT COMPUTABLE (missing inputs): ${notComputable.join(', ')}`)
  }
  console.log('\nPer-hop recall (first hop first) shows whether an arm is short by one hop:')
  for (const m of metrics) {
    console.log(`  ${m.arm.padEnd(18)} ${m.overall.hopRecall.map((v) => v.toFixed(3)).join(' / ') || '(none)'}`)
  }

  if (out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      out,
      JSON.stringify(
        {
          kind: 'retrieval-arms',
          generatedAt: new Date().toISOString(),
          scope,
          budget: ARM_BUDGET,
          corpus: {
            documents: ctx.docIds.length,
            embeddingModel: ctx.embeddingModel ?? null,
            queryEmbeddings: ctx.queryEmbeddings ? Object.keys(ctx.queryEmbeddings).length : 0,
          },
          counts: n,
          duplicates,
          deduped,
          armsMissing: loaded.missing,
          notComputable,
          metrics,
        },
        null,
        2,
      ),
    )
    console.log(`\nwrote ${out}`)
  }
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('harness failed:', e)
      process.exit(1)
    })
}

export { mean, percentile }
