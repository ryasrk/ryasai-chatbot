/**
 * Ablation runner + decision report for Entity-Hop (docs/entity-hop-retrieval-plan.md, Phase 2).
 *
 * The plan's criteria live in `entity-hop-verdict.ts` as constants, not as a reading of the table,
 * and every ablation is one flag through `makeEntityHopArm` — the shipped arm's own code path,
 * because two implementations would measure the difference between two files instead of one
 * component on and off. The baseline is the production hybrid arm (P2) when usable; when it is not,
 * the verdict line says so rather than letting a BM25 comparison pass as the gate.
 *
 * Usage: bun benchmark/entity-hop-ablation.ts --split=held-out --out=benchmark/results/entity-hop-ablation.json
 * Exit: 0 measured · 2 bad arguments · 3 the Entity-Hop arm is absent, so nothing was measured.
 */
import { existsSync } from 'node:fs'
import { ARM_BUDGET, duplicateStats, splitQuestions } from './arm-types'
import type { Arm, ArmMetrics, EntityHopAblation, EntityHopArmFactory } from './arm-types'
import { DEFAULT_EMBEDDING_CACHE, argOf, bm25BaselineArm, gradeArm, loadBenchmarkData, renderArmMetrics } from './arm-harness'
import { decideVerdict } from './entity-hop-verdict'
import type { Verdict } from './entity-hop-verdict'

// The decision rule is part of this runner's contract, so it is re-exported from here too.
export * from './entity-hop-verdict'

/** One flag each, as Phase 2 lists them; hops-3 is added to test the 3-hop hard tier. */
export interface VariantSpec { name: string; options?: Partial<EntityHopAblation>; note: string }

export const VARIANTS: VariantSpec[] = [
  // Named after the arm's own id for the default options, so a row is traceable to the official
  // `entity-hop` entry rather than to a nickname only this runner knows.
  { name: 'entity-hop', note: 'full/defaults: seedSize 4, maxHops 2, MAX_DF 60, decay 0.5' },
  { name: 'ablate-rarity-weight', options: { disableRarityWeight: true }, note: 'rarity weight off' },
  { name: 'ablate-hub-cutoff', options: { disableHubCutoff: true }, note: 'hub cutoff off' },
  { name: 'ablate-negation', options: { disableNegation: true }, note: 'negation skipping off' },
  { name: 'hops-1', options: { maxHops: 1 }, note: 'H=1' },
  { name: 'hops-3', options: { maxHops: 3 }, note: 'H=3' },
  // The tail-dilution control. UNCAPPED is the shape that failed the easy-tier gate by 13x; a variant
  // that reproduces it is kept so the failure stays reproducible after the default changes.
  { name: 'ablate-hop-doc-cap', options: { maxHopDocs: 200 }, note: 'hop ranking uncapped (the failing shape)' },
]

interface HopModule { arm?: Arm; makeEntityHopArm?: EntityHopArmFactory }
interface Section { spec: VariantSpec; metrics: ArmMetrics | null; reason: string | null; verdict: Verdict }

/** An absent or broken arm is REPORTED, never stubbed: a stub scores like a bad retriever. */
async function tryImport(url: URL): Promise<{ mod?: HopModule; error: string | null }> {
  if (!existsSync(url)) return { error: 'file not present' }
  try {
    return { mod: (await import(url.href)) as HopModule, error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) }
  }
}

const f4 = (v: number | undefined) => (v === undefined ? 'n/a' : v.toFixed(4))
/** Summary row: the requested columns — medium/hard/all recall@10, answer@1, p50, per-hop recall. */
function summaryRow(name: string, m: ArmMetrics | undefined): string {
  if (!m) return `| ${name} | NOT COMPUTABLE | — | — | — | — | — |`
  const hop = m.overall.hopRecall.map((h) => h.toFixed(3)).join('/') || 'n/a'
  return `| ${name} | ${f4(m.perTier['medium']?.recall10)} | ${f4(m.perTier['hard']?.recall10)} | ` +
    `${f4(m.overall.recall10)} | ${f4(m.overall.answerAt1)} | ${m.overall.latencyP50Ms.toFixed(2)} | ${hop} |`
}

