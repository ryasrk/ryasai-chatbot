#!/usr/bin/env bun
/**
 * Automated backup validation — runs backup → restore → validate cycle.
 * Designed for cron or CI: exits 0 on success, 1 on failure.
 *
 * Usage:
 *   bun run scripts/validate-backup.ts                    # uses a temp restore DB
 *   bun run scripts/validate-backup.ts --restore-db=postgresql://user:pass@localhost:5432/ryasai_test
 *
 * ponytail: the only way to trust a backup is to restore it. This script
 * automates the full cycle so it can run nightly in CI.
 */
import { execSync } from 'child_process'
import { rmSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

const args = process.argv.slice(2)
const restoreDbArg = args.find((a) => a.startsWith('--restore-db='))
const restoreDb = restoreDbArg?.split('=')[1] ?? process.env.BACKUP_TEST_DATABASE_URL

const sourceDb = process.env.DATABASE_URL
if (!sourceDb) {
  console.error('[validate-backup] DATABASE_URL is required.')
  process.exit(1)
}

if (!restoreDb) {
  console.error('[validate-backup] BACKUP_TEST_DATABASE_URL or --restore-db is required.')
  console.error('[validate-backup] Set up a separate test database for restore validation.')
  process.exit(1)
}

const tmpDir = mkdtempSync(join(tmpdir(), 'ryasai-backup-'))
const backupFile = join(tmpDir, 'test-backup.sql')

console.log('[validate-backup] Step 1: Creating backup...')
try {
  execSync(`pg_dump "${sourceDb}" --no-owner --no-privileges -f "${backupFile}"`, { stdio: 'inherit', timeout: 300_000 })
  console.log(`[validate-backup] Backup created: ${backupFile}`)
} catch (e) {
  console.error('[validate-backup] Backup failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}

console.log('[validate-backup] Step 2: Restoring to test database...')
try {
  execSync(`psql "${restoreDb}" --set ON_ERROR_STOP=on -f "${backupFile}"`, { stdio: 'inherit', timeout: 600_000 })
  console.log('[validate-backup] Restore complete.')
} catch (e) {
  console.error('[validate-backup] Restore failed:', e instanceof Error ? e.message : String(e))
  rmSync(tmpDir, { recursive: true })
  process.exit(1)
}

console.log('[validate-backup] Step 3: Validating restored data...')
const checks: Array<{ label: string; source: string; target: string }> = [
  { label: 'User count matches', source: 'SELECT count(*) FROM "User"', target: 'SELECT count(*) FROM "User"' },
  { label: 'Document count matches', source: 'SELECT count(*) FROM "Document"', target: 'SELECT count(*) FROM "Document"' },
  { label: 'Integration count matches', source: 'SELECT count(*) FROM "Integration"', target: 'SELECT count(*) FROM "Integration"' },
]

let allPassed = true
for (const check of checks) {
  try {
    const sourceCount = execSync(`psql "${sourceDb}" -t -c "${check.source}"`).toString().trim()
    const targetCount = execSync(`psql "${restoreDb}" -t -c "${check.target}"`).toString().trim()
    const passed = sourceCount === targetCount
    console.log(`[validate-backup] ${passed ? 'PASS' : 'FAIL'}: ${check.label} → source=${sourceCount}, target=${targetCount}`)
    if (!passed) allPassed = false
  } catch (e) {
    console.error(`[validate-backup] FAIL: ${check.label} → ${e instanceof Error ? e.message : String(e)}`)
    allPassed = false
  }
}

console.log('[validate-backup] Step 4: Cleanup...')
try {
  execSync(`psql "${restoreDb}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`, { stdio: 'pipe' })
} catch {
  console.warn('[validate-backup] Warning: could not clean test database.')
}
rmSync(tmpDir, { recursive: true })

if (allPassed) {
  console.log('[validate-backup] ALL CHECKS PASSED — backup is valid and restorable.')
  process.exit(0)
} else {
  console.error('[validate-backup] VALIDATION FAILED — backup may be corrupt or incomplete.')
  process.exit(1)
}
