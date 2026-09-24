/**
 * Fusion configuration — which `k` the RRF in `rag-ranking.ts` runs with.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `RRF_K = 60` is the value from Cormack et al. 2009 and the default in
 * Elasticsearch and Vespa. It was never measured on these documents, and offline
 * measurement says the flatness of that curve costs the head:
 * `benchmark/results/retrieval-arms-decision.md` §2b measured the shipped hybrid
 * pipeline BELOW plain keyword search on the same documents (recall@10 0.1502 vs
 * 0.3148 synthetic; 0.9752 vs 1.0000 with a 36% MRR deficit on real prose),
 * because at k=60 one leg's rank 1 weighs 1/61 and another leg's rank 10 weighs
 * 1/70 — a 15% gap. Cross-leg agreement therefore outweighs a strong single-leg
 * rank, and a document both legs rank mid-list beats a document one leg ranks
 * first.
 *
 * That finding is offline and measured on an arm that omits this deployment's
 * reranker and knowledge-graph leg, so it is a hypothesis about production, not a
 * result. This module exists to make the constant measurable in situ, with the
 * default unchanged so that an installation which sets nothing behaves exactly as
 * it did before.
 *
 * RESOLUTION ORDER (most specific wins)
 * ----------------------------------------------------------------------------
 *   1. request override  — `x-fusion-k`, and ONLY while `RAG_FUSION_K` is set
 *   2. `RAG_FUSION_K`    — deployment-wide
 *   3. `DEFAULT_FUSION_K` — the documented default (asserted equal to `RRF_K`)
 *
 * The request override is gated on the env var deliberately, copying the
 * `SIMPLE_PIPELINE` / `x-pipeline` precedent in the chat send route: an operator
 * who has not enabled the flag cannot have a client enable it for them. Without
 * that gate, any caller could pick a ranking configuration, which turns a
 * measurement seam into a client-controlled retrieval setting.
 */
import { AsyncLocalStorage } from 'async_hooks'

/**
 * The value used when nothing is configured — deliberately NOT imported from
 * `rag-ranking.ts`.
 *
 * Importing `RRF_K` here would couple this module to the one it configures, and
 * that coupling is not free: `rag-ranking` is mocked in several test files, so a
 * dependency on it means every one of those mocks must also export `RRF_K` or the
 * failure is "Export named 'RRF_K' not found" — an error about the mock rather
 * than about ranking. Keeping the constant local removes that fragility.
 *
 * Drift is prevented by an explicit assertion instead of by hoping the two stay
 * equal: `rag-fusion-config.test.ts` asserts `DEFAULT_FUSION_K === RRF_K`, so
 * changing one without the other fails loudly. That is the ALIGNMENT_CHECK lesson
 * applied — the schema and the call sites disagreed because nothing compared them.
 */
export const DEFAULT_FUSION_K = 60

/**
 * Bounds for an accepted `k`.
 *
 * The lower bound is 1, not 0: `k = 0` makes the fused score exactly `1/rank`,
 * which discards the whole point of dampening and amplifies the misleading
 * percentage the citation list renders. The upper bound is a sanity rail, not a
 * measured optimum — 1000 flattens the curve to ~0.001 for every rank, i.e. ties
 * everywhere. Both are rails against a typo, not tuning advice.
 */
export const MIN_FUSION_K = 1
export const MAX_FUSION_K = 1000

/** How the effective `k` was chosen. Reported so a measured number names its config. */
export type FusionKSource = 'default' | 'env' | 'request'

export interface FusionConfig {
  k: number
  source: FusionKSource
}

const requestStorage = new AsyncLocalStorage<number>()

let _warnedInvalid = false

/** Test seam — forget that an invalid value was already reported. */
export function resetFusionConfig(): void {
  _warnedInvalid = false
}

/**
 * Parse a candidate `k`. Returns null for anything not an integer in range, so
 * callers can fall back rather than propagating NaN into `1/(k + rank)`.
 */
export function parseFusionK(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text === '') return null
  // Number() rather than parseInt() so "12abc" and "1.5" are rejected instead of
  // silently truncating to 12 and 1.
  const value = Number(text)
  if (!Number.isInteger(value)) return null
  if (value < MIN_FUSION_K || value > MAX_FUSION_K) return null
  return value
}

/**
 * The deployment-wide value, or null when unset/invalid.
 *
 * `env-schema.ts` validates this at boot in production, but validation only runs
 * there — dev and test never parse the schema — so an invalid value must still be
 * handled here. Falling back to the default is the safe direction: a typo must not
 * change ranking behaviour, and it must not unlock the request override either.
 */
export function envFusionK(): number | null {
  const raw = process.env.RAG_FUSION_K
  if (raw === undefined || raw.trim() === '') return null
  const parsed = parseFusionK(raw)
  if (parsed === null) {
    if (!_warnedInvalid) {
      _warnedInvalid = true
      console.warn(
        `[rag-fusion] RAG_FUSION_K=${JSON.stringify(raw)} is not an integer in ` +
          `[${MIN_FUSION_K}, ${MAX_FUSION_K}] — ignoring it and using the default k=${DEFAULT_FUSION_K}. ` +
          'The per-request override stays disabled until a valid value is set.',
      )
    }
    return null
  }
  return parsed
}

/**
 * Whether a request may choose its own `k`.
 *
 * True only when the deployment opted in with a VALID `RAG_FUSION_K`. An invalid
 * value leaves this false, so it cannot become a way to enable the override with a
 * typo.
 */
export function fusionOverrideAllowed(): boolean {
  return envFusionK() !== null
}

/**
 * Enter a request-scoped `k` for the duration of the current async context.
 *
 * Shaped after `enterWithOrg` in `prisma-tenant.ts`, which this codebase already
 * relies on from route handlers: the value must reach `retrieveAndFuse` four calls
 * deep, and threading a parameter through the streaming preparers, the intent
 * pipeline and the reflection loop would touch far more surface than the one
 * decision it carries.
 *
 * Returns false and does nothing when the override is not allowed, so a caller can
 * tell whether the header was honoured rather than assuming it was.
 */
export function enterWithFusionK(raw: string | null | undefined): boolean {
  if (!fusionOverrideAllowed()) return false
  const parsed = parseFusionK(raw)
  if (parsed === null) return false
  requestStorage.enterWith(parsed)
  return true
}

/** The `k` to fuse with right now, and where it came from. */
export function resolveFusionConfig(): FusionConfig {
  const request = requestStorage.getStore()
  if (typeof request === 'number') return { k: request, source: 'request' }
  const env = envFusionK()
  if (env !== null) return { k: env, source: 'env' }
  return { k: DEFAULT_FUSION_K, source: 'default' }
}

/** Convenience for the fusion call site. */
export function resolveFusionK(): number {
  return resolveFusionConfig().k
}

/**
 * Short tag for the retrieval cache key.
 *
 * Keyed on the EFFECTIVE `k` rather than on the source, because two requests that
 * resolve to the same `k` produce byte-identical rankings and should therefore
 * share a cache entry. Tagging by source would fragment the cache for no gain and
 * would make a cache hit depend on how the value was chosen.
 */
export function fusionCacheTag(k: number): string {
  return `k${k}`
}

/** Run `fn` with a request-scoped `k`, for tests that need a deterministic value. */
export async function withFusionK<T>(k: number, fn: () => Promise<T>): Promise<T> {
  return requestStorage.run(k, fn)
}
