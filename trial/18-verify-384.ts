/**
 * Does a 384-dim model now populate DocumentChunk.embedding AND influence ranking?
 * Run against a resized schema (embedding vector(384)).
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { chunkText, extractKeywords, retrieveRelevantChunks } from '../src/lib/rag'
import { embedDocumentChunks, getEmbeddingRuntimeConfig, embedTexts } from '../src/lib/embeddings'
import { hr } from './lib'

const ORG = process.env.EVAL_ORG_ID!
async function main() {
  await bypassOrg(async () => {
    enterWithOrg(ORG)
    const doc = await db.document.create({
      data: {
        organizationId: ORG, name: 'Probe Overtime Policy.txt', category: 'HR',
        type: 'txt', status: 'ready', isEnabled: true, sizeBytes: 10, mimeType: 'text/plain',
        contentText: 'OT',
      },
      select: { id: true },
    })
    const body = 'OVERTIME AND COMPENSATION\nOvertime must be approved by the direct supervisor before it is performed.\nThe overtime rate on a working day is 1.5 times the hourly wage.\nOvertime is calculated from the official attendance record only.'
    const parts = chunkText(body)
    for (let i = 0; i < parts.length; i++) {
      await db.documentChunk.create({
        data: { organizationId: ORG, documentId: doc.id, chunkIndex: i, content: parts[i], keywords: extractKeywords(parts[i]) },
      })
    }
    const cfg = await getEmbeddingRuntimeConfig()
    console.log('embedding cfg:', cfg?.model)
    if (!cfg) throw new Error('no embedding config')

    const r = await embedDocumentChunks({ documentId: doc.id })
    hr('BACKFILL RESULT')
    console.log(`embedded=${r.embedded} skipped=${r.skipped}`)

    const raw = await db.$queryRaw<Array<{ n: bigint }>>`
      select count(*) as n from "DocumentChunk" where "documentId" = ${doc.id} and embedding is not null`
    console.log(`rows with a pgvector value stored: ${raw[0].n}`)

    // Direct pgvector similarity query, the leg that was previously dead.
    const qv = (await embedTexts(cfg, ['Berapa tarif lembur pada hari kerja?']))[0]
    const hits = await db.$queryRaw<Array<{ content: string; similarity: number }>>`
      SELECT content, 1 - (embedding <=> ${`[${qv.join(',')}]`}::vector) AS similarity
      FROM "DocumentChunk" WHERE embedding IS NOT NULL AND "organizationId" = ${ORG}
      ORDER BY embedding <=> ${`[${qv.join(',')}]`}::vector LIMIT 3`
    hr('PGVECTOR LEG (was returning an empty set)')
    for (const h of hits) console.log(`  sim=${h.similarity.toFixed(4)} ${JSON.stringify(h.content.slice(0, 60))}`)

    const ret = await retrieveRelevantChunks({ query: 'Berapa tarif lembur pada hari kerja?', topK: 4 })
    hr('FULL RETRIEVAL')
    for (const c of ret.chunks) {
      const b = c.scoreBreakdown
      console.log(`  score=${c.score.toFixed(4)} sem=${b.semanticSimilarity.toFixed(3)} semScore=${b.semanticScore} ${JSON.stringify(c.content.slice(0, 46))}`)
    }
    process.exit(0)
  })
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
