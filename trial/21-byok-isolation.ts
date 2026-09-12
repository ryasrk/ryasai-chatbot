/**
 * BYOK isolation proof: org A's LLM config must NEVER resolve for org B.
 * With bring-your-own-key, a leak here means org B spends org A's tokens AND
 * sees org A's key material.
 */
import { db } from '../src/lib/db'
import { encryptConfig } from '../src/lib/crypto'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { getLlmRuntimeConfig } from '../src/lib/llm-config'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'
import { hr } from './lib'

async function main() {
  const s = Date.now().toString(36)
  const mk = async (tag: string) => bypassOrg(() => db.organization.create({
    data: { name: tag, slug: `byok-${tag}-${s}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))
  const A = await mk('a'); const B = await mk('b')

  const seed = (orgId: string, model: string, key: string, embModel: string) => bypassOrg(async () => {
    enterWithOrg(orgId)
    await db.llmConfig.create({ data: {
      organizationId: orgId, purpose: 'chat', provider: 'OPENAI_COMPATIBLE',
      baseUrl: `https://${model}.example/v1`, model, encryptedApiKey: encryptConfig({ apiKey: key }),
      embeddingProvider: 'OPENAI_COMPATIBLE', embeddingBaseUrl: `https://${embModel}.example/v1`,
      embeddingModel: embModel, encryptedEmbeddingApiKey: encryptConfig({ apiKey: `emb-${key}` }),
    } })
  })
  await seed(A.id, 'model-for-A', 'sk-key-AAAA', 'embed-for-A')
  await seed(B.id, 'model-for-B', 'sk-key-BBBB', 'embed-for-B')

  hr('RESOLUTION PER ORG')
  for (const [tag, org] of [['A', A], ['B', B]] as const) {
    await bypassOrg(async () => {
      enterWithOrg(org.id)
      const chat = await getLlmRuntimeConfig()
      const emb = await getEmbeddingRuntimeConfig()
      console.log(`org ${tag}: chat=${chat?.model} key=${chat?.apiKey} | embed=${emb?.model} key=${emb?.apiKey}`)
    })
  }

  hr('ASSERTIONS')
  const seenA = await bypassOrg(async () => { enterWithOrg(A.id); const c = await getLlmRuntimeConfig(); return `${c?.model}|${c?.apiKey}` })
  const seenB = await bypassOrg(async () => { enterWithOrg(B.id); const c = await getLlmRuntimeConfig(); return `${c?.model}|${c?.apiKey}` })
  const okA = seenA === 'model-for-A|sk-key-AAAA'
  const okB = seenB === 'model-for-B|sk-key-BBBB'
  console.log(`org A got its own config   : ${okA ? 'PASS' : `FAIL (${seenA})`}`)
  console.log(`org B got its own config   : ${okB ? 'PASS' : `FAIL (${seenB})`}`)
  console.log(`no cross-org key leak      : ${seenA.includes('BBBB') || seenB.includes('AAAA') ? 'FAIL — LEAK' : 'PASS'}`)

  hr('FALLBACK: what does an org with NO config get?')
  const C = await mk('c')
  await bypassOrg(async () => {
    enterWithOrg(C.id)
    const chat = await getLlmRuntimeConfig()
    const emb = await getEmbeddingRuntimeConfig()
    console.log(`org C (unconfigured): chat=${chat === null ? 'null (fail-closed)' : `LEAKED ${chat.model}`} embed=${emb === null ? 'null (fail-closed)' : `LEAKED ${emb.model}`}`)
  })

  await bypassOrg(async () => {
    await db.llmConfig.deleteMany({ where: { organizationId: { in: [A.id, B.id, C.id] } } })
    await db.organization.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  })
  process.exit(0)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
