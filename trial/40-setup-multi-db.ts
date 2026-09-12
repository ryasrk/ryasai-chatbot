/**
 * Siapkan skenario NYATA: satu org, DUA database aktif.
 * HR dibuat lebih dulu (2024) supaya bug lama (pilih tertua) bisa terdeteksi.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { encryptConfig } from '../src/lib/crypto'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/setup.txt', m + '\n')

async function main() {
  const s = 'probe'
  // bersihkan sisa
  const old = await bypassOrg(() => db.organization.findFirst({ where: { slug: `probe-${s}` }, select: { id: true } }))
  if (old) {
    await bypassOrg(async () => {
      await db.integration.deleteMany({ where: { organizationId: old.id } })
      await db.document.deleteMany({ where: { organizationId: old.id } })
      await db.user.deleteMany({ where: { organizationId: old.id } })
      await db.organization.delete({ where: { id: old.id } })
    })
  }

  const org = await bypassOrg(() => db.organization.create({
    data: { name: 'Probe Org', slug: `probe-${s}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))

  const cfg = encryptConfig({ baseUrl: 'http://127.0.0.1:4545/v1', apiKey: 'sk-probe', model: 'probe-model' })
  await bypassOrg(() => db.llmConfig.create({
    data: {
      organizationId: org.id, purpose: 'chat', provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:4545/v1', encryptedApiKey: cfg, model: 'probe-model',
      embeddingProvider: 'OPENAI_COMPATIBLE', embeddingBaseUrl: 'http://127.0.0.1:4545/v1',
      encryptedEmbeddingApiKey: cfg, embeddingModel: 'probe-embedding',
    },
  }))

  await bypassOrg(async () => {
    enterWithOrg(org.id)
    // HR DULU (2024) — inilah yang dulu selalu terpilih
    const hr = await db.integration.create({
      data: {
        organizationId: org.id, name: 'HR Database', provider: 'POSTGRESQL', type: 'DATABASE',
        encryptedConfig: encryptConfig({ connectionString: 'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' }),
        status: 'active', createdAt: new Date('2024-01-01'),
      },
      select: { id: true },
    })
    await db.integrationSchema.createMany({
      data: [
        { organizationId: org.id, integrationId: hr.id, tableName: 'employees', columns: JSON.stringify([{ name: 'id', type: 'int' }, { name: 'salary', type: 'int' }, { name: 'hire_date', type: 'date' }]), description: 'Employee compensation records' },
        { organizationId: org.id, integrationId: hr.id, tableName: 'leave_requests', columns: JSON.stringify([{ name: 'id', type: 'int' }, { name: 'days', type: 'int' }]), description: 'Employee leave requests' },
      ],
    })
    // SALES kemudian (2025)
    const sales = await db.integration.create({
      data: {
        organizationId: org.id, name: 'Sales Database', provider: 'POSTGRESQL', type: 'DATABASE',
        encryptedConfig: encryptConfig({ connectionString: 'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' }),
        status: 'active', createdAt: new Date('2025-06-01'),
      },
      select: { id: true },
    })
    await db.integrationSchema.createMany({
      data: [
        { organizationId: org.id, integrationId: sales.id, tableName: 'orders', columns: JSON.stringify([{ name: 'id', type: 'int' }, { name: 'total_amount', type: 'int' }, { name: 'customer_id', type: 'int' }]), description: 'Customer order transactions' },
        { organizationId: org.id, integrationId: sales.id, tableName: 'customers', columns: JSON.stringify([{ name: 'id', type: 'int' }, { name: 'company_name', type: 'text' }]), description: 'Customer master data' },
      ],
    })
  })

  const u = await bypassOrg(() => db.user.create({
    data: { organizationId: org.id, email: `probe-${s}@example.com`, name: 'Probe User', role: 'admin', passwordHash: 'x' },
    select: { id: true },
  }))

  emit(`ORG=${org.id}`)
  emit(`USER=${u.id}`)
  emit(`HR=hr-1  (2024, tertua)`)
  emit(`SALES=sales-1  (2025)`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
