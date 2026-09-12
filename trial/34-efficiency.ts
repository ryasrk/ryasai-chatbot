/** Analisis efisiensi: apa yang bisa dihemat TANPA menurunkan akurasi? */
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/eff.txt', m + '\n')

function main() {
  emit('=== PETA PANGGILAN LLM PER PERTANYAAN (jalur SQL, worst case) ===')
  emit('')
  const jalur: Array<[string, string, string]> = [
    ['1', 'rewriteQuery (follow-up)', 'menyelesaikan "dan bulan lalu?" -> mandiri'],
    ['2', 'analyzeIntent', 'pilih tool + cek klarifikasi'],
    ['3', 'expandQuery (sinonim/terjemah)', 'jembatani ID<->EN'],
    ['4', 'evaluateEvidenceSufficiency', 'cukup atau perlu pass kedua'],
    ['5', 'generateSql', 'tulis SQL'],
    ['6', 'generateSql (repair)', 'kalau gagal, coba 2x'],
    ['7', 'generateAnswer / streamAnswer', 'susun jawaban akhir'],
  ]
  for (const [n, nama, guna] of jalur) emit(`  ${n}. ${nama.padEnd(34)} ${guna}`)
  emit('')
  emit('DENGAN MODEL 6,5 detik/panggilan (terukur) = 45,5 detik untuk 7 panggilan.')
  emit('Itu ONGKOS akurasi. Pertanyaannya: mana yang bisa dihemat?')
  emit('')
  emit('=== KANDIDAT EFISIENSI (diurutkan dari paling aman) ===')
  emit('')
  emit('A. GABUNG rewriteQuery + analyzeIntent  [AMAN, hemat 1 panggilan]')
  emit('   Keduanya membaca input yang SAMA (pertanyaan + history) dan keduanya')
  emit('   keluaran TEKS/JSON kecil. Bisa jadi satu panggilan yang mengembalikan')
  emit('   { rewritten, tool, needsClarification }. Risiko: prompt gabungan lebih')
  emit('   sulit di-debug. Hemat 6,5 detik/pertanyaan ber-history.')
  emit('')
  emit('B. SKIP rewrite kalau tidak ada history  [SUDAH ADA]')
  emit('   Kode sudah melakukannya (`hasHistory ? ... : cleanQuestion`).')
  emit('')
  emit('C. SKIP evaluateEvidenceSufficiency kalau bukti panjang  [DITOLAK - SUDAH DICOBA]')
  emit('   Saya awalnya mengusulkan ini. Salah. Kode sudah mencobanya dan')
  emit('   hasilnya persis bug yang Anda keluhkan: "LLM bilang tidak tahu".')
  emit('   Baca intent-pipeline.ts:325 — heuristik `evidence.length < 50`')
  emit('   menyatakan "Tarif lembur hari kerja 1,5x upah per jam" (41 char,')
  emit('   jawaban BENAR dan LENGKAP) sebagai TIDAK CUKUP, memaksa pass kedua,')
  emit('   lalu menyuntikkan "katakan kalau bukti tidak memuat jawabannya".')
  emit('   Artinya: penghematan 1 panggilan ini menghasilkan bug yang justru')
  emit('   paling Anda prioritaskan untuk diperbaiki. JANGAN diulang.')
  emit('')
  emit('D. CACHE hasil per pertanyaan identik  [SUDAH ADA, terbatas]')
  emit('   RAG punya cache 1 menit/200 entri; embedding punya cache. Bisa diperluas')
  emit('   ke intent+rewrite. Aman karena deterministik (temp=0).')
  emit('')
  emit('E. JANGAN hapus expandQuery  [TIDAK AMAN]')
  emit('   Ini yang memperbaiki recall lintas-bahasa 58% -> 92%. Menghapusnya')
  emit('   mengembalikan bug "LLM bilang tidak tahu padahal tahu".')
  emit('')
  emit('F. JANGAN hapus repair loop  [TIDAK AMAN]')
  emit('   Menghemat 0 panggilan saat sukses; hanya jalan saat gagal.')
  emit('')
  emit('=== JAWABAN SINGKAT ===')
  emit('Ya, tapi jauh lebih sedikit dari dugaan awal saya.')
  emit('AMAN: A (gabung rewrite+intent, hemat 1) + D (perluas cache).')
  emit('DITOLAK: C — heuristik panjang SUDAH TERBUKTI menyebabkan bug')
  emit('          "bilang tidak tahu padahal tahu". Saya hampir mengulanginya.')
  emit('JANGAN sentuh: expansion (akar bug lintas-bahasa) dan repair loop.')
  emit('')
  emit('Estimasi jujur: hemat 1 panggilan (~6,5 detik), bukan 2.')
  emit('Kalau targetnya latency, jalur yang lebih besar dampaknya adalah')
  emit('membiarkan PELANGGAN memilih: model cepat untuk routing, model bagus')
  emit('untuk sintesis. Itu keputusan mereka (BYOK), bukan kita.')
  process.exit(0)
}
main()
