/**
 * Hand-built bilingual golden set, because the extractive generator produced
 * only 4 usable questions from 28 chunks: it discards sentences longer than
 * MAX_CHUNK_CHARS, and policy prose runs long. 4 questions is not a sample.
 *
 * Crucially this set contains BOTH phrasings of the same fact:
 *   - "vague"      — how a user actually asks (topic words only)
 *   - "source-named" — what reportedly makes it work
 * so the eval can show whether the source-naming asymmetry is real.
 * expectedKeywords are facts that must appear in the answer for it to be
 * correct, used as a deterministic check alongside the LLM judge.
 */
import { writeFileSync } from 'node:fs'

interface Q {
  id: string
  question: string
  expectedAnswer: string
  expectedKeywords?: string[]
  /** trial-only metadata */
  kind: 'vague' | 'source-named' | 'unanswerable'
  doc: string
}

const QS: Q[] = [
  // ---- overtime rate: the same fact asked two ways ----
  {
    id: 'ot-vague-id', kind: 'vague', doc: 'KB Employee Handbook 2024.pdf',
    question: 'Berapa tarif lembur pada hari kerja?',
    expectedAnswer: 'Tarif lembur pada hari kerja adalah 1,5 kali upah per jam.',
    expectedKeywords: ['1,5', '1.5'],
  },
  {
    id: 'ot-source-id', kind: 'source-named', doc: 'KB Employee Handbook 2024.pdf',
    question: 'Menurut KB Employee Handbook 2024, berapa tarif lembur pada hari kerja?',
    expectedAnswer: 'Tarif lembur pada hari kerja adalah 1,5 kali upah per jam.',
    expectedKeywords: ['1,5', '1.5'],
  },
  {
    id: 'ot-vague-en', kind: 'vague', doc: 'KB Employee Handbook 2024.pdf',
    question: 'What is the overtime rate on a public holiday?',
    expectedAnswer: 'The overtime rate on a public holiday is 2.0 times the hourly wage.',
    expectedKeywords: ['2.0', '2,0', '2x', '2 x'],
  },
  // ---- annual leave ----
  {
    id: 'leave-vague-id', kind: 'vague', doc: 'KB Employee Handbook 2024.pdf',
    question: 'Berapa hari cuti tahunan yang diberikan perusahaan?',
    expectedAnswer: 'Employees are entitled to 12 working days of annual leave per year.',
    expectedKeywords: ['12'],
  },
  {
    id: 'leave-carryover', kind: 'vague', doc: 'KB Employee Handbook 2024.pdf',
    question: 'Berapa maksimum cuti tahunan yang bisa dibawa ke tahun berikutnya?',
    expectedAnswer: 'Unused annual leave may be carried over up to a maximum of 5 days.',
    expectedKeywords: ['5'],
  },
  // ---- procurement thresholds ----
  {
    id: 'proc-threshold', kind: 'vague', doc: 'KB Procurement Policy.pdf',
    question: 'Berapa batas nilai pembelian langsung tanpa tender?',
    expectedAnswer: 'Direct purchase without tender is permitted up to 50,000,000 IDR.',
    expectedKeywords: ['50', 'juta', 'million'],
  },
  {
    id: 'proc-tender', kind: 'vague', doc: 'KB Procurement Policy.pdf',
    question: 'Kapan sebuah pengadaan wajib melalui tender terbuka?',
    expectedAnswer: 'Purchases above 250,000,000 IDR require a formal open tender.',
    expectedKeywords: ['250'],
  },
  {
    id: 'proc-payment', kind: 'source-named', doc: 'KB Procurement Policy.pdf',
    question: 'Menurut Procurement Policy, berapa lama termin pembayaran standar?',
    expectedAnswer: 'Standard payment terms are 30 days from the invoice receipt date.',
    expectedKeywords: ['30'],
  },
  // ---- security ----
  {
    id: 'sec-breach', kind: 'vague', doc: 'KB Data Security Standard.docx',
    question: 'Berapa lama batas waktu pelaporan dugaan kebocoran data?',
    expectedAnswer: 'A suspected data breach must be reported to the security team within 24 hours.',
    expectedKeywords: ['24'],
  },
  {
    id: 'sec-access', kind: 'vague', doc: 'KB Data Security Standard.docx',
    question: 'Siapa yang harus menyetujui akses ke data restricted?',
    expectedAnswer: 'Access to restricted data requires approval from the Chief Information Security Officer.',
    expectedKeywords: ['Chief Information Security Officer', 'CISO'],
  },
  // ---- refund ----
  {
    id: 'refund-window', kind: 'vague', doc: 'KB Customer Refund SOP.pdf',
    question: 'Berapa lama jangka waktu pelanggan boleh mengajukan refund?',
    expectedAnswer: 'Customers may request a refund within 30 days of the purchase date.',
    expectedKeywords: ['30'],
  },
  {
    id: 'refund-processing', kind: 'vague', doc: 'KB Customer Refund SOP.pdf',
    question: 'Berapa hari proses refund setelah retur disetujui?',
    expectedAnswer: 'Refunds are processed within 14 working days of the approved return.',
    expectedKeywords: ['14'],
  },
  // ---- negative control: NOT in the knowledge base ----
  {
    id: 'neg-not-in-kb', kind: 'unanswerable', doc: '(none)',
    question: 'Berapa harga saham perusahaan kemarin di bursa efek?',
    expectedAnswer: 'The knowledge base does not contain stock price information, so this cannot be answered.',
    expectedKeywords: [],
  },
  {
    id: 'neg-not-in-kb-2', kind: 'unanswerable', doc: '(none)',
    question: 'Siapa pemenang Piala Dunia 2018?',
    expectedAnswer: 'The knowledge base does not contain this information. It should say it does not know rather than guess.',
    expectedKeywords: [],
  },
]

writeFileSync('/tmp/golden-custom.json', JSON.stringify({ questions: QS }, null, 2))
console.log(`wrote ${QS.length} questions to /tmp/golden-custom.json`)
console.log(`  vague=${QS.filter((q) => q.kind === 'vague').length} source-named=${QS.filter((q) => q.kind === 'source-named').length} unanswerable=${QS.filter((q) => q.kind === 'unanswerable').length}`)
