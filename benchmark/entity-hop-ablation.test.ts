/**
 * Tests for the Entity-Hop ablation decision logic.
 *
 * WHY THESE EXIST: `decideVerdict` is the only thing standing between a table of numbers and
 * a ship/no-ship claim, and it is easy to get wrong in the direction that flatters the
 * feature — a missing metric read as zero, an easy drop compared against the wrong sign, a
 * threshold compared with `>` instead of `>=`. Each case below pins one of those. No real
 * data is loaded: the function is pure, so a fabricated `ArmMetrics` is the whole input.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_ADDED_P50_MS, MAX_EASY_DROP, MIN_MEDIUM_HARD_GAIN, decideVerdict, mediumHardRecall10 } from './entity-hop-ablation'
import type { ArmMetrics, TierMetric } from './arm-types'

const tier = (n: number, recall10: number, latencyP50Ms: number): TierMetric => ({
  n,
  recall5: recall10,
  recall10,
  answerAt1: 0,
  mrr: 0,
  evidenceCoverage: 0,
  hopRecall: [],
  latencyP50Ms,
  latencyP90Ms: latencyP50Ms,
})

/** 175 medium + 150 hard questions, matching the held-out split's shape. */
function metrics(opts: { medium: number; hard: number; easy: number; p50ms: number }): ArmMetrics {
  return {
    arm: 'fake',
    kind: 'entity-hop',
    scope: 'held-out',
    perTier: {
      easy: tier(75, opts.easy, opts.p50ms),
      medium: tier(175, opts.medium, opts.p50ms),
      hard: tier(150, opts.hard, opts.p50ms),
    },
    overall: tier(500, 0, opts.p50ms),
  }
}

const baseline = metrics({ medium: 0.30, hard: 0.10, easy: 1.0, p50ms: 10 })

/** Baseline medium+hard = (0.30*175 + 0.10*150)/325 = 0.2077. */
describe('thresholds come from the plan, not from the caller', () => {
  test('the plan §1 values are the ones compiled in', () => {
    expect(MIN_MEDIUM_HARD_GAIN).toBe(0.1)
    expect(MAX_EASY_DROP).toBe(0.01)
    expect(MAX_ADDED_P50_MS).toBe(50)
  })

  test('medium+hard is combined by question count, not as a plain mean', () => {
    // 0.30 over 175 questions and 0.10 over 150 must not average to 0.20.
    expect(mediumHardRecall10(baseline)).toBeCloseTo((0.3 * 175 + 0.1 * 150) / 325, 10)
  })
})

