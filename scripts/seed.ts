/**
 * Seed script — minimal clean state.
 * Run with: `bun run scripts/seed.ts`
 *
 * Creates only:
 *   - 1 Default Organization (no license — user activates via UI)
 *   - 1 Admin User
 *   - 9 Prebuilt Plugins (tools)
 *
 * No demo integrations, documents, REST connectors, schedules, API keys, or audit logs.
 * The user configures their own DB connections, uploads their own documents, etc.
 */
import { db } from '../src/lib/db'
import { hashPassword } from '../src/lib/passwords'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || 'admin@ryas.ai'
const adminPassword = process.env.ADMIN_INITIAL_PASSWORD || 'admin12345'

async function main() {
  console.log('🌱 Seeding ryasai database (clean state)...')

  // 1. Organization ---------------------------------------------------------
  const org = await bypassOrg(() =>
    db.organization.upsert({
      where: { slug: 'default' },
      update: { name: 'Default Organization' },
      create: {
        id: 'org-default',
        name: 'Default Organization',
        slug: 'default',
      },
    }),
  )
  enterWithOrg(org.id)
  console.log(`   ↳ organization: ${org.name} (${org.id})`)

  // 2. Admin user -----------------------------------------------------------
  await bypassOrg(() =>
    db.user.upsert({
      where: { email: adminEmail },
      update: {
        name: 'Admin',
        isActive: true,
        passwordHash: hashPassword(adminPassword),
        role: 'admin',
        organizationId: org.id,
      },
      create: {
        id: 'usr-admin',
        email: adminEmail,
        name: 'Admin',
        passwordHash: hashPassword(adminPassword),
        avatarColor: 'oklch(0.55 0.18 250)',
        isActive: true,
        role: 'admin',
        organizationId: org.id,
        sessionVersion: 0,
      },
    }),
  )
  console.log(`   ↳ admin user: ${adminEmail}`)

  // 3. AppConfig ------------------------------------------------------------
  const existingConfig = await db.appConfig.findFirst()
  if (!existingConfig) {
    await db.appConfig.create({
      data: {
        organizationId: org.id,
        setupCompleted: false,
        organizationName: org.name,
      },
    })
  }
  console.log('   ↳ app config created')

  // 4. Plugins (prebuilt tools) ---------------------------------------------
  await db.plugin.deleteMany({})
  const { seedPlugins } = await import('./seed-plugins')
  await seedPlugins()
  console.log(`   ↳ inserted ${await db.plugin.count()} plugins`)

  console.log('\n✅ Seed complete (clean state).')
  console.log(`   Admin    → ${adminEmail} / ${adminPassword}`)
  console.log('   Plugins  → 9 prebuilt tools')
  console.log('')
  console.log('   No demo data. Configure your own:')
  console.log('   - Integrations  (Data Sources menu)')
  console.log('   - Documents     (Knowledge menu)')
  console.log('   - LLM config    (AI Configuration menu)')
  console.log('   - API keys      (Settings menu)')
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
