/**
 * Uji: apakah deny-list multi-dialek menyebabkan FALSE POSITIVE?
 * Kolom bernama "sleep" atau "mysql_..." sah-sah saja di banyak database.
 */
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/fp.txt', m + '\n')

const sah = [
  ['Kolom bernama sleep', "SELECT sleep FROM health_metrics LIMIT 10"],
  ['Kolom mysql_host', "SELECT mysql_host FROM servers LIMIT 5"],
  ['Kolom postgres_url', "SELECT postgres_url FROM config LIMIT 5"],
  ['Kolom url di SELECT', "SELECT url FROM bookmarks LIMIT 10"],
  ['Kolom file_name', "SELECT file_name FROM uploads LIMIT 10"],
  ['Tabel bernama benchmark', "SELECT * FROM benchmark LIMIT 10"],
  ['Kolom input_text', "SELECT input_text FROM logs LIMIT 10"],
  ['Kolom remote_addr', "SELECT remote_addr FROM access_log LIMIT 10"],
]

function main() {
  emit('=== FALSE POSITIVE? Query SAH yang mungkin diblokir ===')
  emit('')
  let fp = 0
  for (const [nama, sql] of sah) {
    const r = validateAndSanitizeLlmSql(sql)
    if (r.ok) {
      emit(`OK      | ${nama}`)
    } else {
      fp++
      emit(`DIBLOK  | ${nama}`)
      emit(`        | sebab: ${(r.reason ?? '').slice(0, 70)}`)
      emit(`        | SQL: ${sql}`)
    }
  }
  emit('')
  emit(`FALSE POSITIVE: ${fp}/${sah.length}`)
  emit('')
  emit('INI PENTING: kalau query sah diblokir, pelanggan tidak bisa pakai')
  emit('fitur, dan repair-loop akan mencoba 2x lalu gagal total. Blokir yang')
  emit('berlebihan BUKAN "aman" — itu bug fungsional.')
  process.exit(0)
}
main()
