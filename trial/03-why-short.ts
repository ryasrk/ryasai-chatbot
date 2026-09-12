/**
 * Why would evidence ever be SHORT (< 50 chars)?
 *
 * The reflection short-circuit only misfires when the assembled evidence is
 * under 50 chars. That cannot happen with real retrieved chunks (they are
 * ~1400 chars each). It CAN happen when a chunk is tiny — e.g. the placeholder
 * chunk written for a document whose text extraction produced nothing:
 *
 *   contentText = `[Empty document: ${file.name}]`
 *
 * An image-only PDF or a scanned document yields exactly that. Those chunks are
 * still embedded and still retrieved, and a retrieved placeholder CAN be the
 * whole evidence string when it is the only hit. This harness measures whether
 * placeholder chunks enter retrieval at all.
 */
import { db } from '../src/lib/db'
import { chunkText } from '../src/lib/rag'
import { retrieveRelevantChunks } from '../src/lib/rag'
import { createTrialOrg, dropTrialOrg, inOrg, hr } from './lib'

const REAL_DOC = `BAB III LEMBUR\nPengajuan lembur harus disetujui atasan.\nTarif lembur pada hari kerja adalah 1,5 kali upah per jam.`

async function main() {
  const slug = `trial-short-${Date.now().toString(36)}`
  const ctx = await createTrialOrg(slug)

  // A scanned/image-only PDF: extraction yields '' so the upload path writes a
  // placeholder instead of content. Reproduce that exact string.
  const PLACEHOLDER = '[Empty document: Scan Kontrak Vendor 2024.pdf]'

  await inOrg(ctx, async () => {
    for (const [name, body] of [
      ['SOP Kepegawaian 2024.pdf', REAL_DOC],
      ['Scan Kontrak Vendor 2024.pdf', PLACEHOLDER],
    ] as const) {
      const doc = await db.document.create({
        data: {
          organizationId: ctx.organizationId,
          name, type: 'TEXT', sizeBytes: body.length, mimeType: 'text/plain',
          status: 'ready', isEnabled: true, contentText: body,
        },
        select: { id: true },
      })
      await db.documentChunk.createMany({
        data: chunkText(body).map((c, i) => ({
          organizationId: ctx.organizationId, documentId: doc.id,
          chunkIndex: i, content: c, keywords: '',
        })),
      })
    }
  })

  const docs = await inOrg(ctx, () =>
    db.document.findMany({ select: { name: true, contentText: true } }),
  )
  hr('DOCUMENT CONTENT')
  for (const d of docs) {
    console.log(`${d.name}\n   contentText = ${JSON.stringify(d.contentText).slice(0, 80)} (${d.contentText.length} chars)`)
  }

  const nChunks = await inOrg(ctx, () => db.documentChunk.count())
  const shortest = await inOrg(ctx, () =>
    db.documentChunk.findMany({ select: { content: true }, orderBy: { content: 'asc' }, take: 2 }),
  )
  hr('CHUNKS')
  console.log(`total chunks: ${nChunks}`)
  for (const c of shortest) console.log(`   ${c.content.length} chars :: ${JSON.stringify(c.content).slice(0, 70)}`)

  hr('DOES A PLACEHOLDER CHUNK GET RETRIEVED?')
  for (const q of ['kontrak vendor 2024', 'berapa tarif lembur?', 'Scan Kontrak Vendor']) {
    const r = await inOrg(ctx, () => retrieveRelevantChunks({ query: q, topK: 5 }))
    const hasPlaceholder = r.chunks.some((c) => c.content.includes('[Empty document:'))
    console.log(`${q.padEnd(26)} chunks=${r.chunks.length} placeholder=${hasPlaceholder ? 'YES' : 'no'}`)
  }

  const evidenceLen = await inOrg(ctx, async () => {
    const r = await retrieveRelevantChunks({ query: 'Scan Kontrak Vendor', topK: 5 })
    return r.chunks.map((c) => c.content).join('\n\n').length
  })
  hr('SUMMARY')
  console.log(`assembled evidence for a placeholder-only query: ${evidenceLen} chars`)
  console.log(evidenceLen < 50
    ? '=> UNDER 50 chars: reflection short-circuits to INSUFFICIENT with no LLM call.'
    : '=> over 50 chars: short-circuit not triggered here.')

  await dropTrialOrg(ctx.organizationId)
  console.log('\ncleaned up')
  process.exit(0)
}

main().catch((e) => { console.error('TRIAL FAILED:', e); process.exit(1) })
