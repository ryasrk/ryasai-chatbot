/**
 * Offline `k` sweep — row 6 of docs/retrieval-production-integration-plan.md §6b.
 *
 * WHAT IT ANSWERS: does moving the RRF dampening constant change the ranking, and in
 * which direction per tier? This is a PLAUSIBILITY CHECK, not the shipping decision.
 * The decision comes from the product-surface A/B in §6a (three runs, a real corpus, a
 * reranker and a knowledge-graph leg this sweep does not have).
 *
 * WHY PER TIER AND NOT AN AVERAGE: the mechanism is a head-versus-tail trade. A lower `k`
 * strengthens a strong single-leg rank (helping questions one leg nails, typically easy)
 * and a higher `k` rewards cross-leg agreement (helping questions neither leg ranks well).
 * An all-questions average is the one statistic guaranteed to hide that.
 *
 * Usage:
 *   bun benchmark/fusion-k-sweep.ts --scope=held-out --out=benchmark/results/fusion-k-sweep.json
 */
import { writeFileSync } from 'node:fs'
import { gradeArm, loadBenchmarkData } from './arm-harness'
import { ARM_BUDGET, splitQuestions } from './arm-types'
import { FUSION_K_CANDIDATES, SHIPPED_K, makeFusionKArm } from './arms/fusion-k-arm'

/** Per-tier recall@10, plus enough context to see whether a row is usable. */
export interface SweepRow {
  k: number
  /** Which tier metrics came from. */
  perTier: Record<string, { n: number; recall5: number; recall10: number; mrr: number }>
  overall: { n: number; recall5: number; recall10: number; mrr: number; answerAt1: number }
  p50Ms: number
}

function argOf(name: string, fallback: string | null = null): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function sweep(scope: 'held-out' | 'dev' | 'all'): SweepRow[] {
  const data = loadBenchmarkData()
  const { dev, heldOut } = splitQuestions(data.questions)
  const questions = scope === 'dev' ? dev : scope === 'all' ? data.questions : heldOut
  const rows: SweepRow[] = []
  for (const k of FUSION_K_CANDIDATES) {
    const metrics = gradeArm(makeFusionKArm(k), questions, data.corpus, scope, ARM_BUDGET)
    rows.push({
      k,
      perTier: Object.fromEntries(
        Object.entries(metrics.perTier).map(([tier, m]) => [
          tier,
          { n: m.n, recall5: m.recall5, recall10: m.recall10, mrr: m.mrr },
        ]),
      ),
      overall: {
        n: metrics.overall.n,
        recall5: metrics.overall.recall5,
        recall10: metrics.overall.recall10,
        mrr: metrics.overall.mrr,
        answerAt1: metrics.overall.answerAt1,
      },
      // Wall clock, not a quality signal: it moves between runs and is reported only so a
      // reader can see that k does not change the cost meaningfully.
      p50Ms: metrics.overall.latencyP50Ms ?? 0,
    })
  }
  return rows
}

function main(): number {
  const scope = (argOf('scope', 'held-out') ?? 'held-out') as 'held-out' | 'dev' | 'all'
  const out = argOf('out')
  const rows = sweep(scope)
  const tiers = [...new Set(rows.flatMap((r) => Object.keys(r.perTier)))]

  const data = loadBenchmarkData()
  const { dev, heldOut } = splitQuestions(data.questions)
  const n = scope === 'dev' ? dev.length : scope === 'all' ? data.questions.length : heldOut.length

  console.log(`=== RRF k sweep · scope=${scope} (n=${n}) · budget top-${ARM_BUDGET} ===`)
  console.log(`shipped default k=${SHIPPED_K} is marked with *`)
  console.log('')
  const header = ['k', ...tiers.map((t) => `${t} r@10`), 'ALL r@10', 'ALL r@5', 'ALL MRR', 'ans@1', 'p50 ms']
  console.log(`| ${header.join(' | ')} |`)
  console.log(`|${header.map(() => '---').join('|')}|`)
  for (const r of rows) {
    const cells = [
      r.k === SHIPPED_K ? `*${r.k}` : String(r.k),
      ...tiers.map((t) => (r.perTier[t] ? r.perTier[t].recall10.toFixed(4) : 'n/a')),
      r.overall.recall10.toFixed(4),
      r.overall.recall5.toFixed(4),
      r.overall.mrr.toFixed(4),
      r.overall.answerAt1.toFixed(4),
      r.p50Ms.toFixed(2),
    ]
    console.log(`| ${cells.join(' | ')} |`)
  }

  // Report the best k per tier, because "which k is best" is tier-dependent by
  // construction, and printing a single winner would hide the tradeoff the sweep exists
  // to expose.
  console.log('')
  console.log('best k per tier (by recall@10):')
  for (const tier of tiers) {
    const best = rows.reduce((a, b) =>
      (b.perTier[tier]?.recall10 ?? -1) > (a.perTier[tier]?.recall10 ?? -1) ? b : a,
    )
    const shipped = rows.find((r) => r.k === SHIPPED_K)
    const delta = (best.perTier[tier]?.recall10 ?? 0) - (shipped?.perTier[tier]?.recall10 ?? 0)
    console.log(
      `  ${tier.padEnd(8)} k=${String(best.k).padStart(3)}  r@10=${(best.perTier[tier]?.recall10 ?? 0).toFixed(4)}` +
        `  (vs shipped k=${SHIPPED_K}: ${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`,
    )
  }

  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          kind: 'fusion-k-sweep',
          generatedAt: new Date().toISOString(),
          scope,
          questions: n,
          budget: ARM_BUDGET,
          shippedK: SHIPPED_K,
          candidates: FUSION_K_CANDIDATES,
          rows,
          caveat:
            'Offline only. Inherits every documented difference from production: no reranker, no ' +
            'knowledge-graph leg, no keywords field, whole-corpus lexical leg. The shipping decision ' +
            'is docs/retrieval-production-integration-plan.md §6a, not this file.',
        },
        null,
        2,
      ),
    )
    console.log(`\nwrote ${out}`)
  }
  return 0
}

try {
  // `@/lib/rag` opens a DB handle on import, so the process would otherwise hang.
  process.exit(main())
} catch (e) {
  console.error('k sweep failed:', e)
  process.exit(1)
}
