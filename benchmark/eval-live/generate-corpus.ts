/**
 * Generate the live-eval corpus: one coherent fictional company, ~24 documents, Indonesian and English.
 *
 * WHY SYNTHETIC. The development corpora are tiny (9 documents of ~1.5 KB) and mix two "companies" whose policies
 * contradict each other (12 vs 18 leave days), so an answer could be right for one document and wrong for the other.
 * A customer corpus cannot be committed. A generated corpus for ONE company, written against a shared fact sheet so
 * documents agree with each other, is the closest reproducible stand-in. Every eval question is later tied to a
 * verbatim quote from one of these files, so the corpus is the ground truth and its text is committed.
 *
 *   bun benchmark/eval-live/generate-corpus.ts            (skips files that already exist)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { complete, mapLimit } from './llm'

const AUTHOR_MODEL = process.env.EVAL_CORPUS_MODEL ?? 'ag/gemini-3.8-flash-high'
const OUT = join(import.meta.dir, 'corpus')

const FACT_SHEET = `
COMPANY FACT SHEET — every document must agree with these facts and must not contradict each other.
- Company: PT Arunika Logistik Nusantara ("Arunika"), freight forwarding, warehousing and last-mile delivery.
- Founded 2011 in Surabaya; head office Jl. Rungkut Industri III No. 18, Surabaya. 1,240 employees (Dec 2025).
- Warehouses: Surabaya (SBY-01, 18,000 m2), Jakarta Cikarang (JKT-02, 24,500 m2), Medan (MDN-03, 9,200 m2),
  Makassar (MKS-04, 7,800 m2), Balikpapan (BPN-05, 6,100 m2).
- Fleet: 312 trucks (CDD 140, CDE 96, Fuso 52, Tronton 24), 58 vans.
- CEO Ratna Wijayakusuma; CFO Dimas Prasetyo; CHRO Sekar Ayuningtyas; CTO Hendra Gunawan; COO Yusuf Halim.
- Fiscal year = calendar year. Currency IDR. Working week Monday-Friday 08:00-17:00 WIB; warehouses run 3 shifts.
- Systems: WMS "Gudangku v4", TMS "RuteKu", ERP SAP Business One, ticketing Jira Service Management.
`

/** title, file name, language, and what the document must contain. Concrete numbers are the point. */
const DOCS: Array<{ file: string; lang: 'id' | 'en'; title: string; brief: string }> = [
  { file: 'hr-01-kebijakan-cuti.md', lang: 'id', title: 'Kebijakan Cuti dan Izin Karyawan', brief: 'cuti tahunan (14 hari setelah 12 bulan), tambahan per masa kerja (tabel), cuti sakit dengan surat dokter, cuti melahirkan 3 bulan, cuti ayah 5 hari, cuti duka, carry-over maks 6 hari hangus 31 Maret, prosedur pengajuan di HRIS minimal 7 hari kerja, cuti bersama' },
  { file: 'hr-02-kompensasi-tunjangan.md', lang: 'id', title: 'Kebijakan Kompensasi dan Tunjangan', brief: 'grade G1-G8 dengan rentang gaji (tabel), tunjangan transport, makan, shift malam per malam, lembur (rumus UU), THR, bonus kinerja maks % per grade, BPJS, asuransi rawat inap per grade (tabel plafon)' },
  { file: 'hr-03-rekrutmen-onboarding.md', lang: 'id', title: 'SOP Rekrutmen dan Onboarding', brief: 'tahapan rekrutmen dengan SLA hari, approval headcount, masa percobaan 3 bulan, checklist onboarding hari 1/minggu 1/bulan 1, buddy program, pelatihan K3 wajib 8 jam sebelum masuk gudang' },
  { file: 'hr-04-kinerja-pelatihan.md', lang: 'id', title: 'Manajemen Kinerja dan Pelatihan', brief: 'siklus penilaian (mid-year Juli, annual Desember), skala 1-5, distribusi kuota, PIP 60 hari, anggaran pelatihan per karyawan per tahun per grade, ikatan dinas untuk pelatihan di atas Rp 15 juta' },
  { file: 'hr-05-kode-etik.md', lang: 'id', title: 'Kode Etik dan Disiplin', brief: 'gratifikasi batas Rp 500.000, konflik kepentingan, tahapan SP1-SP3 masa berlaku 6 bulan, pelanggaran berat, whistleblowing hotline dan email, larangan merokok di area gudang' },
  { file: 'fin-01-reimbursement.md', lang: 'id', title: 'Kebijakan Reimbursement dan Perjalanan Dinas', brief: 'uang harian per kota/grade (tabel), plafon hotel per grade, kelas pesawat per grade, batas pengajuan 14 hari setelah perjalanan, dokumen wajib, approval berjenjang berdasarkan nominal' },
  { file: 'fin-02-pengadaan.md', lang: 'id', title: 'Kebijakan Pengadaan Barang dan Jasa', brief: 'ambang nilai: < Rp 10 juta 1 penawaran, Rp 10-100 juta 3 penawaran, > Rp 100 juta tender; matriks otorisasi (tabel jabatan x nilai), vendor terdaftar, termin pembayaran 30 hari, larangan split PO' },
  { file: 'fin-03-penagihan-piutang.md', lang: 'en', title: 'Billing, Credit and Collections Policy', brief: 'customer credit limits by segment (table), payment terms (Enterprise 45 days, SME 30 days, walk-in COD), late fee 2% per month capped at 10%, dunning schedule days +7/+14/+30/+60, write-off approval thresholds, credit hold rules' },
  { file: 'fin-04-anggaran.md', lang: 'en', title: 'Annual Budgeting Procedure FY2026', brief: 'timeline (Sep-Dec 2025 milestones with dates), capex vs opex thresholds (capex above IDR 25 million and useful life > 1 year), contingency 5%, reforecast quarterly, budget owners per cost center, approval by Board in December' },
  { file: 'ops-01-penerimaan-barang.md', lang: 'id', title: 'SOP Penerimaan Barang (Inbound) Gudang', brief: 'slot booking H-1 jam 15:00, toleransi keterlambatan truk 30 menit, pemeriksaan 100% vs sampling, toleransi selisih kuantitas 0,5%, putaway SLA 4 jam, penanganan barang rusak, kode lokasi rak' },
  { file: 'ops-02-pengiriman-outbound.md', lang: 'id', title: 'SOP Picking, Packing dan Pengiriman (Outbound)', brief: 'cut-off order jam 14:00 same-day dispatch, metode FEFO/FIFO, akurasi picking target 99,8%, standar packing per kategori, berat dimensi faktor 6000, serah terima ke driver dengan POD digital' },
  { file: 'ops-03-sla-layanan.md', lang: 'en', title: 'Customer Service Level Agreement (Standard Contract)', brief: 'delivery lead time table by route (e.g. Surabaya-Jakarta 2 days, Surabaya-Medan 5 days), on-time target 97%, service credits per missed % band (table), claim window 7 days, liability cap 10x freight charge, exclusions' },
  { file: 'ops-04-armada.md', lang: 'id', title: 'Kebijakan Pengelolaan Armada dan Pengemudi', brief: 'servis berkala setiap 10.000 km, umur maksimal truk 10 tahun, batas jam mengemudi 8 jam/hari dengan istirahat 30 menit tiap 4 jam, kecepatan maks tol 80 km/jam, GPS, BBM kartu fleet, poin pelanggaran pengemudi' },
  { file: 'ops-05-k3-gudang.md', lang: 'id', title: 'Pedoman K3 (Keselamatan dan Kesehatan Kerja) Gudang', brief: 'APD wajib per area, forklift hanya operator bersertifikat SIO, batas tumpukan palet 3 tingkat, inspeksi APAR bulanan, pelaporan insiden 1x24 jam, target LTIFR, evakuasi titik kumpul' },
  { file: 'ops-06-barang-berbahaya.md', lang: 'en', title: 'Dangerous Goods Handling Procedure', brief: 'accepted UN classes and excluded classes, segregation table, MSDS required, max storage quantities per warehouse, certified handler training every 24 months, spill response steps, which warehouses accept DG (SBY-01 and JKT-02 only)' },
  { file: 'it-01-keamanan-informasi.md', lang: 'id', title: 'Kebijakan Keamanan Informasi', brief: 'klasifikasi data 4 level, password minimal 12 karakter ganti 90 hari, MFA wajib, VPN, larangan USB, backup harian retensi 35 hari, enkripsi laptop, pelaporan insiden keamanan 1 jam' },
  { file: 'it-02-penanganan-insiden.md', lang: 'id', title: 'SOP Penanganan Gangguan dan Insiden TI', brief: 'prioritas P1-P4 dengan SLA respon dan resolusi (tabel), eskalasi, contoh P1 (WMS down), post-incident review dalam 5 hari kerja, jam operasional helpdesk dan nomor ekstensi' },
  { file: 'it-03-akses-sistem.md', lang: 'en', title: 'System Access Management Standard', brief: 'role-based access for Gudangku, RuteKu, SAP B1; request via Jira with manager approval; access review every quarter; offboarding revoke within 4 hours; privileged accounts; shared accounts forbidden; vendor access expiry 30 days' },
  { file: 'it-04-pemulihan-bencana.md', lang: 'en', title: 'IT Disaster Recovery Plan', brief: 'RTO/RPO per system (table: WMS RTO 4h RPO 15m, TMS RTO 8h RPO 1h, ERP RTO 24h RPO 4h), DR site location, DR test twice a year (April and October), roles, communication tree' },
  { file: 'sales-01-tarif.md', lang: 'id', title: 'Daftar Tarif Layanan 2026', brief: 'tarif per kg per rute (tabel beberapa rute dari Surabaya), minimum charge 10 kg, sewa gudang per m2 per bulan per lokasi (tabel), biaya handling per palet, surcharge BBM, diskon volume berjenjang' },
  { file: 'sales-02-onboarding-pelanggan.md', lang: 'en', title: 'Customer Onboarding and KYC Procedure', brief: 'documents required (NIB, NPWP, deed), credit check, onboarding SLA 5 business days, account manager assignment rules by monthly revenue, integration options (API, SFTP, portal), trial shipment' },
  { file: 'risk-01-manajemen-risiko.md', lang: 'id', title: 'Kerangka Manajemen Risiko', brief: 'matriks 5x5 kemungkinan x dampak, kategori risiko, register risiko ditinjau triwulanan, risk appetite, contoh 5 risiko utama dengan pemilik dan mitigasi, komite risiko' },
  { file: 'risk-02-asuransi-klaim.md', lang: 'en', title: 'Cargo Insurance and Claims Procedure', brief: 'insurer and policy limits per shipment and per warehouse, deductible, claim documents, claim must be filed within 7 days, investigation 14 days, payout within 30 days of approval, excluded goods' },
  { file: 'esg-01-keberlanjutan.md', lang: 'en', title: 'Sustainability and Environmental Policy', brief: 'emissions baseline 2023 in tCO2e, target -30% by 2030, EV van pilot 12 units in Jakarta, solar rooftop SBY-01 450 kWp, waste recycling target 60%, idling limit 5 minutes, annual sustainability report in Q2' },
]

