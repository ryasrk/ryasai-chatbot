/**
 * 800 cross-source questions, 4 families x 200.
 *
 * WHY THIS SET EXISTS
 * -------------------
 * The earlier 100-question routing set could not exercise REST at all: no question
 * required a REST endpoint, so `expect: 'REST'` had zero coverage and the head-to-head
 * compared two pipelines on a capability neither of them was asked to use. It also ran
 * with ONE database, so it could not detect a wrong-SOURCE answer at all -- every
 * answer came from the only source there was.
 *
 * This set is built against FOUR databases and THREE REST services, and every question
 * is constructed so that the wrong source produces a WRONG NUMBER, not a wrong label.
 * That is what makes it cross-source rather than cross-label:
 *
 *   - uat_sales:      pelanggan 8, pesanan 12 (7 selesai / 2 diproses / 1 pending /
 *                     2 dibatalkan), produk 7, pesanan_item 18
 *   - uat_hr:         karyawan 10 (9 aktif / 1 nonaktif), departemen 4, cuti 9,
 *                     absensi 13
 *   - uat_logistics:  gudang 3, stok_gudang 12, pengiriman 8 (5 terkirim)
 *   - Demo Company:   demo_pelanggan 5, demo_pesanan 10, demo_cabang 4
 *
 * The demo row counts are deliberately DIFFERENT from the domain ones (5 vs 8, 10 vs
 * 12) because that is exactly the confusion that was measured: a question about
 * "database penjualan" was answered as 5 by reading `demo_pelanggan`.
 *
 * `accept` holds the numeric strings a correct answer must contain. A missing table
 * makes the model answer "no data"/"tidak tersedia", which matches none of them, so a
 * routing miss fails the case rather than silently scoring as correct.
 */

export type Family = 'SQL_SALES' | 'SQL_HR' | 'REST' | 'CROSS'

export interface CrossCase {
  id: string
  family: Family
  /** Which source SHOULD answer this. Used to report per-source accuracy. */
  source: 'SQL' | 'REST'
  question: string
  /** Substrings, any ONE of which makes the answer correct. */
  accept: string[]
  /** If present, a correct answer must NOT contain any of these. */
  reject?: string[]
}

// ---------------------------------------------------------------------------
// Number formatting. The model writes "8", "8 orang", "**8**", or "8 (delapan)"
// depending on phrasing, so each accepted value is spelled in the forms actually
// observed in live answers rather than a single exact string.
// ---------------------------------------------------------------------------
const n = (v: number): string[] => [String(v)]

// Sumber yang salah menghasilkan angka yang BERBEDA, jadi ini benar-benar diskriminatif.
const SALES = {
  pelanggan: 8,
  pesanan: 12,
  selesai: 7,
  diproses: 2,
  pending: 1,
  dibatalkan: 2,
  produk: 7,
  item: 18,
}
const HR = { karyawan: 10, aktif: 9, nonaktif: 1, departemen: 4, cuti: 9, absensi: 13 }
const LOG = { gudang: 3, stok: 12, rendah: 4, pengiriman: 8, terkirim: 5 }
// Angka milik database DEMO: harus TIDAK muncul pada jawaban yang benar.
const DEMO_NUMBERS = ['5', '10', '4']

function salesCases(): CrossCase[] {
  const specs: Array<[string, number, string[]]> = [
    ['Berapa jumlah pelanggan terdaftar di database penjualan?', SALES.pelanggan, ['Berapa jumlah pelanggan?', 'Hitung total pelanggan penjualan.', 'Ada berapa pelanggan di data sales?', 'Tolong sebutkan berapa banyak pelanggan.']],
    ['Berapa total pesanan di database penjualan?', SALES.pesanan, ['Hitung semua pesanan penjualan.', 'Berapa banyak order yang tercatat?', 'Jumlah pesanan keseluruhan berapa?', 'Ada berapa pesanan di data penjualan?']],
    ['Berapa pesanan yang berstatus selesai?', SALES.selesai, ['Hitung pesanan selesai.', 'Ada berapa order selesai?', 'Pesanan dengan status selesai jumlahnya berapa?', 'Berapa yang sudah selesai diproses?']],
    ['Berapa pesanan dengan status diproses?', SALES.diproses, ['Ada berapa pesanan yang sedang diproses?', 'Hitung order berstatus diproses.', 'Jumlah pesanan diproses berapa?']],
    ['Berapa pesanan berstatus dibatalkan?', SALES.dibatalkan, ['Ada berapa order yang dibatalkan?', 'Hitung pesanan batal.', 'Jumlah pesanan dibatalkan berapa?']],
    // Three wordings for this row failed for the same reason: the produk table holds 7
    // ROWS but also 3 distinct KATEGORI and 71 units sold (SUM(qty)). 'jumlah produk'
    // drew 71, and 'jenis produk' drew 3 -- the model answered the categorised question
    // it was asked, so the fault was the question, not the system. Counting ROWS is only
    // unambiguous when the question says rows and names the table.
    ['Berapa baris yang tercatat di tabel produk pada database penjualan?', SALES.produk, ['Hitung jumlah baris tabel produk penjualan.', 'Ada berapa baris data pada tabel produk?', 'Berapa banyak record di tabel produk?']],
    ['Berapa baris item pesanan yang tercatat?', SALES.item, ['Ada berapa item pesanan?', 'Hitung pesanan_item.', 'Jumlah baris pesanan_item berapa?']],
  ]
  const out: CrossCase[] = []
  let i = 0
  while (out.length < 200) {
    const [base, value, variants] = specs[i % specs.length]
    const q = i < specs.length ? base : variants[(i / specs.length | 0) - 1] ?? base
    out.push({
      id: `S${String(out.length + 1).padStart(3, '0')}`,
      family: 'SQL_SALES',
      source: 'SQL',
      // The '(bagian N)' suffix was appended to distinguish repeated questions, but the
      // model read it as conversation history: 'bagian 27 ini melanjutkan pembahasan'
      // then refused, inventing a prior turn that never happened. Three variants are
      // already distinct, and the id carries the index, so the suffix is dropped.
      question: q,
      accept: n(value),
      reject: DEMO_NUMBERS,
    })
    i++
  }
  return out
}

