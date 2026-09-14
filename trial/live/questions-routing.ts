/**
 * 100 questions for a HEAD-TO-HEAD comparison of the two routing pipelines.
 *
 * The existing `questions.ts` measures the MODEL: it asks things any model knows
 * without org data, so both pipelines route them to CHAT and it cannot tell the
 * pipelines apart. This set is the opposite by construction -- every case is chosen
 * so that a WRONG ROUTE PRODUCES A WRONG ANSWER, which is what a routing test has to
 * detect.
 *
 * Five families, 20 each:
 *
 *   DB      a fact that exists ONLY in the connected database. Ground truth was read
 *           from `uat_demo` with `psql` (pelanggan=5, pesanan=12, produk=6, cabang=4,
 *           pesanan status 'selesai'=10). A RAG or CHAT route cannot answer these, so
 *           the DB family is the sharpest discriminator: it fails loudly.
 *   DOC     a fact that exists ONLY in a seeded document (uat/fixtures/knowledge).
 *           A DB route cannot answer it.
 *   GREET   greetings. The correct route is CHAT and the correct COST is ZERO
 *           classification calls; latency is the signal, correctness the guard.
 *   GENERAL small talk / general knowledge needing no source.
 *   TRAP    questions that LOOK like one family but belong to another -- a greeting
 *           prefix on a data question ("halo, berapa ...?") is the case that broke my
 *           first greeting matcher. These catch over-eager shortcuts.
 *
 * `accept`/`reject` are matched against the answer text. A REJECT match is a hard
 * failure even if an accept also matched, because a model that says "5, bukan 12" has
 * not answered correctly.
 */
export interface RoutingCase {
  id: string
  family: 'DB' | 'DOC' | 'GREET' | 'GENERAL' | 'TRAP'
  /** The route a correct pipeline should choose. */
  expect: 'SQL' | 'RAG' | 'CHAT' | 'REST'
  question: string
  accept: RegExp[]
  reject?: RegExp[]
  /** True when the answer must come from the database, so a refusal is a failure. */
  requiresData?: boolean
}

const DB_COUNT_CASES: Array<[string, string, RegExp[]]> = [
  ['B01', 'Berapa jumlah pelanggan yang terdaftar di database?', [/\b5\b|lima\b/i]],
  ['B02', 'Ada berapa pesanan seluruhnya?', [/\b12\b|dua belas\b/i]],
  ['B03', 'Berapa banyak produk yang tercatat?', [/\b6\b|enam\b/i]],
  ['B04', 'Berapa jumlah cabang yang ada?', [/\b4\b|empat\b/i]],
  ['B05', 'Berapa pesanan yang statusnya selesai?', [/\b10\b|sepuluh\b/i]],
  ['B06', 'Total semua baris di tabel pelanggan ada berapa?', [/\b5\b|lima\b/i]],
  ['B07', 'Hitung jumlah pesanan di sistem.', [/\b12\b|dua belas\b/i]],
  ['B08', 'Sebanyak apa produk yang tersedia di database?', [/\b6\b|enam\b/i]],
  ['B09', 'Ada berapa cabang perusahaan ini?', [/\b4\b|empat\b/i]],
  ['B10', 'Berapa banyak pesanan berstatus selesai?', [/\b10\b|sepuluh\b/i]],
]

