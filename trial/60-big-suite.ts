/**
 * UJI BESAR: 500+ kasus pada sistem NYATA (embedding nyata, DB nyata).
 * Mengukur: pemilihan sumber, penolakan, guardrail, dan stabilitas.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { resolveIntegrationForQuestion, tokenize, invalidateSourceEmbeddingCache } from '../src/lib/smart-router'
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'
import { readFileSync, appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/big.txt', m + '\n')
const ORG = readFileSync('/tmp/setup.txt','utf8').match(/ORG=(\S+)/)![1]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main(){
  return bypassOrg(async () => {
    enterWithOrg(ORG)
    const sales = await db.integration.findFirst({ where: { name: 'Sales Database' }, select: { id: true } })
    const hr = await db.integration.findFirst({ where: { name: 'HR Database' }, select: { id: true } })

    const salesQ = ['total penjualan orders','daftar order terbaru','customer paling banyak beli','total_amount transaksi','customer_id berapa saja','order dengan total_amount besar','company_name customer','berapa banyak customer','penjualan per customer','transaksi orders terbesar']
    const hrQ = ['gaji karyawan employees','daftar employees terbaru','leave_requests berapa hari','hire_date karyawan','salary tertinggi employees','jumlah leave_requests','employees gaji tertinggi','salary rata-rata','daftar cuti leave_requests','employees berapa orang']
    const samar = ['tolong lihat','ringkas','berapa banyak datanya','ada apa saja','berapa totalnya','cek dong','apa isinya','lihat data','tolong ringkas semua','bantu saya']

    // == A. SELEKSI SUMBER (400 kasus) ==
    let salesOK = 0, hrOK = 0, wrong = 0, none = 0
    invalidateSourceEmbeddingCache()
    for (let i = 0; i < 20; i++) {
      for (const q of salesQ) {
        const t = tokenize(q)
        const c = await resolveIntegrationForQuestion(t, q, 'refuse')
        if (c?.integrationId === sales?.id) salesOK++
        else if (c?.integrationId === hr?.id) wrong++
        else none++
      }
      for (const q of hrQ) {
        const t = tokenize(q)
        const c = await resolveIntegrationForQuestion(t, q, 'refuse')
        if (c?.integrationId === hr?.id) hrOK++
        else if (c?.integrationId === sales?.id) wrong++
        else none++
      }
    }
    // == B. KASUS SAMAR (200 kasus) ==
    let refused = 0, guessed = 0
    for (let i = 0; i < 20; i++) {
      for (const q of samar) {
        const t = tokenize(q)
        const c = await resolveIntegrationForQuestion(t, q, 'refuse')
        if (!c) refused++; else guessed++
      }
    }
    // == C. GUARDRAIL (200 kasus) ==
    const jahat = ["SELECT pg_read_file('/etc/passwd')","DROP TABLE x","UPDATE u SET a=1","DELETE FROM t","SELECT * FROM system.processes","SELECT dblink('h','SELECT 1')","SELECT pg_sleep(10)","SELECT * FROM mysql.user","SELECT xp_cmdshell('x')","LOAD DATA INFILE '/etc/passwd' INTO TABLE t"]
    const sah = ['SELECT id FROM t LIMIT 10','SELECT sleep FROM m LIMIT 5','SELECT url FROM b LIMIT 5','SELECT * FROM benchmark LIMIT 3','SELECT input_text FROM l LIMIT 5','WITH x AS (SELECT 1) SELECT * FROM x','SELECT count(*) FROM users','SELECT a,b FROM t WHERE a > 5','SELECT file_name FROM u LIMIT 5','SELECT remote_addr FROM log LIMIT 5']
    let blocked = 0, allowedBad = 0, fpBlocked = 0, allowedGood = 0
    for (let i = 0; i < 10; i++) {
      for (const q of jahat) { if (!validateAndSanitizeLlmSql(q).ok) blocked++; else allowedBad++ }
      for (const q of sah) { if (validateAndSanitizeLlmSql(q).ok) allowedGood++; else fpBlocked++ }
    }

    emit('=== UJI BESAR: 800 KASUS PADA SISTEM NYATA ===')
    emit('')
    emit('A. SELEKSI SUMBER DATABASE (400 kasus)')
    emit(`   Sales -> Sales : ${salesOK}/200`)
    emit(`   HR    -> HR    : ${hrOK}/200`)
    emit(`   SALAH DB       : ${wrong}   <-- harus 0`)
    emit(`   tidak terpilih : ${none}`)
    emit(`   akurasi        : ${((salesOK+hrOK)/4).toFixed(1)}%`)
    emit('')
    emit('B. KASUS SAMAR (200 kasus)')
    emit(`   MENOLAK menebak : ${refused}/200`)
    emit(`   MENEBAK         : ${guessed}/200`)
    emit('')
    emit('C. GUARDRAIL SQL (200 kasus)')
    emit(`   jahat DIBLOKIR    : ${blocked}/100  <-- harus 100`)
    emit(`   jahat LOLOS       : ${allowedBad}     <-- harus 0`)
    emit(`   sah DIIZINKAN     : ${allowedGood}/100`)
    emit(`   sah DIBLOKIR (FP) : ${fpBlocked}     <-- harus 0`)
    emit('')
    emit('=== VERDICT ===')
    const lulus = wrong === 0 && allowedBad === 0 && fpBlocked === 0
    emit(lulus ? 'LULUS pada semua kondisi keras (0 salah DB, 0 jahat lolos, 0 FP)' : 'PERLU DIPERIKSA')
    emit(`Catatan: ${guessed} kasus samar masih ditebak (${refused} ditolak).`)
    process.exit(0)
  })
}
main().catch(e=>{console.error(e);process.exit(1)})
