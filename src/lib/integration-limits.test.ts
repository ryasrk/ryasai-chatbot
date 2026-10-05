import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INTEGRATION_PROMPT_MAX, TABLE_DESCRIPTION_MAX } from '@/lib/integration-limits'

const ROOT = join(import.meta.dir, '../..')

describe('integration text caps — one definition', () => {
  test('the caps are the documented values', () => {
    expect(INTEGRATION_PROMPT_MAX).toBe(4000)
    expect(TABLE_DESCRIPTION_MAX).toBe(500)
  })

  test('no other module re-declares a cap as a literal (the "must match" comments this replaced)', () => {
    const offenders = globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
      .filter((f) => !f.endsWith('.test.ts') && f !== 'src/lib/integration-limits.ts')
      .filter((f) => /\b(INTEGRATION_PROMPT_MAX|TABLE_DESCRIPTION_MAX|SCHEMA_DESC_MAX)\s*=\s*\d/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
