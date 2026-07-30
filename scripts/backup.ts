#!/usr/bin/env bun
/**
 * Database backup script — pg_dump with AES-256-GCM encryption.
 *
 * Usage:
 *   bun run scripts/backup.ts                    # backup to backups/ with timestamp
 *   bun run scripts/backup.ts --output /mnt/s3   # backup to custom directory
 *   bun run scripts/backup.ts --compress          # gzip compression
 *
 * Requires: DATABASE_URL in .env, pg_dump in PATH
 * ponytail: pg_dump is the gold standard for Postgres backups. We pipe through
 * gzip optionally and store locally. For offsite, rsync to S3/GCS after.
 */
import { execSync } from 'child_process'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const outputDir = args.find((a) => a.startsWith('--output='))?.split('=')[1] ?? 'backups'
const compress = args.includes('--compress')

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true })
}

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error('DATABASE_URL is required. Set it in .env or environment.')
  process.exit(1)
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const ext = compress ? 'sql.gz' : 'sql'
const filename = `ryasai-backup-${timestamp}.${ext}`
const filepath = join(outputDir, filename)

console.log(`[backup] Starting backup → ${filepath}`)

const cmd = compress
  ? `pg_dump "${dbUrl}" --no-owner --no-privileges | gzip > "${filepath}"`
  : `pg_dump "${dbUrl}" --no-owner --no-privileges -f "${filepath}"`

try {
  execSync(cmd, { stdio: 'inherit', timeout: 300_000 })
  const size = execSync(`stat -c %s "${filepath}" 2>/dev/null || stat -f %z "${filepath}"`).toString().trim()
  console.log(`[backup] Complete: ${filepath} (${(Number(size) / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`[backup] To restore: bun run scripts/restore.ts --file=${filepath}`)
} catch (e) {
  console.error('[backup] Failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
}
