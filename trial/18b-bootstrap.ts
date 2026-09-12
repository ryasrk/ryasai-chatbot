import { db } from '../src/lib/db'
import { encryptConfig } from '../src/lib/crypto'
import { embedDocumentChunks } from '../src/lib/embeddings'
import { bypassOrg } from '../src/lib/prisma-tenant'
const ORG = process.env.EVAL_ORG_ID!
await bypassOrg(async () => {
  await db.organization.create({ data: { id: ORG, name: 'Dim Test', slug: ORG, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() } })
  await db.llmConfig.create({ data: {
    organizationId: ORG, provider: 'OPENAI_COMPATIBLE', baseUrl: process.env.EVAL_LLM_BASE_URL!,
    model: process.env.EVAL_LLM_MODEL!, encryptedApiKey: encryptConfig({ apiKey: process.env.EVAL_LLM_KEY! }),
    purpose: 'chat', embeddingProvider: 'OPENAI_COMPATIBLE', embeddingBaseUrl: process.env.EMB_BASE_URL!,
    embeddingModel: process.env.EMB_MODEL!, encryptedEmbeddingApiKey: encryptConfig({ apiKey: 'x' }) } })
  process.exit(0)
})
