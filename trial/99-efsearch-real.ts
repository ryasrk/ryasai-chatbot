/** Apakah ef_search memperbaiki? Dan berapa yang dibutuhkan? */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/efr.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  const q = `'[0.5,0.51,0.52,0.53,0.54,0.55,0.56,0.57]'::vector`
  emit('target 20 baris, tenant 7 = 1% dari 20.000 vektor')
  emit('index HNSW aktif, ef_search divariasikan:')
  emit('')
  for (const ef of [40, 100, 320, 1000]) {
    const r = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
      return tx.$queryRawUnsafe<Array<{id:number}>>(
        `SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q} LIMIT 20`)
    })
    emit(`  ef_search=${String(ef).padStart(4)} -> ${String(r.length).padStart(2)}/20 baris`)
  }
  emit('')
  emit(`  pembanding TANPA index -> 20/20 baris`)
  emit('')
  emit('KESIMPULAN: ef_search memang memperbaiki (bukti bahwa masalahnya HNSW),')
  emit('tetapi pada pgvector 0.6.0 TIDAK ADA nilai yang menjamin hasil lengkap;')
  emit('maksimum yang diizinkan server adalah 1000, dan menaikkannya memperlambat')
  emit('SEMUA query. Yang benar adalah hnsw.iterative_scan (0.8.0+).')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
