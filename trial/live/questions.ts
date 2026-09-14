/**
 * Factual questions with machine-checkable answers, for a REAL accuracy
 * measurement against a live provider.
 *
 * Every case carries `accept` patterns rather than one exact string, because a
 * model may answer "38" or "38 provinsi" or "thirty-eight". A single exact match
 * would measure formatting, not correctness.
 *
 * `category` exists so a failure says WHAT broke: a factual miss, arithmetic, or
 * an instruction-following miss are different defects.
 */
export interface LiveCase {
  id: string
  category: 'factual' | 'arithmetic' | 'reasoning' | 'format' | 'indonesian'
  question: string
  /** All must appear (case-insensitive) for the answer to count as correct. */
  accept: RegExp[]
  /** If any appears, the answer is wrong regardless of `accept`. */
  reject?: RegExp[]
}

export const CASES: LiveCase[] = [
  { id: 'F01', category: 'factual', question: 'Ibukota Indonesia saat ini? Jawab satu nama.', accept: [/jakarta|nusantara/i] },
  { id: 'F02', category: 'factual', question: 'Berapa jumlah provinsi di Indonesia? Jawab angkanya saja.', accept: [/\b38\b/] },
  { id: 'F03', category: 'factual', question: 'Planet terdekat dengan Matahari? Jawab satu kata.', accept: [/merkurius|mercury/i], reject: [/venus|bumi|earth/i] },
  { id: 'F04', category: 'factual', question: 'Siapa penemu lampu pijar komersial yang praktis? Jawab nama saja.', accept: [/edison/i] },
  { id: 'F05', category: 'factual', question: 'Apa simbol kimia untuk emas? Jawab satu simbol.', accept: [/\bau\b/i] },
  { id: 'F06', category: 'factual', question: 'Berapa jumlah pemain inti satu tim sepak bola di lapangan? Jawab angka.', accept: [/\b11\b/] },
  { id: 'F07', category: 'factual', question: 'Negara dengan populasi terbanyak di dunia saat ini? Jawab satu nama.', accept: [/india/i] },
  { id: 'F08', category: 'factual', question: 'Apa ibukota Jepang? Jawab satu kata.', accept: [/tokyo|tokio/i] },
  { id: 'A01', category: 'arithmetic', question: 'Berapa 17 dikali 23? Jawab angkanya saja.', accept: [/\b391\b/] },
  { id: 'A02', category: 'arithmetic', question: 'Berapa 144 dibagi 12? Jawab angkanya saja.', accept: [/\b12\b/] },
  { id: 'A03', category: 'arithmetic', question: 'Berapa 2 pangkat 10? Jawab angkanya saja.', accept: [/\b1024\b/] },
  { id: 'A04', category: 'arithmetic', question: 'Berapa 15 persen dari 240? Jawab angkanya saja.', accept: [/\b36\b/] },
  { id: 'A05', category: 'arithmetic', question: 'Berapa 1000 dikurangi 257? Jawab angkanya saja.', accept: [/\b743\b/] },
  { id: 'R01', category: 'reasoning', question: 'Jika semua kucing adalah hewan, dan Tom adalah kucing, apakah Tom hewan? Jawab ya atau tidak.', accept: [/ya|yes/i], reject: [/tidak|no\b/i] },
  { id: 'R02', category: 'reasoning', question: 'Ani lebih tinggi dari Budi. Budi lebih tinggi dari Cici. Siapa paling tinggi? Jawab satu nama.', accept: [/ani/i], reject: [/cici|budi/i] },
  { id: 'R03', category: 'reasoning', question: 'Sebuah kotak berisi 3 bola merah dan 5 bola biru. Berapa total bola? Jawab angkanya.', accept: [/\b8\b/] },
  { id: 'R04', category: 'reasoning', question: 'Hari ini Rabu. Hari apa 3 hari lagi? Jawab satu kata.', accept: [/sabtu|saturday/i], reject: [/minggu|senin|selasa|kamis|jumat/i] },
  { id: 'M01', category: 'format', question: 'Balas HANYA dengan kata OK, tanpa penjelasan apa pun.', accept: [/^\s*\**\s*ok/i] },
  { id: 'M02', category: 'format', question: 'Sebutkan tiga nama buah, pisahkan dengan koma, tanpa kalimat lain.', accept: [/apel|apple/i, /jeruk|orange/i] },
  { id: 'M03', category: 'format', question: 'Balas dengan tepat satu angka: berapa 7 tambah 5?', accept: [/12/] },
  { id: 'M04', category: 'format', question: 'Tulis ulang kalimat ini tanpa mengubah arti: "Saya suka kopi." Jawab kalimatnya saja.', accept: [/kopi|coffee/i] },
  { id: 'I01', category: 'indonesian', question: 'Apa arti kata "gembira" dalam bahasa Indonesia? Jawab singkat.', accept: [/senang|bahagia|suka|happy|glad/i] },
  { id: 'I02', category: 'indonesian', question: 'Sebutkan ibu kota provinsi Jawa Barat. Jawab satu nama.', accept: [/bandung/i] },
  { id: 'I03', category: 'indonesian', question: 'Mata uang Indonesia adalah? Jawab satu nama.', accept: [/rupiah|idr/i] },
  { id: 'I04', category: 'indonesian', question: 'Apa lawan kata dari "panas"? Jawab satu kata.', accept: [/dingin|cold/i] },
  { id: 'I05', category: 'indonesian', question: 'Siapa proklamator kemerdekaan Indonesia selain Soekarno? Jawab satu nama.', accept: [/hatta|mohammad hatta/i] },
]
