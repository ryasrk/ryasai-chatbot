/**
 * E2E database seeder.
 *
 * Deletes any previous e2e DB, runs prisma db push against a fresh file, then
 * applies the FTS5 virtual table SQL. Does NOT create any rows — the setup
 * wizard spec is responsible for creating the admin on a truly fresh DB.
 */
import { $ } from 'bun'
import { resolve } from 'node:path'

// Use an ABSOLUTE path so that Prisma (which resolves relative to schema.prisma)
// and sqlite3 (which resolves relative to cwd) operate on the SAME file.
const E2E_DB_PATH = resolve(process.cwd(), 'db/e2e.db')
const E2E_DB = `file:${E2E_DB_PATH}`

console.log('[e2e-seed] Resetting e2e database…', E2E_DB_PATH)
await $`rm -f ${E2E_DB_PATH} ${E2E_DB_PATH}-journal`

// Also clean up any stale DB created by previous relative-path runs.
await $`rm -f ${resolve(process.cwd(), 'prisma/db/e2e.db')}`
await $`rm -f ${resolve(process.cwd(), 'prisma/db/e2e.db-journal')}`

console.log('[e2e-seed] Running prisma db push…')
await $`env DATABASE_URL=${E2E_DB} bunx prisma db push --skip-generate`

console.log('[e2e-seed] Applying FTS5 SQL…')
await $`sqlite3 ${E2E_DB_PATH} < prisma/rag-fts.sql`

console.log('[e2e-seed] ✅ e2e db ready')

console.log('[e2e-seed] ✅ e2e db ready')
