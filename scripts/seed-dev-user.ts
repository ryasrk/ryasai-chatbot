/**
 * Local-dev test account (idempotent). Run by start.bat after `prisma db push`.
 * Creates an org with setup already completed + an admin user, so you can log
 * in directly without signup / license / setup wizard.
 * Override with DEV_USER_EMAIL / DEV_USER_PASSWORD. Refuses to run in production.
 */
import { db } from '../src/lib/db'
import { hashPassword } from '../src/lib/passwords'
import { bypassOrg } from '../src/lib/prisma-tenant'

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev-user: refusing to run with NODE_ENV=production')
  process.exit(1)
}

const email = process.env.DEV_USER_EMAIL || 'test@ryasai.local'
const password = process.env.DEV_USER_PASSWORD || 'Test1234'

await bypassOrg(async () => {
  const org =
    (await db.organization.findUnique({ where: { slug: 'dev' } })) ??
    (await db.organization.create({
      data: { name: 'Dev Organization', slug: 'dev', licensePlan: 'enterprise', licenseStatus: 'valid', licenseValidatedAt: new Date() },
    }))

  const cfg = await db.appConfig.findFirst({ where: { organizationId: org.id } })
  if (cfg) await db.appConfig.update({ where: { id: cfg.id }, data: { setupCompleted: true } })
  else await db.appConfig.create({ data: { organizationId: org.id, setupCompleted: true, organizationName: org.name } })

  await db.user.upsert({
    where: { email },
    create: { email, name: 'Test Admin', passwordHash: hashPassword(password), role: 'admin', isActive: true, organizationId: org.id },
    update: { passwordHash: hashPassword(password), role: 'admin', isActive: true },
  })
})

console.log(`Dev test account ready:  ${email}  /  ${password}`)
await db.$disconnect()
process.exit(0)
