/**
 * PRINASA benchmark — part 7: long-session (multi-turn) scenarios,
 * cross-session memory scenarios, and source-toggle reaction scenarios.
 *
 * These are NOT single-question items — each is a scripted conversation.
 * The session runner (prinasa-session-runner.ts) replays them through the
 * REAL chat pipeline and scores:
 *
 *   long_session:
 *     - turn answers must not degrade as history grows (answer-quality per
 *       turn on its own ground truth)
 *     - follow-up resolution: "what about site X?" must reuse context
 *     - subject switches must not leak the previous topic (contamination)
 *
 *   cross_session:
 *     - a fact established in session A must be retrievable in session B
 *       (memory/recall), OR at minimum session B must still answer from
 *       sources — never hallucinate the missing context
 *
 *   source_toggle:
 *     - ask a DB question with SQL tool OFF → must NOT fabricate numbers;
 *       must say it cannot query and (best) offer the document/knowledge path
 *     - ask a knowledge question with RAG OFF → must not cite documents
 *     - re-enable → the SAME question must now answer with data
 *     This pins the "confused when both sources exist" failure mode from
 *       the other direction: availability changes must produce coherent,
 *       honest behavior — never loops or vague clarifications.
 */
import type {
  BenchmarkDifficulty,
  LongSessionScenario,
  CrossSessionScenario,
  ToggleScenario,
} from '../types'

function long(
  id: string,
  difficulty: BenchmarkDifficulty,
  description: string,
  turns: LongSessionScenario['turns'],
): LongSessionScenario {
  return { id, category: 'long_session', difficulty, description, turns }
}

function cross(
  id: string,
  difficulty: BenchmarkDifficulty,
  description: string,
  sessions: CrossSessionScenario['sessions'],
): CrossSessionScenario {
  return { id, category: 'cross_session', difficulty, description, sessions }
}

function toggle(
  id: string,
  difficulty: BenchmarkDifficulty,
  description: string,
  steps: ToggleScenario['steps'],
): ToggleScenario {
  return { id, category: 'source_toggle', difficulty, description, steps }
}

