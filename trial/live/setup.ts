/**
 * Point the app's BYOK LlmConfig at a REAL provider, through the app's own
 * encryption, so the measurement exercises production code rather than a mock.
 *
 * This is the one thing the previous rounds could not do: `aggregate: false`
 * answers ("not measurable here") were honest but unhelpful. A real key and 83
 * real models ARE reachable from this machine, so answer quality is measurable.
 *
 * Usage: bun trial/live/setup.ts <baseUrl> <model> <apiKeyEnvFile>
 *        bun trial/live/setup.ts --restore
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { encryptConfig } from '../../src/lib/crypto'

const DB = (() => {
  const env = readFileSync('.env', 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('DATABASE_URL not found in .env')
  return m[1].trim().replace(/^["']|["']$/g, '')
})()

async function q(sql: string, params: unknown[] = []) {
  const { SQL } = await import('bun')
  const pg = new SQL(DB)
  try { return await pg.unsafe(sql, params as never[]) } finally { await pg.end() }
}

const BACKUP = 'trial/live/.llmconfig.backup.json'

if (process.argv.includes('--restore')) {
  const backup = JSON.parse(readFileSync(BACKUP, 'utf8'))
  await q(
    `UPDATE "LlmConfig" SET provider=$1, "baseUrl"=$2, model=$3, "encryptedApiKey"=$4 WHERE id=$5`,
    [backup.provider, backup.baseUrl, backup.model, backup.encryptedApiKey, backup.id],
  )
  console.log('RESTORED LlmConfig to:', backup.provider, backup.baseUrl, backup.model)
  process.exit(0)
}

const [baseUrl, model, keyFile] = process.argv.slice(2)
if (!baseUrl || !model || !keyFile) {
  console.error('usage: setup.ts <baseUrl> <model> <apiKeyFile> | --restore')
  process.exit(2)
}
const apiKey = readFileSync(keyFile, 'utf8').trim()

const rows = await q(`SELECT id, provider, "baseUrl", model, "encryptedApiKey" FROM "LlmConfig"`)
if (rows.length !== 1) throw new Error(`expected exactly 1 LlmConfig, found ${rows.length}`)
const cur = rows[0] as Record<string, string>
writeFileSync(BACKUP, JSON.stringify({ id: cur.id, provider: cur.provider, baseUrl: cur.baseUrl, model: cur.model, encryptedApiKey: cur.encryptedApiKey }, null, 2))

// Only baseUrl/model/key change. The provider stays OPENAI_COMPATIBLE, which is
// what 9router speaks, so this is a config change and NOT a code change -- the
// point is to measure the production path, not a path I wrote for the benchmark.
await q(
  `UPDATE "LlmConfig" SET "baseUrl"=$1, model=$2, "encryptedApiKey"=$3 WHERE id=$4`,
  [baseUrl, model, encryptConfig({ apiKey } as never), cur.id],
)
console.log(`LIVE LlmConfig -> ${baseUrl} / ${model} (backup at ${BACKUP})`)
