/**
 * Seed script — populates the internal application database.
 * Run with: `bun run scripts/seed.ts`
 *
 * Creates:
 *   - 1 Admin User
 *   - 1 Sample Integration (ERP Produksi — SQLITE_DEMO provider)
 *   - 4 Sample SOP / policy documents with chunks for RAG
 */
import { db } from '../src/lib/db'
import { encryptConfig } from '../src/lib/crypto'
import { hashPassword } from '../src/lib/passwords'
import { ensureDemoSchema, connectorRegistry, describeSchema } from '../src/lib/connectors'

// Admin credentials honour env overrides so production seeds use real values
// instead of a placeholder hash. Defaults are dev-only.
const adminEmailOverride = process.env.ADMIN_EMAIL?.trim().toLowerCase() || null
const adminPassword = process.env.ADMIN_INITIAL_PASSWORD || 'admin12345'

async function main() {
  console.log('🌱 Seeding ryasai database...')

  // 1. Users ----------------------------------------------------------------
  const users = [
    { id: 'usr-admin', email: 'admin@ryas.ai', name: 'Ryas Admin', color: 'oklch(0.55 0.18 250)' },
    { id: 'usr-manager', email: 'manager@ryas.ai', name: 'Ryas Manager', color: 'oklch(0.6 0.16 160)' },
    { id: 'usr-staff', email: 'staff@ryas.ai', name: 'Ryas Staff', color: 'oklch(0.65 0.2 70)' },
  ]
  for (const [i, u] of users.entries()) {
    const email = i === 0 && adminEmailOverride ? adminEmailOverride : u.email
    const password = i === 0 ? adminPassword : 'user12345'
    await db.user.upsert({
      where: { email },
      update: {
        name: u.name,
        isActive: true,
        avatarColor: u.color,
        passwordHash: hashPassword(password),
      },
      create: {
        id: u.id,
        email,
        name: u.name,
        passwordHash: hashPassword(password),
        avatarColor: u.color,
        isActive: true,
      },
    })
  }

  // 2. Integration (encrypted config) --------------------------------------
  const enc = encryptConfig({
    host: 'erp-db.ryas.ai',
    port: 5432,
    username: 'ai_reader_restricted',
    password: 'P@sswordSecureClient2026',
    database_name: 'erp_production',
  })
  const integration = await db.integration.upsert({
    where: { id: 'int-erp-001' },
    update: {
      name: 'Database ERP Produksi Utama',
      type: 'DATABASE',
      provider: 'SQLITE_DEMO',
      encryptedConfig: enc,
      status: 'active',
    },
    create: {
      id: 'int-erp-001',
      name: 'Database ERP Produksi Utama',
      type: 'DATABASE',
      provider: 'SQLITE_DEMO',
      encryptedConfig: enc,
      status: 'active',
    },
  })

  // 3. Reflect schema + cache it -------------------------------------------
  await ensureDemoSchema()
  const connector = connectorRegistry.getConnector(integration.id, integration.provider, {
    host: 'demo',
    port: 5432,
    username: 'demo',
    password: 'demo',
    database_name: 'demo',
  })
  const ok = await connector.testConnection()
  const tables = await connector.fetchSchema()
  console.log(`   ↳ connector test: ${ok ? 'OK' : 'FAIL'}, reflected ${tables.length} tables`)

  await db.integrationSchema.deleteMany({ where: { integrationId: integration.id } })
  for (const t of tables) {
    await db.integrationSchema.create({
      data: {
        integrationId: integration.id,
        tableName: t.tableName,
        columns: JSON.stringify(t.columns),
        rowCount: t.rowCount ?? null,
        reflectedAt: new Date(),
      },
    })
  }
  await db.integration.update({
    where: { id: integration.id },
    data: { lastTestedAt: new Date(), lastTestOk: ok },
  })
  console.log(`   ↳ schema cached. Preview:\n${describeSchema(tables).split('\n').slice(0, 4).join('\n')} ...`)

  // 4. Sample documents + chunks (RAG knowledge base) ----------------------
  const docs = buildSampleDocs()
  await db.documentChunk.deleteMany({})
  await db.document.deleteMany({})
  for (const d of docs) {
    const doc = await db.document.create({
      data: {
        name: d.name,
        type: d.type,
        sizeBytes: d.content.length,
        mimeType: d.mimeType,
        status: 'ready',
        category: d.category,
        description: d.description,
        contentText: d.content,
      },
    })
    // chunk by paragraphs (~512 tokens target)
    const paras = d.content.split(/\n\n+/).filter((p) => p.trim().length > 0)
    await db.documentChunk.createMany({
      data: paras.map((p, i) => ({
        documentId: doc.id,
        chunkIndex: i,
        content: p.trim(),
        tokenCount: Math.ceil(p.trim().length / 4),
        keywords: extractKeywords(p),
      })),
    })
  }
  console.log(`   ↳ inserted ${docs.length} documents with chunks`)

  // 5. REST API connector + endpoints ---------------------------------------
  await db.restApiEndpoint.deleteMany({})
  await db.restApiConnector.deleteMany({})
  const restConnector = await db.restApiConnector.create({
    data: {
      id: 'conn-rest-001',
      name: 'JSONPlaceholder API',
      baseUrl: 'https://jsonplaceholder.typicode.com',
      authType: 'NONE',
      isActive: true,
      timeoutMs: 15000,
    },
  })
  const endpoints = [
    { method: 'GET', path: '/users', description: 'Daftar semua user', isEnabled: true },
    { method: 'GET', path: '/users/{id}', description: 'Detail user by ID', isEnabled: true },
    { method: 'GET', path: '/posts', description: 'Daftar semua post', isEnabled: true },
    { method: 'GET', path: '/posts/{id}', description: 'Detail post by ID', isEnabled: true },
    { method: 'GET', path: '/comments', description: 'Daftar semua comment', isEnabled: true },
  ]
  for (const ep of endpoints) {
    await db.restApiEndpoint.create({
      data: { connectorId: restConnector.id, ...ep },
    })
  }
  console.log(`   ↳ inserted REST connector with ${endpoints.length} endpoints`)

  // 6. Plugin ----------------------------------------------------------------
  await db.plugin.deleteMany({})
  await db.plugin.create({
    data: {
      toolId: 'weather',
      name: 'Weather Plugin',
      description: 'Cek cuaca berdasarkan nama kota',
      manifestJson: JSON.stringify({
        paramDescription: '{ "input": "nama kota" }',
        executorType: 'webhook',
        endpoint: 'https://jsonplaceholder.typicode.com/posts/1',
        method: 'GET',
        authType: 'NONE',
        timeoutMs: 10000,
        description: 'Simulasi plugin weather — returns placeholder data',
      }),
      isEnabled: true,
    },
  })
  console.log('   ↳ inserted 1 plugin (weather)')

  // 7. Scheduled run ---------------------------------------------------------
  await db.scheduledRun.deleteMany({})
  await db.scheduledRun.create({
    data: {
      name: 'Ringkasan Penjualan Harian',
      cronExpr: '0 9 * * *',
      prompt: 'Tampilkan ringkasan penjualan hari ini dari database ERP',
      isActive: true,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  console.log('   ↳ inserted 1 scheduled run')

  // 8. API Key for external testing -----------------------------------------
  const { generateApiKey } = await import('../src/lib/api-keys')
  await db.apiKey.deleteMany({})
  const generated = generateApiKey()
  await db.apiKey.create({
    data: {
      label: 'E2E Test Key',
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      requestLimitPerMinute: 100,
      dailyRequestLimit: 10000,
    },
  })
  console.log(`   ↳ inserted API key: ${generated.plainText}`)

  // 9. Sample audit log entries --------------------------------------------
  await db.auditLog.createMany({
    data: [
      {
        userId: 'usr-admin',
        action: 'INTEGRATION_CREATE',
        severity: 'info',
        detail: JSON.stringify({ integrationId: integration.id, name: integration.name, provider: integration.provider }),
      },
      {
        userId: 'usr-admin',
        action: 'SYSTEM_INIT',
        severity: 'info',
        detail: JSON.stringify({ message: 'Sistem ryasai diinisialisasi.' }),
      },
      {
        action: 'GUARDRAIL_BLOCK',
        severity: 'critical',
        detail: JSON.stringify({ reason: 'Contoh: percobaan prompt injection terdeteksi & diblokir saat testing awal.' }),
      },
    ],
  })

  console.log('\n✅ Seed complete.')
  console.log('   Users      :', users.map((u) => u.email).join(', '))
  console.log('   Integration:', integration.name)
  console.log('   REST       :', restConnector.name, `(${endpoints.length} endpoints)`)
  console.log('   Plugin     : weather')
  console.log('   Schedule   : Ringkasan Penjualan Harian (0 9 * * *)')
  console.log('   API Key    : see above')
}

function extractKeywords(text: string): string {
  const stop = new Set(['yang','dan','atau','untuk','pada','dari','ke','dalam','ini','itu','dengan','adalah','akan','tidak','juga','oleh','sebagai','agar','ataupun','the','a','an','of','to','in','on','for','and','or'])
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []
  const freq = new Map<string, number>()
  for (const w of words) {
    if (w.length < 4 || stop.has(w)) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([w])=>w).join(',')
}

function buildSampleDocs() {
  return [
    {
      name: 'SOP Pengelolaan Inventaris Gudang.pdf',
      type: 'pdf',
      mimeType: 'application/pdf',
      category: 'SOP',
      description: 'Prosedur operasi standar pengelolaan stok dan inventaris gudang.',
      content: `STANDAR OPERASIONAL PROSEDUR — PENGELOLAAN INVENTARIS GUDANG

1. TUJUAN
SOP ini bertujuan memastikan setiap pergerakan stok barang di gudang tercatat, terverifikasi, dan dapat ditelusuri. Kepatuhan terhadap SOP ini wajib bagi seluruh staf gudang dan manajer operasional.

2. RUANG LINGKUP
Berlaku untuk seluruh gudang perusahaan: Gudang Utama Jakarta, Gudang Surabaya, dan Gudang Bandung. Mencakup penerimaan barang, penyimpanan, picking, packing, dan pengiriman.

3. PENERIMAAN BARANG
Setiap kiriman yang tiba wajib diperiksa oleh minimum dua staf. Lakukan pencocokan antara surat jalan, purchase order, dan barang fisik. Jika ada selisih lebih dari 2%, tahan barang di zona karantina dan laporkan ke manajer gudang dalam 1x24 jam. Barang yang lolos verifikasi dimasukkan ke sistem inventori pada hari yang sama.

4. PENYIMPANAN
Barang disusun berdasarkan kategori produk dan SKU. Produk dengan pergerakan tinggi ditempatkan di area dekat pintu keluar. Produk elektronik wajib disimpan di area ber-AC dengan suhu 18-25°C. Setiap rak diberi label kode lokasi yang jelas.

5. REORDER LEVEL
Setiap produk memiliki reorder level. Ketika stok mencapai atau di bawah reorder level, sistem otomatis membuat permintaan pembelian. Misalnya SKU-910 (UPS 1500VA) memiliki reorder level 100 unit — jika stok turun ke 95 unit, pembelian otomatis dipicu. Manajer wajib menyetujui PO sebelum dikirim ke vendor.

6. STOCK OPNAME
Stock opname dilakukan setiap akhir bulan. Selisih fisik vs sistem lebih dari 1% harus disertai laporan penyebab. Hasil opname ditandatangani oleh manajer gudang dan kepala operasional.

7. KEAMANAN
Akses gudang terbatas pada staf terdaftar. CCTV aktif 24 jam. Tidak diperkenankan membawa tas pribadi ke area penyimpanan tanpa pemeriksaan.`,
    },
    {
      name: 'Kebijakan Pembayaran Invoice 2026.docx',
      type: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      category: 'KEBIJAKAN',
      description: 'Kebijakan pembayaran invoice kepada pelanggan enterprise dan SMB.',
      content: `KEBIJAKAN PEMBAYARAN INVOICE — TAHUN ANGGARAN 2026

1. DASAR HUKUM INTERNAL
Kebijakan ini mengatur seluruh siklus pembayaran invoice pelanggan, mulai dari penerbitan, pengingat, hingga penagihan. Berlaku efektif 1 Januari 2026.

2. TERMIN PEMBAYARAN
- Pelanggan segmen Enterprise: termin 30 hari kalender sejak invoice diterbitkan.
- Pelanggan segmen SMB: termin 14 hari kalender sejak invoice diterbitkan.
- Pelanggan segmen Retail: pembayaran di muka penuh sebelum pengiriman.

3. PENGINGAT OTOMATIS
Sistem mengirim pengingat otomatis via email:
- H-7 sebelum jatuh tempo (pengingat ramah)
- H+1 setelah jatuh tempo (invoice overdue)
- H+14 setelah jatuh tempo (surat peringatan pertama)
- H+30 setelah jatuh tempo (diteruskan ke tim legal)

4. DENDA KETERLAMBATAN
Keterlambatan pembayaran dikenakan denda 1% per bulan dari nilai invoice yang belum dibayar, dihitung harian. Maksimum denda 5% dari nilai invoice.

5. DISKON PEMBAYARAN DINI
Pembayaran yang diterima dalam 7 hari sejak invoice diterbitkan mendapat diskon 2% untuk pelanggan Enterprise dan 1,5% untuk SMB. Diskon tidak berlaku untuk pelanggan Retail.

6. PEMBATALAN INVOICE
Invoice dapat dibatalkan dalam 3 hari setelah penerbitan dengan persetujuan manajer keuangan. Setelah 3 hari, pembatalan memerlukan approval direktur keuangan.

7. METODE PEMBAYARAN
Diterima: transfer bank (BCA, Mandiri, BNI), virtual account, dan QRIS. Tidak diterima: tunai di atas 10 juta rupiah untuk pelanggan Enterprise.

8. REKONSILIASI
Tim finance melakukan rekonsiliasi harian antara pembayaran masuk dan invoice aktif. Setiap anomali wajib dilaporkan ke kepala finance dalam 1x24 jam.`,
    },
    {
      name: 'Panduan Pengadaan IT Perusahaan.md',
      type: 'md',
      mimeType: 'text/markdown',
      category: 'KEBIJAKAN',
      description: 'Panduan pengadaan perangkat dan layanan IT untuk seluruh departemen.',
      content: `# Panduan Pengadaan IT Perusahaan

## 1. Prinsip Umum
Setiap pengadaan perangkat IT harus melalui proses persetujuan berjenjang. Tujuannya menjamin value-for-money, keamanan, dan kompatibilitas dengan ekosistem eksisting.

## 2. Threshold Persetujuan
- **< Rp 5.000.000**: disetujui oleh manajer departemen.
- **Rp 5.000.000 - Rp 50.000.000**: disetujui oleh manajer departemen + manajer IT.
- **Rp 50.000.000 - Rp 250.000.000**: tambahan persetujuan direktur operasional.
- **> Rp 250.000.000**: harus melalui tender dan persetujuan direksi.

## 3. Vendor yang Disetujui
Berikut vendor resmi perusahaan untuk pengadaan:
- Laptop & Desktop: PT Computech Asia, CV Sumber Komputer
- Networking: PT Jaringan Nusantara
- Aksesoris: CV Aksesoris Maju
- Software lisensi: PT Lisensi Digital

Vendor di luar daftar ini wajib melalui proses due diligence minimal 2 minggu.

## 4. Standar Perangkat
- Laptop standar staf: Intel i5, RAM 16GB, SSD 512GB.
- Laptop standar manager: Intel i7, RAM 32GB, SSD 1TB.
- Monitor: minimal 24" untuk staf, 27" 4K untuk manager.
- Masa pakai perangkat: 3 tahun untuk laptop, 5 tahun untuk monitor.

## 5. Keamanan
Semua perangkat wajib terinstal endpoint protection. Akses root/admin hanya untuk tim IT. Tidak diperkenankan instalasi software tanpa persetujuan IT.

## 6. Pengembalian Aset
Karyawan yang resign wajib mengembalikan seluruh perangkat IT dalam kondisi baik. Kerusakan akibat kelalaian dikenakan biaya sesuai nilai sisa aset.`,
    },
    {
      name: 'Laporan Keuangan Q1 2026.xlsx',
      type: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      category: 'FINANSIAL',
      description: 'Ringkasan laporan keuangan kuartal pertama 2026.',
      content: `LAPORAN KEUANGAN KUARTAL 1 (Q1) 2026 — RINGKASAN

PENDAPATAN
- Januari: Rp 425.000.000
- Februari: Rp 480.000.000
- Maret: Rp 612.000.000
- Total Q1: Rp 1.517.000.000
- Pertumbuhan QoQ: +18,5%
- Pertumbuhan YoY: +24,2%

HARGA POKOK PENJUALAN (HPP)
- Januari: Rp 297.500.000
- Februari: Rp 336.000.000
- Maret: Rp 428.400.000
- Total Q1 HPP: Rp 1.061.900.000
- Margin bruto Q1: 30%

BIAYA OPERASIONAL
- Gaji & tunjangan: Rp 320.000.000
- Sewa kantor & gudang: Rp 85.000.000
- Utilitas & internet: Rp 18.500.000
- Marketing & promosi: Rp 45.000.000
- Logistik & pengiriman: Rp 62.000.000
- Lain-lain: Rp 24.000.000
- Total biaya operasional Q1: Rp 554.500.000

LABA BERSIH Q1
- Laba kotor: Rp 455.100.000
- Laba operasional: Rp -99.400.000 (rugi operasional, ditutup oleh pendapatan lain)
- Pendapatan lain-lain: Rp 145.000.000
- Laba sebelum pajak: Rp 500.700.000
- Pajak (22%): Rp 110.154.000
- Laba bersih Q1 2026: Rp 390.546.000

POSISI KEUANGAN PER 31 MARET 2026
- Kas & setara kas: Rp 680.000.000
- Piutang usaha: Rp 425.000.000
- Persediaan: Rp 1.240.000.000
- Aset tetap: Rp 2.150.000.000
- Total aset: Rp 4.495.000.000
- Utang usaha: Rp 385.000.000
- Modal: Rp 4.110.000.000

CATATAN
- Piutang overdue: Rp 62.000.000 (3 invoice Enterprise, perlu ditindaklanjuti).
- Persediaan meningkat 12% karena persiapan Q2.
- Rasio lancar: 5,9 (sangat sehat).`,
    },
  ]
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
