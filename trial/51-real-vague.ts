/** Ukur cosine NYATA untuk pertanyaan samar (hindari cache 1-entri dengan jeda). */
import { getQuestionEmbedding } from '../src/lib/smart-router-helpers'
import { getEmbeddingRuntimeConfig, cosineSimilarity } from '../src/lib/embeddings'
import { bypassOrg } from '../src/lib/prisma-tenant'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/vague.txt', m + '\n')

// Jeda > TTL cache supaya setiap pengukuran benar-benar memanggil API
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(){
  const cfg = await bypassOrg(() => getEmbeddingRuntimeConfig())
  const texts = [
    { n: 'Sales', t: 'Sales Database. table orders: Customer order transactions. table customers: Customer master data.' },
    { n: 'HR', t: 'HR Database. table employees: Employee compensation records. table leave_requests: Employee leave requests.' },
  ]
  emit('=== COSINE NYATA (jeda > TTL agar cache tidak menipu) ===')
  const integEmbs: number[][] = []
  for (const x of texts) { integEmbs.push(await getQuestionEmbedding(x.t, cfg!)); await sleep(11000) }

  const jelas = ['berapa total penjualan bulan ini','berapa gaji karyawan','daftar order terbaru','berapa hari cuti']
  const samar = ['tolong lihat','ringkas','berapa banyak datanya','ada apa saja','berapa totalnya','cek dong']

  emit('--- JELAS (harus punya pemenang) ---')
  for (const q of jelas) {
    const qe = await getQuestionEmbedding(q, cfg!); await sleep(11000)
    const s = integEmbs.map(e => cosineSimilarity(qe, e))
    const win = s[0] > s[1] ? 'Sales' : 'HR'
    const gap = Math.abs(s[0]-s[1])
    emit(`  Sales=${s[0].toFixed(3)} HR=${s[1].toFixed(3)} gap=${gap.toFixed(3)} -> ${win}  | "${q}"`)
  }
  emit('--- SAMAR (harus TIDAK punya pemenang jelas) ---')
  for (const q of samar) {
    const qe = await getQuestionEmbedding(q, cfg!); await sleep(11000)
    const s = integEmbs.map(e => cosineSimilarity(qe, e))
    const win = s[0] > s[1] ? 'Sales' : 'HR'
    const gap = Math.abs(s[0]-s[1])
    emit(`  Sales=${s[0].toFixed(3)} HR=${s[1].toFixed(3)} gap=${gap.toFixed(3)} -> ${win}  | "${q}"`)
  }
  emit('')
  emit('=== YANG DICARI: ambang GAP yang memisahkan jelas dari samar ===')
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
