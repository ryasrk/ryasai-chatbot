export function resultAccuracy<T>(
  results: T[],
  hasExpectation: (result: T) => boolean,
  matches: (result: T) => boolean | undefined,
): number | null {
  const checks = results.filter(hasExpectation)
  // Failed generation or execution is a failed result check, not a missing sample.
  return checks.length ? checks.filter(result => matches(result) === true).length / checks.length : null
}

export function firstRowHasValue(row: Record<string, unknown> | undefined, expected: unknown): boolean {
  if (!row) return false
  const normalize = (value: unknown) => {
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) return numeric
    }
    return typeof value === 'string' ? value.toLowerCase() : value
  }
  return Object.values(row).some(value => normalize(value) === normalize(expected))
}
