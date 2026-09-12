/**
 * BUKTI BERSIH: filter SETELAH index scan -> hasil hilang.
 * Tanpa subquery, EXPLAIN dikutip, angka langsung.
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/clean.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  const q = `'[0.5,0.51,0.52,0.53,0.54,0.55,0.56,0.57]'`
  emit('setup: 20.000 vektor, 100 tenant x 200 baris (1% tabel masing-masing)')
  emit('index: HNSW (vector_cosine_ops), ef_search default = 40')
  emit('')
  emit('RENCANA QUERY (EXPLAIN):')
  const plan = await p.$queryRawUnsafe<Array<Record<string,string>>>(
    `EXPLAIN (COSTS OFF) SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT 24`)
  for (const row of plan) emit(`  ${Object.values(row)[0]}`)
  emit('')
  emit('HASIL LANGSUNG (tenant 7 punya 200 baris di tabel):')
  for (const want of [10, 24, 40, 80, 150, 200]) {
    const rows = await p.$queryRawUnsafe<Array<{id:number}>>(
      `SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}`)
    const flag = rows.length === want ? 'OK' : '<<< HILANG'
    emit(`  LIMIT ${String(want).padStart(3)} -> ${String(rows.length).padStart(3)} baris  ${flag}`)
  }
  emit('')
  emit('PEMBANDING (exact, index dimatikan):')
  for (const want of [10, 24, 80]) {
    const rows = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan=off`)
      await tx.$executeRawUnsafe(`SET LOCAL enable_indexonlyscan=off`)
      return tx.$queryRawUnsafe<Array<{id:number}>>(
        `SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}`)
    })
    emit(`  LIMIT ${String(want).padStart(3)} -> ${String(rows.length).padStart(3)} baris`)
  }
  emit('')
  emit('BACA: baris yang HILANG bukan yang "tidak ada", melainkan yang')
  emit('seharusnya masuk peringkat teratas. Filter tenant dibuang SETELAH')
  emit('index scan, dan LIMIT menghentikan scan lebih awal.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
