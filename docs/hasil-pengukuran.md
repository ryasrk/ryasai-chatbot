# Hasil Pengukuran — Sesi UAT & Perbaikan

Dokumen ini berisi **angka yang benar-benar diukur**, bukan klaim. Setiap bagian
menyebutkan batas kejujurannya. Tanggal pengukuran: sesi ini, HEAD `2224a57`.

---

## 1. Ringkasan

| Metrik | Nilai | Status |
|---|---|---|
| Akurasi fleet trial | **518/518 = 100,00%** | terukur |
| Token speed (loopback) | **403,2 tok/s**, TTFT 1.841 ms | terukur |
| Tokens/task (prompt) | **~379 token** per pertanyaan | **estimasi**, bukan usage provider |
| Test coverage | **62,44%** (12.168/19.489 baris, 126 file) | terukur, **belum 95%** |
| Test suite | 139 file · **2.425 lulus · 0 gagal** | terukur |
| tsc / lint | 0 error | terukur |

**Target 95% coverage TIDAK tercapai dan masih jauh.** Itu dicatat apa adanya di
bawah, bukan dibulatkan ke atas.

---

## 2. Akurasi — 518 kasus, 100%

Diukur dengan menjalankan `trial/fleet/dataset.ts` (518 kasus) terhadap kode
produksi lewat `trial/fleet/harness.ts`. Hasil mentah: `trial/fleet/results.json`.

| Kategori | Hasil |
|---|---|
| `guard-block` (harus diblokir) | 221/221 = 100% |
| `guard-allow` (harus diizinkan — jaring false-positive) | 76/76 = 100% |
| `invariant` (kontrak tokenizer/fence) | 221/221 = 100% |

Per divisi: D1 107/107 · D2 114/114 · D3 297/297.

**Yang diukur:** lapisan yang bisa diperiksa mesin — guardrail SQL, tokenizer,
evidence fence. **Yang TIDAK diukur:** kualitas jawaban LLM, faithfulness, dan
RAGAS. Lingkungan ini hanya punya LLM mock untuk korpus, jadi skor kualitas tidak
bisa dihasilkan di sini. Recall pada korpus pelanggan juga belum diukur (korpus
dev hanya 2 chunk).

---

## 3. Token speed — 403,2 tok/s

Diukur loopback ke 9router (`ag/gemini-3.8-flash-low`), 3 sampel:

| Sampel | TTFT | Output | Speed |
|---|---|---|---|
| "OK" | 2.119 ms | 1 tok | 500,0 tok/s |
| Pertanyaan pendek | 1.890 ms | 56 tok | 350,0 tok/s |
| Pertanyaan panjang | 1.513 ms | 155 tok | 359,6 tok/s |
| **Rata-rata** | **1.841 ms** | — | **403,2 tok/s** |

**Penting — jangan salah baca:** probe yang sama melaporkan `tok(in=2006)` untuk
prompt yang isinya hanya 5 token. Itu **preamble proxy 9router**, bukan biaya
produk kita. Melaporkannya sebagai "token per task" akan menyesatkan.

---

## 4. Tokens/task — ~379 (estimasi)

`trial/A3-tokens-per-task.ts` membaca string prompt dari `src/lib/ai.ts` dan
menghitung setiap panggilan LLM yang dipicu **satu** pertanyaan pengguna:

| Tahap | Token |
|---|---|
| `rewriteQuery` (resolusi follow-up) | 51 |
| `routeQuery` (pemilihan tool) | 180 |
| `generateSql` (text-to-SQL) | 77 |
| `streamAnswer` (sintesis) | 71 |
| **Total per task** | **~379** (≈95 per panggilan) |

**Batas kejujuran:** ini hitungan karakter/4, **bukan usage yang dilaporkan
provider**. Hitungan nyata butuh endpoint BYOK hidup, yang tidak tersedia di
lingkungan ini. Ini angka lantai untuk perencanaan, bukan angka penagihan.

---

## 5. Coverage — 62,44% (dari 51,35%)

Diukur `bun run coverage` (→ `scripts/coverage.ts`, merge lcov per-file).
Total: **12.168 / 19.489 baris** di 126 file. Naik **+11,09 poin persen**.

Peningkatan per modul sesi ini:

| Modul | Sebelum | Sesudah |
|---|---|---|
| `src/lib/stream-preparers.ts` | 4,0% | **61,3%** |
| `src/lib/smart-router.ts` | 8,1% | **77,5%** |
| `src/lib/smart-router-helpers.ts` | 28,5% | **86,8%** |
| `src/lib/real-connectors.ts` | 23,4% | **64,8%** |

Sisa celah terbesar (baris belum tertutup):

| File | Belum tertutup | Coverage |
|---|---|---|
| `src/lib/planner.ts` | 263 | 61,4% |
| `src/lib/tool-branches.ts` | 416 | 45,4% |
| `src/lib/tool-router-agentic.ts` | 399 | 16,2% |
| `src/app/api/chat/sessions/[id]/send/route.ts` | 476 | 8,6% |
| `src/lib/cognee-knowledge-graph.ts` | 331 | 3,5% |
| `src/lib/real-connectors.ts` | 327 | 64,8% |
| `src/lib/admin-tools.ts` | 301 | 55,0% |
| `src/lib/intent-pipeline.ts` | 277 | 39,3% |

