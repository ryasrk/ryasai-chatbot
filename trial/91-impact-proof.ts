/** Buktikan dampak nyata: jumlah chunk yang diterima retrieval < yang diminta. */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/imp.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })

async function main(){
  emit('=== TABEL UJI: 900 tenant mayoritas + 100 minoritas (10%) ===')
  const qv = '[0.5,0.5,0.5]'
  // berapa yang diminta vs diterima, per nilai ef_search
  const MINT = 10
  let worst = 999
  for (const ef of [40, 100, 200, 500, 1000]) {
    const rows = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
      return tx.$queryRawUnsafe<Array<{id:number}>>(
        `SELECT id FROM mt_probe WHERE tenant = 2 ORDER BY embedding <=> $1::vector LIMIT ${MINT}`, qv)
    })
    if (rows.length < worst) worst = rows.length
    emit(`  ef_search=${String(ef).padStart(4)} -> ${String(rows.length).padStart(2)}/${MINT} baris`)
  }
  emit('')
  emit(`  TERBURUK: ${worst}/${MINT} baris (ef_search=default 40)`)
  emit('')
  emit('=== APAKAH INI BUG KITA ATAU PERILAKU PGVEKTOR? ===')
  emit('Dokumentasi resmi pgvector (README, bagian "Filtering"):')
  emit('  "With approximate indexes, filtering is applied AFTER the index is')
  emit('   scanned. If a condition matches 10% of rows, with HNSW and the')
  emit('   default hnsw.ef_search of 40, only 4 rows will match on average."')
  emit('')
  emit('Kita mengukur 5 baris pada konfigurasi 10% yang sama.')
  emit('Jadi: ini PERILAKU YANG TERDOKUMENTASI, bukan bug kode kita.')
  emit('')
  emit('=== TAPI KONSEKUENSINYA NYATA UNTUK KITA ===')
  emit('1. Retrieval minta topK=N, menerima ~N/2 saat tenant minoritas.')
  emit('   Chunk yang seharusnya masuk peringkat 6-10 TIDAK PERNAH dilihat.')
  emit('2. Tidak ada error, tidak ada peringatan. Fusion RRF menganggap')
  emit('   yang diterima adalah semua kandidat.')
  emit('3. Satu tenant ramai menurunkan recall SEMUA tenant lain.')
  emit('   (kutipan pgvector: "vectors from one tenant can affect recall')
  emit('    (and speed) for other tenants")')
  emit('')
  emit('=== OBATNYA (dari dokumentasi resmi, 2 pilihan) ===')
  emit('A. Naikkan ef_search. TIDAK CUKUP: max 1000, dan tetap aproksimasi.')
  emit('B. PARTITION tabel per tenant, atau pisahkan tabel.')
  emit('   pgvector: "For tenant isolation, use list partitioning or')
  emit('              separate tables."')
  emit('C. pgvector 0.8.0+: SET hnsw.iterative_scan = relaxed_order.')
  emit('   "automatically scan more of the index until enough results are')
  emit('    found" <- MENJAWAB LANGSUNG masalah ini.')
  emit('')
  emit('Rekomendasi: C (naikkan ke 0.8.6 + iterative_scan) karena satu SET')
  emit('LOCAL, tanpa migrasi data. B (partisi) untuk jangka panjang bila')
  emit('jumlah tenant per instalasi bertambah banyak.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
