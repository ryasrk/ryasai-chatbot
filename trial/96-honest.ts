/**
 * Ukur dengan cara yang TIDAK BISA salah: ambil id secara langsung,
 * seperti yang dilakukan rag-retrieval.ts, tanpa subquery/LIMIT bersarang.
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/honest.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  const q = `'[0.5,0.51,0.52,0.53,0.54,0.55,0.56,0.57]'`
  emit('=== PENGUKURAN LANGSUNG (cara yang dipakai produksi) ===')
  emit('')
  for (const want of [24, 80, 200]) {
    const rows = await p.$queryRawUnsafe<Array<{id:number}>>(
      `SELECT id FROM hnsw_probe WHERE tenant = 7 ORDER BY v <=> ${q}::vector LIMIT ${want}`)
    emit(`  LIMIT ${String(want).padStart(3)} -> ${String(rows.length).padStart(3)} baris kembali`)
  }
  emit('')
  emit('=== UJI KHUSUS: apakah recall-nya BENAR (bukan hanya jumlahnya)? ===')
  const want = 50
  const hnsw = await p.$queryRawUnsafe<Array<{id:number}>>(
    `SELECT id FROM hnsw_probe WHERE tenant = 7 ORDER BY v <=> ${q}::vector LIMIT ${want}`)
  const exact = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan=off`)
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexonlyscan=off`)
    await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan=off`)
    return tx.$queryRawUnsafe<Array<{id:number}>>(
      `SELECT id FROM hnsw_probe WHERE tenant = 7 ORDER BY v <=> ${q}::vector LIMIT ${want}`)
  })
  const a = new Set(hnsw.map(r=>r.id))
  const overlap = exact.filter(r=>a.has(r.id)).length
  emit(`  HNSW  : ${hnsw.length} baris`)
  emit(`  EXACT : ${exact.length} baris`)
  emit(`  overlap: ${overlap}/${exact.length} (${(100*overlap/exact.length).toFixed(1)}%)`)
  emit('')
  emit(overlap === exact.length
    ? '  >> HNSW menghasilkan himpunan yang SAMA dengan exact di sini.'
    : `  >> HNSW kehilangan ${exact.length-overlap} baris terbaik -> recall turun.`)
  emit('')
  emit('=== KENAPA ef_search TIDAK TERLIHAT BERPENGARUH ===')
  emit('Pada tabel ini tenant 7 punya 200 baris dari 20.000 (1%).')
  emit('ef_search=40 mengambil 40 kandidat GLOBAL. Karena distribusi tenant')
  emit('dalam data uji ini merata (i % 100), tenant 7 menyumbang ~1% dari')
  emit('kandidat mana pun -> ~0.4 baris, tapi query di atas justru penuh.')
  emit('Artinya data uji saya TIDAK mereproduksi skenario yang saya klaim:')
  emit('distribusi tenant merata, bukan mayoritas/minoritas seperti produksi.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
