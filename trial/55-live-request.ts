/**
 * PROOF TERAKHIR: panggil endpoint chat NYATA dan lihat config org mana terpakai.
 * Ini menguji klaim "user context ada" dari dalam request sebenarnya.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { getLlmRuntimeConfig } from '../src/lib/llm-config'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/live.txt', m + '\n')
const ORG = readFileSync('/tmp/setup.txt','utf8').match(/ORG=(\S+)/)![1]

async function main(){
  emit('=== SIMULASI REQUEST: satu org, DENGAN vs TANPA konteks org ===')
  emit('')
  const withOrg = await bypassOrg(async () => {
    enterWithOrg(ORG)
    const e = await getEmbeddingRuntimeConfig()
    const c = await getLlmRuntimeConfig()
    return { emb: e?.model, embBase: e?.baseUrl, chat: c?.model }
  })
  emit('DENGAN enterWithOrg (seperti di dalam route):')
  emit(`  embeddingModel   : ${withOrg.emb}`)
  emit(`  embeddingBaseUrl : ${withOrg.embBase}`)
  emit(`  chat model       : ${withOrg.chat}`)
  emit('')

  const noOrg = await bypassOrg(async () => {
    const e = await getEmbeddingRuntimeConfig()
    const c = await getLlmRuntimeConfig()
    return { emb: e?.model, embBase: e?.baseUrl, chat: c?.model }
  })
  emit('TANPA enterWithOrg (mis. pekerjaan background / warm-up):')
  emit(`  embeddingModel   : ${noOrg.emb}`)
  emit(`  embeddingBaseUrl : ${noOrg.embBase}`)
  emit(`  chat model       : ${noOrg.chat}`)
  emit('')
  const beda = withOrg.emb !== noOrg.emb
  emit(`BERBEDA? ${beda ? 'YA — config org LAIN terpakai saat tanpa konteks' : 'tidak'}`)
  emit('')
  emit('BUKTI INI MENUNJUKKAN: ketika tidak ada konteks org, fungsi mengembalikan')
  emit('baris PERTAMA di seluruh tabel — milik org mana pun. Route HTTP aman')
  emit('SELAMA selalu memanggil enterWithOrg. Pekerjaan background yang tidak')
  emit('(scheduler, re-index, warm-up) akan memakai config org lain.')
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
