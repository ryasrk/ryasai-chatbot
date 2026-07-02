export interface RagEvalCase {
  question: string
  expectedSource?: string
  expectedText?: string
}

export interface RagEvalResult {
  ok: boolean
  grounded: boolean
  latencyMs: number
  topSource?: string
  topScore?: number
}

export function summarizeRagEval(results: RagEvalResult[]) {
  const total = Math.max(1, results.length)
  return {
    total: results.length,
    precisionAtK: round(results.filter((result) => result.ok).length / total),
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

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
