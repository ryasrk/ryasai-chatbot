#!/usr/bin/env bun
/**
 * Database restore + validation script.
 *
 * Usage:
 *   bun run scripts/restore.ts --file=backups/ryasai-backup-2026-01-01T00-00-00.sql
 *   bun run scripts/restore.ts --file=backups/backup.sql.gz --dry-run
 *
 * Validates: table count, user count, document count, integration count.
 * ponytail: restore is the untested half of every backup system. This script
 * proves the backup is restorable by running pg_restore + a validation query suite.
 */
import { execSync } from 'child_process'
import { existsSync } from 'fs'

const args = process.argv.slice(2)
const fileArg = args.find((a) => a.startsWith('--file='))
const dryRun = args.includes('--dry-run')

if (!fileArg) {
  console.error('Usage: bun run scripts/restore.ts --file=<path> [--dry-run]')
  process.exit(1)
}

const filepath = fileArg.split('=')[1]
if (!existsSync(filepath)) {
  console.error(`File not found: ${filepath}`)
  process.exit(1)
}

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}

const isCompressed = filepath.endsWith('.gz')

if (dryRun) {
  console.log(`[restore] DRY RUN — would restore from ${filepath}`)
  console.log('[restore] DRY RUN — would run validation queries:')
  console.log('  - SELECT count(*) FROM "User"')
  console.log('  - SELECT count(*) FROM "Document"')
  console.log('  - SELECT count(*) FROM "Integration"')
  console.log('  - SELECT count(*) FROM "ChatSession"')
  console.log('[restore] DRY RUN complete — no changes made.')
  process.exit(0)
}

console.log(`[restore] Restoring from ${filepath}...`)

const cmd = isCompressed
  ? `gunzip -c "${filepath}" | psql "${dbUrl}" --set ON_ERROR_STOP=on`
  : `psql "${dbUrl}" --set ON_ERROR_STOP=on -f "${filepath}"`

try {
  execSync(cmd, { stdio: 'inherit', timeout: 600_000 })
  console.log('[restore] Restore complete. Running validation...')
} catch (e) {
  console.error('[restore] Restore failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}

const validations: Array<{ label: string; sql: string; min: number }> = [
  { label: 'User table exists with rows', sql: 'SELECT count(*) FROM "User"', min: 1 },
  { label: 'Document table exists', sql: 'SELECT count(*) FROM "Document"', min: 0 },
  { label: 'Integration table exists', sql: 'SELECT count(*) FROM "Integration"', min: 0 },
  { label: 'ChatSession table exists', sql: 'SELECT count(*) FROM "ChatSession"', min: 0 },
]

let allPassed = true
for (const v of validations) {
  try {
    const result = execSync(`psql "${dbUrl}" -t -c "${v.sql}"`).toString().trim()
    const count = Number(result)
    const passed = count >= v.min
    console.log(`[restore] ${passed ? 'PASS' : 'FAIL'}: ${v.label} → ${count} rows (min: ${v.min})`)
    if (!passed) allPassed = false
  } catch (e) {
    console.error(`[restore] FAIL: ${v.label} → query error: ${e instanceof Error ? e.message : String(e)}`)
    allPassed = false
  }
}

if (allPassed) {
  console.log('[restore] All validations passed. Backup is restorable.')
} else {
  console.error('[restore] Some validations failed. Check the backup integrity.')
  process.exit(1)
}
