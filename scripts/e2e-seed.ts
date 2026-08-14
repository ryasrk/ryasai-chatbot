/**
 * E2E database seeder — PostgreSQL.
 *
 * Uses the dedicated e2e database (E2E_DATABASE_URL, default ryasai_e2e on
 * localhost). Schema is Postgres-only now, so the old SQLite file flow is gone.
 * Does NOT create rows — the setup-wizard spec creates the admin on a fresh DB.
 */
import { $ } from 'bun'

const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai_e2e'

console.log('[e2e-seed] Resetting e2e database…', E2E_DB)

// Drop & recreate — a schema reset must be total between runs.
await $`env DATABASE_URL=${E2E_DB} bunx prisma db push --accept-data-loss --skip-generate`
  .quiet()

// db push only guarantees SCHEMA, not emptiness — an unchanged schema leaves
// rows from the previous run alive, which made the setup-wizard spec skip
// signup (hasAdmin=true → Sign In) on every run after the first.
await $`env DATABASE_URL=${E2E_DB} bun run scripts/e2e-truncate.ts`.quiet()

console.log('[e2e-seed] ✅ e2e db ready (postgres, emptied)')
