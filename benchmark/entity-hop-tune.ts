/**
 * Phase 2 dev-split tuning for `maxHopDocs` (docs/entity-hop-retrieval-plan.md §4).
 *
 * WHY THIS IS A SEPARATE RUNNER AND A COMMITTED ARTIFACT
 * ----------------------------------------------------------------------------
 * The cap was tuned on the DEV split and then applied to the held-out split, which is
 * the plan's procedure. The first time this was done the DEV numbers existed only in a
 * terminal, so `benchmark/results/entity-hop-decision.md` quoted figures that nothing
 * could reproduce — exactly the drift the benchmark audit flagged. This runner writes
 * the sweep to JSON so the report's DEV table traces to a file.
 *
 * It reads DEV only, by construction: with any split name it selects `splitQuestions()`
 * .dev, so it cannot be pointed at the reported split by accident.
 *
 * Usage:
 *   bun benchmark/entity-hop-tune.ts --out=benchmark/results/entity-hop-tune.json
 */
import { writeFileSync } from 'node:fs'
import { gradeArm, loadBenchmarkData, bm25BaselineArm } from './arm-harness'
import { ARM_BUDGET, ENTITY_HOP_DEFAULTS, splitQuestions } from './arm-types'
import { makeEntityHopArm } from './arms/entity-hop-arm'
import { arm as hybridArm } from './arms/hybrid-arm'

/** Candidate caps. 200 is effectively uncapped and is the control. */
export const CAP_CANDIDATES = [3, 5, 8, 10, 12, 15, 20, 40, 80, 200]

export interface TuneRow {
  maxHopDocs: number
  easy: number
  medium: number
  hard: number
  all: number
  answerAt1: number
  mediumHardGainVsP2: number
}

function argOf(name: string, fallback: string | null = null): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** Mean of medium and hard, weighted by question count. */
function mediumHard(m: ReturnType<typeof gradeArm>): number {
  const med = m.perTier.medium
  const hard = m.perTier.hard
  if (!med && !hard) return 0
  const n = (med?.n ?? 0) + (hard?.n ?? 0)
  return ((med?.recall10 ?? 0) * (med?.n ?? 0) + (hard?.recall10 ?? 0) * (hard?.n ?? 0)) / (n || 1)
}

function main(): number {
  const out = argOf('out')
  const data = loadBenchmarkData()
  // DEV ONLY. Never the reported split.
  const { dev } = splitQuestions(data.questions)
  const ctx = data.corpus

  const p2 = gradeArm(hybridArm, dev, ctx, 'dev', ARM_BUDGET)
  const bm25 = gradeArm(bm25BaselineArm, dev, ctx, 'dev', ARM_BUDGET)
  const p2MediumHard = mediumHard(p2)

  const rows: TuneRow[] = []
  for (const cap of CAP_CANDIDATES) {
    const m = gradeArm(makeEntityHopArm({ maxHopDocs: cap }), dev, ctx, 'dev', ARM_BUDGET)
    rows.push({
      maxHopDocs: cap,
      easy: m.perTier.easy?.recall10 ?? 0,
      medium: m.perTier.medium?.recall10 ?? 0,
      hard: m.perTier.hard?.recall10 ?? 0,
      all: m.overall.recall10,
      answerAt1: m.overall.answerAt1,
      mediumHardGainVsP2: mediumHard(m) - p2MediumHard,
    })
  }

  console.log(`=== maxHopDocs sweep on the DEV split (n=${dev.length}) — never the reported split ===`)
  console.log(`P2 easy=${(p2.perTier.easy?.recall10 ?? 0).toFixed(4)} medium=${(p2.perTier.medium?.recall10 ?? 0).toFixed(4)} hard=${(p2.perTier.hard?.recall10 ?? 0).toFixed(4)} all=${p2.overall.recall10.toFixed(4)}`)
  console.log(`BM25 easy=${(bm25.perTier.easy?.recall10 ?? 0).toFixed(4)} all=${bm25.overall.recall10.toFixed(4)}`)
  console.log('')
  console.log('| maxHopDocs | easy | medium | hard | all | answer@1 | med+hard gain vs P2 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(`| ${r.maxHopDocs} | ${r.easy.toFixed(4)} | ${r.medium.toFixed(4)} | ${r.hard.toFixed(4)} | ${r.all.toFixed(4)} | ${r.answerAt1.toFixed(4)} | ${r.mediumHardGainVsP2 >= 0 ? '+' : ''}${r.mediumHardGainVsP2.toFixed(4)} |`)
  }
  // THE SELECTION RULE, stated so it is reproducible rather than remembered:
  // among caps that leave DEV easy AT OR ABOVE P2's (no drop at all), take the one with
  // the highest medium+hard gain. Choosing the LARGEST zero-drop cap instead would pick
  // a different value and forgo gain for nothing, so the rule is the gain-maximiser.
  const p2Easy = p2.perTier.easy?.recall10 ?? 0
  const zeroDrop = rows.filter((r) => r.easy >= p2Easy - 1e-9)
  const chosenRow = zeroDrop.length
    ? zeroDrop.reduce((best, r) => (r.mediumHardGainVsP2 > best.mediumHardGainVsP2 ? r : best))
    : null
  const chosen = chosenRow?.maxHopDocs ?? null
  console.log(`\nselection rule: max medium+hard gain among caps with a ZERO dev easy drop`)
  console.log(`  zero-drop caps: ${zeroDrop.map((r) => r.maxHopDocs).join(', ') || 'none'} (P2 easy = ${p2Easy.toFixed(4)})`)
  console.log(`  rule selects maxHopDocs = ${chosen ?? 'none'}${chosenRow ? ` at gain +${chosenRow.mediumHardGainVsP2.toFixed(4)}` : ''}`)
  // The shipped default must be what the rule selects, or the arm and its documentation disagree.
  if (chosen !== null && chosen !== ENTITY_HOP_DEFAULTS.maxHopDocs) {
    console.log(`  WARNING: shipped default is ${ENTITY_HOP_DEFAULTS.maxHopDocs}, rule selects ${chosen} — reconcile these`)
  }

  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          kind: 'entity-hop-tune',
          generatedAt: new Date().toISOString(),
          split: 'dev',
          devQuestions: dev.length,
          budget: ARM_BUDGET,
          capCandidates: CAP_CANDIDATES,
          baseline: {
            arm: 'hybrid-rrf',
            easy: p2Easy,
            medium: p2.perTier.medium?.recall10 ?? 0,
            hard: p2.perTier.hard?.recall10 ?? 0,
            all: p2.overall.recall10,
            mediumHard: p2MediumHard,
          },
          bm25Reference: { easy: bm25.perTier.easy?.recall10 ?? 0, all: bm25.overall.recall10 },
          selectionRule: 'max medium+hard gain among caps whose dev easy drop is zero',
          shippedDefault: ENTITY_HOP_DEFAULTS.maxHopDocs,
          chosen,
          rows,
        },
        null,
        2,
      ),
    )
    console.log(`wrote ${out}`)
  }
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main())
  } catch (e) {
    console.error('tune runner failed:', e)
    process.exit(1)
  }
}
