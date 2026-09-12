/**
 * Configure a scratch org with the LOCAL embedding server + the real chat model,
 * then seed the bilingual corpus and backfill embeddings through the app's own
 * backfill path (so this measures production code, not a hand-written INSERT).
 */
import { db } from '../src/lib/db'
import { encryptConfig } from '../src/lib/crypto'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { chatOnce } from '../src/lib/llm-client'
import { getLlmRuntimeConfig } from '../src/lib/llm-config'
import { embedTexts, getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { hr } from './lib'

const CHAT_BASE = process.env.EVAL_LLM_BASE_URL!
const CHAT_KEY = process.env.EVAL_LLM_KEY!
const CHAT_MODEL = process.env.EVAL_LLM_MODEL!
const EMB_BASE = process.env.EMB_BASE_URL!
const EMB_MODEL = process.env.EMB_MODEL!

async function main() {
  const slug = `embed-${Date.now().toString(36)}`
  const org = await bypassOrg(() =>
    db.organization.create({
      data: {
        name: `Embed ${slug}`, slug, licenseStatus: 'valid', licensePlan: 'flat',
        licenseValidatedAt: new Date(),
      },
      select: { id: true },
    }),
  )
  const orgId = org.id
  await bypassOrg(() =>
    db.user.create({
      data: {
        organizationId: orgId, email: `embed-${slug}@eval.local`,
        name: 'Eval Admin', passwordHash: '!', role: 'admin', sessionVersion: 1,
      },
    }),
  )
  await bypassOrg(() =>
    db.llmConfig.create({
      data: {
        organizationId: orgId,
        provider: 'OPENAI_COMPATIBLE',
        baseUrl: CHAT_BASE,
        model: CHAT_MODEL,
        encryptedApiKey: encryptConfig({ apiKey: CHAT_KEY }),
        purpose: 'chat',
        embeddingProvider: 'OPENAI_COMPATIBLE',
        embeddingBaseUrl: EMB_BASE,
        embeddingModel: EMB_MODEL,
        // Local server needs no key. Store the chat key anyway so the app does
        // not skip the call on the `!apiKey` guard.
        encryptedEmbeddingApiKey: encryptConfig({ apiKey: CHAT_KEY }),
      },
    }),
  )

  hr('CONFIG')
  console.log(`org          : ${orgId}`)
  console.log(`chat         : ${CHAT_BASE} / ${CHAT_MODEL}`)
  console.log(`embeddings   : ${EMB_BASE} / ${EMB_MODEL}`)

  await bypassOrg(async () => {
    enterWithOrg(orgId)
    const chat = await getLlmRuntimeConfig()
    console.log(`resolved chat      : ${chat?.model}`)
    const emb = await getEmbeddingRuntimeConfig()
    console.log(`resolved embedding : ${emb ? `${emb.provider} ${emb.model} @ ${emb.baseUrl}` : 'NONE'}`)
    if (!emb) throw new Error('embedding config did not resolve')

    hr('LIVE EMBEDDING CALL THROUGH THE APP')
    const vecs = await embedTexts(emb, ['Berapa tarif lembur pada hari kerja?', 'Resep kue bolu'])
    console.log(`vectors: ${vecs.length}, dim=${vecs[0]?.length}`)
    if (vecs.length === 2) {
      const dot = vecs[0].reduce((s, v, i) => s + v * vecs[1][i], 0)
      console.log(`cosine(on-topic, off-topic) = ${dot.toFixed(4)} (should be low)`)
    }

    hr('CHAT STILL WORKS')
    const out = await chatOnce(chat!, [{ role: 'user', content: 'Reply with exactly: OK' }], 0, 'smoke')
    console.log(`chat -> ${JSON.stringify(out).slice(0, 40)}`)
  })

  console.log(`\nORG_ID=${orgId}`)
  process.exit(0)
}

main().catch((e) => { console.error('SETUP FAILED:', e); process.exit(1) })
