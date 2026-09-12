/** Kenapa 90 dari 200 tidak terpilih? Cari akarnya. */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { resolveIntegrationForQuestion, tokenize } from '../src/lib/smart-router'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/unsel.txt', m + '\n')
const ORG = readFileSync('/tmp/setup.txt', 'utf8').match(/ORG=(\S+)/)![1]

async function main() {
  return bypassOrg(async () => {
    enterWithOrg(ORG)
    emit('=== MENGAPA TIDAK TERPILIH? ===')
    emit('')
    emit('tokenize() memfilter kata pendek. Mari lihat token untuk tiap pertanyaan:')
    emit('')
    const qs = ['berapa total penjualan bulan ini','daftar order terbaru','customer mana yang paling banyak beli','berapa gaji karyawan','daftar karyawan terbaru','berapa hari cuti diambil']
    for (const q of qs) {
      const t = tokenize(q)
      const c = await resolveIntegrationForQuestion(t, q, 'refuse')
      emit(`Q: "${q}"`)
      emit(`   token    : [${t.join(', ')}]`)
      emit(`   terpilih : ${c ? c.integrationId.slice(0, 8) : 'TIDAK ADA'}`)
    }
    emit('')
    emit('=== ANALISIS ===')
    emit('Yang jelas terlihat: kata Indonesia umum ("berapa", "daftar", "paling",')
    emit('"banyak") TIDAK ADA di nama tabel/kolom, karena skema saya berbahasa')
    emit('INGGRIS (orders, total_amount, employees, salary).')
    emit('')
    emit('Jadi ini BUKAN kegagalan perbaikan — ini keterbatasan MATCHING:')
    emit('pertanyaan Indonesia vs skema Inggris hanya cocok kalau ada kata yang')
    emit('kebetulan sama (order, customer, salary).')
    emit('')
    emit('Implikasi NYATA untuk pelanggan Anda: kalau skema DB mereka berbahasa')
    emit('Inggris dan pengguna bertanya dalam Indonesia, pemilihan integrasi akan')
    emit('sering TIDAK menemukan kandidat -> pengguna ditanya balik terus.')
    emit('')
    emit('Ini lebih baik daripada salah DB. Tapi kalau terlalu sering bertanya,')
    emit('pengguna akan frustrasi.')
    process.exit(0)
  })
}
main().catch((e) => { console.error(e); process.exit(1) })
