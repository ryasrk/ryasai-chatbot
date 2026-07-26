/**
 * RAG Benchmark Evaluation Framework
 * ----------------------------------------------------------------------------
 * Measures the full NL→SQL→Answer pipeline across 10 metric categories:
 *   1. Retrieval Quality (schema match, table selection)
 *   2. Context Quality (column coverage)
 *   3. Faithfulness (answer grounded in query results)
 *   4. Answer Correctness (expected values present)
 *   5. Answer Relevance (on-topic)
 *   6. Groundedness (traceable to data)
 *   7. Citation Accuracy (not applicable for SQL pipeline)
 *   8. Latency (per-stage timing)
 *   9. Cost (token usage)
 *  10. Robustness (typo/paraphrase variance)
 *
 * Usage: bun run benchmark/runner.ts [--db chinook] [--limit 50]
 */
import type { BenchmarkQuestion } from './types'

export interface BenchmarkResult {
  questionId: string
  category: string
  difficulty: string
  question: string
  // Stage timings (ms)
  latency: {
    total: number
    routing?: number
    sqlGen?: number
    sqlExec?: number
    answerGen?: number
  }
  // SQL generation
  generatedSql: string
  sqlValid: boolean
  sqlExecuted: boolean
  sqlError?: string
  // Result
  rowCount: number
  rows: Record<string, unknown>[]
  // Correctness
  expectedColumnsFound: string[]
  expectedColumnsMissing: string[]
  answerContainsAllExpected: boolean
  answerMissingExpected: string[]
  // Overall
  correct: boolean
  partialCredit: number // 0.0 - 1.0
}

export interface BenchmarkSummary {
  totalQuestions: number
  totalRun: number
  passed: number
  failed: number
  partial: number
  passRate: number
  // By category
  byCategory: Record<string, { total: number; passed: number; failed: number; passRate: number }>
  // By difficulty
  byDifficulty: Record<string, { total: number; passed: number; failed: number; passRate: number }>
  // By integration
  byIntegration: Record<string, { total: number; passed: number; failed: number; passRate: number }>
  // Latency
  latency: {
    p50: number
    p95: number
    p99: number
    avg: number
    min: number
    max: number
  }
  // SQL validity
  sqlValidityRate: number
  // Robustness
  robustnessScore: number
  // Detailed results
  results: BenchmarkResult[]
}

/**
 * Check if the generated SQL contains expected columns in its result.
 */
export function checkColumns(
  resultColumns: string[],
  expectedColumns: string[],
): { found: string[]; missing: string[] } {
  const resultLower = resultColumns.map((c) => c.toLowerCase())
  const found: string[] = []
  const missing: string[] = []
  for (const expected of expectedColumns) {
    if (resultLower.includes(expected.toLowerCase())) {
      found.push(expected)
    } else {
      missing.push(expected)
    }
  }
  return { found, missing }
}

/**
 * Check if the answer contains all expected values.
 * For numeric answers, we check if the number appears anywhere in the answer text.
 */
export function checkAnswerContains(
  answerText: string,
  expectedContains: string[],
): { allFound: boolean; missing: string[] } {
  if (expectedContains.length === 0) {
    return { allFound: true, missing: [] }
  }
  const answerLower = answerText.toLowerCase()
  const missing: string[] = []
  for (const expected of expectedContains) {
    if (!answerLower.includes(expected.toLowerCase())) {
      missing.push(expected)
    }
  }
  return { allFound: missing.length === 0, missing }
}

/**
 * Calculate partial credit for a result.
 * - SQL valid but wrong answer: 0.3
 * - SQL valid + executed + correct columns: 0.6
 * - SQL valid + executed + correct columns + expected values: 1.0
 */