// ---------------------------------------------------------------------------
// Long-session scenarios (20) — 5–8 turns each, mixing SQL + knowledge topics
// with pronoun/ellipsis follow-ups and deliberate subject switches.
// ---------------------------------------------------------------------------
export const prinasaLongSessionScenarios: LongSessionScenario[] = [
  long('prinl-001', 'hard', 'Compliance walkthrough: permits → expiring → site drill-down → doc policy → back to counts', [
    { question: 'Berapa total permit yang terdaftar di sistem?', expectContains: ['32'], expectNotContains: [], kind: 'sql' },
    { question: 'Dari itu, yang sudah EXPIRED ada berapa?', expectContains: ['9'], expectNotContains: [], kind: 'sql', followsUpOn: 'permit totals' },
    { question: 'Yang aktif, mana yang expired dalam 90 hari ke depan?', expectContains: [], expectNotContains: ['could you clarify'], kind: 'sql', followsUpOn: 'active permits' },
    { question: 'Di site Bengalon ada berapa pemegang permit aktif?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Menurut dokumen, bagaimana prosedur renewal permit yang sudah expired?', expectContains: [], expectNotContains: ['continue analyzing'], kind: 'knowledge' },
    { question: 'Jadi kalau digabung: berapa total yang perlu renewal sekarang dan apa langkah pertamanya?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
    { question: 'Dan berapa lagi yang akan ikut expired bulan depan?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'renewal list' },
  ]),
  long('prinl-002', 'hard', 'MCU audit trail: totals → FIT stats → overdue list → policy → vendor breakdown', [
    { question: 'Berapa total registrasi MCU sampai sekarang?', expectContains: ['28'], expectNotContains: [], kind: 'sql' },
    { question: 'Berapa hasilnya yang FIT?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Siapa saja yang NextMcuDate-nya sudah lewat?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Apa standar kategori FIT vs UNFIT menurut dokumen K3?', expectContains: [], expectNotContains: ['let me continue'], kind: 'knowledge' },
    { question: 'Vendor mana yang karyawannya paling banyak overdue MCU?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Bandingkan dengan vendor yang paling banyak ikut training — sama atau beda?', expectContains: [], expectNotContains: [], kind: 'sql' },
  ]),
  long('prinl-003', 'hard', 'Training deep-dive with topic switch contamination test', [
    { question: 'Ada berapa training batch tahun ini?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Batch mana yang pesertanya paling banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Siapa trainernya dan dari site mana?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Sekarang ganti topik — berapa tag aktif yang belum dilepas?', expectContains: [], expectNotContains: ['training'], kind: 'sql' },
    { question: 'Kembali ke training: berapa rata-rata skor semua peserta?', expectContains: [], expectNotContains: ['tag'], kind: 'sql' },
    { question: 'Apa syarat kelulusan training menurut dokumen?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
  ]),
  long('prinl-004', 'hard', 'Pronoun-heavy follow-up chain on one participant cluster', [
    { question: 'Siapa pemegang KIMPER saat ini?', expectContains: ['2'], expectNotContains: [], kind: 'sql' },
    { question: 'Mereka bekerja di site mana?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'KIMPER holders' },
    { question: 'Dan perusahaannya siapa?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'KIMPER holders' },
    { question: 'Apakah mereka sudah MCU terakhir ini?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'KIMPER holders' },
    { question: 'Kalau dilihat dari dokumen, apa saja kewajiban pemegang KIMPER?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Jadi keseluruhan, apakah mereka compliant? Ringkas.', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-005', 'hard', 'Induction vs training comparison with doc rules', [
    { question: 'Berapa induction batch dan training batch saat ini?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Induction yang statusnya COMPLETED berapa persen?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Kalau training, berapa persen lulusnya?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dokumen menyebut kapan induction wajib vs training wajib — apa bedanya?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Siapa yang sudah kerja (punya permit) tapi belum pernah induction?', expectContains: [], expectNotContains: [], kind: 'sql' },
  ]),
  long('prinl-006', 'hard', 'Vendor risk assessment multi-turn', [
    { question: 'Vendor SUBCON kita ada berapa perusahaan?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Yang karyawannya paling banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Vendor itu — ada berapa yang permitnya expired?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'largest vendor' },
    { question: 'Bagaimana dengan MCU mereka?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'largest vendor' },
    { question: 'Dari dokumen: apa konsekuensi vendor yang tidak compliant?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Buat ringkasan risiko vendor itu dalam 3 poin.', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-007', 'hard', 'Ellipsis chain ("yang itu", "dia") on trainers', [
    { question: 'Siapa trainer yang mengajar batch paling banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dia berasal dari site mana?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'busiest trainer' },
    { question: 'Rata-rata skor pesertanya berapa?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'busiest trainer' },
    { question: 'Apa kriteria penunjukan trainer menurut dokumen?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Apakah dia memenuhi kriteria itu berdasarkan datanya?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-008', 'hard', 'Site-by-site sweep with pivot to policy', [
    { question: 'Site mana yang pesertanya paling banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Site terkecil mana?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Di site terkecil itu, semua orang sudah punya permit?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'smallest site' },
    { question: 'Apa tanggung jawab darurat site menurut dokumen?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Nomor darurat site itu sudah terisi belum di sistem?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'smallest site' },
  ]),
  long('prinl-009', 'hard', 'Equipment certification chain', [
    { question: 'Equipment model terdaftar ada berapa?', expectContains: ['850'], expectNotContains: [], kind: 'sql' },
    { question: 'Brand apa yang paling banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Equipment mana yang dipakai di training tapi tidak di permit?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dokumen mensyaratkan inspeksi equipment seperti apa?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Berapa equipment yang terkait sertifikasi permit saat ini?', expectContains: [], expectNotContains: [], kind: 'sql' },
  ]),
  long('prinl-010', 'hard', 'Age demographics → insurance → policy', [
    { question: 'Berapa usia rata-rata peserta?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Yang di atas 55 tahun ada berapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Mereka masih aktif semua?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: '55+ group' },
    { question: 'Apa aturan kesehatan untuk pekerja senior menurut dokumen?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Berdasarkan itu, berapa yang perlu MCU khusus?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-011', 'hard', 'Tag incident review meeting simulation', [
    { question: 'Tag belum dilepas ada berapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Yang paling lama diterapkan kapan?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Alasannya apa saja?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Prosedur pelepasan tag dari dokumen bagaimana?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Siapa yang berwenang melepas berdasarkan data historis?', expectContains: [], expectNotContains: [], kind: 'sql' },
  ]),
  long('prinl-012', 'hard', 'Department audit with hierarchy', [
    { question: 'Department terbesar yang mana?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Punya sub-department berapa?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'largest department' },
    { question: 'Karyawannya tersebar di site mana saja?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'largest department' },
    { question: 'Apa struktur department ideal menurut dokumen?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Bandingkan dengan struktur aktual — sesuai atau tidak?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-013', 'hard', 'Cross-entity comparison: two sites end-to-end', [
    { question: 'Bandingkan Asam-Asam dan Bengalon: jumlah peserta masing-masing?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Permit aktifnya masing-masing berapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'MCU overdue-nya mana yang lebih banyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dokumen menetapkan standar rasio apa untuk site operasional?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Site mana yang lebih compliant? Kesimpulan.', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-014', 'hard', 'Numbers-then-why: anomaly hunting', [
    { question: 'Ada peserta yang punya banyak permit sekaligus?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Ada NIK duplikat?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Ada yang MCU overdue tapi permit masih aktif?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dokumen bilang apa soal data ganda/konflik seperti ini?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Prioritas perbaikan mana yang paling urgent?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-015', 'hard', 'Exam quality review', [
    { question: 'Exam questions aktif ada berapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Yang belum pernah dijawab ada berapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Rata-rata skor exam per batch?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Dokumen mensyaratkan review soal seperti apa?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
  ]),
  long('prinl-016', 'hard', 'Onboarding flow check', [
    { question: 'Peserta terbaru siapa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Sudah punya permit dan MCU belum?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'newest participant' },
    { question: 'Sudah ikut induction?', expectContains: [], expectNotContains: [], kind: 'sql', followsUpOn: 'newest participant' },
    { question: 'Urutan onboarding yang benar menurut dokumen apa?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Jadi dia sudah sejauh mana di flow itu?', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-017', 'hard', 'Clinic performance review', [
    { question: 'Klinik mitra ada berapa?', expectContains: ['8'], expectNotContains: [], kind: 'sql' },
    { question: 'Yang menangani registrasi terbanyak?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Kategori MCU apa yang paling seriing ditanganinya?', expectContains: [], expectNotContains: ['could you clarify'], kind: 'sql' },
    { question: 'Standar pemilihan klinik dari dokumen apa?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
  ]),
  long('prinl-018', 'hard', 'Aggressive topic-switching stress test', [
    { question: 'Berapa permit SIMPER aktif?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Lalu berapa karyawan department Engineering?', expectContains: [], expectNotContains: ['SIMPER'], kind: 'sql' },
    { question: 'Lalu berapa klinik aktif?', expectContains: [], expectNotContains: ['Engineering'], kind: 'sql' },
    { question: 'Lalu apa itu tag type menurut dokumen?', expectContains: [], expectNotContains: ['klinik'], kind: 'knowledge' },
    { question: 'Dan sekarang: rata-rata umur peserta?', expectContains: [], expectNotContains: ['tag'], kind: 'sql' },
    { question: 'Terakhir: ringkas 4 topik tadi masing-masing satu kalimat.', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
  long('prinl-019', 'hard', 'Failed-training remediation flow', [
    { question: 'Siapa yang pernah gagal training?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Ada yang kemudian lulus di attempt berikutnya?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Berapa lama jaraknya rata-rata?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Aturan retake dari dokumen bagaimana?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Siapa yang masih perlu dijadwalkan ulang sekarang?', expectContains: [], expectNotContains: [], kind: 'sql' },
  ]),
  long('prinl-020', 'hard', 'Executive summary build-up (final turn must synthesize)', [
    { question: 'Beri saya angka kunci compliance: total peserta, permit aktif, MCU FIT, training lulus.', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Sekarang risiko terbesar dari masing-masing area apa?', expectContains: [], expectNotContains: [], kind: 'sql' },
    { question: 'Apa yang dokumen K3 tegaskan soal prioritas keselamatan?', expectContains: [], expectNotContains: [], kind: 'knowledge' },
    { question: 'Susun executive summary 5 bullet untuk direksi dari semua di atas.', expectContains: [], expectNotContains: ['continue analyzing'], kind: 'hybrid' },
    { question: 'Ubah jadi versi Bahasa Indonesia formal satu paragraf.', expectContains: [], expectNotContains: [], kind: 'hybrid' },
  ]),
]

// ---------------------------------------------------------------------------
// Cross-session scenarios (10) — memory + independent-session correctness
// ---------------------------------------------------------------------------
export const prinasaCrossSessionScenarios: CrossSessionScenario[] = [
  cross('princ-001', 'hard', 'Fact established in A, referenced elliptically in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Vendor dengan karyawan terbanyak siapa?', expectContains: ['PT DARMA HENWA'], kind: 'sql' },
        { question: 'Ingat nama vendor itu untuk pertanyaan berikutnya.', expectContains: [], kind: 'chat' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Vendor yang tadi saya tanyakan di percakapan sebelumnya — berapa permit expired karyawannya?', expectContains: [], expectNotContains: ['could you clarify', 'which vendor'], kind: 'hybrid' },
      ],
      memoryProbes: ['PT DARMA HENWA'],
    },
  ]),
  cross('princ-002', 'hard', 'Person established in A, profile asked in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Siapa pemegang KIMPER pertama yang terdaftar?', expectContains: [], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Orang yang saya tanyakan barusan — department dia apa?', expectContains: [], expectNotContains: ['which person', 'could you clarify'], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-003', 'hard', 'Policy learned in A applied to data question in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Apa interval MCU berkala menurut dokumen K3?', expectContains: [], kind: 'knowledge' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Dengan interval itu, siapa saja yang sudah melewati batas MCU-nya sekarang?', expectContains: [], expectNotContains: ['let me continue'], kind: 'hybrid' },
      ],
    },
  ]),
  cross('princ-004', 'hard', 'Site context in A, drill-down in B must not hallucinate', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Site dengan MCU FIT rate tertinggi yang mana?', expectContains: [], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Di site yang FIT rate-nya tertinggi itu, siapa yang belum punya permit aktif?', expectContains: [], expectNotContains: ['which site'], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-005', 'hard', 'Cross-session contradiction check: B asks opposite, must not stick to A answer', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Urutkan site dari peserta terbanyak ke tersedikit.', expectContains: [], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Sekarang urutkan site dari peserta tersedikit ke terbanyak.', expectContains: [], expectNotContains: [], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-006', 'hard', 'Number in A, percentage recompute in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Berapa total peserta dan berapa yang SUBCON?', expectContains: ['5060', '20'], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Dari angka yang saya dapat sebelumnya, berapa persen SUBCON dari total?', expectContains: [], expectNotContains: ['could you clarify'], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-007', 'hard', 'Trainer fact in A, schedule question in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Trainer paling sibuk siapa dan mengajar berapa batch?', expectContains: [], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Trainer itu batch terakhirnya kapan dan di site mana?', expectContains: [], expectNotContains: ['which trainer'], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-008', 'hard', 'Doc rule in A, exception hunt in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Apa syarat wajib induction sebelum mulai kerja menurut dokumen?', expectContains: [], kind: 'knowledge' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Cari siapa yang melanggar syarat itu — sudah kerja tapi belum induction.', expectContains: [], expectNotContains: ['continue analyzing'], kind: 'hybrid' },
      ],
    },
  ]),
  cross('princ-009', 'hard', 'Establish list in A, ask for member detail in B', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Sebutkan semua training type yang aktif.', expectContains: ['HI', 'MTR', 'PLH'], kind: 'sql' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Dari training type yang saya sebut tadi, mana yang pesertanya paling sedikit?', expectContains: [], expectNotContains: ['which training'], kind: 'sql' },
      ],
    },
  ]),
  cross('princ-010', 'hard', 'Long gap simulation: A policy, B applies to live number', [
    {
      sessionKey: 'A',
      turns: [
        { question: 'Dokumen menyebut batas maksimal peserta per batch training — berapa?', expectContains: [], kind: 'knowledge' },
      ],
    },
    {
      sessionKey: 'B',
      turns: [
        { question: 'Dengan batas itu, batch mana yang melebihi kuota saat ini?', expectContains: [], expectNotContains: ['let me continue'], kind: 'hybrid' },
      ],
    },
  ]),
]

// ---------------------------------------------------------------------------
// Source-toggle scenarios (10) — flip tool availability, assert honesty
// ---------------------------------------------------------------------------
export const prinasaToggleScenarios: ToggleScenario[] = [
  toggle('print-001', 'hard', 'SQL off → DB question must be refused honestly, not fabricated', [
    { action: 'set-tools', tools: { sql: false, rag: true } },
    { action: 'ask', question: 'Berapa total peserta di database?', expectBehavior: 'refuses-db', expectNotContains: ['5060'], note: 'Must NOT fabricate the number with SQL disabled' },
    { action: 'ask', question: 'Menurut dokumen, apa prosedur MCU?', expectBehavior: 'answers-knowledge', note: 'Knowledge path must still work' },
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'Sekarang berapa total peserta di database?', expectContains: ['5060'], expectBehavior: 'answers-db', note: 'Re-enabled → same question now answers with data' },
    { action: 'restore-tools' },
  ]),
  toggle('print-002', 'hard', 'RAG off → knowledge question must not cite docs', [
    { action: 'set-tools', tools: { sql: true, rag: false } },
    { action: 'ask', question: 'Apa prosedur pelepasan tag menurut dokumen?', expectBehavior: 'no-doc-citation', note: 'Must not fabricate document content' },
    { action: 'ask', question: 'Berapa tag yang belum dilepas di database?', expectBehavior: 'answers-db', note: 'DB path unaffected' },
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'Ulangi: apa prosedur pelepasan tag menurut dokumen?', expectBehavior: 'answers-knowledge', note: 'Re-enabled → now cites documents' },
    { action: 'restore-tools' },
  ]),
  toggle('print-003', 'hard', 'Both off → chat must answer honestly as plain LLM', [
    { action: 'set-tools', tools: { sql: false, rag: false } },
    { action: 'ask', question: 'Berapa total permit kita?', expectBehavior: 'refuses-db', expectNotContains: ['32'], note: 'No tools → no fabricated numbers' },
    { action: 'ask', question: 'Halo, kamu bisa apa saja?', expectBehavior: 'answers-chat', note: 'Plain greeting still works' },
    { action: 'restore-tools' },
  ]),
  toggle('print-004', 'hard', 'Hybrid question with SQL off → answers doc half, honest about DB half', [
    { action: 'set-tools', tools: { sql: false, rag: true } },
    { action: 'ask', question: 'Jelaskan aturan renewal permit dari dokumen dan berapa yang perlu renewal sekarang.', expectBehavior: 'answers-knowledge', expectNotContains: ['continue analyzing'], note: 'Must answer doc half, admit DB half unavailable — not loop' },
    { action: 'restore-tools' },
  ]),
  toggle('print-005', 'hard', 'Hybrid question with RAG off → answers DB half, honest about doc half', [
    { action: 'set-tools', tools: { sql: true, rag: false } },
    { action: 'ask', question: 'Apa aturan MCU berkala dan siapa yang overdue?', expectBehavior: 'answers-db', expectNotContains: ['let me continue'], note: 'Must give overdue list, admit doc rules unavailable' },
    { action: 'restore-tools' },
  ]),
  toggle('print-006', 'hard', 'Toggle flap: off→on mid-conversation, same session', [
    { action: 'set-tools', tools: { sql: false, rag: true } },
    { action: 'ask', question: 'Berapa permit EXPIRED?', expectBehavior: 'refuses-db', expectNotContains: ['9'] },
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'Coba jawab lagi pertanyaan saya barusan.', expectContains: ['9'], expectBehavior: 'answers-db', followsUpOn: 'previous question', note: 'Must re-answer the pending question with data now' },
    { action: 'restore-tools' },
  ]),
  toggle('print-007', 'hard', 'Typo robustness must survive toggles (router must not get confused)', [
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'berapa permints actve sekarng?', expectContains: ['23'], expectBehavior: 'answers-db', note: 'Typo + both tools on → still answers' },
    { action: 'ask', question: 'dan dokumen bilang soal permit expierd apa?', expectBehavior: 'answers-knowledge', expectNotContains: ['could you clarify'] },
    { action: 'restore-tools' },
  ]),
  toggle('print-008', 'hard', 'Switch-back stability: rag off → on, verify citation returns', [
    { action: 'set-tools', tools: { sql: true, rag: false } },
    { action: 'ask', question: 'Apa syarat SIMPER menurut dokumen?', expectBehavior: 'no-doc-citation' },
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'Tanya lagi: syarat SIMPER menurut dokumen apa saja?', expectBehavior: 'answers-knowledge', note: 'Citations should reappear' },
    { action: 'restore-tools' },
  ]),
  toggle('print-009', 'hard', 'Long-session + toggle combined stress', [
    { action: 'set-tools', tools: { sql: true, rag: true } },
    { action: 'ask', question: 'Berapa total peserta?', expectContains: ['5060'], expectBehavior: 'answers-db' },
    { action: 'ask', question: 'Yang SUBCON berapa?', expectContains: ['20'], expectBehavior: 'answers-db', followsUpOn: 'participant totals' },
    { action: 'set-tools', tools: { sql: false, rag: true } },
    { action: 'ask', question: 'Sekarang berapa peserta VISITOR?', expectBehavior: 'refuses-db', expectNotContains: ['1'] },
    { action: 'restore-tools' },
  ]),
  toggle('print-010', 'hard', 'Bilingual honesty under toggle (ID + EN mixed)', [
    { action: 'set-tools', tools: { sql: false, rag: false } },
    { action: 'ask', question: 'How many permits do we have right now?', expectBehavior: 'refuses-db', expectNotContains: ['32'] },
    { action: 'ask', question: 'Dan sekarang ceritakan apa yang kamu masih bisa bantu.', expectBehavior: 'answers-chat' },
    { action: 'restore-tools' },
  ]),
]
