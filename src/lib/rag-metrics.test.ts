/**
 * Tests for the retrieval metrics.
 *
 * The load-bearing assertion is the last block: a cache HIT must not record a
 * latency sample. Recording one would make retrieval appear to speed up as the hit
 * rate rose — the busier the cache, the lower the p50 — which is the opposite of
 * what a latency budget is for. Everything else here pins that the samples actually
 * land, because `metrics.ts` drops a sample whose metric was never registered, and a
 * dropped sample is silent: an empty panel with no error anywhere.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { prometheusText, resetMetrics } from './metrics'
import {
  RAG_CACHE_HIT_METRIC,
  RAG_CACHE_MISS_METRIC,
  RAG_CANDIDATES_METRIC,
  RAG_LATENCY_METRIC,
  RAG_RESULTS_METRIC,
  RAG_VECTOR_LEG_METRIC,
  recordRetrievalCache,
  recordRetrievalTiming,
} from './rag-metrics'

/** The rendered series for one metric name, label lines included. */
function seriesFor(metric: string): string[] {
  return prometheusText()
    .split('\n')
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `) || line.startsWith(`${metric}_`))
}

function labelValues(metric: string): string[] {
  return seriesFor(metric)
    .map((line) => /ranking="v(\d+)"/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined)
}

/**
 * A timing sample with the vector-leg fields filled in.
 *
 * Defaults to a HEALTHY leg so that a test about latency, candidates or result counts is
 * not also silently asserting something about the vector leg — the two concerns are
 * separate and the tests below cover the leg explicitly.
 */
function timing(over: Partial<Parameters<typeof recordRetrievalTiming>[0]> = {}) {
  return { ms: 10, rankingVersion: 'v60', candidatesScanned: 5, returned: 3, vectorHits: 2, vectorAttempted: true, ...over }
}

beforeEach(() => {
  resetMetrics()
})

describe('samples land without a prior initMetrics() call', () => {
  test('a timing sample is recorded even though nothing registered it first', () => {
    // This is the failure mode the per-call registration exists for: `observe` on an
    // unregistered metric is a silent no-op, so on a fresh process every retrieval
    // before the first /api/metrics scrape would record nothing.
    expect(seriesFor(RAG_LATENCY_METRIC)).toEqual([])
    recordRetrievalTiming(timing({ ms: 42, rankingVersion: 'v60', candidatesScanned: 17, returned: 4 }))
    expect(seriesFor(RAG_LATENCY_METRIC).length).toBeGreaterThan(0)
    expect(prometheusText()).toContain('rag_retrieval_latency_ms_count')
  })

  test('a cache sample is recorded without a prior registration', () => {
    recordRetrievalCache(true)
    expect(prometheusText()).toContain(RAG_CACHE_HIT_METRIC)
  })

  test('counting a hit and a miss increments both, independently', () => {
    recordRetrievalCache(true)
    recordRetrievalCache(true)
    recordRetrievalCache(false)
    const text = prometheusText()
    expect(text).toMatch(new RegExp(`${RAG_CACHE_HIT_METRIC} 2`))
    expect(text).toMatch(new RegExp(`${RAG_CACHE_MISS_METRIC} 1`))
  })
})

describe('the ranking version labels the series, so an A/B run is readable', () => {
  test('two different ranking versions produce two labelled series', () => {
    recordRetrievalTiming(timing({ ms: 10, rankingVersion: 'v60', candidatesScanned: 5, returned: 3 }))
    recordRetrievalTiming(timing({ ms: 20, rankingVersion: 'v1', candidatesScanned: 5, returned: 3 }))
    const values = labelValues(RAG_LATENCY_METRIC)
    expect(values).toContain('60')
    expect(values).toContain('1')
  })

  test('repeated samples at one version share a series rather than multiplying labels', () => {
    for (let i = 0; i < 5; i++) {
      recordRetrievalTiming(timing({ ms: 10, rankingVersion: 'v60', candidatesScanned: 5, returned: 3 }))
    }
    // Distinct label SETS, not sample count: 5 identical samples are one series.
    expect(new Set(labelValues(RAG_LATENCY_METRIC)).size).toBe(1)
  })
})

describe('the other retrieval samples', () => {
  test('candidates scanned and results returned are both recorded', () => {
    recordRetrievalTiming(timing({ ms: 30, rankingVersion: 'v60', candidatesScanned: 240, returned: 12 }))
    const text = prometheusText()
    expect(text).toContain(RAG_CANDIDATES_METRIC)
    expect(text).toContain(RAG_RESULTS_METRIC)
    // A wrong wiring (swapping the two arguments) would still emit both names, so
    // assert the VALUES land in the right buckets: candidates into the 250 bucket,
    // results into the 12 bucket.
    expect(text).toMatch(new RegExp(`${RAG_CANDIDATES_METRIC}_bucket\\{ranking="v60",le="250"} 1`))
    expect(text).toMatch(new RegExp(`${RAG_RESULTS_METRIC}_bucket\\{ranking="v60",le="12"} 1`))
  })

  test('zero results is a real observation, not a missing sample', () => {
    // An empty retrieval is the interesting case (nothing matched); it must appear in
    // the 0 bucket rather than being dropped as falsy.
    recordRetrievalTiming(timing({ ms: 5, rankingVersion: 'v60', candidatesScanned: 0, returned: 0 }))
    expect(prometheusText()).toMatch(new RegExp(`${RAG_RESULTS_METRIC}_bucket\\{ranking="v60",le="0"} 1`))
  })
})

describe('a cache hit is NOT a retrieval', () => {
  test('recordRetrievalCache never touches the latency histogram', () => {
    // The property in rag-metrics.ts's header: if a hit recorded its near-zero
    // duration, p50 would fall as the hit rate rose and the latency budget would
    // look healthier precisely when the cache was masking the retrievers.
    recordRetrievalCache(true)
    recordRetrievalCache(true)
    recordRetrievalCache(false)
    expect(seriesFor(RAG_LATENCY_METRIC)).toEqual([])
    // …and the hit/miss counters still moved, so the separation is not achieved by
    // recording nothing at all.
    const text = prometheusText()
    expect(text).toContain(RAG_CACHE_HIT_METRIC)
    expect(text).toContain(RAG_CACHE_MISS_METRIC)
  })

  test('the latency count equals the number of real retrievals, not of cache reads', () => {
    recordRetrievalCache(true)
    recordRetrievalTiming(timing({ ms: 20, rankingVersion: 'v60', candidatesScanned: 3, returned: 1 }))
    recordRetrievalCache(false)
    recordRetrievalTiming(timing({ ms: 40, rankingVersion: 'v60', candidatesScanned: 4, returned: 2 }))
    const countLine = prometheusText().split('\n').find((l) => l.startsWith(`${RAG_LATENCY_METRIC}_count`))!
    expect(countLine.endsWith(' 2')).toBe(true)
  })
})

describe('the vector leg reports its own health, not just its effect', () => {
  // WHY THIS EXISTS: latency, candidates and results all look NORMAL when the vector leg
  // is dead, because a lexical-only answer is still a good answer. Three separate faults
  // in this subsystem (a dimension mismatch, an SSRF-blocked embedder, an unset vector
  // column) each presented as "retrieval works, it just isn't very good" and took hours to
  // find. These series are what turns that into a one-line query.
  const legCount = (outcome: string): number => {
    const line = prometheusText()
      .split('\n')
      .find((l) => l.startsWith(`${RAG_VECTOR_LEG_METRIC}{`) && l.includes(`outcome="${outcome}"`))
    return line ? Number(line.split(' ').pop()) : 0
  }

  test('a leg that was never attempted is distinguished from one that found nothing', () => {
    recordRetrievalTiming(timing({ vectorAttempted: false, vectorHits: 0 }))
    expect(legCount('not_attempted')).toBe(1)
    expect(legCount('empty')).toBe(0)

    recordRetrievalTiming(timing({ vectorAttempted: true, vectorHits: 0 }))
    expect(legCount('not_attempted')).toBe(1)
    expect(legCount('empty')).toBe(1)

    recordRetrievalTiming(timing({ vectorAttempted: true, vectorHits: 5 }))
    expect(legCount('used')).toBe(1)
  })

  test('a live leg does NOT register as a fault', () => {
    // Without this the two zero-series could be satisfied by a meter that fires on every
    // retrieval, which would alarm constantly and be ignored.
    recordRetrievalTiming(timing({ vectorAttempted: true, vectorHits: 3 }))
    expect(legCount('not_attempted')).toBe(0)
    expect(legCount('empty')).toBe(0)
  })

  test('the series carries the ranking version, so an A/B cannot mix outcomes', () => {
    recordRetrievalTiming(timing({ rankingVersion: 'lex1', vectorAttempted: false }))
    const line = prometheusText()
      .split('\n')
      .find((l) => l.startsWith(`${RAG_VECTOR_LEG_METRIC}{`))
    expect(line).toContain('ranking="lex1"')
    expect(line).toContain('outcome="not_attempted"')
  })
})
