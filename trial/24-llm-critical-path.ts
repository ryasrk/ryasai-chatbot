/**
 * Berapa banyak keputusan STRUKTURAL yang bergantung pada LLM dan TIDAK punya
 * jalur deterministik? Kalau LLM salah/ngawur, apa yang rusak?
 */
import { hr } from './lib'

const surfaces = [
  { area: 'Pemilihan tool (SQL/RAG/REST/CHAT)', llm: 'smart-router skor + LLM tiebreaker', fallback: 'skor heuristik', risiko: 'sedang' },
  { area: 'Pemilihan integrasi DB mana', llm: 'pickBestIntegration (skor keyword)', fallback: 'createdAt tertua', risiko: 'TINGGI — bisa query DB yang salah' },
  { area: 'Pemilihan endpoint REST mana', llm: 'generateRestCall pilih dari whitelist', fallback: 'tidak ada', risiko: 'rendah (dibatasi whitelist)' },
  { area: 'Generate SQL', llm: 'generateSql + 2x repair', fallback: 'tidak ada', risiko: 'TINGGI — salah kolom = error' },
  { area: 'Deskripsi tabel/schema', llm: 'enrichSchemaDescriptions', fallback: 'nama kolom mentah', risiko: 'rendah' },
  { area: 'Query expansion RAG', llm: 'expandQuery (sinonim + terjemah)', fallback: 'query asli', risiko: 'sedang' },
  { area: 'Rewrite follow-up', llm: 'rewriteQuery', fallback: 'query asli', risiko: 'sedang' },
  { area: 'Cek kecukupan bukti', llm: 'evaluateEvidenceSufficiency', fallback: 'heuristik konten', risiko: 'sedang' },
  { area: 'Judge alignment', llm: 'checkAlignment', fallback: 'fail-open (dilewati)', risiko: 'rendah (advisory)' },
  { area: 'Judul sesi', llm: 'generateSessionTitle', fallback: 'slice(0,60)', risiko: 'tidak ada' },
]

function main() {
  hr('BEBAN LLM PER KEPUTUSAN')
  console.log('Kolom "fallback" = apa yang terjadi kalau LLM gagal/ngawur.\n')
  for (const s of surfaces) {
    const f = s.fallback === 'tidak ada' ? '*** TIDAK ADA ***' : s.fallback
    console.log(`• ${s.area}`)
    console.log(`    LLM      : ${s.llm}`)
    console.log(`    fallback : ${f}`)
    console.log(`    risiko   : ${s.risiko}`)
  }
  hr('KESIMPULAN')
  console.log('2 dari 10 keputusan (generate SQL, pilih endpoint REST) TIDAK punya')
  console.log('jalur deterministik sama sekali — kalau LLM salah, permintaan gagal,')
  console.log('titik. Tidak ada degradasi bertahap.')
  console.log('')
  console.log('Yang paling berbahaya: PEMILIHAN INTEGRASI DB. Fallback-nya')
  console.log('"integrasi tertua" — jadi kalau skor LLM salah, sistem diam-diam')
  console.log('query DATABASE YANG BERBEDA, bukan gagal. Itu jawaban yang salah')
  console.log('tanpa error, yang lebih buruk daripada crash.')
  process.exit(0)
}
main()
