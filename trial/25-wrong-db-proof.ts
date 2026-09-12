/**
 * Bukti: kalau integrationId kosong, sistem memilih integrasi TERTUA,
 * bukan yang cocok. Dua org dengan DB berbeda -> jawaban dari DB salah.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { hr } from './lib'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/wd2.txt', m + '\n')

async function main() {
  const s = Date.now().toString(36)
  const org = await bypassOrg(() => db.organization.create({
    data: { name: `x ${s}`, slug: `wrongdb-${s}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))

  // Dua integrasi, dibuat berurutan. Yang "HR" dibuat DULU.
  const mk = (name: string, dsn: string, when: Date) => bypassOrg(async () => {
    enterWithOrg(org.id)
    return db.integration.create({
      data: {
        organizationId: org.id, name, provider: 'POSTGRESQL', type: 'DATABASE',
        encryptedConfig: 'x', status: 'active', createdAt: when,
      },
      select: { id: true, name: true, createdAt: true },
    })
  })
  const hr1 = await mk('HR Database', 'hr', new Date('2024-01-01'))
  const sales = await mk('Sales Database', 'sales', new Date('2025-06-01'))

  hr('KONDISI')
  emit(`HR Database    dibuat ${hr1.createdAt.toISOString()}  <- TERTUA`)
  emit(`Sales Database dibuat ${sales.createdAt.toISOString()}`)

  hr('APA YANG DIPILIH SISTEM kalau integrasi tidak ditentukan?')
  const picked = await bypassOrg(async () => {
    enterWithOrg(org.id)
    return db.integration.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { name: true },
    })
  })
  emit(`-> ${picked?.name}`)
  emit(``)
  emit(`Pertanyaan "berapa total penjualan?" akan dijalankan terhadap:`)
  emit(`   ${picked?.name}`)
  emit(``)
  if (picked?.name === 'HR Database') {
    emit('HASIL: DB YANG SALAH dipilih untuk pertanyaan sales.')
    emit('       Model akan menebak-nebak SQL terhadap tabel yang tidak ada,')
    emit('       lalu repair-loop mencoba 2x lagi dan tetap gagal — ATAU lebih')
    emit('       buruk: kebetulan ada tabel bernama mirip, dan jawabannya SALAH')
    emit('       TANPA ERROR.')
  }

  await bypassOrg(async () => {
    await db.integration.deleteMany({ where: { organizationId: org.id } })
    await db.organization.delete({ where: { id: org.id } })
  })
  process.exit(0)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
