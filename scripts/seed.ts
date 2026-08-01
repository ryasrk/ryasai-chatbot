/**
 * Seed script — pure empty state.
 * Run with: `bun run scripts/seed.ts`
 *
 * Creates nothing. The database is completely empty.
 * The user registers via the signup flow: Register → License → Setup Wizard.
 * Plugins are seeded per-org during setup completion.
 */
import { db } from '../src/lib/db'

async function main() {
  console.log('🌱 Seeding ryasai database (pure empty)...')
  console.log('   Nothing to seed — database is empty.')
  console.log('')
  console.log('✅ Done. Start the app and register via the signup flow.')
  console.log('   1. Register (name, email, password)')
  console.log('   2. Activate License (enter license key)')
  console.log('   3. Setup Wizard (LLM config, etc.)')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
    process.exit(0)
  })