async function main(): Promise<number> {
  const scope = argOf('split', argOf('scope', 'held-out'))!
  if (!['dev', 'held-out', 'all'].includes(scope)) {
    console.error(`--split must be dev|held-out (got "${scope}")`)
    return 2
  }
  const out = argOf('out')
  const only = process.argv.flatMap((a) => (a.startsWith('--only=') ? a.slice(7).split(',') : []))
  const selected = VARIANTS.filter((v) => only.length === 0 || only.includes(v.name))
  if (selected.length === 0) {
    console.error(`--only matched no variant. Known: ${VARIANTS.map((v) => v.name).join(', ')}`)
    return 2
  }

  const data = loadBenchmarkData(undefined, undefined, argOf('embeddings', DEFAULT_EMBEDDING_CACHE)!)
  const { dev, heldOut } = splitQuestions(data.questions)
  const questions = scope === 'dev' ? dev : scope === 'all' ? data.questions : heldOut
  const ctx = data.corpus

  const hybrid = await tryImport(new URL('./arms/hybrid-arm.ts', import.meta.url))
  let production = hybrid.mod?.arm
  let fallback = `lexical-first-hybrid not usable (${hybrid.error ?? 'no arm export'})`
  if (production && !production.ready(ctx)) {
    fallback = `lexical-first-hybrid present but NOT READY (${ctx.embeddings ? 'unknown missing input' : 'no vector cache'})`
    production = undefined
  } else if (production) fallback = ''
  // BM25 is graded every run: it is the reference the recorded cognee/supermemory rows compare to.
  const reference = gradeArm(bm25BaselineArm, questions, ctx, scope)
  const baseline: Arm = production ?? bm25BaselineArm
  const baselineMetrics = production ? gradeArm(production, questions, ctx, scope) : reference
  const isP2 = baseline.id === production?.id

  const hop = await tryImport(new URL('./arms/entity-hop-arm.ts', import.meta.url))
  const factory = hop.mod?.makeEntityHopArm
  const armError = factory ? null : (hop.error ?? 'module has no makeEntityHopArm export')
  // One row per variant. A missing / not-ready / throwing arm becomes NOT COMPUTABLE, never a
  // fabricated score, so its criterion list can never contain a PASS.
  const sections: Section[] = selected.map((spec) => {
    let metrics: ArmMetrics | null = null
    let reason = armError ? `benchmark/arms/entity-hop-arm.ts unusable: ${armError}` : null
    if (factory) {
      try {
        const arm = factory(spec.options)
        reason = arm.ready(ctx) ? null : 'arm reports not ready (missing vectors or index)'
        if (!reason) metrics = gradeArm(arm, questions, ctx, scope)
      } catch (e) {
        reason = `arm threw: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
      }
    }
    return { spec, metrics, reason, verdict: decideVerdict({ baselineMetrics, variantMetrics: metrics, unavailable: reason }) }
  })

  console.log(`\n=== ENTITY-HOP ABLATION — split=${scope} (dev ${dev.length} / held-out ${heldOut.length}) ===`)
  console.log(`corpus ${ctx.docIds.length} docs · budget top-${ARM_BUDGET} · questions ${questions.length} · ` +
    `vectors: ${ctx.embeddings ? `yes (${ctx.embeddingModel})` : 'NONE — vector variants NOT COMPUTABLE'}`)
  // Printed in the form the gate needs, so an optimistic BM25 comparison cannot be quoted as a pass
  // of the "beats P2" rule.
  console.log(`\nBASELINE=${isP2 ? `${baseline.id} (production hybrid, P2)` : 'bm25 (production hybrid unavailable)'}` +
    `${fallback ? ` — ${fallback}` : ''}`)
  if (!isP2) console.log('!! Gain is OPTIMISTIC, NOT THE GATE: the plan measures +0.10 against P2, and BM25\n' +
    '!! is weaker than P2. No verdict below is a Phase-2 gate pass until re-run with P2.')
  // Printed because a decision report is unreadable without it: the generated set repeats question
  // texts across conflicting evidence sets, which caps attainable recall no matter how good the arm
  // is. Same stats the harness banner reports, from the same shared helper.
  const dup = duplicateStats(data.questions)
  console.log(`rows ${dup.rows} · distinct question texts ${dup.distinctTexts} · ` +
    `collapsed rows ${dup.collapsedRows} · conflicting evidence sets ${dup.conflictingRows} · ` +
    `texts straddling the split ${dup.straddlingTexts} · embeddings ${ctx.embeddings ? Object.values(ctx.embeddings)[0]?.length : 0}-dim`)

  console.log('\n### Ablation summary\n')
  console.log('| variant | medium r@10 | hard r@10 | all r@10 | answer@1 all | p50 ms | per-hop r@10 |')
  console.log('|---|---|---|---|---|---|---|')
  console.log([
    summaryRow('bm25-baseline (reference row)', reference),
    ...(production ? [summaryRow(`${baseline.id} (DECISION BASELINE)`, baselineMetrics)] : []),
    ...sections.map(({ spec, metrics }) => summaryRow(spec.name, metrics ?? undefined)),
  ].join('\n'))
  console.log('\n### Detailed rows (renderArmMetrics) — every arm, every tier\n')
  console.log(renderArmMetrics([
    reference, ...(production ? [baselineMetrics] : []), ...sections.flatMap((s) => (s.metrics ? [s.metrics] : [])),
  ]))

  console.log(`\n### Decision (plan §1) — baseline ${isP2 ? baseline.id : 'bm25 (NOT P2)'}\n`)
  console.log(sections.map(({ spec, verdict }) => [
    `${spec.name} — ${spec.note}`,
    ...verdict.criteria.map((c) => `  [${c.status.padEnd(14)}] ${c.label}\n                    ${c.detail}`),
    `  VERDICT: ${verdict.status}${verdict.status === 'SHIPPABLE' ? ' (Phase-2 gate passed; Phase 3 still pending)' : ''}`,
  ].join('\n')).join('\n\n'))
  // Separate from the per-variant reasons above, because it invalidates the whole run.
  if (armError) console.log(`\nUNVERIFIED: benchmark/arms/entity-hop-arm.ts unusable (${armError}).\n` +
    'No Entity-Hop row above rests on measured data, and no verdict was computed from data.')

  if (out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(out, JSON.stringify({
      kind: 'entity-hop-ablation', generatedAt: new Date().toISOString(), scope, budget: ARM_BUDGET,
      command: `bun benchmark/entity-hop-ablation.ts --split=${scope} --out=${out}`,
      thresholds: { MIN_MEDIUM_HARD_GAIN: 0.1, MAX_EASY_DROP: 0.01, MAX_ADDED_P50_MS: 50 },
      corpus: { documents: ctx.docIds.length, embeddingModel: ctx.embeddingModel ?? null },
      counts: { dev: dev.length, heldOut: heldOut.length, questions: questions.length },
      baseline: { id: baseline.id, isProductionP2: isP2, gainIsOptimistic: !isP2, fallbackReason: fallback || null },
      entityHopArm: { available: Boolean(factory), error: armError },
      bm25ReferenceMetrics: reference, baselineMetrics, variants: sections.map(({ spec, metrics, reason, verdict }) => ({
        name: spec.name, note: spec.note, options: spec.options ?? {}, notComputable: reason, metrics, verdict,
      })),
    }, null, 2))
    console.log(`\nwrote ${out}`)
  }
  return factory ? 0 : 3
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('ablation runner failed:', e)
    process.exit(1)
  })
}
