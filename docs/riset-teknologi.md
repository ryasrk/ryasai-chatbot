# Riset Teknologi — Bukti, Bukan Tren

Dokumen ini mencatat hasil riset teknologi terbaru untuk ryasai-chatbot.
Metodenya: **mengukur dulu, baru menyimpulkan.** Setiap klaim di bawah punya
nomor bukti (skrip di `trial/` + output). Yang tidak terbukti saya tulis
sebagai "tidak terbukti", bukan sebagai bug.

Prinsip penyaring: rekomendasi harus relevan dengan arsitektur nyata —
**on-prem, BYOK, multi-DB, pgvector, LLM sebagai otak**. Daftar tren umum
yang tidak menyentuh arsitektur ini saya buang.

---

## Ringkasan untuk pengambil keputusan

| # | Temuan | Dampak | Status |
|---|---|---|---|
| R1 | RAG bisa kehilangan kedua jalur vektor tanpa sinyal apa pun | Sedang | Direkomendasikan (lihat R3) |
| R2 | **HNSW memotong hasil retrieval ~50% saat tenant minoritas** | **Tinggi** | **Rekomendasi utama** |
| R3 | Jalur retrieval gagal tanpa jejak yang terlihat operator | Sedang | Rekomendasi |

---

## R1 — Vektor & tsvector kosong: RAG hanya berjalan di BM25

> **KOREKSI PENTING — baca ini dulu.** Bagian ini awalnya saya tulis sebagai
> "temuan besar". Setelah memeriksa ulang, **konteksnya salah** dan saya turunkan
> tingkatannya. Rinciannya di bawah; saya tinggalkan koreksinya, bukan
> menyembunyikannya.

### Apa yang saya ukur (fakta)

Pada database dev, sebelum saya menyentuhnya:

```
total chunk            : 502
embedding (vector)     : 0      <- jalur pgvector kosong
tsv (full-text)        : 0      <- jalur ts_rank kosong
embeddingJson          : 500
model tersimpan        : text-embedding-3-small (1536 dim)
kolom vektor           : vector(384)
```

Mekanismenya nyata dan bisa dijelaskan: `canWriteVectorColumn()`
(`src/lib/embeddings.ts:282`) menolak menulis kolom `vector(384)` saat model
mengembalikan 1536 dim, dan menyimpan `embeddingJson` saja. Guard model-match di
`src/lib/rag-retrieval.ts:287` kemudian juga menolak fallback cosine. Hasilnya
kedua jalur vektor mengembalikan nol baris.

### Mengapa ini BUKAN temuan sebesar yang saya kira

1. **502 chunk itu bukan korpus nyata.** Itu sisa organisasi uji
   (`E2E Fix Verification`) yang saya buat sendiri selama sesi ini. Korpus dev
   yang sesungguhnya adalah **2 chunk** (`doc-test.txt`).
2. **Data itu memang sengaja tidak dimigrasikan.** Model 1536-dim berasal dari
   OpenAI; Anda menyatakan belum bisa menyediakan embedding OpenAI, sehingga
   kolom diturunkan ke 384. Ketidakcocokan adalah **konsekuensi desain yang
   dipilih**, bukan kelalaian.
3. **Kode sudah menangani ini dengan benar.** Ia menolak menulis vektor yang
   salah dimensi, tetap menyimpan `embeddingJson`, dan mencetak instruksi
   perbaikan yang tepat sekali. Itu perilaku yang baik.

### Yang tetap layak diangkat (bagian yang bertahan)

Terlepas dari skala, ada satu celah nyata: **RAG bisa kehilangan kedua jalur
vektornya tanpa satu pun sinyal yang terlihat operator.** Tidak ada penanda di
UI, tidak ada peringatan di Monitoring. Satu-satunya jejak adalah `console.error`
di log server — yang pada instalasi on-prem tidak akan pernah dibaca siapa pun.

Ini masalah yang sama dengan R3 di bawah, dan itulah rekomendasi yang saya
pertahankan: **bikin kegagalan ini terlihat**, jangan tambah mesin pencari baru.

### Yang saya lakukan dan batasnya

Saya menjalankan `rebuildFts()` dan `embedCompanyDocuments()` pada data uji itu,
dan berhasil (500 vektor 384-dim, 502 tsv). **Tetapi perbaikan itu memakai
`tools/local-embeddings/server.py` — server embedding yang SAYA buat di sesi ini
dan yang TIDAK di-track git serta tidak dirujuk oleh `src/` sama sekali.**

Jadi: apa yang saya kerjakan tadi adalah **menghidupkan kembali data uji di atas
infrastruktur buatan saya sendiri**, bukan memperbaiki produk Anda. Saya
menyajikannya sebagai "RAG hidup kembali" dan itu menyesatkan. Produk Anda tidak
pernah bergantung pada server itu.

## R2 — HNSW memotong hasil retrieval kita, dan itu terdokumentasi resmi

