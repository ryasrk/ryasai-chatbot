/** Wilson score interval (95%) for k successes in n trials — honest error bars for small eval samples. */
export function wilson(k: number, n: number): { rate: number; low: number; high: number; n: number } {
  if (n === 0) return { rate: NaN, low: NaN, high: NaN, n }
  const z = 1.96
  const p = k / n
  const den = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n }
}
