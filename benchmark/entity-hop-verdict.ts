/**
 * The Entity-Hop decision rule, as code (docs/entity-hop-retrieval-plan.md §1).
 *
 * WHY THIS IS NOT PART OF THE RUNNER: the thresholds are the whole point of the Phase 2 gate, and
 * a rule embedded in a 250-line script is read as prose by whoever runs it. Splitting it out makes
 * it a pure function with one input shape, so every branch (each criterion, the boundaries, the
 * uncomputable case) is unit-tested directly instead of being inferred from a printed table.
 *
 * `decideVerdict` answers only the gate the plan puts on THIS benchmark: items 1, 2 and 4, which
 * are measured offline. Item 3 needs a real org's golden set (Phase 3), so it is always reported
 * NOT COMPUTABLE here and never gates the result.
 */
import type { ArmMetrics } from './arm-types'

/** Plan §1 item 1: absolute medium+hard recall@10 gain against P2. Fixed before any code. */
export const MIN_MEDIUM_HARD_GAIN = 0.10
/** Plan §1 item 2: easy-tier recall@10 may not drop by more than this against P2. */
export const MAX_EASY_DROP = 0.01
/** Plan §1 item 4: added p50 retrieval latency ceiling in milliseconds. */
export const MAX_ADDED_P50_MS = 50

export type Status = 'PASS' | 'FAIL' | 'NOT COMPUTABLE'
/** c1/c2/c4 are the criteria this benchmark can decide; c3 is the Phase 3 real-org gate. */
export type GateId = 'c1' | 'c2' | 'c4'
export interface Criterion { id: GateId | 'c3'; label: string; status: Status; detail: string }
export interface Range { baseline: number; variant: number }

/** Absent metrics make every criterion NOT COMPUTABLE; `unavailable` names why they are absent. */
export interface VerdictInput {
  baselineMetrics?: ArmMetrics | null
  variantMetrics?: ArmMetrics | null
  /** Overrides the derived p50 delta, so a caller can exercise the latency gate on its own. */
  addedP50Ms?: number | null
  unavailable?: string | null
}
export interface Verdict {
  status: 'SHIPPABLE' | 'DO NOT SHIP' | 'NOT COMPUTABLE'
  criteria: Criterion[]
  mediumHard: (Range & { gain: number }) | null
  easy: (Range & { drop: number }) | null
  addedP50Ms: number | null
  /** Named reasons nothing could be decided. Empty when the verdict rests on measurements. */
  reasons: string[]
}

/** Medium+hard recall@10 combined by question count, or null when either tier is absent. */
export function mediumHardRecall10(m: ArmMetrics | null | undefined): number | null {
  const med = m?.perTier?.['medium']
  const hard = m?.perTier?.['hard']
  return !med || !hard || med.n + hard.n === 0 ? null : (med.recall10 * med.n + hard.recall10 * hard.n) / (med.n + hard.n)
}

/** The plan's three decidable criteria, in plan order, each with its direction and threshold. */
interface Gate { id: GateId; label: string; atLeast: boolean; threshold: number; unit: string }
const GATES: Gate[] = [
  { id: 'c1', atLeast: true, threshold: MIN_MEDIUM_HARD_GAIN, unit: '',
    label: `plan item 1 — medium+hard recall@10 gain ≥ ${MIN_MEDIUM_HARD_GAIN} vs baseline` },
  { id: 'c2', atLeast: false, threshold: MAX_EASY_DROP, unit: '',
    label: `plan item 2 — easy recall@10 drop ≤ ${MAX_EASY_DROP}` },
  { id: 'c4', atLeast: false, threshold: MAX_ADDED_P50_MS, unit: ' ms',
    label: `plan item 4 — added p50 ≤ ${MAX_ADDED_P50_MS} ms` },
]
const PHASE_3: Criterion = { id: 'c3', status: 'NOT COMPUTABLE',
  label: 'plan item 3 — real-org golden set not worse than P2',
  detail: 'Phase 3 has not run; not evaluable from this benchmark' }

