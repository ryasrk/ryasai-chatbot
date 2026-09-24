/** Grade every fusion design on the synthetic benchmark, per tier. Offline; see fusion-design-arms.ts. */
import { gradeArm, loadBenchmarkData } from './arm-harness'
import { ARM_BUDGET, splitQuestions } from './arm-types'
import { DESIGN_ARMS } from './arms/fusion-design-arms'
import { bm25BaselineArm } from './arm-harness'

const data = loadBenchmarkData()
const { heldOut } = splitQuestions(data.questions)
const arms = [bm25BaselineArm, ...DESIGN_ARMS]
console.log(`synthetic held-out n=${heldOut.length}`)
console.log('| arm | easy | medium | hard | complex | ALL r@10 | MRR | ans@1 |')
console.log('|---|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const m = gradeArm(arm, heldOut, data.corpus, 'held-out', ARM_BUDGET)
  const t = (x: string) => (m.perTier[x]?.recall10 ?? 0).toFixed(4)
  console.log(`| ${arm.id} | ${t('easy')} | ${t('medium')} | ${t('hard')} | ${t('complex')} | ${m.overall.recall10.toFixed(4)} | ${m.overall.mrr.toFixed(4)} | ${m.overall.answerAt1.toFixed(4)} |`)
}
process.exit(0)
