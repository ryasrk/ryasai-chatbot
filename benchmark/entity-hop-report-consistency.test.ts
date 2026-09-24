/**
 * Guard: every number in the Entity-Hop decision report must trace to a committed run.
 *
 * WHY THIS EXISTS: the report is hand-written prose over generated output, and it drifted
 * twice during this work — once quoting a pre-cap run after the default changed, once
 * quoting a DEV sweep whose numbers existed only in a terminal. Both times the verdict was
 * unaffected, which is exactly what makes the class of bug dangerous: a reader cannot tell
 * a stale figure from a current one.
 *
 * The check is deliberately coarse (4-decimal tokens), because a prose number that matches
 * nothing in the machine output is the signal. Derived values are admitted only when the run
 * itself computed them.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const REPORT = 'benchmark/results/entity-hop-decision.md'
const ABLATION = 'benchmark/results/entity-hop-ablation.json'
const TUNE = 'benchmark/results/entity-hop-tune.json'

interface Metrics {
  perTier: Record<string, { recall10: number; recall5: number; answerAt1: number }>
  overall: { recall10: number; answerAt1: number; mrr: number }
}

/** Numbers a reader can look up in one of the two result files. */
function traceable(): Set<string> {
  const out = new Set<string>()
  const add = (n: unknown) => {
    if (typeof n === 'number' && Number.isFinite(n)) out.add(Math.abs(n).toFixed(4))
  }

  const abl = JSON.parse(readFileSync(ABLATION, 'utf8')) as {
    variants: Array<{ metrics: Metrics | null; verdict: { criteria: Array<{ detail?: string }> } }>
    baselineMetrics: Metrics
    bm25ReferenceMetrics: Metrics
  }
  const harvest = (m: Metrics | null) => {
    if (!m) return
    for (const t of Object.values(m.perTier)) {
      add(t.recall10)
      add(t.recall5)
      add(t.answerAt1)
    }
    add(m.overall.recall10)
    add(m.overall.answerAt1)
    add(m.overall.mrr)
  }
  for (const v of abl.variants) {
    harvest(v.metrics)
    // Deltas only exist inside the verdict detail strings, so parse them back out.
    for (const c of v.verdict.criteria) {
      for (const num of (c.detail ?? '').match(/[+-]?\d*\.\d{4}/g) ?? []) add(Number(num))
    }
  }
  harvest(abl.baselineMetrics)
  harvest(abl.bm25ReferenceMetrics)

  const tune = JSON.parse(readFileSync(TUNE, 'utf8')) as {
    rows: Array<Record<string, number>>
    baseline: Record<string, number>
    bm25Reference: Record<string, number>
  }
  for (const r of tune.rows) for (const v of Object.values(r)) add(v)
  for (const v of Object.values(tune.baseline)) add(v)
  for (const v of Object.values(tune.bm25Reference)) add(v)
  return out
}

describe('Entity-Hop decision report consistency', () => {
  test('every 4-decimal figure in the report appears in the committed run output', () => {
    const known = traceable()
    const report = readFileSync(REPORT, 'utf8')
    const tokens = [...new Set(report.match(/\b\d*\.\d{4}\b/g) ?? [])]
    expect(tokens.length).toBeGreaterThan(0)
    const orphans = tokens.filter((t) => !known.has(t.replace(/^[+-]/, '')))
    // Report the offenders, not just a count: a bare "expected 0, got 3" does not say which.
    expect(orphans).toEqual([])
  })

  test('the report states the verdict the run computed', () => {
    const abl = JSON.parse(readFileSync(ABLATION, 'utf8')) as {
      variants: Array<{ name: string; verdict: { status: string } }>
    }
    const shipped = abl.variants.find((v) => v.name === 'entity-hop')!
    const report = readFileSync(REPORT, 'utf8')
    expect(report).toContain(shipped.verdict.status)
    // The headline must carry the verdict, not bury it further down.
    expect(report.slice(0, 800)).toContain(shipped.verdict.status)
  })

  test('the tuning file records the cap the arm actually ships', () => {
    const tune = JSON.parse(readFileSync(TUNE, 'utf8')) as { chosen: number; shippedDefault: number; rows: unknown[] }
    expect(tune.chosen).toBe(tune.shippedDefault)
    expect(tune.rows.length).toBeGreaterThan(1)
  })

  test('the tuning sweep covers enough caps for the selection rule to mean something', () => {
    const tune = JSON.parse(readFileSync(TUNE, 'utf8')) as { rows: Array<{ maxHopDocs: number; mediumHardGainVsP2: number }> }
    expect(tune.rows.length).toBeGreaterThanOrEqual(5)
    // At least one cap must show a positive gain, or the rule had nothing to choose from.
    expect(tune.rows.some((r) => r.mediumHardGainVsP2 > 0)).toBe(true)
  })
})