/**
 * A value exactly on a threshold must pass, since the plan fails a drop "of more than 0.01". Without
 * this the float representation decides instead of the rule: 1 - 0.99 is 0.010000000000000009, which
 * prints as "+0.0100 vs allowed 0.0100" and still failed — output contradicting itself. 1e-9 absorbs
 * representation noise only; these are 4-decimal values, so anything visibly over is still over.
 */
const EPSILON = 1e-9
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`

/** Pure: no data loading, no I/O, no variant names. */
export function decideVerdict(input: VerdictInput): Verdict {
  const { baselineMetrics: b, variantMetrics: v } = input
  const baseHard = mediumHardRecall10(b)
  const variantHard = mediumHardRecall10(v)
  const baseEasy = b?.perTier?.['easy']
  const variantEasy = v?.perTier?.['easy']
  const addedP50Ms = input.addedP50Ms ?? (b && v ? v.overall.latencyP50Ms - b.overall.latencyP50Ms : null)
  // `=== null`, never a falsy test: an arm that genuinely scores 0.0000 on medium+hard is a
  // measurement, and `!0` would report it as missing and block the whole verdict.
  const reasons = [input.unavailable, baseHard === null && 'baseline medium+hard metrics unavailable',
    variantHard === null && 'variant medium+hard metrics unavailable', !baseEasy?.n && 'baseline easy metrics unavailable',
    !variantEasy?.n && 'variant easy metrics unavailable', addedP50Ms === null && 'latency comparison unavailable',
  ].filter((r): r is string => typeof r === 'string')

  // Nothing is offered as PASS/FAIL until every gate value is known: a variant missing one metric
  // must never read as shippable because the criterion it failed was the missing one.
  if (baseHard === null || variantHard === null || addedP50Ms === null || reasons.length > 0) {
    const blocked = reasons[0] ?? 'incomplete metrics'
    const blank = (id: GateId | 'c3', label: string): Criterion => ({ id, label, status: 'NOT COMPUTABLE', detail: blocked })
    return {
      status: 'NOT COMPUTABLE', mediumHard: null, easy: null, addedP50Ms: null, reasons,
      criteria: [blank('c1', GATES[0].label), blank('c2', GATES[1].label), PHASE_3, blank('c4', GATES[2].label)],
    }
  }

  const gain = variantHard - baseHard
  const drop = baseEasy!.recall10 - variantEasy!.recall10
  const measured: Record<GateId, { value: number; detail: string }> = {
    c1: { value: gain, detail: `gain ${pct(gain)} (variant ${variantHard.toFixed(4)} vs baseline ${baseHard.toFixed(4)})` },
    c2: { value: drop, detail: `drop ${pct(drop)} (variant ${variantEasy!.recall10.toFixed(4)} vs baseline ${baseEasy!.recall10.toFixed(4)})` },
    c4: { value: addedP50Ms, detail: `added p50 ${pct(addedP50Ms)} ms` },
  }
  const gate = ({ id, label, atLeast, threshold, unit }: Gate): Criterion => {
    const { value, detail } = measured[id]
    const pass = atLeast ? value + EPSILON >= threshold : value <= threshold + EPSILON
    return { id, label, status: pass ? 'PASS' : 'FAIL', detail: `${detail}; ${atLeast ? 'need' : 'allowed'} ${threshold}${unit}` }
  }
  const criteria = [gate(GATES[0]), gate(GATES[1]), PHASE_3, gate(GATES[2])]
  return {
    status: criteria.some((c) => c.status === 'FAIL') ? 'DO NOT SHIP' : 'SHIPPABLE',
    criteria,
    mediumHard: { baseline: baseHard, variant: variantHard, gain },
    easy: { baseline: baseEasy!.recall10, variant: variantEasy!.recall10, drop },
    addedP50Ms,
    reasons: [],
  }
}