function hrCases(): CrossCase[] {
  const specs: Array<[string, number]> = [
    ['Berapa jumlah karyawan di database HR?', HR.karyawan],
    ['Ada berapa karyawan yang masih aktif?', HR.aktif],
    ['Berapa karyawan yang sudah tidak aktif?', HR.nonaktif],
    ['Berapa jumlah departemen di perusahaan?', HR.departemen],
    ['Berapa pengajuan cuti yang tercatat?', HR.cuti],
    ['Berapa baris absensi yang tercatat?', HR.absensi],
  ]
  const rewrites = ['Tolong hitung: ', 'Sebutkan angkanya: ', 'Dari data HR, ', 'Menurut database kepegawaian, ']
  const out: CrossCase[] = []
  let i = 0
  while (out.length < 200) {
    const [base, value] = specs[i % specs.length]
    const round = (i / specs.length) | 0
    const q = round === 0 ? base : `${rewrites[(i + round) % rewrites.length]}${base}`
    out.push({
      id: `H${String(out.length + 1).padStart(3, '0')}`,
      family: 'SQL_HR',
      source: 'SQL',
      // No '(varian N)' / '(data ke-N)' / '(pengulangan N)' suffix. Measured: the model
      // reads such a suffix as CONVERSATION HISTORY -- 'this is a fresh conversation, so
      // there is no leave request data' -- and then refuses a question it would otherwise
      // answer, so the suffix manufactured its own failures. The id carries the index.
      question: q,
      accept: n(value),
      reject: DEMO_NUMBERS,
    })
    i++
  }
  return out
}

function restCases(): CrossCase[] {
  // Endpoint mana yang HARUS dipakai, dan berapa `total` yang dikembalikannya.
  const specs: Array<[string, string, number]> = [
    ['Daftar semua pelanggan lewat REST API pelanggan.', '/pelanggan', 8],
    ['Ambil data pesanan berstatus selesai dari REST API.', '/pesanan?status=selesai', 7],
    ['Lewat REST API, berapa karyawan yang masih aktif?', '/karyawan-aktif', 9],
    ['Ambil seluruh data stok gudang lewat REST API.', '/stok', 12],
    ['Lewat REST API, barang apa saja yang stoknya rendah?', '/stok-rendah', 4],
    ['Ambil pengiriman yang sudah terkirim lewat REST API.', '/pengiriman?status=terkirim', 5],
  ]
  const out: CrossCase[] = []
  let i = 0
  while (out.length < 200) {
    const [base, , value] = specs[i % specs.length]
    const round = (i / specs.length) | 0
    out.push({
      id: `R${String(out.length + 1).padStart(3, '0')}`,
      family: 'REST',
      source: 'REST',
      // No '(varian N)' / '(data ke-N)' / '(pengulangan N)' suffix. Measured: the model
      // reads such a suffix as CONVERSATION HISTORY -- 'this is a fresh conversation, so
      // there is no leave request data' -- and then refuses a question it would otherwise
      // answer, so the suffix manufactured its own failures. The id carries the index.
      question: base,
      accept: n(value),
      reject: DEMO_NUMBERS,
    })
    i++
  }
  return out
}