export function calculatePartialCredit(result: {
  sqlValid: boolean
  sqlExecuted: boolean
  expectedColumnsMissing: string[]
  answerContainsAllExpected: boolean
  expectedAnswerContainsEmpty: boolean
}): number {
  if (!result.sqlValid) return 0.0
  if (!result.sqlExecuted) return 0.1
  if (result.expectedColumnsMissing.length === 0) {
    if (result.expectedAnswerContainsEmpty) return 0.8 // no specific values to check, but columns match
    if (result.answerContainsAllExpected) return 1.0
    return 0.6 // correct shape, wrong values
  }
  if (result.expectedColumnsMissing.length <= 1) return 0.4
  return 0.2
}

/**
 * Calculate latency percentiles.
 */
export function calculateLatencyStats(latencies: number[]): {
  p50: number
  p95: number
  p99: number
  avg: number
  min: number
  max: number
} {
  if (latencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 }
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]
  return {
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

/**
 * Calculate robustness score — variance in correctness between
 * normal questions and their typo/paraphrase counterparts.
 */
export function calculateRobustnessScore(results: BenchmarkResult[]): number {
  const robustnessResults = results.filter(
    (r) => r.category === 'robustness_typo' || r.category === 'robustness_paraphrase',
  )
  if (robustnessResults.length === 0) return 1.0
  const passed = robustnessResults.filter((r) => r.correct).length
  return passed / robustnessResults.length
}

/**
 * Aggregate results into a summary.
 */
export function summarizeResults(
  results: BenchmarkResult[],
  questions: BenchmarkQuestion[],
): BenchmarkSummary {
  const totalRun = results.length
  const passed = results.filter((r) => r.correct).length
  const failed = results.filter((r) => !r.correct && r.partialCredit < 0.5).length
  const partial = results.filter((r) => !r.correct && r.partialCredit >= 0.5).length

  // By category
  const byCategory: Record<string, { total: number; passed: number; failed: number; passRate: number }> = {}
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, passed: 0, failed: 0, passRate: 0 }
    byCategory[r.category].total++
    if (r.correct) byCategory[r.category].passed++
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].failed = byCategory[cat].total - byCategory[cat].passed
    byCategory[cat].passRate = byCategory[cat].total > 0 ? byCategory[cat].passed / byCategory[cat].total : 0
  }

  // By difficulty
  const byDifficulty: Record<string, { total: number; passed: number; failed: number; passRate: number }> = {}
  for (const r of results) {
    if (!byDifficulty[r.difficulty]) byDifficulty[r.difficulty] = { total: 0, passed: 0, failed: 0, passRate: 0 }
    byDifficulty[r.difficulty].total++
    if (r.correct) byDifficulty[r.difficulty].passed++
  }
  for (const d of Object.keys(byDifficulty)) {
    byDifficulty[d].failed = byDifficulty[d].total - byDifficulty[d].passed
    byDifficulty[d].passRate = byDifficulty[d].total > 0 ? byDifficulty[d].passed / byDifficulty[d].total : 0
  }

  // By integration
  const byIntegration: Record<string, { total: number; passed: number; failed: number; passRate: number }> = {}
  for (const r of results) {
    const q = questions.find((q) => q.id === r.questionId)
    const intId = q?.integrationId ?? 'unknown'
    if (!byIntegration[intId]) byIntegration[intId] = { total: 0, passed: 0, failed: 0, passRate: 0 }
    byIntegration[intId].total++
    if (r.correct) byIntegration[intId].passed++
  }
  for (const i of Object.keys(byIntegration)) {
    byIntegration[i].failed = byIntegration[i].total - byIntegration[i].passed
    byIntegration[i].passRate = byIntegration[i].total > 0 ? byIntegration[i].passed / byIntegration[i].total : 0
  }

  const latencies = results.map((r) => r.latency.total)
  const sqlValidCount = results.filter((r) => r.sqlValid).length

  return {
    totalQuestions: questions.length,
    totalRun,
    passed,
    failed,
    partial,
    passRate: totalRun > 0 ? passed / totalRun : 0,
    byCategory,
    byDifficulty,
    byIntegration,
    latency: calculateLatencyStats(latencies),
    sqlValidityRate: totalRun > 0 ? sqlValidCount / totalRun : 0,
    robustnessScore: calculateRobustnessScore(results),
    results,
  }
}
