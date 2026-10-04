#!/usr/bin/env bun
import { join } from 'node:path'
import { backupPostgres } from '../src/lib/postgres-backup'

const args = process.argv.slice(2)
const outputDir = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) ?? 'backups'
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const filepath = join(outputDir, `ryasai-backup-${timestamp}.sql${args.includes('--compress') ? '.gz' : ''}`)
try {
  const size = await backupPostgres(databaseUrl, filepath)
  console.log(`[backup] Saved ${filepath} (${size} bytes)`)
} catch (error) {
  console.error('[backup]', error instanceof Error ? error.message : 'Backup failed')
  process.exitCode = 1
}
