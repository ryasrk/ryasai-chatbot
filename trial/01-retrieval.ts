/**
 * Retrieval trial — the "I don't know, but I do know" symptom.
 *
 * Seeds 3 documents where only ONE contains the answer to a specific question,
 * then asks the SAME question two ways:
 *   (a) vaguely        — "berapa tarif lembur?"            (how users actually ask)
 *   (b) source-named   — "menurut SOP Kepegawaian 2024…"   (what makes it work)
 *
 * If (a) fails to retrieve the chunk that (b) finds, the defect is in
 * retrieval/ranking, NOT the model — and that is what the user is hitting.
 */
import { db } from '../src/lib/db'
import { chunkText, extractKeywords } from '../src/lib/rag'
import { retrieveRelevantChunks } from '../src/lib/rag'
import { createTrialOrg, dropTrialOrg, inOrg, hr } from './lib'

// The needle: a precise, checkable fact that exists in exactly one document.
const NEEDLE = 'Tarif lembur pada hari kerja adalah 1,5 kali upah per jam.'

const DOCS = [
  {
    name: 'SOP Kepegawaian 2024.pdf',
    category: 'HR',
    // The answer lives here, buried in the middle the way real docs are.
    body: `BAB I PENDAHULUAN\nDokumen ini mengatur ketentuan kepegawaian perusahaan untuk periode 2024.\n\nBAB II JAM KERJA\nJam kerja normal adalah 40 jam per minggu, Senin sampai Jumat.\nKaryawan wajib melakukan absensi masuk dan keluar melalui sistem.\n\nBAB III LEMBUR DAN KOMPENSASI\nPengajuan lembur harus disetujui atasan langsung sebelum pelaksanaan.\n${NEEDLE}\nPerhitungan lembur dilakukan berdasarkan catatan absensi resmi.\n\nBAB IV CUTI\nCuti tahunan sebanyak 12 hari kerja per tahun.\n`,
  },
  {
    name: 'Panduan Pengadaan Barang.pdf',
    category: 'Procurement',
    body: `Prosedur pengadaan barang dan jasa internal.\nVendor wajib terdaftar dalam daftar pemasok yang disetujui.\nBatas nilai pengadaan langsung adalah 50 juta rupiah.\n`,
  },
  {
    name: 'Kebijakan Keamanan Data.docx',
    category: 'Security',
    body: `Klasifikasi data dibagi menjadi publik, internal, dan rahasia.\nAkses ke data rahasia memerlukan persetujuan tertulis.\n`,
  },
]

const QUERIES = [
  { kind: 'vague', q: 'berapa tarif lembur?' },
  { kind: 'vague', q: 'aturan lembur bagaimana?' },
  { kind: 'vague', q: 'lembur dibayar berapa?' },
  { kind: 'specific', q: 'menurut SOP Kepegawaian 2024, berapa tarif lembur?' },
  { kind: 'specific', q: 'SOP Kepegawaian lembur hari kerja tarif' },
]

async function main() {
  const slug = `trial-rag-${Date.now().toString(36)}`
  const ctx = await createTrialOrg(slug)
  console.log(`trial org ${ctx.organizationId}`)

  // Seed the corpus through the real chunking + keyword path, so retrieval sees
  // exactly what an uploaded document produces.
  for (const d of DOCS) {
    await inOrg(ctx, async () => {
      const doc = await db.document.create({
        data: {
          organizationId: ctx.organizationId,
          name: d.name,
          type: 'TEXT',
          sizeBytes: d.body.length,
          mimeType: 'text/plain',
          status: 'ready',
          isEnabled: true,
          contentText: d.body,
          category: d.category,
        },
        select: { id: true },
      })
      const chunks = chunkText(d.body)
      await db.documentChunk.createMany({
        data: chunks.map((c, i) => ({
          organizationId: ctx.organizationId,
          documentId: doc.id,
          chunkIndex: i,
          content: c,
          keywords: extractKeywords(c, 8),
        })),
      })
    })
  }

  const chunkCount = await inOrg(ctx, () => db.documentChunk.count())
  console.log(`seeded ${DOCS.length} docs, ${chunkCount} chunks`)

  hr('RETRIEVAL: does the needle chunk surface?')
  const results: Array<{ kind: string; q: string; hit: boolean; rank: number | null; topDoc: string }> = []

  for (const { kind, q } of QUERIES) {
    const r = await inOrg(ctx, () => retrieveRelevantChunks({ query: q, topK: 5 }))
    // Find the needle only via content match — we are measuring retrieval, not
    // asking the (mock) model anything.
    const idx = r.chunks.findIndex((c) => c.content.includes('1,5 kali upah'))
    const topDoc = r.chunks[0]?.content?.includes('1,5 kali') ? 'NEEDLE' : 'other'
    results.push({ kind, q, hit: idx >= 0, rank: idx >= 0 ? idx + 1 : null, topDoc })
    console.log(
      `${kind.padEnd(9)} ${q.slice(0, 44).padEnd(46)} needle=${idx >= 0 ? `rank ${idx + 1}` : 'MISS'} (${r.chunks.length} chunks)`,
    )
  }

  hr('SUMMARY')
  const vague = results.filter((r) => r.kind === 'vague')
  const specific = results.filter((r) => r.kind === 'specific')
  console.log(`vague    : ${vague.filter((r) => r.hit).length}/${vague.length} retrieved the needle`)
  console.log(`specific : ${specific.filter((r) => r.hit).length}/${specific.length} retrieved the needle`)

  await dropTrialOrg(ctx.organizationId)
  console.log('\ncleaned up')
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error('TRIAL FAILED:', e)
  process.exit(1)
})
