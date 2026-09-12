/**
 * Point an org's embedding config at the local server, explicitly.
 * Kept as a tiny standalone step (not inline in a test) because an inline
 * update silently failed to take effect in one run and produced a confusing
 * HTTP 400 against the CHAT gateway; a separate, verifiable step removes that
 * ambiguity.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { getEmbeddingRuntimeConfig } from '../src/lib/embeddings'

const ORG = process.env.EVAL_ORG_ID!
await bypassOrg(async () => {
  enterWithOrg(ORG)
  const row = await db.llmConfig.findFirst({ select: { id: true, encryptedApiKey: true } })
  if (!row) throw new Error('no llmConfig row')
  await db.llmConfig.update({
    where: { id: row.id },
    data: {
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: process.env.EMB_BASE_URL!,
      embeddingModel: process.env.EMB_MODEL!,
      encryptedEmbeddingApiKey: row.encryptedApiKey,
    },
  })
  const c = await getEmbeddingRuntimeConfig()
  console.log('VERIFIED ->', c?.provider, c?.baseUrl, c?.model)
  process.exit(0)
})
