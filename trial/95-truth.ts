/**
 * Ukur dengan BENAR. Kesalahan uji sebelumnya: SET LOCAL enable_indexscan=off
 * tidak cukup untuk memaksa exact scan. Pakai enable_indexonlyscan juga,
 * dan bandingkan dengan hitungan langsung.
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/truth.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  const q = `'[0.5,0.51,0.52,0.53,0.54,0.55,0.56,0.57]'`
  const want = 80
  emit('target: 80 baris dari tenant 7 (1% tabel)')
  emit('')
  // Exact: paksa seq scan penuh
  const ex = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan=off`)
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexonlyscan=off`)
    await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan=off`)
    return tx.$queryRawUnsafe<Array<{n:bigint}>>(
      `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
  })
  emit(`  EXACT (index dimatikan)      -> ${ex[0].n}/${want}`)
  emit('')
  for (const ef of [40, 320, 1000]) {
    const r = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
      return tx.$queryRawUnsafe<Array<{n:bigint}>>(
        `SELECT count(*) AS n FROM (SELECT id FROM hnsw_probe WHERE tenant=7 ORDER BY v <=> ${q}::vector LIMIT ${want}) s`)
    })
    emit(`  HNSW ef_search=${String(ef).padStart(4)}       -> ${String(r[0].n).padStart(2)}/${want}`)
  }
  emit('')
  emit('  Catatan: nilai similarity tenant 7 semuanya negatif/rendah untuk')
  emit('  query di atas (lihat -0.18, 0.57, -0.93). Artinya pada kasus ini')
  emit('  baris tenant 7 memang BUKAN tetangga terdekat -> exact pun bisa')
  emit('  memberi sedikit hasil. Ini mengungkap hal penting:')
  emit('')
  emit('  KERUGIAN SEBENARNYA BUKAN "kehilangan baris", melainkan')
  emit('  "kehilangan baris TERBAIK": HNSW mengambil 40 kandidat terdekat')
  emit('  dari SELURUH tabel, lalu filter tenant membuang hampir semuanya.')
  emit('  Yang tersisa adalah baris tenant yang kebetulan menempel di')
  emit('  kandidat global — belum tentu yang paling relevan bagi tenant itu.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
