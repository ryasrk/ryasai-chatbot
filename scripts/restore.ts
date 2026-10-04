#!/usr/bin/env bun
import { stat } from 'node:fs/promises'
import { postgresScalar, restorePostgres } from '../src/lib/postgres-backup'

const args = process.argv.slice(2)
const filepath = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
const databaseUrl = process.env.DATABASE_URL
if (!filepath || !databaseUrl) throw new Error('DATABASE_URL and --file=<path> are required')
if (!(await stat(filepath)).size) throw new Error('Database dump is empty')
if (args.includes('--dry-run')) {
  console.log(`[restore] Would restore ${filepath}; no database changes made`)
} else {
  try {
    await restorePostgres(databaseUrl, filepath)
    for (const table of ['User', 'Document', 'Integration', 'ChatSession']) {
      const count = Number(postgresScalar(databaseUrl, `SELECT count(*) FROM "${table}"`))
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid row count for ${table}`)
      console.log(`[restore] ${table}: ${count} rows`)
    }
    console.log('[restore] Restore and table validation passed')
  } catch (error) {
    console.error('[restore]', error instanceof Error ? error.message : 'Restore failed')
    process.exitCode = 1
  }
}
