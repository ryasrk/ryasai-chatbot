/**
 * Temuan: 6 peran LLM didukung kode, tapi API hanya bisa menulis purpose='chat'.
 * Artinya pelanggan TIDAK bisa memakai model murah untuk routing.
 */
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/role.txt', m + '\n')

function main() {
  emit('=== ARSITEKTUR YANG SUDAH ADA ===')
  emit('getRoleLlmConfig(role) mendukung 6 peran:')
  emit('  extract, query, keyword, vlm, chat, agent')
  emit('Tiap peran: cari row llmConfig dengan purpose=role.')
  emit('Kalau tidak ada -> JATUH KEMBALI ke model chat. Jadi ini opt-in.')
  emit('')
  emit('=== TAPI TIDAK TERHUBUNG ===')
  emit('src/app/api/llm-config/route.ts:107 menulis:')
  emit("  data: { ..., purpose: 'chat', ...payload, ... }")
  emit('')
  emit("`purpose: 'chat'` ditulis SEBELUM spread payload, jadi SECARA TEKNIS")
  emit('payload.purpose bisa menimpanya. Tapi payload dibangun tanpa field')
  emit('purpose (diverifikasi: grep "const payload" -> tidak ada purpose), dan')
  emit('UI hanya menampilkan SATU form konfigurasi. Jadi dalam praktik: peran')
  emit('selain chat tidak pernah bisa diatur oleh pelanggan.')
  emit('')
  emit('=== AKIBATNYA ===')
  emit('Fitur "model berbeda per peran" ada di kode, tapi tidak dapat dipakai.')
  emit('Semua peran memakai satu model: model termahal/terlambat yang pelanggan')
  emit('pilih, dipakai juga untuk tugas sepele seperti judul sesi dan klasifikasi')
  emit('intent.')
  emit('')
  emit('=== INILAH EFISIENSI TERBESAR YANG AMAN ===')
  emit('Bukan menghapus panggilan (itu menurunkan akurasi — lihat trial/34),')
  emit('tapi memakai model MURAH untuk panggilan yang tidak butuh kecerdasan:')
  emit('  keyword/intent  -> model kecil, 0,5 detik, cukup')
  emit('  title           -> model kecil')
  emit('  query/reflection-> model kecil')
  emit('  chat/synthesis  -> model BESAR (jawaban akhir, akurasi penting)')
  emit('')
  emit('Hasil: akurasi sintesis TIDAK berubah, latency & biaya turun drastis.')
  emit('Dan ini keputusan PELANGGAN (BYOK) — mereka punya kunci masing-masing.')
  process.exit(0)
}
main()
