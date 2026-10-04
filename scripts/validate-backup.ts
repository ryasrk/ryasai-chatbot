#!/usr/bin/env bun
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDistinctDatabases, backupPostgres, postgresScalar, restorePostgres } from '../src/lib/postgres-backup'

const source = process.env.DATABASE_URL
const target = process.argv.slice(2).find((arg) => arg.startsWith('--restore-db='))?.slice('--restore-db='.length)
  ?? process.env.BACKUP_TEST_DATABASE_URL
if (!source || !target) throw new Error('DATABASE_URL and a separate BACKUP_TEST_DATABASE_URL are required')
assertDistinctDatabases(source, target)
const tableCount = Number(postgresScalar(target, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"))
if (tableCount !== 0) throw new Error('Restore validation requires an empty target database')
const temporary = await mkdtemp(join(tmpdir(), 'ryasai-backup-'))
try {
  const filepath = join(temporary, 'validation.sql.gz')
  await backupPostgres(source, filepath)
  await restorePostgres(target, filepath)
  for (const table of ['User', 'Document', 'Integration', 'ChatSession']) {
    const sql = `SELECT count(*) FROM "${table}"`
    const before = postgresScalar(source, sql)
    const after = postgresScalar(target, sql)
    if (!/^\d+$/.test(before) || before !== after) throw new Error(`Row count mismatch: ${table}`)
    console.log(`[validate-backup] ${table}: ${after} rows match`)
  }
  console.log('[validate-backup] Restore validation passed; target retained for inspection')
} catch (error) {
  console.error('[validate-backup]', error instanceof Error ? error.message : 'Validation failed')
  process.exitCode = 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
