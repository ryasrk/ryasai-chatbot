/**
 * Ulangi uji seleksi dengan EMBEDDING NYATA (bukan mock konstan).
 * Mock konstan membuat cosine=1.0 untuk semua -> jalur semantik tidak teruji.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { resolveIntegrationForQuestion, tokenize } from '../src/lib/smart-router'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { getQuestionEmbedding } from '../src/lib/smart-router-helpers'
import { cosineSimilarity } from '../src/lib/embeddings'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/realemb.txt', m + '\n')
const ORG = readFileSync('/tmp/setup.txt', 'utf8').match(/ORG=(\S+)/)![1]

async function main() {
  return bypassOrg(async () => {
    // ganti config embedding ke server lokal NYATA
    await db.llmConfig.updateMany({
      where: { organizationId: ORG },
      data: { embeddingProvider: 'OPENAI_COMPATIBLE', embeddingBaseUrl: 'http://127.0.0.1:8081/v1', embeddingModel: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2' },
    })
    enterWithOrg(ORG)

    const cfg = await getEmbeddingRuntimeConfig()
    emit('=== KONFIG EMBEDDING ===')
    emit(`ditemukan: ${cfg ? 'YA' : 'TIDAK'}`)
    if (cfg) emit(`model: ${cfg.model}  baseUrl: ${cfg.baseUrl}`)
    emit('')

    // Ukur cosine nyata antara pertanyaan Indonesia dan deskripsi integrasi Inggris
    emit('=== COSINE NYATA: pertanyaan Indonesia vs deskripsi integrasi Inggris ===')
    const integs = [
      { nama: 'Sales Database', teks: 'Sales Database. table orders: Customer order transactions. table customers: Customer master data.' },
      { nama: 'HR Database', teks: 'HR Database. table employees: Employee compensation records. table leave_requests: Employee leave requests.' },
    ]
    const integEmbs: number[][] = []
    for (const i of integs) {
      const e = await getQuestionEmbedding(i.teks, cfg!) as unknown as number[]
      integEmbs.push(e)
    }
    const qs = ['berapa total penjualan bulan ini','berapa gaji karyawan','daftar karyawan terbaru','berapa hari cuti diambil','customer mana yang paling banyak beli','berapa jumlah karyawan']
    for (const q of qs) {
      const qe = await getQuestionEmbedding(q, cfg!) as unknown as number[]
      const scores = integEmbs.map((e, i) => ({ nama: integs[i].nama, s: cosineSimilarity(qe, e) }))
      scores.sort((a, b) => b.s - a.s)
      const winner = scores[0]
      emit(`Q: "${q}"`)
      emit(`   Sales=${scores.find(x=>x.nama==='Sales Database')!.s.toFixed(3)}  HR=${scores.find(x=>x.nama==='HR Database')!.s.toFixed(3)}  -> ${winner.nama}`)
    }
    process.exit(0)
  })
}
main().catch((e) => { console.error('ERR', e); process.exit(1) })