describe('decideVerdict', () => {
  test('(a) a large medium/hard gain with no easy drop is SHIPPABLE', () => {
    const variant = metrics({ medium: 0.45, hard: 0.25, easy: 1.0, p50ms: 20 })
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.status).toBe('SHIPPABLE')
    expect(v.criteria.filter((c) => c.status === 'FAIL')).toEqual([])
    expect(v.mediumHard!.gain).toBeGreaterThan(MIN_MEDIUM_HARD_GAIN)
  })

  test('(b) a big gain but an easy drop over 0.01 is DO NOT SHIP', () => {
    const variant = metrics({ medium: 0.45, hard: 0.25, easy: 0.98, p50ms: 20 })
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.status).toBe('DO NOT SHIP')
    expect(v.criteria.find((c) => c.id === 'c2')!.status).toBe('FAIL')
    // The gain really was large: this refusal is about the regression, not a weak gain.
    expect(v.criteria.find((c) => c.id === 'c1')!.status).toBe('PASS')
  })

  test('(c) a gain under 0.10 is DO NOT SHIP even with everything else clean', () => {
    const variant = metrics({ medium: 0.35, hard: 0.13, easy: 1.0, p50ms: 20 })
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.mediumHard!.gain).toBeLessThan(MIN_MEDIUM_HARD_GAIN)
    expect(v.status).toBe('DO NOT SHIP')
    expect(v.criteria.find((c) => c.id === 'c1')!.status).toBe('FAIL')
    expect(v.criteria.find((c) => c.id === 'c2')!.status).toBe('PASS')
  })

  test('(d) added p50 over 50 ms is DO NOT SHIP, even at a large gain', () => {
    const variant = metrics({ medium: 0.60, hard: 0.40, easy: 1.0, p50ms: 10 + MAX_ADDED_P50_MS + 1 })
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.addedP50Ms).toBe(MAX_ADDED_P50_MS + 1)
    expect(v.status).toBe('DO NOT SHIP')
    expect(v.criteria.find((c) => c.id === 'c4')!.status).toBe('FAIL')
  })

  test('(e) missing variant metrics give NOT COMPUTABLE, never SHIPPABLE', () => {
    for (const input of [
      { baselineMetrics: baseline, variantMetrics: null },
      { baselineMetrics: baseline, unavailable: 'arm reports not ready (missing vectors or index)' },
      { baselineMetrics: null, variantMetrics: metrics({ medium: 0.9, hard: 0.9, easy: 1, p50ms: 11 }) },
    ]) {
      const v = decideVerdict(input)
      expect(v.status).toBe('NOT COMPUTABLE')
      expect(v.mediumHard).toBe(null)
      expect(v.addedP50Ms).toBe(null)
      expect(v.criteria.some((c) => c.status === 'PASS')).toBe(false)
      expect(v.criteria.some((c) => c.status === 'FAIL')).toBe(false)
      for (const c of v.criteria) expect(c.status).toBe('NOT COMPUTABLE')
    }
  })

  test('an uncomputable variant is never SHIPPABLE even when the other two gates would pass', () => {
    const variant = metrics({ medium: 0.60, hard: 0.40, easy: 1.0, p50ms: 20 })
    // `unavailable` wins over metrics that happen to look perfect.
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant, unavailable: 'arm threw' })
    expect(v.status).toBe('NOT COMPUTABLE')
    expect(v.reasons.join(' ')).toContain('arm threw')
  })

  test('a missing easy tier is NOT COMPUTABLE, not "no easy drop"', () => {
    const variant = metrics({ medium: 0.60, hard: 0.40, easy: 1.0, p50ms: 20 })
    delete variant.perTier.easy
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.status).toBe('NOT COMPUTABLE')
    expect(v.reasons.join(' ')).toContain('easy')
  })
})

describe('boundary behaviour on the exact thresholds', () => {
  test('a gain of exactly +0.10 passes', () => {
    // medium+hard must land exactly 0.10 above the baseline's 0.207692...
    const baseHard = mediumHardRecall10(baseline)!
    const target = baseHard + MIN_MEDIUM_HARD_GAIN
    const variant = metrics({ medium: target, hard: target, easy: 1.0, p50ms: 20 })
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.criteria.find((c) => c.id === 'c1')!.status).toBe('PASS')
    expect(v.status).toBe('SHIPPABLE')
  })

  test('an easy drop of exactly 0.01 passes; a hair more fails', () => {
    const at = decideVerdict({
      baselineMetrics: baseline,
      variantMetrics: metrics({ medium: 0.60, hard: 0.40, easy: 1.0 - MAX_EASY_DROP, p50ms: 20 }),
    })
    expect(at.criteria.find((c) => c.id === 'c2')!.status).toBe('PASS')

    const over = decideVerdict({
      baselineMetrics: baseline,
      variantMetrics: metrics({ medium: 0.60, hard: 0.40, easy: 1.0 - MAX_EASY_DROP - 0.001, p50ms: 20 }),
    })
    expect(over.criteria.find((c) => c.id === 'c2')!.status).toBe('FAIL')
    expect(over.status).toBe('DO NOT SHIP')
  })

  test('an easy improvement (negative drop) passes', () => {
    const v = decideVerdict({
      baselineMetrics: metrics({ medium: 0.30, hard: 0.10, easy: 0.95, p50ms: 10 }),
      variantMetrics: metrics({ medium: 0.60, hard: 0.40, easy: 1.0, p50ms: 20 }),
    })
    expect(v.easy!.drop).toBeLessThan(0)
    expect(v.criteria.find((c) => c.id === 'c2')!.status).toBe('PASS')
  })

  test('a negative added p50 (faster variant) passes', () => {
    const v = decideVerdict({
      baselineMetrics: metrics({ medium: 0.30, hard: 0.10, easy: 1, p50ms: 30 }),
      variantMetrics: metrics({ medium: 0.60, hard: 0.40, easy: 1, p50ms: 12 }),
    })
    expect(v.addedP50Ms).toBeLessThan(0)
    expect(v.criteria.find((c) => c.id === 'c4')!.status).toBe('PASS')
  })
})