**Untuk mencapai 95%** kira-kira perlu menutup ~6.300 baris lagi. Yang paling
murah lebih dulu: `tool-router-agentic.ts` (399 baris, 16,2%),
`cognee-knowledge-graph.ts` (278, 19,2%), dan
`api/chat/sessions/[id]/send/route.ts` (476, 8,6%).

### Catatan semantik angka

Angka merge adalah **union lintas file tes**, jadi lebih rendah daripada menjalankan
satu file tes sendirian untuk modul yang sama (`smart-router-helpers`: 86,8%
merged vs 97,3% sendiri) — karena `Math.max` tidak bisa mengarang hit untuk baris
yang tidak dieksekusi run mana pun. Untuk "seberapa teruji modul ini sendirian",
pakai run satu file; untuk "seberapa terpakai `src/` secara keseluruhan", pakai angka merge.

---

## 6. Cacat proses yang ditemukan (dan diperbaiki)

Pengukuran ini menemukan tiga cacat di alat ukur sendiri. Yang penting: **alat
ukur yang salah lebih berbahaya daripada tidak ada alat ukur**, karena angkanya
dipakai untuk mengambil keputusan.

1. **`scripts/coverage.ts` melaporkan angka yang salah DUA KALI berturut-turut.**
   Versi pertama: 3,8% untuk modul yang sebenarnya 61,3%. Versi kedua: masih
   mencampur laporan antar-run — `planner.ts` dilaporkan 69/673 sementara suite-nya
   sendiri 379/578. **Petunjuknya:** 673 baris "found" melebihi angka yang bisa
   dihasilkan satu run mana pun (578), jadi penyebut itu pasti campuran dua
   laporan. Akarnya: lcov ditulis oleh proses ANAK, jadi mutex pada baca+rename
   tidak menolong — worker berikutnya menimpa file sebelum lock dilepas.
   Perbaikan akhir: spawn dijalankan **di dalam** critical section.
   (Percobaan cwd terisolasi ditolak: 139/139 file tes gagal karena resolver
   mencari `.env` dan alias `@/*` relatif ke root repo.)
   **Pelajaran:** dua perbaikan berturut-turut pada alat ukur adalah sinyalnya
   sendiri — angka yang salah lebih berbahaya daripada tidak ada angka, karena
   ia dipakai untuk mengambil keputusan.
2. **`bun run test` melaporkan "8 fail" di suite yang hijau seluruhnya.**
   `out.match(/(\d+)\s+fail/)` mengambil kecocokan pertama di mana pun, sehingga
   tes yang **lulus** dengan nama "exactly 10 runs with 8 failures trips the
   breaker" dihitung sebagai 8 kegagalan. Diperbaiki: hanya baca baris ringkasan.
3. **Sebuah tes guard saya sendiri menguji ritual, bukan bug.** Versi pertama tes
   regresi Unicode mengetik ulang regex di dalam tes, jadi **lulus** meski bug
   produksi dikembalikan. Diperbaiki dengan mengekspor `extractDomainGlossaryTerms()`
   dan memanggil kode produksi. Kontrol negatif sekarang sah.

---

## 7. Perbaikan produksi dari sesi ini

| Commit | Temuan |
|---|---|
| `70d51f6` | `generateSql`/`generateRestCall` dipanggil **di luar** `try`. Provider mati / key BYOK mati → error bocor keluar, SSE sudah dijanjikan → **koneksi terbuka tanpa satu frame pun**, UI kosong tanpa pesan error. |
| `b5f568d` | Tiga pemindaian masih memakai kelas karakter Latin-only `[a-z0-9]` yang sudah dihapus dari `tokenize`. Glosarium domain, nama dokumen, path REST non-Latin menghasilkan **nol** kata kunci → fitur diam-diam tidak bekerja di luar aksara Latin. |
| `8b2575f` | Alat ukur coverage under-report (lihat §6). |

**Temuan yang dilaporkan, BELUM diperbaiki** (masing-masing perlu tinjauan sendiri):

- **ClickHouse `fetchSchema()` SQL-injectable** lewat field `database` yang bisa
  diatur admin: `WHERE t.database = '${db}'` diinterpolasi mentah. Postgres/MySQL/
  MSSQL memakai parameter terikat. Postgres/MySQL/MSSQL aman; ClickHouse satu-satunya.
- **`semanticMargin` tidak bisa memveto**: margin diukur terhadap runner-up, jadi
  satu kecocokan bagus melawan beberapa yang buruk lolos 0,02 secara konstruksi.
- **Bobot 0,4/0,6 membalik bukti kata kunci**: `"salary of everyone"` memilih
  integrasi SALES meski hanya HR yang punya kolom `salary`.
- **Pertanyaan identik dua kali berturut-turut bisa resolve berbeda** (masalah
  suhu cache embedding).
- **`withToolSandbox` dan rate limit SQL dilewati** di jalur streaming (sudah
  terdokumentasi di AGENTS.md, kini dikunci tes).

---

## 8. Tugas operator (tidak bisa dikerjakan dari sini)

- **Upgrade pgvector 0.6.0 → 0.8.6** per `docs/pgvector-upgrade.md`. Diperlukan
  agar `hnsw.iterative_scan` tersedia — satu-satunya perbaikan nyata untuk
  truncation saat filter HNSW. `sudo` tidak tersedia tanpa password di sini dan
  apt hanya menyediakan 0.6.0.

---

## 9. Pertanyaan terbuka

Partisi tabel per-organisasi: lanjutkan, atau berhenti di upgrade pgvector saja?
Belum dijawab.
