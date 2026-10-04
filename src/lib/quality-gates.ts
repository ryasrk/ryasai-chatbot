/** A quality gate needs measured samples and finite scores before thresholds matter. */
export function qualityGateFailures(args: {
  samples: number
  minimumSamples: number
  metrics: Record<string, { value: number; minimum: number }>
  skipped?: number
  independentJudge?: boolean
}): string[] {
  const failures: string[] = []
  if (!Number.isSafeInteger(args.minimumSamples) || args.minimumSamples < 1) failures.push('Invalid minimum sample count')
  if (!Number.isSafeInteger(args.samples) || args.samples < args.minimumSamples) failures.push('Insufficient evaluation samples')
  if (args.skipped !== undefined && args.skipped !== 0) failures.push('Evaluation contains unjudged samples')
  if (args.independentJudge === false) failures.push('An independent judge is required')
  for (const [name, metric] of Object.entries(args.metrics)) {
    if (!Number.isFinite(metric.minimum) || metric.minimum < 0 || metric.minimum > 1) failures.push(`${name}: invalid threshold`)
    if (!Number.isFinite(metric.value) || metric.value < 0 || metric.value > 1) failures.push(`${name}: invalid score`)
    else if (metric.value < metric.minimum) failures.push(`${name}: ${metric.value.toFixed(3)} < ${metric.minimum}`)
  }
  if (!Object.keys(args.metrics).length) failures.push('No metrics were measured')
  return failures
}
