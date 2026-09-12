/**
 * REPRODUKSI ANGKA RESMI pgvector README:
 *   "If a condition matches 10% of rows, with HNSW and the default
 *    hnsw.ef_search of 40, only 4 rows will match on average."
 *
 * Arsitektur kita: satu tabel + satu index HNSW + filter organizationId.
 * Dokumentasi pgvector punya bagian khusus "Multitenancy" yang menyatakan
 * ini masalah isolasi tenant. Mari UKUR, jangan percaya begitu saja.
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/mt.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })

async function main(){
  const v = await p.$queryRawUnsafe<Array<{extversion:string}>>(`SELECT extversion FROM pg_extension WHERE extname='vector'`)
  emit(`pgvector terpasang: ${v[0].extversion}`)
  emit(`(iterative_scan butuh 0.8.0+; kita BELUM punya)`)
  emit('')

  // Buat tabel uji terpisah supaya DB dev tidak disentuh
  await p.$executeRawUnsafe(`DROP TABLE IF EXISTS mt_probe`)
  await p.$executeRawUnsafe(`CREATE TABLE mt_probe (id serial, tenant int, embedding vector(3))`)
  await p.$executeRawUnsafe(`CREATE INDEX ON mt_probe USING hnsw (embedding vector_cosine_ops)`)

  // 1000 baris: 900 milik tenant 1 (mayoritas), 100 milik tenant 2 (10%)
  emit('=== MEMBUAT 1000 VEKTOR: tenant 1 = 900, tenant 2 = 100 (10%) ===')
  const vals: string[] = []
  for (let i = 0; i < 1000; i++) {
    const tenant = i < 900 ? 1 : 2
    // tenant 1: menyebar acak. tenant 2: juga acak (tidak sengaja berdekatan)
    const x = (Math.sin(i * 12.9898) * 43758.5453) % 1
    const y = (Math.sin(i * 78.233) * 43758.5453) % 1
    const z = (Math.sin(i * 45.164) * 43758.5453) % 1
    vals.push(`(${tenant}, '[${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}]')`)
  }
  await p.$executeRawUnsafe(`INSERT INTO mt_probe (tenant, embedding) VALUES ${vals.join(',')}`)
  await p.$executeRawUnsafe(`ANALYZE mt_probe`)
  const cnt = await p.$queryRawUnsafe<Array<{tenant:number,n:bigint}>>(`SELECT tenant, count(*) AS n FROM mt_probe GROUP BY 1 ORDER BY 1`)
  for (const c of cnt) emit(`  tenant ${c.tenant}: ${c.n}`)
  emit('')

  // Query sebagai tenant 2 (minoritas 10%), minta 10 hasil
  const q = '[0.5,0.5,0.5]'
  emit('=== QUERY sebagai tenant 2 (10% baris), LIMIT 10 ===')
  emit('ef_search default = 40 -> harapan teori: ~4 hasil')
  emit('')
  for (const ef of [40, 100, 400, 4000]) {
    const rows = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
      return tx.$queryRawUnsafe<Array<{id:number}>>(
        `SELECT id FROM mt_probe WHERE tenant = 2 ORDER BY embedding <=> $1::vector LIMIT 10`, q)
    })
    emit(`  ef_search=${String(ef).padStart(4)} -> ${String(rows.length).padStart(2)} baris`)
  }
  emit('')
  // Exact search sebagai pembanding kebenaran
  const exact = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`)
    return tx.$queryRawUnsafe<Array<{id:number}>>(
      `SELECT id FROM mt_probe WHERE tenant = 2 ORDER BY embedding <=> $1::vector LIMIT 10`, q)
  })
  emit(`  EXACT (tanpa index) -> ${exact.length} baris  <- seharusnya 10`)
  emit('')
  emit('KESIMPULAN: bandingkan baris di atas dengan EXACT.')
  emit('Kalau kurang dari 10 -> hasil PANGGILAN RAG KITA TERPOTONG tanpa error.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,400));process.exit(1)})