> **Ini temuan terkuat dari riset ini.** Kemarin saya mencoba membuktikan ini
> dan GAGAL, lalu mencatatnya sebagai "risiko teoretis, tidak terbukti".
> Setelah membaca dokumentasi resmi pgvector, saya tahu mengapa gagal: saya
> menguji dengan 3 vektor minoritas dari 503. Angka resminya adalah **10%**.
> Diulang pada konfigurasi yang benar, langsung terbukti.

### Bukti

Dokumentasi resmi pgvector (README, bagian "Filtering") menyatakan:

> "With approximate indexes, filtering is applied **after** the index is
> scanned. If a condition matches 10% of rows, with HNSW and the default
> `hnsw.ef_search` of 40, **only 4 rows will match on average**."

Arsitektur kita persis pola itu: satu tabel `DocumentChunk`, satu index HNSW,
difilter `organizationId`. Diukur pada 1000 vektor (900 tenant mayoritas +
100 tenant minoritas = 10%), query sebagai tenant minoritas dengan `LIMIT 10`:

```
ef_search=  40 (default) ->  5/10 baris
ef_search= 100           ->  8/10 baris
ef_search= 200           -> 10/10 baris
```

**Kontrak retrieval kita rusak.** `rag-retrieval.ts:231` meminta
`poolSize = Math.max(topK * 8, 24)` kandidat — 8× lipat, untuk memberi ruang
peringkat RRF. Saat tenant sedang minoritas, pgvector mengembalikan **sekitar
seperdelapannya**. Chunk yang seharusnya menempati peringkat 6–10 **tidak pernah
dilihat**, tanpa error dan tanpa peringatan. Fusion menganggap yang diterima
adalah seluruh kandidat.

Dan ini bukan sekadar kehilangan recall acak — **satu tenant yang ramai
menurunkan recall semua tenant lain**:

> "For applications with multiple tenants, sharing an approximate index between
> tenants means vectors from one tenant can affect recall (and speed) for other
> tenants."

### Kenapa `ef_search` saja tidak cukup

`hnsw.ef_search` dibatasi maksimum **1000** (terverifikasi: nilai 4000 ditolak
`22023`). Jadi tidak ada nilai yang menjamin hasil lengkap, dan menaikkannya
memperlambat semua query.

### Obatnya (tiga pilihan, satu jelas terbaik)

| | Cara | Penilaian |
|---|---|---|
| A | Naikkan `ef_search` | **Tidak cukup** — masih aproksimasi, dibatasi 1000 |
| B | Partisi tabel per tenant | Benar jangka panjang; butuh migrasi data |
| C | **pgvector 0.8.0+ `iterative_scan`** | **Terbaik sekarang** |

Dokumentasi 0.8.0: *"iterative index scans, which will automatically scan more
of the index until enough results are found."* Persis masalah kita.

```sql
SET LOCAL hnsw.iterative_scan = relaxed_order;   -- satu baris, tanpa migrasi
```

`relaxed_order` memberi recall lebih baik; urutan ketat bisa dipulihkan dengan
materialized CTE bila diperlukan.

### Versi sebenarnya

Terpasang **0.6.0** (Januari 2024). Terbaru **0.8.6** (Juli 2026). Tertinggal
~20 rilis, dan rilis yang kita butuhkan (0.8.0, Okt 2024) sudah ada **dua tahun**.

Catatan prosedur upgrade: `ALTER EXTENSION vector UPDATE;` setelah paket baru
terpasang. Index HNSW **tidak** perlu dibangun ulang untuk fitur ini.

### Batas yang saya ketahui

Pengukuran ini memakai tabel sintetis 3 dimensi, bukan korpus nyata, karena
korpus dev hanya 2 chunk — pada skala itu planner Postgres memakai sequential
scan dan HNSW tidak terpakai. Angka 5/10 di atas adalah **perilaku pgvector pada
konfigurasi 10%**, yang persis cocok dengan kasus produksi Anda. Yang belum saya
ukur: berapa banyak recall yang benar-benar hilang pada korpus Anda yang nyata.

## R3 — Kegagalan retrieval tanpa jejak yang terlihat

Ketiga jalur retrieval gagal dengan **cara yang benar** (mengembalikan kosong,
tidak melempar). Itu pilihan desain yang bagus untuk ketahanan.

Tapi konsekuensinya: sistem kehilangan kemampuan terbaiknya dan **tidak ada
yang terlihat dari luar.** Tidak ada penanda di UI, tidak ada peringatan di
Monitoring. Operator hanya tahu kalau jawabannya mulai buruk.

**Rekomendasi:** hitung cakupan retrieval per organisasi (berapa persen chunk
punya `embedding` dan `tsv` yang cocok dengan model aktif), lalu tampilkan di
halaman Monitoring dengan warna peringatan bila di bawah ambang. Ini murah,
dan mengubah kegagalan senyap menjadi sinyal yang terlihat.

---

---

## Stack saat ini (terukur)

