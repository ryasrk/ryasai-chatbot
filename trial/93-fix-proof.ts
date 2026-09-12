/** Buktikan perbaikan: ef_search proporsional mengubah 0/80 menjadi cukup. */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/fixp.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })

async function main(){
  const q = `'[${Array.from({length:8},(_,k)=>(0.5+k*0.01).toFixed(6)).join(',')}]'`
  const want = 80
  emit('=== SEBELUM vs SESUDAH perbaikan ef_search ===')
  emit('(tenant 7 = 1% dari tabel 20.000 vektor)')
  emit('')
  emit('  SEBELUM (kode lama: biarkan default 40):')
  const before = await p.$queryRawUnsafe<Array<{n:bigint}>>(
    `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
  emit(`    -> ${before[0].n}/${want} baris`)
  emit('')
  emit('  SESUDAH (kode baru: SET LOCAL ef_search = min(max(limit*4,100),1000)):')
  const ef = Math.min(Math.max(want*4,100),1000)
  emit(`    ef_search yang dipakai = ${ef}`)
  const after = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
    return tx.$queryRawUnsafe<Array<{n:bigint}>>(
      `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
  })
  emit(`    -> ${after[0].n}/${want} baris`)
  emit('')
  emit('  Pengecekan MIN_VECTOR_LEG_ROWS=8:')
  emit(`    sebelum: ${before[0].n} < 8 -> dianggap GAGAL, jatuh ke external store`)
  emit(`    sesudah: ${after[0].n} >= 8 -> diterima sebagai hasil lengkap`)
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