export const ROUTING_CASES: RoutingCase[] = [
  ...DB_COUNT_CASES.map(([id, question, accept]) => ({
    id,
    family: 'DB' as const,
    expect: 'SQL' as const,
    question,
    accept,
    reject: [/tidak tersedia|tidak dapat|maaf.{0,20}(tidak|belum)/i],
    requiresData: true,
  })),
  // The same ten counts, asked with different wording so a single lucky prompt
  // pattern cannot carry the family.
  ...DB_COUNT_CASES.map(([id, question, accept]) => ({
    id: id.replace('B0', 'C0').replace('B1', 'C1'),
    family: 'DB' as const,
    expect: 'SQL' as const,
    question: question.replace(/\.$/, '') + ' Sebutkan angkanya saja.',
    accept,
    reject: [/tidak tersedia|tidak dapat|maaf.{0,20}(tidak|belum)/i],
    requiresData: true,
  })),

  { id: 'D01', family: 'DOC', expect: 'RAG', question: 'Berapa hari jatah cuti tahunan karyawan?', accept: [/\b12\b|dua belas/i] },
  { id: 'D02', family: 'DOC', expect: 'RAG', question: 'Berapa lama minimal masa kerja sebelum bisa mengajukan cuti tahunan?', accept: [/\b12\b|satu tahun|1 tahun|dua belas/i] },
  { id: 'D03', family: 'DOC', expect: 'RAG', question: 'Siapa yang harus menyetujui pengajuan cuti tahunan?', accept: [/atasan|manajer|manager|hr|supervisor/i] },
  { id: 'D04', family: 'DOC', expect: 'RAG', question: 'Berapa panjang minimal kata sandi menurut panduan keamanan data?', accept: [/14|empat belas/i] },
  { id: 'D05', family: 'DOC', expect: 'RAG', question: 'Berapa hari sekali kata sandi wajib diganti?', accept: [/90|sembilan puluh/i] },
  { id: 'D06', family: 'DOC', expect: 'RAG', question: 'Berapa banyak kata sandi lama yang tidak boleh diulang?', accept: [/10|sepuluh/i] },
  { id: 'D07', family: 'DOC', expect: 'RAG', question: 'Apa yang harus dilakukan pegawai baru pada hari pertama onboarding?', accept: [/orientasi|onboarding|hr|perkenalan|daftar/i] },
  { id: 'D08', family: 'DOC', expect: 'RAG', question: 'Bagaimana prosedur penanganan keluhan pelanggan?', accept: [/keluhan|komplain|tindak lanjut|eskalasi|catat/i] },
  { id: 'D09', family: 'DOC', expect: 'RAG', question: 'Aturan apa yang berlaku untuk data pribadi pelanggan?', accept: [/pribadi|rahasia|dilindungi|lindungi|akses/i] },
  { id: 'D10', family: 'DOC', expect: 'RAG', question: 'Apa isi kebijakan tentang cuti sakit?', accept: [/sakit|surat|dokter|medis/i] },
  { id: 'D11', family: 'DOC', expect: 'RAG', question: 'Bagaimana aturan memakai perangkat perusahaan?', accept: [/perangkat|device|laptop|komputer|kebijakan/i] },
  { id: 'D12', family: 'DOC', expect: 'RAG', question: 'Apa langkah-langkah yang tercantum dalam SOP layanan pelanggan?', accept: [/salam|sapa|identifikasi|catat|solusi|tindak/i] },
  { id: 'D13', family: 'DOC', expect: 'RAG', question: 'Apakah ada aturan tentang bekerja dari rumah?', accept: [/rumah|remote|wfh|jarak jauh/i] },
  { id: 'D14', family: 'DOC', expect: 'RAG', question: 'Apa kewajiban karyawan terkait kerahasiaan informasi?', accept: [/rahasia|kerahasiaan|informasi|internal/i] },
  { id: 'D15', family: 'DOC', expect: 'RAG', question: 'Bagaimana cara mengajukan cuti tahunan menurut kebijakan?', accept: [/ajukan|ajukan|formulir|sistem|atasan|hr/i] },
  { id: 'D16', family: 'DOC', expect: 'RAG', question: 'Apa yang diatur dalam panduan onboarding karyawan?', accept: [/onboarding|orientasi|pelatihan|perkenalan|hr/i] },
  { id: 'D17', family: 'DOC', expect: 'RAG', question: 'Aturan apa yang berlaku jika terjadi kebocoran data?', accept: [/kebocoran|lapor|insiden|segera|keamanan/i] },
  { id: 'D18', family: 'DOC', expect: 'RAG', question: 'Apakah kebijakan cuti mengatur cuti melahirkan?', accept: [/melahirkan|hamil|bersalin|cuti/i] },
  { id: 'D19', family: 'DOC', expect: 'RAG', question: 'Siapa yang bisa mengakses data pelanggan menurut kebijakan?', accept: [/akses|berwenang|izin|terbatas|pihak/i] },
  { id: 'D20', family: 'DOC', expect: 'RAG', question: 'Apa prosedur pelaporan insiden keamanan data?', accept: [/lapor|insiden|segera|keamanan|tim/i] },

  { id: 'G01', family: 'GREET', expect: 'CHAT', question: 'Halo', accept: [/.{5,}/] },
  { id: 'G02', family: 'GREET', expect: 'CHAT', question: 'Halo, apa kabar?', accept: [/.{5,}/] },
  { id: 'G03', family: 'GREET', expect: 'CHAT', question: 'Selamat pagi', accept: [/.{5,}/] },
  { id: 'G04', family: 'GREET', expect: 'CHAT', question: 'Terima kasih', accept: [/.{5,}/] },
  { id: 'G05', family: 'GREET', expect: 'CHAT', question: 'Hai', accept: [/.{5,}/] },
  { id: 'G06', family: 'GREET', expect: 'CHAT', question: 'Apa kabar?', accept: [/.{5,}/] },
  { id: 'G07', family: 'GREET', expect: 'CHAT', question: 'Makasih ya', accept: [/.{5,}/] },
  { id: 'G08', family: 'GREET', expect: 'CHAT', question: 'Halo halo', accept: [/.{5,}/] },
  { id: 'G09', family: 'GREET', expect: 'CHAT', question: 'Selamat malam', accept: [/.{5,}/] },
  { id: 'G10', family: 'GREET', expect: 'CHAT', question: 'Hai, terima kasih', accept: [/.{5,}/] },

  { id: 'G11', family: 'GREET', expect: 'CHAT', question: 'Hey', accept: [/.{5,}/] },
  { id: 'G12', family: 'GREET', expect: 'CHAT', question: 'Halo, selamat siang', accept: [/.{5,}/] },
  { id: 'G13', family: 'GREET', expect: 'CHAT', question: 'Oke siap', accept: [/.{5,}/] },
  { id: 'G14', family: 'GREET', expect: 'CHAT', question: 'Hai hai', accept: [/.{5,}/] },
  { id: 'G15', family: 'GREET', expect: 'CHAT', question: 'Terima kasih banyak', accept: [/.{5,}/] },
  { id: 'G16', family: 'GREET', expect: 'CHAT', question: 'Selamat sore', accept: [/.{5,}/] },
  { id: 'G17', family: 'GREET', expect: 'CHAT', question: 'Halo, siapa kamu?', accept: [/ryasai|asisten|ai|bantu/i] },
  { id: 'G18', family: 'GREET', expect: 'CHAT', question: 'Thanks', accept: [/.{5,}/] },
  { id: 'G19', family: 'GREET', expect: 'CHAT', question: 'Halo!', accept: [/.{5,}/] },
  { id: 'G20', family: 'GREET', expect: 'CHAT', question: 'Permisi', accept: [/.{5,}/] },

  { id: 'N01', family: 'GENERAL', expect: 'CHAT', question: 'Berapa 2 + 2? Jawab singkat.', accept: [/\b4\b|empat/i] },
  { id: 'N02', family: 'GENERAL', expect: 'CHAT', question: 'Berapa 15 kali 3? Jawab angkanya.', accept: [/\b45\b/] },
  { id: 'N03', family: 'GENERAL', expect: 'CHAT', question: 'Apa ibukota Indonesia? Jawab satu kata.', accept: [/jakarta|nusantara/i] },
  { id: 'N04', family: 'GENERAL', expect: 'CHAT', question: 'Siapa kamu? Jawab singkat.', accept: [/ryasai|asisten|ai|bantu/i] },
  { id: 'N05', family: 'GENERAL', expect: 'CHAT', question: 'Apa warna langit saat cerah? Jawab satu kata.', accept: [/biru|blue/i] },
  { id: 'N06', family: 'GENERAL', expect: 'CHAT', question: 'Berapa jumlah hari dalam seminggu? Jawab angka.', accept: [/\b7\b|tujuh/i] },
  { id: 'N07', family: 'GENERAL', expect: 'CHAT', question: 'Hewan apa yang dikenal sebagai raja hutan? Jawab singkat.', accept: [/singa|lion/i] },
  { id: 'N08', family: 'GENERAL', expect: 'CHAT', question: 'Apa lawan kata dari panas? Jawab satu kata.', accept: [/dingin|sejuk|cold/i] },
  { id: 'N09', family: 'GENERAL', expect: 'CHAT', question: 'Berapa sisi yang dimiliki segitiga? Jawab angka.', accept: [/\b3\b|tiga/i] },
  { id: 'N10', family: 'GENERAL', expect: 'CHAT', question: 'Buah apa yang identik dengan warna kuning dan bentuk melengkung?', accept: [/pisang|banana/i] },

  { id: 'N11', family: 'GENERAL', expect: 'CHAT', question: 'Berapa 100 dibagi 4? Jawab angka.', accept: [/\b25\b/] },
  { id: 'N12', family: 'GENERAL', expect: 'CHAT', question: 'Apa warna daun pada umumnya? Jawab satu kata.', accept: [/hijau|green/i] },
  { id: 'N13', family: 'GENERAL', expect: 'CHAT', question: 'Berapa jumlah bulan dalam setahun? Jawab angka.', accept: [/\b12\b|dua belas/i] },
  { id: 'N14', family: 'GENERAL', expect: 'CHAT', question: 'Alat apa yang dipakai untuk mengukur suhu? Jawab satu kata.', accept: [/termometer|thermometer/i] },
  { id: 'N15', family: 'GENERAL', expect: 'CHAT', question: 'Apa bahasa pemrograman yang dipakai untuk membuat web? Sebut satu.', accept: [/javascript|typescript|python|html|php/i] },
  { id: 'N16', family: 'GENERAL', expect: 'CHAT', question: 'Berapa hasil 7 dikurangi 9? Jawab angka.', accept: [/-2|minus 2|negatif 2/i] },
  { id: 'N17', family: 'GENERAL', expect: 'CHAT', question: 'Apa benua terbesar di dunia? Jawab satu kata.', accept: [/asia/i] },
  { id: 'N18', family: 'GENERAL', expect: 'CHAT', question: 'Berapa jumlah jam dalam sehari? Jawab angka.', accept: [/\b24\b|dua puluh empat/i] },
  { id: 'N19', family: 'GENERAL', expect: 'CHAT', question: 'Apa ibu kota Jepang? Jawab satu kata.', accept: [/tokyo|tokio/i] },
  { id: 'N20', family: 'GENERAL', expect: 'CHAT', question: 'Apakah kamu bisa berbahasa Indonesia? Jawab singkat.', accept: [/ya|bisa|tentu|yes/i] },

  // A greeting glued to a DATA question must still route to the data. This is the
  // family that caught the `\b` bug in my first greeting matcher.
  { id: 'T01', family: 'TRAP', expect: 'SQL', question: 'halo, berapa jumlah pelanggan?', accept: [/\b5\b|lima\b/i], reject: [/tidak tersedia/i], requiresData: true },
  { id: 'T02', family: 'TRAP', expect: 'SQL', question: 'hai, ada berapa pesanan?', accept: [/\b12\b|dua belas\b/i], requiresData: true },
  { id: 'T03', family: 'TRAP', expect: 'SQL', question: 'selamat pagi, berapa jumlah produk?', accept: [/\b6\b|enam\b/i], requiresData: true },
  { id: 'T04', family: 'TRAP', expect: 'RAG', question: 'permisi, berapa hari cuti tahunan?', accept: [/\b12\b|dua belas/i] },
  { id: 'T05', family: 'TRAP', expect: 'RAG', question: 'maaf mengganggu, berapa panjang minimal kata sandi?', accept: [/14|empat belas/i] },
  // "jumlah" invites SQL but the answer is a DOCUMENT fact: the count of steps.
  { id: 'T06', family: 'TRAP', expect: 'RAG', question: 'Berapa jumlah langkah dalam prosedur penanganan keluhan?', accept: [/langkah|sopan|catat|solusi|tindak|beberapa|empat|lima|tiga/i] },
  { id: 'T07', family: 'TRAP', expect: 'CHAT', question: 'Terima kasih atas bantuannya', accept: [/.{5,}/] },
  { id: 'T08', family: 'TRAP', expect: 'SQL', question: 'Tolong sebutkan jumlah cabang yang terdaftar.', accept: [/\b4\b|empat\b/i], requiresData: true },
  { id: 'T09', family: 'TRAP', expect: 'SQL', question: 'Bisa lihat jumlah pesanan selesai?', accept: [/\b10\b|sepuluh\b/i], requiresData: true },
  { id: 'T10', family: 'TRAP', expect: 'RAG', question: 'Menurut panduan keamanan data, berapa hari sekali sandi diganti?', accept: [/90|sembilan puluh/i] },
  { id: 'T11', family: 'TRAP', expect: 'SQL', question: 'hai, tolong hitung jumlah pelanggan', accept: [/\b5\b|lima\b/i], requiresData: true },
  { id: 'T12', family: 'TRAP', expect: 'RAG', question: 'halo, apa aturan cuti tahunan?', accept: [/\b12\b|dua belas/i] },
  { id: 'T13', family: 'TRAP', expect: 'RAG', question: 'Berapa jumlah kata sandi lama yang tidak boleh diulang?', accept: [/\b10\b|sepuluh/i] },
  { id: 'T14', family: 'TRAP', expect: 'SQL', question: 'selamat siang, ada berapa produk?', accept: [/\b6\b|enam\b/i], requiresData: true },
  { id: 'T15', family: 'TRAP', expect: 'RAG', question: 'terima kasih, tapi tolong jelaskan prosedur onboarding', accept: [/orientasi|onboarding|hr|perkenalan|pelatihan/i] },
  { id: 'T16', family: 'TRAP', expect: 'SQL', question: 'Halo, berapa total pesanan yang sudah selesai?', accept: [/\b10\b|sepuluh\b/i], requiresData: true },
  { id: 'T17', family: 'TRAP', expect: 'RAG', question: 'pagi, bagaimana cara mengajukan cuti?', accept: [/ajukan|formulir|atasan|hr|sistem/i] },
  { id: 'T18', family: 'TRAP', expect: 'SQL', question: 'Permisi, berapa banyak cabang yang terdaftar di database?', accept: [/\b4\b|empat\b/i], requiresData: true },
  { id: 'T19', family: 'TRAP', expect: 'RAG', question: 'hai, apa aturan kerahasiaan informasi karyawan?', accept: [/rahasia|kerahasiaan|informasi|internal/i] },
  { id: 'T20', family: 'TRAP', expect: 'SQL', question: 'Halo, cek dong jumlah pesanan di database.', accept: [/\b12\b|dua belas\b/i], requiresData: true },
]
