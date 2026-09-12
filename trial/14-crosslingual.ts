/**
 * Measure the cross-lingual retrieval gap.
 *
 * Documents are frequently authored in English (vendor policies, handbooks)
 * while users ask in Indonesian. `tokenize` is exact-match word matching and
 * this deployment has NO embedding provider, so nothing bridges the two.
 *
 * Reports, per golden question: how many chunks retrieval returns, whether the
 * chunk holding the answer is among them, and the best score — split by whether
 * the question was asked in Indonesian or English.
 */
import { db } from '../src/lib/db'
import { retrieveRelevantChunks } from '../src/lib/rag'
import { retrieveWithReflection } from '../src/lib/intent-pipeline'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { readFileSync } from 'node:fs'
import { hr } from './lib'

const ORG = process.env.EVAL_ORG_ID!
const GOLDEN = process.env.GOLDEN_PATH ?? '/tmp/golden-custom.json'

interface Q { id: string; question: string; expectedKeywords?: string[]; kind: string }

async function main() {
  const qs = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { questions: Q[] }).questions
  await bypassOrg(async () => {
    enterWithOrg(ORG)
    const chunks = await db.documentChunk.findMany({ select: { content: true } })
    console.log(`corpus: ${chunks.length} chunks\n`)

    hr('RETRIEVAL PER QUESTION')
    let idHit = 0, idTotal = 0, enHit = 0, enTotal = 0
    for (const q of qs) {
      if (q.kind === 'unanswerable') continue
      const kws = q.expectedKeywords ?? []
      // RAW = single pass, no expansion. ORCH = what the product actually runs
      // (retrieveWithReflection applies expandQuery first). Measuring only the
      // raw path would hide the expansion fix entirely.
      const raw = await retrieveRelevantChunks({ query: q.question, topK: 4 })
      const orch = await retrieveWithReflection({ query: q.question, topK: 4 })
      const r = { chunks: orch.chunks, _raw: raw }
      const joined = r.chunks.map((c) => c.content).join('\n').toLowerCase()
      // "hit" = a keyword of the expected answer appears in the retrieved text
      const hit = kws.length > 0 && kws.some((k) => joined.includes(String(k).toLowerCase()))
      const isId = /^(berapa|menurut|siapa|kapan|bagaimana|apa)/i.test(q.question.trim())
      if (isId) { idTotal += 1; if (hit) idHit += 1 } else { enTotal += 1; if (hit) enHit += 1 }
      const rawJoined = raw.chunks.map((c) => c.content).join('\n').toLowerCase()
      const rawHit = kws.length > 0 && kws.some((k) => rawJoined.includes(String(k).toLowerCase()))
      console.log(
        `${hit ? 'HIT ' : 'MISS'} [${isId ? 'ID' : 'EN'}] ${q.id.padEnd(20)} raw=${rawHit ? 'hit ' : 'miss'} (${String(raw.chunks.length).padEnd(2)}ch) -> orch=${hit ? 'hit ' : 'miss'} (${String(r.chunks.length).padEnd(2)}ch)  ${q.question.slice(0, 40)}`,
      )
    }

    hr('SUMMARY — does retrieval surface the answer?')
    console.log(`Indonesian questions: ${idHit}/${idTotal} retrieved the answer`)
    console.log(`English questions   : ${enHit}/${enTotal} retrieved the answer`)
    const tot = idHit + enHit, all = idTotal + enTotal
    console.log(`overall             : ${tot}/${all} = ${all ? ((tot / all) * 100).toFixed(0) : 'n/a'}%`)
  })
  process.exit(0)
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
