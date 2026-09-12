/** Verifikasi runtime: apakah KETIGA jalur retrieval mati? */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/dead.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })
async function main(){
  emit('=== JALUR RETRIEVAL vs DATA ===')
  const [emb, tsv, json] = await Promise.all([
    p.$queryRawUnsafe<Array<{n:bigint}>>(`SELECT count(*) AS n FROM "DocumentChunk" WHERE embedding IS NOT NULL`),
    p.$queryRawUnsafe<Array<{n:bigint}>>(`SELECT count(*) AS n FROM "DocumentChunk" WHERE tsv IS NOT NULL`),
    p.$queryRawUnsafe<Array<{n:bigint}>>(`SELECT count(*) AS n FROM "DocumentChunk" WHERE "embeddingJson" IS NOT NULL`),
  ])
  const total = await p.$queryRawUnsafe<Array<{n:bigint}>>(`SELECT count(*) AS n FROM "DocumentChunk"`)
  const N = Number(total[0].n)
  emit(`total chunk: ${N}`)
  emit(`  embedding (vector) : ${emb[0].n}   <- jalur pgvector`)
  emit(`  tsv (full-text)    : ${tsv[0].n}   <- jalur ts_rank FTS`)
  emit(`  embeddingJson      : ${json[0].n}   <- fallback cosine (butuh model cocok)`)
  emit('')
  emit('=== KESIMPULAN ===')
  const v=Number(emb[0].n), t=Number(tsv[0].n), j=Number(json[0].n)
  emit(`pgvector : ${v===0?'MATI (0 baris)':'hidup'}`)
  emit(`ts_rank  : ${t===0?'MATI (0 baris)':'hidup'}`)
  emit(`cosine   : ${j===0?'MATI':'ADA data, tapi guard model-match bisa mematikannya'}`)
  emit('')
  if(v===0&&t===0){
    emit('>> HANYA bm25Rank in-memory yang bekerja.')
    emit('   Itu berarti: setiap pertanyaan menarik SEMUA chunk ke memori')
    emit('   (O(n) per query), dan fusion vector+kg tidak menyumbang apa pun.')
    emit('   Catatan: kode sudah benar & aman (fallback + guard). Masalahnya')
    emit('   DATA belum di-reindex setelah model embedding berubah.')
  }
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,200));process.exit(1)})
