/**
 * BUKTI FINAL — dengan index vs tanpa index, pada query yang IDENTIK.
 * Inilah perbandingan yang menentukan: apakah HNSW yang membuang hasil?
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/final.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })

async function main(){
  const q = `'[0.5,0.51,0.52,0.53,0.54,0.55,0.56,0.57]'::vector`
  const sql = `SELECT id FROM hnsw_probe WHERE tenant_sel = 7 ORDER BY v <=> ${q} LIMIT 20`

  // tabel salinan TANPA index, isi sama persis
  await p.$executeRawUnsafe(`DROP TABLE IF EXISTS hnsw_exact`)
  await p.$executeRawUnsafe(`CREATE TABLE hnsw_exact AS SELECT * FROM hnsw_probe`)
  emit('dua tabel identik: hnsw_probe (ADA index) vs hnsw_exact (TANPA index)')
  emit('')

  const withIdx = await p.$queryRawUnsafe<Array<{id:number}>>(
    `SELECT id FROM hnsw_probe WHERE tenant = 7 ORDER BY v <=> ${q} LIMIT 20`)
  const noIdx = await p.$queryRawUnsafe<Array<{id:number}>>(
    `SELECT id FROM hnsw_exact WHERE tenant = 7 ORDER BY v <=> ${q} LIMIT 20`)

  emit('QUERY IDENTIK: WHERE tenant=7 ORDER BY v <=> q LIMIT 20')
  emit('')
  emit(`  hnsw_probe  (ADA HNSW index) -> ${withIdx.length} baris`)
  emit(`  hnsw_exact  (TANPA index)    -> ${noIdx.length} baris`)
  emit('')
  const missing = noIdx.filter(r => !withIdx.some(w => w.id === r.id))
  emit(`  HNSW kehilangan ${missing.length} dari ${noIdx.length} baris terbaik`)
  emit('')
  if (withIdx.length === 0 && noIdx.length > 0) {
    emit('>>> TERBUKTI: HNSW mengembalikan NOL, exact mengembalikan data.')
    emit('>>> Filter diterapkan SETELAH index scan; LIMIT menghentikan scan')
    emit('>>> lebih awal, sehingga baris tenant tidak pernah tercapai.')
  }
  await p.$executeRawUnsafe(`DROP TABLE IF EXISTS hnsw_exact`)
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
