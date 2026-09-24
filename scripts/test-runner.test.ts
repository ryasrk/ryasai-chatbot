/**
 * The runner's own summary parser.
 *
 * WHY THIS FILE EXISTS. The skip count was silently ZERO for as long as the runner has
 * existed: Bun prints `37 pass` / `41 skip` / `0 fail` on SEPARATE lines, and the runner
 * `find()`-ed the one line containing `pass`, then looked for `fail` and `skip` inside it.
 * `fail` survived by accident; `skip` never matched. Measured before the fix: this suite
 * reported "6805 pass · 0 fail · 0 skip" over 54 skipped tests.
 *
 * A count that reads zero while work is skipped is worse than no count — it is the same
 * failure the runner's own comment warns about for the failure count ("a wrong failure
 * count is worse than no count — it trains everyone to ignore the number"). The parser is
 * extracted and pinned here so the next person cannot reintroduce it by simplifying the
 * summary handling.
 */
import { describe, expect, test } from 'bun:test'
import { parseBunSummary } from './test-summary'

describe('parseBunSummary counts every line, not just the one carrying `pass`', () => {
  test('a green run with skips reports the skips', () => {
    // The real shape, verbatim from `bun test`. The regression this pins: `skip` is on its
    // own line, so reading only the `pass` line reports 0.
    const out = ' 37 pass\n 41 skip\n 0 fail\n 128 expect() calls\nRan 78 tests across 1 file. [5.12s]'
    expect(parseBunSummary(out)).toEqual({ pass: 37, fail: 0, skip: 41 })
  })

  test('a fully green run with no skips still reports zeros', () => {
    expect(parseBunSummary(' 12 pass\n 0 fail\nRan 12 tests across 1 file. [1ms]'))
      .toEqual({ pass: 12, fail: 0, skip: 0 })
  })

  test('a failing run reports the failures', () => {
    const out = ' 5 pass\n 2 fail\nRan 7 tests across 1 file. [2ms]'
    expect(parseBunSummary(out)).toEqual({ pass: 5, fail: 2, skip: 0 })
  })

  test('skips and failures together are both counted', () => {
    const out = ' 3 pass\n 4 skip\n 2 fail\nRan 9 tests across 1 file. [2ms]'
    expect(parseBunSummary(out)).toEqual({ pass: 3, fail: 2, skip: 4 })
  })

  test('output with NO summary reports zeros rather than throwing', () => {
    // A process that died mid-run prints no summary; the caller decides what that means
    // (it floors the failure count from the exit code).
    expect(parseBunSummary('panic: something exploded')).toEqual({ pass: 0, fail: 0, skip: 0 })
    expect(parseBunSummary('')).toEqual({ pass: 0, fail: 0, skip: 0 })
  })

  test('a nested "N pass" deeper in the output does not win over the summary', () => {
    // A test that prints its own "1 pass" line must not be mistaken for the summary. The
    // real summary is the LAST set of lines, so the parser reads all matching lines and the
    // final value for each kind wins.
    const out = ' 1 pass\n 1 pass\n 0 fail\n 9 skip'
    expect(parseBunSummary(out)).toEqual({ pass: 1, fail: 0, skip: 9 })
  })
})
