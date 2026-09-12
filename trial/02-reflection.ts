/**
 * Reflection-gate trial.
 *
 * Trial 01 showed retrieval reaches the needle for BOTH vague and specific
 * queries, so "I don't know" is NOT a recall failure. The remaining candidate
 * is `evaluateEvidenceSufficiency` (intent-pipeline.ts): if it returns
 * insufficient, `tool-branches.ts` injects the instruction
 * "If the evidence doesn't contain the answer, say so."
 *
 * This measures the gate directly, at each stage, so we can see WHERE quality
 * is lost. Note the <50-char short-circuit — a real defect surface, because it
 * judges sufficiency by LENGTH with no LLM call at all.
 */
import { evaluateEvidenceSufficiency } from '../src/lib/intent-pipeline'
import { hr } from './lib'

const NEEDLE = 'Tarif lembur pada hari kerja adalah 1,5 kali upah per jam.'

const CASES: Array<{ name: string; q: string; evidence: string; expect: 'sufficient' | 'insufficient' }> = [
  {
    name: 'direct hit, verbatim question',
    q: 'Berapa tarif lembur?',
    evidence: NEEDLE,
    expect: 'sufficient',
  },
  {
    name: 'direct hit, paraphrased question',
    q: 'Bagaimana aturan pembayaran kerja lembur di perusahaan ini?',
    evidence: NEEDLE,
    expect: 'sufficient',
  },
  {
    name: 'answer present but buried in a long chunk',
    q: 'berapa tarif lembur?',
    evidence:
      'BAB III LEMBUR DAN KOMPENSASI\nPengajuan lembur harus disetujui atasan langsung sebelum pelaksanaan.\n' +
      NEEDLE +
      '\nPerhitungan lembur dilakukan berdasarkan catatan absensi resmi. Pengajuan harus disetujui atasan.',
    expect: 'sufficient',
  },
  {
    name: 'short but complete evidence (tests the 50-char short-circuit)',
    q: 'berapa tarif lembur?',
    evidence: 'Tarif lembur hari kerja 1,5x upah per jam.',
    expect: 'sufficient',
  },
  {
    name: 'genuinely unrelated evidence',
    q: 'berapa tarif lembur?',
    evidence: 'Klasifikasi data dibagi menjadi publik, internal, dan rahasia.',
    expect: 'insufficient',
  },
]

async function main() {
  hr('REFLECTION GATE — does it correctly judge sufficiency?')
  let correct = 0
  for (const c of CASES) {
    const r = await evaluateEvidenceSufficiency({ question: c.q, evidence: c.evidence })
    const got = r.sufficient ? 'sufficient' : 'insufficient'
    const ok = got === c.expect
    if (ok) correct += 1
    console.log(
      `${ok ? 'OK  ' : 'WRONG'} ${c.name.padEnd(48)} got=${got.padEnd(12)} conf=${r.confidence.toFixed(2)} :: ${r.reason}`,
    )
  }
  hr('SUMMARY')
  console.log(`correct: ${correct}/${CASES.length}`)
  console.log(
    '\nNOTE: with the mock LLM configured on :4545 the JSON verdict is not a real\n' +
      'model judgment — this run only proves the gate is reachable and the\n' +
      'short-circuit branches behave as coded. Real verdict quality needs a real model.',
  )
}

main().catch((e) => {
  console.error('TRIAL FAILED:', e)
  process.exit(1)
})
