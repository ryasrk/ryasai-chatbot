/** Apakah embedTexts mengembalikan vektor BENAR untuk tiap input? */
import { embedTexts, getEmbeddingRuntimeConfig, cosineSimilarity } from '../src/lib/embeddings'
import { bypassOrg } from '../src/lib/prisma-tenant'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/et.txt', m + '\n')
async function main(){
  const cfg = await bypassOrg(() => getEmbeddingRuntimeConfig())
  emit(`model: ${cfg?.model}  baseUrl: ${cfg?.baseUrl}`)
  const inputs = ['Sales Database orders customers','HR Database employees salary']
  const r = await embedTexts(cfg!, inputs)
  emit(`jumlah vektor: ${r.length}`)
  emit(`v0[:4]: [${r[0].slice(0,4).map(x=>x.toFixed(4)).join(', ')}]`)
  emit(`v1[:4]: [${r[1].slice(0,4).map(x=>x.toFixed(4)).join(', ')}]`)
  emit(`v0 === v1 : ${JSON.stringify(r[0]) === JSON.stringify(r[1])}`)
  emit(`cosine(v0,v1) : ${cosineSimilarity(r[0], r[1]).toFixed(4)}`)
  emit('')
  emit('Kalau cosine = 1.000 -> embedTexts mengembalikan vektor IDENTIK untuk')
  emit('input berbeda, yang berarti jalur embedding RUSAK (bukan cache).')
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
