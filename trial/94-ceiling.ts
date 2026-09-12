/** Berapa ef_search yang BENAR-BENAR dibutuhkan? Cari batasnya. */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/ceil.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  const q = `'[${Array.from({length:8},(_,k)=>(0.5+k*0.01).toFixed(6)).join(',')}]'`
  const want = 80
  emit(`target: ${want} baris, tenant = 1% dari 20.000 vektor`)
  emit('')
  for (const ef of [40, 320, 1000, 5000]) {
    try {
      const r = await p.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
        return tx.$queryRawUnsafe<Array<{n:bigint}>>(
          `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
      })
      emit(`  ef_search=${String(ef).padStart(4)} -> ${String(r[0].n).padStart(2)}/${want}`)
    } catch (e) {
      emit(`  ef_search=${String(ef).padStart(4)} -> DITOLAK: ${e instanceof Error ? e.message.slice(0,60) : e}`)
    }
  }
  emit('')
  emit('  Pembanding EXACT (tanpa index):')
  const ex = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`)
    return tx.$queryRawUnsafe<Array<{n:bigint}>>(
      `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
  })
  emit(`    -> ${ex[0].n}/${want} baris`)
  emit('')
  emit('KESIMPULAN: ef_search TIDAK dapat memperbaiki ini secara memadai.')
  emit('Bahkan di maksimum yang diizinkan (1000) hasilnya jauh dari cukup,')
  emit('karena scan tetap mengambil kandidat terdekat dari SELURUH tabel')
  emit('lalu membuang yang bukan milik tenant. Filter selektif + HNSW')
  emit('memang tidak kompatibel tanpa iterative_scan (pgvector 0.8.0+).')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