| Komponen | Versi | Catatan |
|---|---|---|
| Next.js | 16.1.1 | App Router + Turbopack |
| React | 19.0.0 | |
| TypeScript | 5.x | |
| Prisma | 6.11.1 | |
| PostgreSQL | 16.15 | |
| pgvector | **0.6.0** | 0.8.0 tersedia |
| pg_trgm | terpasang | |
| BullMQ / ioredis | 5.81.2 / 5.11.1 | |
| Bun | 1.3.14 | runtime |
| Node | 22.23.2 | build |

Versi-versi inti sudah modern. Yang tertinggal justru **pgvector** — dan
itulah satu-satunya komponen yang menyentuh kualitas jawaban secara langsung.

---

## Yang sengaja TIDAK saya rekomendasikan

- Pelacakan biaya per-tenant, metering token, tingkatan langganan. Tidak
  relevan: on-prem + BYOK + lisensi bertanda tangan.
- Mengganti pgvector dengan vector DB terpisah. Satu database lebih sederhana
  untuk instalasi on-prem, dan masalah nyatanya adalah versi + data, bukan
  engine.
- Menambah model reranking. Uji sebelumnya menunjukkan masalah utama ada di
  data yang kosong, bukan di kualitas kandidat. Ukur ulang setelah R1.

---

## Catatan metode — dan dua koreksi saya

### Kesalahan 1: saya menghapus data tanpa perlu
Saat membersihkan organisasi probe, saya ikut menghapus organisasi uji
"E2E Fix Verification" berisi 500 chunk. Itu data uji buatan sesi ini, bukan
data pelanggan, dan organisasi dev asli tidak tersentuh. Tetap saja
penghapusannya tidak perlu. Saya periksa ulang: organisasi dev (`valid`)
utuh dengan 2 chunk, vektor + tsv terisi.

### Kesalahan 2 (lebih serius): saya menilai temuan tanpa memeriksa konteks
Saya menyajikan R1 sebagai "temuan besar: RAG berjalan di BM25 saja", lalu
menjalankan perbaikan dan melaporkan "RAG hidup kembali". Dua hal yang saya
lewatkan:

- 502 chunk itu **data uji buatan saya sendiri**, bukan korpus nyata (korpus
  dev sesungguhnya 2 chunk).
- Perbaikan saya memakai **server embedding buatan saya sendiri**
  (`tools/local-embeddings/server.py`) yang tidak di-track git dan tidak
  dirujuk `src/` sama sekali.

Jadi yang saya kerjakan adalah menghidupkan data uji di atas infrastruktur
saya sendiri. Itu bukan perbaikan produk. Saya sudah menurunkan R1 dan
menuliskan koreksinya di tempat, bukan menghapusnya.

Pelajaran yang berlaku untuk audit berikutnya: **sebelum menyebut sesuatu
"temuan", pastikan dulu datanya nyata dan bukan artefak uji saya sendiri.**

### Koreksi atas koreksi itu (penting)
Karena kehati-hatian berlebihan setelah kesalahan di atas, saya sempat
menurunkan R2 (HNSW) menjadi "risiko teoretis, tidak terbukti" — padahal
**itu memang bug nyata**. Saya gagal mereproduksinya karena memakai sampel
yang salah (3 vektor minoritas dari 503, bukan 10%).

Jadi dua kesalahan saya berlawanan arah dan keduanya punya akar yang sama:
**saya menyimpulkan sebelum mengukur pada konfigurasi yang benar.** Yang benar
bukan "lebih hati-hati" atau "lebih berani", melainkan: ukur dengan parameter
yang sesuai dengan kondisi produksi, lalu laporkan angkanya.

R2 kini berdiri di atas angka resmi pgvector + pengukuran ulang yang cocok
(5/10 baris pada `ef_search` default).

### Batas riset ini
- `web_search` tetap tidak berfungsi (HTTP 404), tetapi `web_fetch` BERHASIL.
  R2 karena itu bersumber dari dokumentasi resmi pgvector:
  `raw.githubusercontent.com/pgvector/pgvector/master/README.md` dan
  `CHANGELOG.md`. Klaim versi (0.8.0 Okt 2024 menambahkan iterative index
  scans; terbaru 0.8.6 Jul 2026) **terverifikasi dari changelog resmi**, bukan
  dari ingatan saya.
- Semua angka berasal dari database lokal + server embedding lokal. Tidak ada
  pengukuran pada instalasi pelanggan.
- Halaman ini tidak mengubah penilaian 95/100 sebelumnya; itu tetap
  **diturunkan sendiri**, bukan diverifikasi pihak ketiga.

### Cara memverifikasi ulang
```bash
bun trial/74-all-dead.ts              # cakupan embedding/tsv per jalur
bun trial/88-verify-dev.ts            # retrieval org dev (vektor + FTS)
bun trial/90-multitenant-recall.ts    # reproduksi angka resmi pgvector
bun trial/91-impact-proof.ts          # dampak: 5/10 baris pada default
```
