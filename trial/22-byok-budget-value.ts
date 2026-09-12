/**
 * With BYOK, whose problem is the token budget?
 * The cap is PER-ORG and env-configured, so every org shares one global number.
 */
import { getLlmBudgetConfig } from '../src/lib/llm-budget'
import { hr } from './lib'

function main() {
  hr('BUDGET CONFIG IS PROCESS-WIDE, NOT PER-ORG')
  for (const env of [{}, { LLM_DAILY_TOKEN_BUDGET: '500000' }] as const) {
    const cfg = getLlmBudgetConfig(env as NodeJS.ProcessEnv)
    console.log(`env=${JSON.stringify(env)} -> enabled=${cfg.enabled} cap=${cfg.tokenCap} window=${cfg.windowHours}h`)
  }

  hr('WHY THIS MATTERS UNDER BYOK')
  console.log(`The org hitting the cap pays its OWN provider, so the cap does not`)
  console.log(`protect ryasai's margin at all. It protects the CUSTOMER from`)
  console.log(`their own runaway agent loop — a real but different feature.`)
  console.log(``)
  console.log(`And because it is env-configured, it applies the SAME cap to every`)
  console.log(`org: a 5-person startup and a 500-seat enterprise get one number.`)
  console.log(`The per-org knob the BYOK model wants (each customer sets their own`)
  console.log(`ceiling in the UI) does not exist.`)
  process.exit(0)
}
main()
