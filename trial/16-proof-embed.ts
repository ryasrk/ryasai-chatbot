/**
 * End-to-end proof that LOCAL embeddings change retrieval quality.
 *
 * Runs the SAME retrieval twice against the SAME org:
 *   A) embeddings configured (local sentence-transformers server)
 *   B) embedding config removed  (`embeddingProvider: null`)
 * If B == A, the embedding path is decorative and this "fix" is a placebo.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { retrieveRelevantChunks } from '../src/lib/rag'
import { retrieveWithReflection } from '../src/lib/intent-pipeline'
import { embedDocumentChunks } from '../src/lib/embeddings'
import { hr } from './lib'

const ORG = process.env.EVAL_ORG_ID!
const QS = [
  { id: 'ot-vague-id',   q: 'Berapa tarif lembur pada hari kerja?',        kw: ['1.5', 'hourly wage'] },
  { id: 'leave-vague-id',q: 'Berapa hari cuti tahunan yang diberikan?',   kw: ['annual leave', '12'] },
  { id: 'refund-window', q: 'Berapa lama jangka waktu pengajuan refund?', kw: ['30 days'] },
  { id: 'sec-breach',    q: 'Berapa lama batas waktu pelaporan kebocoran?', kw: ['72', 'breach'] },
  { id: 'off-topic',     q: 'Bagaimana cara membuat kue bolu?',           kw: [] },
]

async function measure(label: string) {
  hr(label)
  let hit = 0, tot = 0
  for (const item of QS) {
    const r = await retrieveWithReflection({ query: item.q, topK: 4 })
    const joined = r.chunks.map((c) => c.content).join('\n').toLowerCase()
    const best = r.chunks[0]?.scoreBreakdown
    const sem = best?.semanticSimilarity ?? 0
    if (item.id === 'off-topic') {
      console.log(`  [neg] ${item.id.padEnd(16)} chunks=${r.chunks.length} semantic=${sem.toFixed(3)} (want 0 chunks)`)
      continue
    }
    tot++
    const ok = item.kw.some((k) => joined.includes(k.toLowerCase()))
    if (ok) hit++
    console.log(`  ${ok ? 'HIT ' : 'MISS'} ${item.id.padEnd(16)} semantic=${sem.toFixed(3)} best=${(r.chunks[0]?.score ?? 0).toFixed(4)}`)
  }
  console.log(`  -> ${hit}/${tot}`)
  return hit / tot
}

async function main() {
  await bypassOrg(async () => {
    enterWithOrg(ORG)
    // Seed the corpus: re-use the earlier KB documents if present.
    const docs = await db.document.findMany({ select: { id: true, name: true } })
    console.log(`documents: ${docs.length}`)
    const chunks = await db.documentChunk.count()
    console.log(`chunks   : ${chunks}`)

    hr('BACKFILL EMBEDDINGS (through the app, not SQL)')
    let embedded = 0
    for (const d of docs) {
      const r = await embedDocumentChunks({ documentId: d.id })
      embedded += r.embedded
      console.log(`  ${d.name.slice(0, 34).padEnd(36)} embedded=${r.embedded} skipped=${r.skipped} model=${r.model ?? 'none'}`)
    }
    const withVec = await db.documentChunk.count({ where: { embeddingJson: { not: null } } })
    hr('EMBEDDING COVERAGE')
    console.log(`  chunks with embeddingJson: ${withVec}/${chunks}`)

    const withEmb = await measure('A) WITH LOCAL EMBEDDINGS')

    // --- remove embedding config and re-measure (negative control) ---
    const cfg = await db.llmConfig.findFirst({ select: { id: true } })
    if (cfg) {
      await db.llmConfig.update({
        where: { id: cfg.id },
        data: { embeddingProvider: null, embeddingBaseUrl: null, embeddingModel: null,
                encryptedEmbeddingApiKey: null },
      })
    }
    const noEmb = await measure('B) WITHOUT EMBEDDING CONFIG (negative control)')
    await db.documentChunk.updateMany({ data: { embeddingJson: null } })
    const withEmbNoVec = await measure('C) EMBEDDING CONFIG OFF *AND* VECTORS CLEARED')

    hr('VERDICT')
    console.log(`  A (local embeddings)      : ${(withEmb * 100).toFixed(0)}%`)
    console.log(`  B (config removed)        : ${(noEmb * 100).toFixed(0)}%`)
    console.log(`  C (vectors also cleared)  : ${(withEmbNoVec * 100).toFixed(0)}%`)
    console.log(`  embeddings actually matter: ${withEmb > noEmb || withEmb > withEmbNoVec ? 'YES' : 'NO — PLACEBO'}`)
  })
  process.exit(0)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
