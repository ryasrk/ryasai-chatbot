/** Generate the golden set by calling the harness function directly.
 *  The golden-set.ts CLI segfaults inside Bun 1.3.14 (crash report issued);
 *  the library function itself is fine, so call it rather than the CLI. */
import { writeFileSync } from 'node:fs'
import { generateExtractiveGoldenSet } from '../benchmark/golden-set'
import { bypassOrg } from '../src/lib/prisma-tenant'

const ORG = process.env.EVAL_ORG_ID!

async function main() {
  const qs = await bypassOrg(() => generateExtractiveGoldenSet({ orgId: ORG, limit: 40 }))
  console.log(`generated ${qs.length} extractive questions`)
  for (const q of qs.slice(0, 4)) {
    console.log(`  [${q.id}] ${q.question}`)
  }
  writeFileSync('/tmp/golden.json', JSON.stringify({ questions: qs }, null, 2))
  console.log('wrote /tmp/golden.json')
  process.exit(0)
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
