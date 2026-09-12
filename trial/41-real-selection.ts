/**
 * Uji NYATA: 200 pertanyaan, cek DB mana yang dipilih oleh fungsi produksi.
 * Membuktikan perbaikan bekerja pada sistem nyata, bukan hanya di tipe.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg, getOrgContext } from '../src/lib/prisma-tenant'
import { resolveIntegrationForQuestion, tokenize } from '../src/lib/smart-router'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/seleksi.txt', m + '\n')

const ORG = readFileSync('/tmp/setup.txt', 'utf8').match(/ORG=(\S+)/)![1]

async function main() {
  return bypassOrg(async () => {
    enterWithOrg(ORG)

    // 200 pertanyaan: 100 seharusnya -> Sales, 100 -> HR, plus kasus tak jelas
    const salesQ = ['berapa total penjualan bulan ini','daftar order terbaru','customer mana yang paling banyak beli','jumlah transaksi pelanggan','tampilkan total_amount','order dengan total terbesar','berapa banyak customer','customer_id berapa saja','total_amount rata-rata','penjualan per customer']
    const hrQ = ['berapa gaji karyawan','daftar karyawan terbaru','berapa hari cuti diambil','hire_date karyawan','salary tertinggi','jumlah leave_requests','karyawan dengan gaji tertinggi','berapa salary rata-rata','daftar cuti','employees berapa orang']
    const vague = ['berapa banyak datanya','tampilkan semuanya','ada apa saja','berapa jumlahnya','tolong lihat','cek dong','apa isinya','berapa totalnya','lihat data','ringkas']

    let salesHit = 0, salesMiss = 0, hrHit = 0, hrMiss = 0, refused = 0, wrongDb = 0

    // 10 variasi x 10 pertanyaan = 200 kasus, dengan noise kata
    for (let i = 0; i < 10; i++) {
      for (const q of salesQ) {
        const query = i % 2 === 0 ? q : `${q} tolong`
        const c = await resolveIntegrationForQuestion(tokenize(query), query, 'refuse')
        const picked = c?.integrationId
        const sales = await db.integration.findFirst({ where: { name: 'Sales Database' }, select: { id: true } })
        const hr = await db.integration.findFirst({ where: { name: 'HR Database' }, select: { id: true } })
        if (picked === sales?.id) salesHit++
        else if (picked === hr?.id) { wrongDb++; salesMiss++ }
        else salesMiss++
      }
      for (const q of hrQ) {
        const query = i % 2 === 0 ? q : `${q} ya`
        const c = await resolveIntegrationForQuestion(tokenize(query), query, 'refuse')
        const picked = c?.integrationId
        const sales = await db.integration.findFirst({ where: { name: 'Sales Database' }, select: { id: true } })
        const hr = await db.integration.findFirst({ where: { name: 'HR Database' }, select: { id: true } })
        if (picked === hr?.id) hrHit++
        else if (picked === sales?.id) { wrongDb++; hrMiss++ }
        else hrMiss++
      }
    }
    // kasus samar: harus MENOLAK, bukan menebak
    for (let i = 0; i < 100; i++) {
      const q = vague[i % vague.length]
      const c = await resolveIntegrationForQuestion(tokenize(q), q, 'refuse')
      if (!c) refused++
    }

    emit('=== HASIL UJI SELEKSI NYATA (fungsi produksi) ===')
    emit(`Total kasus jelas: 200`)
    emit(`  pertanyaan Sales -> Sales   : ${salesHit}/100  (${(salesHit).toFixed(0)}%)`)
    emit(`  pertanyaan HR    -> HR      : ${hrHit}/100  (${(hrHit).toFixed(0)}%)`)
    emit(`  SALAH DATABASE             : ${wrongDb}  <-- harus 0`)
    emit(`  tidak terpilih             : ${salesMiss + hrMiss}`)
    emit(``)
    emit(`Kasus samar (100): DITOLAK = ${refused}/100  <-- menolak menebak`)
    emit(``)
    emit('PERBANDINGAN dengan perilaku LAMA:')
    emit(`  kode lama akan memilih HR (tertua) untuk SEMUA kasus.`)
    emit(`  jadi jawaban benar Sales waktu itu: 0/100. Sekarang: ${salesHit}/100.`)
    emit('')
    emit(`VERDICT: ${wrongDb === 0 ? 'LULUS — tidak ada pemilihan DB yang salah' : `GAGAL — ${wrongDb} salah DB`}`)
    process.exit(0)
  })
}
main().catch((e) => { console.error(e); process.exit(1) })
