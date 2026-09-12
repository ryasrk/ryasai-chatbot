/** Verifikasi akhir lewat kode produksi: retrieval hidup untuk org dev. */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { searchFtsChunkIds } from '../src/lib/rag-fts'
import { getQuestionEmbedding } from '../src/lib/smart-router-helpers'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/vdev.txt',m+'\n')
async function main(){
  const o = await bypassOrg(() => db.organization.findFirst({ select:{id:true,name:true} }))
  await bypassOrg(async () => {
    enterWithOrg(o!.id)
    const dim = await db.$queryRawUnsafe<Array<{d:number}>>(
      `SELECT vector_dims(embedding) AS d FROM "DocumentChunk" WHERE embedding IS NOT NULL LIMIT 1`)
    const cfg = await getEmbeddingRuntimeConfig()
    const qv = await getQuestionEmbedding('test document', cfg!)
    const rows = await db.$queryRawUnsafe<Array<{s:number}>>(
      `SELECT 1-(embedding <=> $1::vector) AS s FROM "DocumentChunk"
       WHERE embedding IS NOT NULL AND "organizationId" = $2
       ORDER BY embedding <=> $1::vector LIMIT 5`, `[${qv.join(',')}]`, o!.id)
    const fts = await searchFtsChunkIds({ queryTokens:['uji','rag'], limit:5 })
    const ftsNo = await searchFtsChunkIds({ queryTokens:['nonexistent'], limit:5 })
    emit(`org          : ${o!.name.slice(0,35)}`)
    emit(`vector_dims  : ${dim[0]?.d}`)
    emit(`pgvector hits: ${rows.length} (top sim ${rows[0]?.s.toFixed(4)})`)
    emit(`FTS "uji rag" : ${fts.length}`)
    emit(`FTS (tak ada) : ${ftsNo.length}  <- harus 0`)
    emit('')
    emit(dim[0]?.d===384 && rows.length>0 ? '>> RETRIEVAL HIDUP untuk org dev' : '>> perlu diperiksa')
  })
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,250));process.exit(1)})
