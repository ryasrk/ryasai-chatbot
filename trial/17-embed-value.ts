/**
 * Where do embeddings EARN their keep?
 *
 * trial/16 proved local embeddings are live (semantic 0.27-0.67) but changed
 * nothing on 4 questions — because the bilingual synonym bridge already handles
 * those. A bridge only works for vocabulary someone listed. These are the cases
 * it CANNOT cover, so they isolate the embedding contribution:
 *
 *   1. paraphrase / no shared token with the document
 *   2. a term absent from the synonym map entirely
 *   3. English doc, Indonesian question, ZERO overlapping content words
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { retrieveWithReflection } from '../src/lib/intent-pipeline'
import { embedDocumentChunks, getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { hr } from './lib'

const ORG = process.env.EVAL_ORG_ID!

const QS = [
  { id: 'paraphrase-1', q: 'Seberapa besar kompensasi tambahan bila staf diminta bekerja melewati jam normal?', kw: ['1.5', 'overtime'] },
  { id: 'paraphrase-2', q: 'Berapa jatah hari libur berbayar untuk pegawai setiap tahun?', kw: ['12', 'annual leave'] },
  { id: 'unmapped-term', q: 'Apa sanksi bagi pegawai yang datang terlambat?', kw: ['lateness', 'late', 'disciplinary', 'warning'] },
  { id: 'no-shared-word', q: 'Bagaimana perusahaan melindungi informasi rahasia milik klien?', kw: ['encrypt', 'confidential', 'classification'] },
  { id: 'numeric-semantic', q: 'Dalam tempo berapa lama uang pembeli dikembalikan?', kw: ['14', 'refund'] },
]

async function measure(label: string) {
  hr(label)
  let lexicalOnly = 0, anyHit = 0
  for (const item of QS) {
    const r = await retrieveWithReflection({ query: item.q, topK: 4 })
    const joined = r.chunks.map((c) => c.content).join('\n').toLowerCase()
    const sem = Math.max(...r.chunks.map((c) => c.scoreBreakdown.semanticSimilarity), 0)
    const hit = item.kw.some((k) => joined.includes(k.toLowerCase()))
    if (hit) anyHit++
    console.log(`  ${hit ? 'HIT ' : 'MISS'} ${item.id.padEnd(15)} sem=${sem.toFixed(3)} chunks=${r.chunks.length}`)
  }
  console.log(`  -> ${anyHit}/${QS.length}`)
  return anyHit
}

async function main() {
  await bypassOrg(async () => {
    enterWithOrg(ORG)
    const chunks = await db.documentChunk.count()
    const cfg = await db.llmConfig.findFirst({ select: { id: true } })
    if (!cfg) throw new Error('no llm config')

    // --- A: embeddings ON ---
    // NOTE: must set ALL FOUR fields. Leaving embeddingBaseUrl unset makes the
    // app fall back to the CHAT base URL and default the model to
    // 'text-embedding-3-small' — which the chat-only gateway rejects with
    // HTTP 400. That failure is a config mistake, not a product bug, and it cost
    // a debugging cycle here.
    const key = (await db.llmConfig.findFirst({ select: { encryptedApiKey: true } }))!.encryptedApiKey
    await db.llmConfig.update({
      where: { id: cfg.id },
      data: {
        embeddingProvider: 'OPENAI_COMPATIBLE',
        embeddingBaseUrl: process.env.EMB_BASE_URL,
        embeddingModel: process.env.EMB_MODEL,
        encryptedEmbeddingApiKey: key,
      },
    })
    // Assert the config actually resolved BEFORE measuring, so a config mistake
    // can never be mistaken for "embeddings did not help".
    const resolved = await getEmbeddingRuntimeConfig()
    console.log(`  config  : ${resolved?.provider} ${resolved?.baseUrl} ${resolved?.model}`)
    if (!resolved || resolved.baseUrl !== process.env.EMB_BASE_URL || resolved.model !== process.env.EMB_MODEL) {
      throw new Error(`embedding config did NOT resolve as intended: ${JSON.stringify(resolved)}`)
    }
    // Re-embed AFTER the config is correct (an earlier run embedded against the
    // wrong endpoint and stored nothing).
    for (const d of await db.document.findMany({ select: { id: true } })) {
      await embedDocumentChunks({ documentId: d.id })
    }
    const withEmb = await measure(`A) EMBEDDINGS ON (${chunks} chunks)`)

    // --- B: embeddings OFF, vectors gone ---
    await db.llmConfig.update({
      where: { id: cfg.id },
      data: { embeddingProvider: null, embeddingBaseUrl: null, embeddingModel: null, encryptedEmbeddingApiKey: null },
    })
    await db.documentChunk.updateMany({ data: { embeddingJson: null } })
    const noEmb = await measure('B) EMBEDDINGS OFF + VECTORS CLEARED (lexical bridge only)')

    hr('VERDICT ON HARD CASES')
    console.log(`  A) with local embeddings : ${withEmb}/${QS.length}`)
    console.log(`  B) lexical bridge only   : ${noEmb}/${QS.length}`)
    console.log(`  embeddings add value     : ${withEmb > noEmb ? `YES (+${withEmb - noEmb})` : 'NO'}`)
  })
  process.exit(0)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
