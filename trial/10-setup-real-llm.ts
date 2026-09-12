/**
 * Point a scratch org at the real LLM endpoint and report what it got.
 *
 * ponytail: the model here is a REASONING model. It spends tokens on
 * `reasoning_content` before emitting any `content`, so a tight max_tokens
 * yields a response with EMPTY content and finish_reason 'length'. Measured
 * before wiring: 20 tokens -> content '' (all 20 went to reasoning), 2000
 * tokens -> content 'OK' after 67 reasoning tokens. Any eval that assumes
 * `content` is populated will score an empty answer as a wrong answer.
 */
import { db } from '../src/lib/db'
import { encryptConfig } from '../src/lib/crypto'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { chatOnce } from '../src/lib/llm-client'
import { getLlmRuntimeConfig } from '../src/lib/llm-config'
import { hr } from './lib'

const BASE_URL = process.env.EVAL_LLM_BASE_URL!
const API_KEY = process.env.EVAL_LLM_KEY!
const MODEL = process.env.EVAL_LLM_MODEL!

async function main() {
  const slug = `eval-${Date.now().toString(36)}`
  const org = await bypassOrg(() =>
    db.organization.create({
      data: {
        name: `Eval ${slug}`, slug, licenseStatus: 'valid', licensePlan: 'flat',
        licenseValidatedAt: new Date(),
      },
      select: { id: true },
    }),
  )
  const orgId = org.id

  await bypassOrg(() =>
    db.user.create({
      data: {
        organizationId: orgId, email: `eval-${slug}@eval.local`,
        name: 'Eval Admin', passwordHash: '!', role: 'admin', sessionVersion: 1,
      },
    }),
  )
  await bypassOrg(() =>
    db.llmConfig.create({
      data: {
        organizationId: orgId,
        provider: 'OPENAI_COMPATIBLE',
        baseUrl: BASE_URL,
        model: MODEL,
        encryptedApiKey: encryptConfig({ apiKey: API_KEY }),
        purpose: 'chat',
      },
    }),
  )

  hr('LLM CONFIGURED')
  console.log(`org      : ${orgId}`)
  console.log(`baseUrl  : ${BASE_URL}`)
  console.log(`model    : ${MODEL}`)

  await bypassOrg(async () => {
    enterWithOrg(orgId)
    const cfg = await getLlmRuntimeConfig()
    if (!cfg) throw new Error('no runtime config resolved')
    console.log(`resolved : provider=${cfg.provider} model=${cfg.model}`)

    hr('LIVE CALL THROUGH THE APP TRANSPORT')
    const out = await chatOnce(cfg, [
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'What is 17 multiplied by 23? Answer with just the number.' },
    ], 0, 'smoke')
    console.log(`raw      : ${JSON.stringify(out).slice(0, 200)}`)
    const digits = (out.match(/391/) ?? []).length > 0
    console.log(digits ? 'PASS — correct arithmetic (391)' : `NOTE — expected 391, got: ${out.slice(0, 120)}`)
  })

  console.log(`\nORG_ID=${orgId}`)
  process.exit(0)
}

main().catch((e) => { console.error('SETUP FAILED:', e); process.exit(1) })
