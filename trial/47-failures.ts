/** Bedah tiap kegagalan: mana yang salah DB, mana yang menebak saat samar. */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { pickBestIntegrationWithAmbiguity, tokenize } from '../src/lib/smart-router'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/fail.txt', m + '\n')
const ORG = readFileSync('/tmp/setup.txt','utf8').match(/ORG=(\S+)/)![1]

async function main(){
  return bypassOrg(async () => {
    enterWithOrg(ORG)
    const sales = await db.integration.findFirst({ where: { name: 'Sales Database' }, select: { id: true } })
    const hr = await db.integration.findFirst({ where: { name: 'HR Database' }, select: { id: true } })

    const hrQ = ['berapa gaji karyawan','daftar karyawan terbaru','berapa hari cuti diambil','hire_date karyawan','salary tertinggi','jumlah leave_requests','karyawan dengan gaji tertinggi','berapa salary rata-rata','daftar cuti','employees berapa orang']
    emit('=== 10 PERTANYAAN HR, CEK SATU PER SATU ===')
    for (const q of hrQ) {
      const t = tokenize(q)
      const r = await pickBestIntegrationWithAmbiguity(t, q)
      const mana = r?.integrationId === hr?.id ? 'HR   ' : r?.integrationId === sales?.id ? 'SALES' : 'TIDAK'
      emit(`${mana === 'HR   ' ? 'OK  ' : 'SALAH'} | ${mana} <- "${q}"`)
    }
    emit('')
    const vague = ['berapa banyak datanya','tampilkan semuanya','ada apa saja','berapa jumlahnya','tolong lihat','cek dong','apa isinya','berapa totalnya','lihat data','ringkas']
    emit('=== 10 PERTANYAAN SAMAR, SEHARUSNYA DITOLAK ===')
    for (const q of vague) {
      const t = tokenize(q)
      const r = await pickBestIntegrationWithAmbiguity(t, q)
      const mana = r?.integrationId === hr?.id ? 'HR' : r?.integrationId === sales?.id ? 'SALES' : 'TIDAK(baik)'
      emit(`${r?.integrationId ? 'MENEBAK' : 'MENOLAK'} | ${mana} <- "${q}"`)
    }
    process.exit(0)
  })
}
main().catch(e=>{console.error(e);process.exit(1)})
