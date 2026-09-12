/**
 * Apakah cache embedding GLOBAL menyebabkan kebocoran lintas-tenant?
 * Cache di-key hanya pada STRING pertanyaan, bukan organisasi/config.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { getQuestionEmbedding } from '../src/lib/smart-router-helpers'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { cosineSimilarity } from '../src/lib/embeddings'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/crossorg.txt', m + '\n')
const ORG_A = readFileSync('/tmp/setup.txt','utf8').match(/ORG=(\S+)/)![1]

async function main(){
  // Org B: konfigurasi embedding BERBEDA (mis. model lain)
  const orgB = await bypassOrg(() => db.organization.create({
    data: { name: 'Probe B', slug: `probe-b-${Date.now().toString(36)}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))
  const { encryptConfig } = await import('../src/lib/crypto')
  await bypassOrg(() => db.llmConfig.create({
    data: {
      organizationId: orgB.id, purpose: 'chat', provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:4545/v1', encryptedApiKey: encryptConfig({ apiKey: 'sk-b' }), model: 'probe-model',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'http://127.0.0.1:4545/v1',   // MOCK (vektor konstan), bukan server nyata
      embeddingModel: 'probe-embedding',
      encryptedEmbeddingApiKey: encryptConfig({ apiKey: 'sk-b' }),
    },
  }))

  const Q = 'berapa total penjualan'

  // Org A dulu -> cache terisi dengan embedding NYATA
  const embA = await bypassOrg(async () => { enterWithOrg(ORG_A); const c = await getEmbeddingRuntimeConfig(); return getQuestionEmbedding(Q, c!) })

  // Org B bertanya string IDENTIK -> apakah dapat embedding org A?
  const embB = await bypassOrg(async () => { enterWithOrg(orgB.id); const c = await getEmbeddingRuntimeConfig(); return getQuestionEmbedding(Q, c!) })

  emit('=== CACHE EMBEDDING LINTAS-ORG, PERTANYAAN IDENTIK ===')
  const modelA = await bypassOrg(async () => { enterWithOrg(ORG_A); const c = await getEmbeddingRuntimeConfig(); return c?.model })
  emit(`Org A config model : ${modelA}`)
  emit(`Org B config model : probe-embedding (mock, vektor konstan)`)
  emit('')
  emit(`vektor A[:4] : [${embA.slice(0,4).map(x=>x.toFixed(4)).join(', ')}]`)
  emit(`vektor B[:4] : [${embB.slice(0,4).map(x=>x.toFixed(4)).join(', ')}]`)
  emit(`A identik B  : ${JSON.stringify(embA) === JSON.stringify(embB)}`)
  emit('')
  if (JSON.stringify(embA) === JSON.stringify(embB)) {
    emit('!!! ORG B MENERIMA VECTOR ORG A !!!')
    emit('Cache di-key hanya pada string pertanyaan. Dalam rentang TTL 10 detik,')
    emit('org yang bertanya string identik mendapat embedding org lain — dari')
    emit('model/provider yang MUNGKIN BERBEDA.')
    emit('')
    emit('DAMPAK: bukan kebocoran DATA mentah (vektor bukan isi dokumen), tapi')
    emit('hasil retrieval org B dihitung dengan representasi vektor org A ->')
    emit('ranking salah, dan secara prinsip mengukur konten org lain.')
  } else {
    emit('Tidak identik — cache tidak bocor pada skenario ini.')
  }
  await bypassOrg(async () => { await db.llmConfig.deleteMany({ where: { organizationId: orgB.id } }); await db.organization.delete({ where: { id: orgB.id } }) })
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
