# UAT — Data Vector, Database, dan REST API

Dokumen ini menjelaskan cara menjalankan UAT (User Acceptance Test) untuk tiga
bidang data aplikasi, dan **apa yang benar-benar diukur** oleh tiap langkahnya.

## Prinsip

UAT di sini bukan kumpulan unit test. Setiap langkah adalah panggilan HTTP ke
aplikasi yang benar-benar berjalan, dengan urutan yang akan dilakukan seorang
operator: masuk, menghubungkan sumber data, menunggu sistem memahami sumber itu,
mengajukan pertanyaan dengan bahasa sehari-hari, lalu **membaca jawabannya dan
memeriksa angkanya**.

Konsekuensinya: langkah yang mengembalikan HTTP 200 dengan **angka yang salah**
dihitung GAGAL. Status code bukan penerimaan. Inilah sebabnya tiap langkah
mencatat apa yang "dilihat" pengguna, sehingga laporan gagal bisa dibaca orang
yang tidak mengenal kode:

```
DAPAT : 13.944.000     <- menjumlahkan pesanan yang dibatalkan
HARAP : 9.366.000      <- hanya pesanan berstatus selesai
```

## Berkas

| Berkas | Isi |
|---|---|
| `journey.ts` | Runner UAT utama — 22 langkah di tiga bidang |
| `fixtures/db-sales.sql` | Basis data Sales (8 pelanggan, 12 pesanan, 7 produk) |
| `fixtures/db-hr.sql` | Basis data HR (10 karyawan, 4 departemen, 9 cuti, 13 absensi) |
| `fixtures/db-logistics.sql` | Basis data Logistics (3 gudang, 12 stok, 8 pengiriman) |
| `fixtures/knowledge/*.md` | 9 dokumen kebijakan untuk pengetahuan vector |
| `fixtures/rest-sales.ts` | REST Sales (port 4511) |
| `fixtures/rest-hr.ts` | REST HR (port 4512) |
| `fixtures/rest-logistics.ts` | REST Logistics (port 4513) |
| `fixtures/embedding-server-real.py` | Embedding nyata (`paraphrase-multilingual-MiniLM-L12-v2`, port 4503) |
| `fixtures/embed-all.ts` | Mengisi kolom `embedding` untuk seluruh chunk |
| `results/*.json` | Hasil mentah setiap langkah, per bidang |

`db-seed.sql`, `rest-server.ts` dan `embedding-server.ts` adalah fixture UAT lama dan
**tidak lagi dipakai** `journey.ts`. Ketiganya dipertahankan sebagai catatan sejarah:
`db-seed.sql` memakai tabel `demo_*` yang namanya nyaris identik dengan skema Sales, dan
`rest-server.ts` menyajikan `/stok` serta `/orders` yang sama dengan Logistics tetapi
dengan data berbeda — keduanya membuat pemilihan sumber ambigu. Jangan dipakai untuk
pengukuran baru.

## Menyalakan lingkungan

```bash
# 1. Tiga basis data + tiga layanan REST
for D in sales hr logistics; do
  createdb uat_$D 2>/dev/null || true
  psql "postgresql://ryasai:ryasai_dev@localhost:5432/uat_$D" -f uat/fixtures/db-$D.sql
done

# 2. Layanan pendukung (port 4511/4512/4513/4503)
bun uat/fixtures/rest-sales.ts     &
bun uat/fixtures/rest-hr.ts        &
bun uat/fixtures/rest-logistics.ts &
python3 uat/fixtures/embedding-server-real.py &

# 3. Aplikasi, dengan anggaran waktu untuk model REASONING (lihat di bawah)
LLM_TIMEOUT_MS=300000 \
CHAT_OVERALL_DEADLINE_MS=600000 \
CHAT_IDLE_TIMEOUT_MS=300000 \
LLM_ALLOWED_HOSTS=127.0.0.1,127.0.0.1.nip.io \
  bun run dev

# 4. Jalankan UAT
bun uat/journey.ts --plane all --json uat/results/final.json
bun uat/journey.ts --plane vector     # hanya pengetahuan vector
bun uat/journey.ts --plane db
bun uat/journey.ts --plane rest
```

## Catatan yang tidak menyenangkan tapi penting

**Endpoint embedding adalah syarat mutlak, dan kegagalannya menyesatkan.**
Gateway model yang dipakai untuk UAT ini tidak menyediakan `/embeddings`.
Akibatnya `embeddingBaseUrl` jatuh ke `baseUrl` (gateway chat), dan seluruh jalur
RAG gagal dengan pesan `Base URL points to a blocked internal host` — pesan yang
terdengar seperti masalah SSRF, padahal masalahnya tidak ada layanan embedding.
Perbaikan sesungguhnya adalah menyediakan `fixtures/embedding-server.ts` dan
mengarahkan `LlmConfig.embeddingBaseUrl` ke sana.

**Kolom vector harus 1536 dimensi.** `prisma/schema.prisma` mendeklarasikan
`vector(384)`, sedangkan `validateEmbeddingResponse()` aplikasi menuntut 1536 dan
menolak lebar lain. Ketidakcocokan ini TIDAK memunculkan galat: aplikasi
mendeteksinya, melewati kolom vector, menyimpan `embeddingJson` saja, dan
peringatan yang sangat jelas muncul di log. Akibatnya pencarian jatuh ke
lexical-only. Untuk UAT, kolom diubah ke 1536 (lihat SQL di peringatan itu).

**Jalur antrean rebuild embedding tidak berjalan di lingkungan dev ini.**
`POST /api/documents/embeddings/rebuild` mengembalikan 200 dalam ~26 ms dan
pekerjaan masuk ke BullMQ, tetapi `redis-cli llen bull:embedding-rebuild:wait`
langsung bernilai 0 dan tidak ada vektor yang ditulis. Karena itu
`fixtures/embed-all.ts` mengisi vektor secara langsung. Yang **tidak** diukur oleh
skrip itu: klien embedding milik aplikasi sendiri. Yang diukur: chunk ada, layanan
mengembalikan satu vektor berukuran benar per input, dan kolom pgvector menerimanya.

**Model reasoning butuh anggaran waktu dan batas token yang jauh lebih besar.**
Dengan `cbcn/hy4-preview`, satu panggilan intent tanpa batas menghasilkan 6.386
token dan 121.992 ms untuk prompt 273 token — melewati tenggat obrolan 120 detik,
sehingga SEMUA pertanyaan RAG gagal sebagai timeout generik padahal dokumen sudah
terindeks dan bisa ditemukan. Ini bug nyata yang diperbaiki di
`src/lib/llm-client.ts` (lihat komit `a51db8b`); variabel lingkungan di atas tetap
diperlukan karena model reasoning memang lambat.

**Biaya waktu.** Satu pertanyaan RAG pada model ini memerlukan 1–5 menit. UAT tiga
bidang secara penuh memakan puluhan menit. Ini pengukuran yang jujur, bukan
lambatnya alat ukur.