describe('a genuine zero is a measurement, not missing data', () => {
  // REGRESSION: the first version tested `!baseHard`, so the production hybrid arm's real
  // 0.0000 medium+hard score read as "unavailable" and every verdict came back NOT COMPUTABLE.
  // This is not hypothetical — that is exactly what lexical-first-hybrid scores on the held-out split.
  test('a baseline of exactly 0 on medium+hard still produces a verdict', () => {
    const zero: ArmMetrics = {
      ...metrics({ medium: 0, hard: 0, easy: 0.5600, p50ms: 4.6 }),
      perTier: { easy: tier(75, 0.56, 4.6), medium: tier(179, 0, 4.6), hard: tier(138, 0, 4.6) },
    }
    const variant = metrics({ medium: 0.4, hard: 0.35, easy: 0.55, p50ms: 5.0 })
    const v = decideVerdict({ baselineMetrics: zero, variantMetrics: variant })
    expect(v.status).not.toBe('NOT COMPUTABLE')
    expect(v.mediumHard!.baseline).toBe(0)
    expect(v.mediumHard!.gain).toBeGreaterThan(0)
    expect(v.criteria.find((c) => c.id === 'c1')!.status).toBe('PASS')
  })

  test('a variant scoring exactly 0 is evaluated as 0, and fails the gain gate', () => {
    const zero: ArmMetrics = {
      ...metrics({ medium: 0, hard: 0, easy: 0.5, p50ms: 1 }),
      perTier: { easy: tier(75, 0.5, 1), medium: tier(179, 0, 1), hard: tier(138, 0, 1) },
    }
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: zero })
    expect(v.status).toBe('DO NOT SHIP')
    expect(v.mediumHard!.variant).toBe(0)
    expect(v.criteria.find((c) => c.id === 'c1')!.status).toBe('FAIL')
    expect(v.reasons).toEqual([])
  })

  test('an easy tier of exactly 0 is a measured drop, not a missing tier', () => {
    const variant: ArmMetrics = {
      ...metrics({ medium: 0.6, hard: 0.4, easy: 0, p50ms: 20 }),
      perTier: { easy: tier(75, 0, 20), medium: tier(179, 0.6, 20), hard: tier(138, 0.4, 20) },
    }
    const v = decideVerdict({ baselineMetrics: baseline, variantMetrics: variant })
    expect(v.easy!.drop).toBe(1)
    expect(v.criteria.find((c) => c.id === 'c2')!.status).toBe('FAIL')
    expect(v.status).toBe('DO NOT SHIP')
  })
})

describe('what a verdict is allowed to claim', () => {
  test('item 3 is always NOT COMPUTABLE here, and never the reason for a refusal', () => {
    const shipped = decideVerdict({
      baselineMetrics: baseline,
      variantMetrics: metrics({ medium: 0.60, hard: 0.40, easy: 1.0, p50ms: 20 }),
    })
    const c3 = shipped.criteria.find((c) => c.id === 'c3')!
    expect(c3.status).toBe('NOT COMPUTABLE')
    expect(shipped.status).toBe('SHIPPABLE')

    const refused = decideVerdict({
      baselineMetrics: baseline,
      variantMetrics: metrics({ medium: 0.31, hard: 0.11, easy: 1.0, p50ms: 20 }),
    })
    expect(refused.status).toBe('DO NOT SHIP')
    expect(refused.reasons).toEqual([])
  })
})
