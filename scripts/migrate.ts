#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { canBaselineSchema } from '../src/lib/migration-baseline'
import { postgresScalar } from '../src/lib/postgres-backup'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const baseline = '20261004000000_baseline'
function prisma(args: string[], capture = false): string {
  const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
    env: process.env, encoding: 'utf8', timeout: 300_000,
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.error || result.status !== 0) throw new Error('Prisma migration command failed')
  return result.stdout ?? ''
}

const tables = Number(postgresScalar(databaseUrl,
  "SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'"))
const history = Number(postgresScalar(databaseUrl,
  "SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename = '_prisma_migrations'"))
if (!Number.isSafeInteger(tables) || !Number.isSafeInteger(history)) throw new Error('Could not inspect migration state')
if (tables > 0 && history === 0) {
  // Adopt only the recorded baseline shape. Never execute the diff: runtime
  // indexes must survive, and a legacy schema mismatch needs a reviewed migration.
  const diff = prisma(['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma',
    '--to-schema-datamodel', `prisma/migrations/${baseline}/schema.prisma`, '--script'], true)
  if (!canBaselineSchema(diff)) throw new Error('Legacy schema differs from the baseline; back up and reconcile it before migrating')
  prisma(['migrate', 'resolve', '--applied', baseline])
}
prisma(['migrate', 'deploy'])
