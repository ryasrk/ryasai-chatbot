/**
 * Parse one `bun test` summary into counts.
 *
 * Extracted from the runner so the counting rules are testable without spawning anything
 * (see test-runner.test.ts for why that matters here).
 *
 * WHY IT COLLECTS EVERY LINE instead of searching one. Bun prints the three counts on
 * SEPARATE lines:
 *
 *     37 pass
 *     41 skip
 *     0 fail
 *
 * The runner used to `find()` the first line matching `^\s*\d+\s+pass\b` and then regex
 * `fail` and `skip` out of THAT line. `fail` survived by luck — a failing run prints it in
 * the same line as an inline message — but `skip` could never match, so a suite with 54
 * skipped tests reported "0 skip". Reading all three lines and letting the last value for
 * each kind win is both correct and robust to a test that prints its own "N pass" line.
 */
export interface BunSummary {
  pass: number
  fail: number
  skip: number
}

export function parseBunSummary(output: string): BunSummary {
  const lines = output
    .split('\n')
    .filter((l) => /^\s*\d+\s+(pass|fail|skip)\b/.test(l))
  const lastValue = (kind: 'pass' | 'fail' | 'skip'): number => {
    let value = 0
    for (const line of lines) {
      const m = new RegExp(`(\\d+)\\s+${kind}\\b`).exec(line)
      if (m) value = Number(m[1])
    }
    return value
  }
  return { pass: lastValue('pass'), fail: lastValue('fail'), skip: lastValue('skip') }
}
