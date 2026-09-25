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

// Redis holds the BullMQ document-processing queue, and it is NOT part of the Postgres reset.
// A job left on `active` by a previous run's app being killed stays there, and the stalled
// checker that would requeue it only runs inside a LIVE worker — so the next run starts with
// orphans. MEASURED effect: with 4 jobs on `wait` and 9 on `active`, an e2e document ended up
// with a chunk that had NO vector, `Sources (2)` cited the wrong documents, and
// 03-knowledge-chat failed on an assertion about which document was cited. Clearing the queue
// made it pass, and the same run's documents then embedded fully (2/2 chunks for the answer
// doc, 1/1 for the others).
//
// Deleting the queue keys is safe HERE and only here: this is the e2e database's own Redis
// namespace, the app is not running yet, and nothing else uses these keys.
try {
  const { default: Redis } = await import('ioredis')
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 4000 })
  await r.connect()
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, found] = await r.scan(cursor, 'MATCH', 'bull:document-processing:*', 'COUNT', 500)
    cursor = next
    keys.push(...found)
  } while (cursor !== '0')
  if (keys.length > 0) await r.del(...keys)
  r.disconnect()
  console.log(`[e2e-seed] cleared ${keys.length} document-processing queue key(s) from Redis`)
} catch (e) {
  // Not fatal: the app degrades to synchronous processing without Redis, and a seed step must
  // not be the reason an e2e run cannot start.
  console.log(`[e2e-seed] Redis not cleared (${e instanceof Error ? e.message : String(e)}) — continuing`)
}

console.log('[e2e-seed] ✅ e2e db ready (postgres emptied, queue cleared)')
