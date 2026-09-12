/**
 * Prove ALIGNMENT_CHECK=llm actually engages the gate after the fix.
 * Before the fix this was a silent no-op (compared against 'true').
 */
import { isAlignmentCheckEnabled, checkAlignment } from '../src/lib/alignment-check'
import { hr } from './lib'

for (const v of ['llm', 'disabled', 'true', undefined as unknown as string]) {
  if (v === undefined) delete process.env.ALIGNMENT_CHECK
  else process.env.ALIGNMENT_CHECK = v
  delete process.env.ALIGNMENT_CHECK_URL
  console.log(`ALIGNMENT_CHECK=${String(JSON.stringify(v)).padEnd(12)} -> enabled=${isAlignmentCheckEnabled()}`)
}
hr('LIVE checkAlignment with ALIGNMENT_CHECK=llm')
process.env.ALIGNMENT_CHECK = 'llm'
process.env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
const r = await checkAlignment('I will answer the question about overtime.', 'What is the overtime rate?')
console.log('result:', JSON.stringify(r))
process.exit(0)
