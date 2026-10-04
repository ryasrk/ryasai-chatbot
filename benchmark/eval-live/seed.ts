/**
 * Seed a dedicated eval organization in a SEPARATE database (never the development or customer one).
 *
 * Creates the org (licence valid), an admin and a viewer, copies the source org's encrypted LLM/embedding config
 * VERBATIM (same install key, so nothing is decrypted here), chooses internal storage, and mints an API key.
 * Credentials go to the file named by EVAL_CREDENTIALS_FILE (outside the repo) and are never printed.
 *
 *   DATABASE_URL=<eval db> EVAL_SOURCE_DATABASE_URL=<db holding the config> EVAL_SOURCE_ORG_ID=<org> \
 *   EVAL_CREDENTIALS_FILE=<path> bun benchmark/eval-live/seed.ts
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { hashPassword } from '../../src/lib/passwords'
import { generateApiKey } from '../../src/lib/api-keys'

const evalUrl = process.env.DATABASE_URL
const sourceUrl = process.env.EVAL_SOURCE_DATABASE_URL
const sourceOrg = process.env.EVAL_SOURCE_ORG_ID
const credFile = process.env.EVAL_CREDENTIALS_FILE
if (!evalUrl || !sourceUrl || !sourceOrg || !credFile) throw new Error('DATABASE_URL, EVAL_SOURCE_DATABASE_URL, EVAL_SOURCE_ORG_ID and EVAL_CREDENTIALS_FILE are required')
if (evalUrl === sourceUrl) throw new Error('refusing to seed the source database: use a separate eval database')

const source = new PrismaClient({ datasourceUrl: sourceUrl })
const target = new PrismaClient({ datasourceUrl: evalUrl })

const llm = await source.llmConfig.findFirst({ where: { organizationId: sourceOrg, purpose: 'chat' } })
if (!llm) throw new Error('source org has no chat LLM config')

const org = await target.organization.upsert({
  where: { slug: 'zz-eval-arunika' },
  update: { licenseStatus: 'valid', licenseValidatedAt: new Date() },
  create: { name: 'ZZ Eval Arunika', slug: 'zz-eval-arunika', licenseStatus: 'valid', licensePlan: 'enterprise', licenseValidatedAt: new Date() },
})

const password = randomBytes(18).toString('base64url')
const users: Record<string, { email: string; role: string }> = {
  admin: { email: 'eval-admin@arunika.test', role: 'admin' },
  viewer: { email: 'eval-viewer@arunika.test', role: 'viewer' },
}
for (const u of Object.values(users)) {
  await target.user.upsert({
    where: { email: u.email },
    update: { passwordHash: hashPassword(password), role: u.role, isActive: true },
    create: { email: u.email, name: u.role, role: u.role, passwordHash: hashPassword(password), organizationId: org.id },
  })
}

const { id: _id, organizationId: _o, createdAt: _c, updatedAt: _u, ...llmFields } = llm
await target.llmConfig.deleteMany({ where: { organizationId: org.id } })
await target.llmConfig.create({ data: { ...llmFields, organizationId: org.id } })

await target.vectorStoreConfig.deleteMany({ where: { organizationId: org.id } })
await target.vectorStoreConfig.create({ data: { organizationId: org.id, provider: 'INTERNAL', storageChosenAt: new Date() } })

const key = generateApiKey()
await target.apiKey.create({ data: { organizationId: org.id, label: 'live-eval', keyPrefix: key.prefix, keyHash: key.hash } })

writeFileSync(credFile, JSON.stringify({ orgId: org.id, password, users, apiKey: key.plainText }, null, 2), { mode: 0o600 })
console.log(`seeded org ${org.id}; credentials written to ${credFile}`)
await source.$disconnect()
await target.$disconnect()
process.exit(0)
