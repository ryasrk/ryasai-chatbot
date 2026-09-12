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
| R2 | pgvector 0.6.0, sedangkan 0.8.0 punya `iterative_scan` | Sedang | Rekomendasi |
| R3 | Jalur retrieval gagal tanpa jejak yang terlihat operator | Sedang | Rekomendasi |
| R4 | Skala HNSW + filter org: risiko teoretis, **tidak terbukti** di sini | Rendah | Tidak terbukti |

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

## R2 — pgvector 0.6.0 vs 0.8.0 (`iterative_scan`)

Versi terpasang **0.6.0** (rilis 2023). Versi 0.8.0 (2024) menambahkan
`hnsw.iterative_scan`, yang menjawab masalah asli: **filter diterapkan
SETELAH approximate scan.**

Query Anda di `src/lib/rag-retrieval.ts:365` berbentuk:

```sql
WHERE embedding IS NOT NULL
  AND "organizationId" = $org
  AND "documentId" IN (...)
ORDER BY embedding <=> $vec
LIMIT $n
```

HNSW mengambil `ef_search` kandidat terdekat dari **seluruh tabel**, baru
membuang yang bukan milik org. Kalau org Anda minoritas di tabel yang
dipakai bersama banyak tenant, hasilnya bisa lebih sedikit dari `LIMIT`
— **tanpa error apa pun.**

**Rekomendasi:** naikkan ke pgvector 0.8.0+ dan setel `hnsw.iterative_scan =
relaxed_order`. Ini satu baris dan menghilangkan seluruh kelas risiko ini.
Catat juga: `hnsw.ef_search` default 40 tidak diubah di kode Anda — untuk
korpus besar, itu layak disetel eksplisit.

---

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

## R4 — HNSW + filter org: risiko teoretis, TIDAK terbukti di sini

Saya mencoba membuktikan R2 pada data nyata: membuat organisasi mayoritas
(500 vektor) dan minoritas (3 vektor) di tabel yang sama, lalu menjalankan
query sebagai org minoritas dengan `LIMIT 10`.

**Hasilnya: 3/3 baris dikembalikan, benar.** Bahkan dengan `hnsw.ef_search`
diturunkan ke 1, hasilnya tetap lengkap — karena pada skala 503 vektor,
tetangga terdekat dari query itu memang milik org minoritas sendiri.

**Jadi saya tidak bisa mengklaim ini bug yang aktif.** Yang bisa saya
katakan: mekanismenya nyata (terdokumentasi di pgvector), skalanya belum
cukup besar untuk memicunya di sini, dan 0.8.0 menghilangkannya sepenuhnya.
Saya mencatatnya sebagai **risiko yang wajar diantisipasi**, bukan cacat.

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

### Batas riset ini
- Web search tidak tersedia (tidak ada `DEEPSEEK_API_KEY`), jadi riset
  teknologi dilakukan dari versi paket terpasang, dokumentasi lokal, dan
  pengukuran langsung — bukan dari berita terbaru. Untuk klaim "0.8.0 punya
  `iterative_scan`" saya mengandalkan pengetahuan umum, dan saya **tidak bisa
  memverifikasinya** karena 0.8.0 tidak terpasang di sini.
- Semua angka berasal dari database lokal + server embedding lokal. Tidak ada
  pengukuran pada instalasi pelanggan.
- Halaman ini tidak mengubah penilaian 95/100 sebelumnya; itu tetap
  **diturunkan sendiri**, bukan diverifikasi pihak ketiga.

### Cara memverifikasi ulang
```bash
bun trial/74-all-dead.ts        # cakupan embedding/tsv per jalur
bun trial/88-verify-dev.ts      # retrieval org dev (vektor + FTS)
```
