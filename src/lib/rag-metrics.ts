/**
 * Retrieval metrics — the baseline a ranking change is judged against.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `docs/retrieval-production-integration-plan.md` §4b: before changing what orders
 * results, there has to be a way to see what the current ordering COSTS. Without a
 * pre-change baseline, a regression after a ranking change cannot be told apart from
 * normal variation, and the inherited 50 ms latency budget has no production
 * counterpart to compare against.
 *
 * WHY THE REGISTRATION IS PER-CALL RATHER THAN AT MODULE LOAD
 * ----------------------------------------------------------------------------
 * `metrics.ts` drops a sample when the metric was never registered (`inc`/`observe`
 * return early), and registration today happens either in `initMetrics()` — called
 * from the `/api/metrics` route module — or nowhere. So a metric registered only in
 * that function is silently inert whenever retrieval runs before the scrape route
 * has ever been loaded, which on a fresh process is every request until the first
 * scrape. Registering inside each helper costs one map lookup and removes that whole
 * class of "the dashboard is empty and nothing errors".
 *
 * LABELS
 * ----------------------------------------------------------------------------
 * Series are labelled with the ranking version (`RANKING_VERSION` in rag-retrieval.ts),
 * one value per deployed ranking, so a before/after comparison across a ranking change
 * is readable in one panel.
 */
// A NAMESPACE import, not named imports, on purpose. `metrics.ts` is mocked in other
// test files with a partial surface (e.g. only `inc`/`observe`), and a named import of
// something the mock omits throws at MODULE-EVALUATION time:
//
//   Export named 'counter' not found in module 'src/lib/metrics.ts'
//
// That error is invisible to the test that causes it and surfaces as an unrelated file
// failing intermittently, depending on which files the runner schedules together.
// Measured while adding this module: `tool-branches.test.ts` failed in one full-suite
// run and passed alone on five consecutive runs. With a namespace import a missing
// name is simply `undefined`, so the optional calls below degrade to a no-op instead.
//
// Observability must never be able to break the feature it observes: dropping a sample
// is always preferable to failing a retrieval.
import * as metrics from './metrics'

/** Sub-second retrieval is the normal case; the tail matters more than the head. */
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]

export const RAG_LATENCY_METRIC = 'rag_retrieval_latency_ms'
export const RAG_CANDIDATES_METRIC = 'rag_retrieval_candidates'
export const RAG_RESULTS_METRIC = 'rag_retrieval_results'
export const RAG_CACHE_HIT_METRIC = 'rag_cache_hit_total'
export const RAG_CACHE_MISS_METRIC = 'rag_cache_miss_total'

/**
 * A completed retrieval, from the caller's point of view.
 *
 * A CACHE HIT MUST NOT CALL THIS. A hit does no retrieval work, so recording its
 * (near-zero) duration in the same histogram as a real retrieval drags the p50 down
 * in proportion to the hit rate — the busier the cache, the faster retrieval would
 * appear to get, without anything getting faster. Hits are counted separately below.
 */
export function recordRetrievalTiming(args: {
  ms: number
  rankingVersion: string
  candidatesScanned: number
  returned: number
}): void {
  const labels = { ranking: args.rankingVersion }
  // Optional calls (`?.`) because a mocked `metrics` may omit any of these.
  metrics.histogram?.(
    RAG_LATENCY_METRIC,
    'RAG retrieval duration in milliseconds, excluding cache hits',
    LATENCY_BUCKETS_MS,
  )
  metrics.observe?.(RAG_LATENCY_METRIC, args.ms, labels)
  metrics.histogram?.(
    RAG_CANDIDATES_METRIC,
    'Candidate chunks scanned per RAG retrieval',
    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  )
  metrics.observe?.(RAG_CANDIDATES_METRIC, args.candidatesScanned, labels)
  metrics.histogram?.(RAG_RESULTS_METRIC, 'Chunks returned per RAG retrieval', [0, 1, 2, 4, 8, 12, 20, 50])
  metrics.observe?.(RAG_RESULTS_METRIC, args.returned, labels)
}

/** One cache read. A miss is counted too — the ratio is the useful signal. */
export function recordRetrievalCache(hit: boolean): void {
  const metric = hit
    ? { name: RAG_CACHE_HIT_METRIC, help: 'RAG retrievals served from cache' }
    : { name: RAG_CACHE_MISS_METRIC, help: 'RAG retrievals that ran the retrievers' }
  // `counter()` registers (idempotent) and `inc` records the sample. Both are needed:
  // `inc` on an unregistered metric is a silent no-op, which is the failure mode this
  // module exists to avoid. Both are optional calls so a partial mock cannot throw.
  metrics.counter?.(metric.name, metric.help)
  metrics.inc?.(metric.name)
}