function prompt(d: (typeof DOCS)[number]): string {
  const language = d.lang === 'id' ? 'Bahasa Indonesia (formal, as an internal company document)' : 'English (formal, as an internal company document)'
  return `${FACT_SHEET}
Write the internal document "${d.title}" for Arunika in ${language}, as Markdown.
It must contain: ${d.brief}.
Requirements:
- 3,500 to 6,000 characters. Headings, numbered sections, at least one Markdown table, and many concrete facts
  (numbers, durations, amounts in IDR, dates, role names). Invent specifics where the brief does not fix them, but
  never contradict the fact sheet.
- Include a document code, version, effective date in 2025 or 2026, and the owning department.
- No placeholders such as [X] or TBD. No commentary outside the document. Output only the Markdown.`
}

mkdirSync(OUT, { recursive: true })
const todo = DOCS.filter((d) => !existsSync(join(OUT, d.file)))
console.log(`generating ${todo.length} of ${DOCS.length} documents with ${AUTHOR_MODEL}`)
await mapLimit(todo, 4, async (d) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = (await complete(AUTHOR_MODEL, [{ role: 'user', content: prompt(d) }], { maxTokens: 6000, temperature: 0.4 }))
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()
    if (text.length >= 3000 && /\|.*\|/.test(text) && !/\[(X|TBD|.*?placeholder.*?)\]/i.test(text)) {
      writeFileSync(join(OUT, d.file), text + '\n')
      console.log(`  ${d.file}: ${text.length} chars`)
      return
    }
    console.log(`  ${d.file}: rejected attempt ${attempt + 1} (${text.length} chars)`)
  }
  throw new Error(`could not generate ${d.file}`)
})