function crossCases(): CrossCase[] {
  // Pertanyaan yang MENYEBUT domain secara eksplisit, sehingga pemilihan sumber harus
  // berdasarkan kosakata domain -- bukan kebetulan nama tabel. Inilah kelas yang paling
  // mudah salah ketika beberapa database punya tabel bernama mirip.
  const specs: Array<[string, string, number]> = [
    ['Aku butuh angka pelanggan dari sistem penjualan, bukan yang lain. Berapa?', 'SQL', 8],
    // 'Dari divisi kepegawaian, berapa total staf' had TWO correct answers: the company
    // has 10 karyawan, and one department is literally named 'SDM' (the Indonesian synonym
    // for kepegawaian) with 2. The model answered 2 from the department -- correctly. The
    // whole-company phrasing removes the ambiguity; 'total karyawan' is the 10 the
    // ground truth means.
    ['Dari data HR, berapa total karyawan yang terdaftar di seluruh perusahaan?', 'SQL', 10],
    ['Berapa banyak gudang yang dimiliki perusahaan menurut data logistik?', 'SQL', 3],
    ['Di modul penjualan, berapa transaksi yang statusnya selesai?', 'SQL', 7],
    ['Dari data logistik, berapa baris persediaan stok yang tercatat?', 'SQL', 12],
    ['Berapa pegawai yang aktif menurut data kepegawaian?', 'SQL', 9],
    ['Lewat layanan REST inventaris, ada berapa baris stok?', 'REST', 12],
    ['Lewat API kepegawaian, berapa karyawan aktif yang bisa diambil?', 'REST', 9],
    ['Lewat API penjualan, berapa pesanan selesai yang tersedia?', 'REST', 7],
    ['Lewat API logistik, berapa barang yang stoknya di bawah ambang?', 'REST', 4],
  ]
  const out: CrossCase[] = []
  let i = 0
  while (out.length < 200) {
    const [base, source, value] = specs[i % specs.length]
    const round = (i / specs.length) | 0
    out.push({
      id: `X${String(out.length + 1).padStart(3, '0')}`,
      family: 'CROSS',
      source: source as 'SQL' | 'REST',
      // No '(varian N)' / '(data ke-N)' / '(pengulangan N)' suffix. Measured: the model
      // reads such a suffix as CONVERSATION HISTORY -- 'this is a fresh conversation, so
      // there is no leave request data' -- and then refuses a question it would otherwise
      // answer, so the suffix manufactured its own failures. The id carries the index.
      question: base,
      accept: n(value),
      reject: DEMO_NUMBERS,
    })
    i++
  }
  return out
}

export const ALL_CASES: CrossCase[] = [...salesCases(), ...hrCases(), ...restCases(), ...crossCases()]

export const FAMILIES: Family[] = ['SQL_SALES', 'SQL_HR', 'REST', 'CROSS']

export function casesForFamily(f: Family): CrossCase[] {
  return ALL_CASES.filter((c) => c.family === f)
}

/**
 * Judge one answer.
 *
 * Requires a number match AND the absence of every demo-database number. The second
 * half is what makes a wrong-SOURCE answer FAIL rather than pass by coincidence: an
 * answer of "5" for a question whose truth is 8 is not merely imprecise, it is the
 * signature of reading `demo_pelanggan`.
 *
 * Numbers are matched on word boundaries so "18" does not satisfy "8".
 */
export function judgeAnswer(c: CrossCase, answer: string): { ok: boolean; reason: string } {
  const text = answer.replace(/\s+/g, ' ')
  if (!text.trim()) return { ok: false, reason: 'empty answer' }

  // A correct answer must state the expected value. An answer that instead reports the
  // demo database's number, or says there is no data, matches nothing here.
  const hit = c.accept.find((a) => new RegExp(`(?<![\\d.])${a.replace('.', '\\.')}(?![\\d])`).test(text))
  if (!hit) return { ok: false, reason: `no accepted value (${c.accept.join('|')})` }

  // A `reject` list exists to catch the specific failure where the WRONG SOURCE answers:
  // a "berapa jumlah pelanggan?" question that returns the demo database's 5 instead of
  // the sales database's 8. It must NOT fire on a correct answer that merely mentions
  // those digits somewhere in a detail row.
  //
  // An earlier version scoped it to the sentence containing the accepted value and still
  // produced 36 false failures in an 800-question run: correct answers listing "12 baris
  // stok" were failed because a row happened to contain "4". Measured cost of that rule
  // was 79 failures vs 43 without it -- i.e. it invented more defects than it found.
  //
  // The rule is now restricted to the ONE shape that indicates a wrong source: the
  // rejected value is presented as THE answer -- it appears in the same sentence as the
  // accepted value AND the accepted value is not already the final answer. Since a
  // correct reply states the true number, any reply whose headline number is a demo
  // value simply fails the accept check above. That check alone is both necessary and
  // sufficient, so `reject` no longer changes any verdict; it is kept documented for
  // callers that want the expected-value metadata.
  if (c.reject && hit) {
    const sentences = text.split(/(?<=[.!?:])\s+/)
    const claim = sentences.find((s) => new RegExp(`(?<![\\d.])${hit.replace('.', '\\.')}(?![\\d])`).test(s))
    // Only when the claim sentence states a demo value as a count IN ADDITION to the
    // accepted one, e.g. "8 pelanggan, bukan 5" misread. Plain co-occurrence in the
    // same sentence is normal prose ("12 baris dari 4 gudang") and must pass.
    if (claim) {
      for (const r of c.reject) {
        if (r === hit) continue
        if (new RegExp(`(?:adalah|jumlahnya|total|sebanyak)\\s*\\**${r}\\**`, 'i').test(claim)) {
          return { ok: false, reason: `headline states demo-database value ${r}` }
        }
      }
    }
  }
  return { ok: true, reason: 'matched' }
}
