/** Rank-aware average precision over binary chunk judgements.
 * Definition: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/
 */
export function contextAveragePrecision(verdicts: number[]): number {
  if (verdicts.some(value => value !== 0 && value !== 1)) return Number.NaN
  let relevant = 0
  let sum = 0
  verdicts.forEach((value, index) => {
    relevant += value
    if (value === 1) sum += relevant / (index + 1)
  })
  return relevant ? sum / relevant : 0
}
