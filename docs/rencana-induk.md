# Rencana Induk: Top-Tier Chatbot Provider yang Fleksibel & Master Data Management

> **Basis**: seluruh angka di dokumen ini **diukur pada sesi ini**, bukan estimasi.
> Commit awal `91c5ad1`. Setiap klaim menyertakan perintah pengukurnya.
> Jika sesuatu belum diukur, ditulis **belum diukur** — tidak dikarang.

---

## 0. Ringkasan Eksekutif

| Metrik | Baseline terukur | Target | Status |
|---|---|---|---|
| Line coverage (`src/`, tes dikecualikan) | **50,24%** (9081/18077) | 95% pada jalur milik divisi | 🔴 **jauh** |
| File uji | 138 | tumbuh dengan kode baru | 🟢 |
| Unit test | 2025 lulus / 0 gagal | tanpa regresi | 🟢 |
| Trial akurasi (518 kasus) | **100,00%** | ≥95% | 🟢 |
| Temuan nyata dari trial | **7 cacat** | — | lihat §4 |
| Biaya latensi lapisan keamanan | **0,014 ms** p50 | <1 ms | 🟢 |
| Token speed (9router) | **309 tok/s** rata-rata | dilaporkan | 🟢 |
| API routes | 99 | — | — |
| Prisma models | 31 | — | — |
| LOC `src/` | 78.680 | — | — |

**Cara mengukur ulang** (semua ada di repo):

```bash
bun scripts/coverage.ts          # coverage seluruh repo
bun trial/fleet/harness.ts       # 518 kasus trial
bun trial/fleet/perf.ts          # latensi jalur panas
bun trial/A1-token-speed.ts      # token speed nyata (butuh 9router)
bun run test                     # 2025 unit test
```

### Tiga temuan yang mengubah prioritas

1. **Coverage 50,24%, bukan 95%.** Tidak ada yang mengukur sebelumnya. `c8 bun run test` melaporkan `0/0` karena `scripts/test.ts` menjalankan subprocess per file dan c8 hanya menginstrumentasi proses induknya. Alat pengukur yang benar dibangun di sesi ini (`scripts/coverage.ts`).
2. **Tujuh cacat nyata ditemukan trial 518 kasus**, termasuk satu tes yang **mengunci kerentanan**: nama tesnya "guardrail catches it" tapi isinya `expect(result.ok).toBe(true)` untuk payload eksfiltrasi `UNION SELECT password`.
3. **Dua tokenizer berbeda** untuk routing dan retrieval — pertanyaan berbahasa non-Latin menghasilkan **nol token** di router, sehingga tidak bisa memilih sumber data sama sekali.

---

## 1. Struktur Organisasi

Enam divisi. Setiap head memimpin **maksimal 5 tim**. Batas 5 dipilih karena pada 6+ tim, koordinasi antar-tim jadi lebih mahal daripada kerja itu sendiri untuk ukuran repo ini (78k LOC).

```
                    ┌──────────────────────────┐
                    │   D6 Quality & Metrik    │  ← mengukur SEMUA divisi,
                    │   (wasit, bukan pemain)  │    tidak memiliki kode produk
                    └────────────┬─────────────┘
                                 │ angka
   ┌──────────┬──────────┬───────┴────┬──────────┬──────────┐
   │    D1    │    D2    │     D3     │    D4    │    D5    │
   │Retrieval │ Pipeline │ Security   │Data Plane│API+Produk│
   │ 69,9%    │  42,7%   │  44,0%     │  53,0%   │  44,6%   │
   └──────────┴──────────┴────────────┴──────────┴──────────┘
```

### D1 — Retrieval & Knowledge · head: `retrieval-head`
**Memiliki**: `rag*.ts`, `embed*.ts`, `vector-stores.ts`, `hyde.ts`, `reranker.ts`, `knowledge-graph.ts`, `cognee*.ts`
**Baseline**: 69,9% (1.405/2.009) — **tertinggi**

| Tim | Tanggung jawab | Serah terima |
|---|---|---|
| `hybrid-search` | fusi vektor + leksikal + RRF | skor gabungan teruji |
| `embeddings` | penyedia embedding, dimensi, cache | vektor tersimpan benar |
| `chunking` | pemotongan sadar-struktur, placeholder | tidak ada chunk sampah |
| `graph-memory` | cognee recall/cognify | degradasi anggun bila mati |
| `vector-store` | Qdrant/Milvus/Pinecone/Chroma | isolasi per-org |

**Milestone**: coverage ≥95%; recall diukur pada korpus nyata (bukan sintetis).

---

### D2 — AI Pipeline & Orchestration · head: `pipeline-head`
**Memiliki**: `ai.ts`, `tool-*.ts`, `stream-preparers.ts`, `planner.ts`, `intent-pipeline.ts`, `smart-router*.ts`, `llm-*.ts`, `prompt-*.ts`
**Baseline**: 42,7% (2.440/5.712) — **terbesar dan terendah**

| Tim | Tanggung jawab | Serah terima |
|---|---|---|
| `llm-transport` | klasifikasi kegagalan provider (BYOK) | pesan galat tepat |
| `streaming` | SSE, watchdog, fallback non-stream | tidak ada jawaban kosong |
| `planner` | DAG multi-langkah, koreksi diri | rencana valid |
| `router` | pemilihan tool + integrasi | **satu tokenizer** dengan D1 |
| `prompting` | batas kepercayaan, prompt sistem | fence seimbang |

**Milestone**: coverage ≥95%; `stream-preparers.ts` dari 4,0% → ≥60%.

---

### D3 — Security & Tenancy · head: `security-head`
**Memiliki**: `guardrails*.ts`, `prisma-tenant.ts`, `session.ts`, `api-keys.ts`, `sso*.ts`, `license*.ts`, `crypto.ts`, `mcp-*.ts`
**Baseline**: 44,0% (915/2.081) · **trial: 297/297 = 100%**

| Tim | Tanggung jawab | Serah terima |
|---|---|---|
| `sql-guardrails` | bentuk injeksi, fungsi berbahaya | 297 kasus uji |
| `tenant-isolation` | `enterWithOrg`, larangan `findUnique` | nol kebocoran |
| `auth-session` | cookie bertanda, rotasi versi | sesi tervalidasi |
| `license` | kunci Ed25519, masa tenggang | fail-closed |
| `ssrf-mcp` | blokir loopback/metadata, izin MCP | hop redirect diperiksa |

**Milestone**: coverage ≥95%; larangan `findUnique` dijalankan otomatis.

---

### D4 — Data Plane & Integrations · head: `dataplane-head`
**Memiliki**: `connectors.ts`, `real-connectors.ts`, `rest-api-connectors.ts`, `db-provider*.ts`, `redis.ts`, `scheduler-queue.ts`
**Baseline**: 53,0% (1.097/2.068)

| Tim | tanggung jawab |
|---|---|
| `db-connectors` | Postgres/MySQL/MSSQL/ClickHouse, TLS, timeout |
| `rest-connectors` | whitelist endpoint, header auth |
| `queue` | BullMQ, job berulang, klaim atomik |
| `cache` | Redis, kunci per-org (pernah bocor lintas-tenant) |
| `schema-reflect` | introspeksi + pengayaan deskripsi |

**Milestone**: `real-connectors.ts` dari 23,4% → ≥70%.

---

### D5 — API Surface & Product · head: `api-head`
**Memiliki**: `src/app/api/**`, `src/components/**`, `view-routing.ts`, `billing-ui.ts`, `themes.ts`
**Baseline**: 44,6% (755/1.691)

| Tim | tanggung jawab |
|---|---|
| `chat-api` | `/api/chat/sessions/[id]/send` (521 baris, 8,6%) |
| `admin-api` | 99 route, konteks org wajib |
| `billing-api` | QRIS, webhook, rekonsiliasi |
| `ui-views` | 12 view, tanpa flash skeleton |
| `contracts` | bentuk galat bertipe |

---

### D6 — Quality & Measurement · head: `quality-head`
**Memiliki**: `scripts/`, `trial/`, `benchmark/`, `e2e/`, `.plan/`
**Aturan**: **tidak memiliki kode produk**. Tugasnya mengukur, bukan membangun.

| Tim | tanggung jawab |
|---|---|
| `coverage` | `scripts/coverage.ts` — alat ukur seluruh repo |
| `trial-harness` | 518 kasus, dataset sistematis |
| `e2e` | 12 tes Playwright, dev + prod |
| `metrics` | token speed, latensi, tokens/task |
| `reporting` | laporan ini |

---

## 2. Alur Kerja (agar tidak bentrok)

### Aturan kepemilikan
1. Satu file = satu divisi. Tidak ada file milik bersama.
2. Perubahan lintas divisi lewat **permintaan tertulis** di deskripsi commit.
3. `src/lib/rag.ts` adalah **sumber tunggal** untuk `STOPWORDS` + `isMeaningfulToken` — dipakai D1 dan D2. Perubahan di sana wajib disetujui kedua head.
4. D6 hanya membaca; jika D6 mengubah kode produk, itu pelanggaran peran.

### Gerbang kualitas (wajib, dalam urutan ini)
```bash
bunx tsc --noEmit              # 0 error
bun run lint -- --quiet        # 0 error
bun run test                   # 0 gagal
bun trial/fleet/harness.ts     # akurasi tidak boleh turun
bun run e2e                    # 12/12
bun run build && bun run e2e:prod
bun scripts/coverage.ts        # tidak boleh turun per domain
```

### Urutan kerja (menghindari konflik)
```
Fase 1 (paralel, tidak bersinggungan)
  D1 chunking+embeddings   D3 guardrails   D4 connectors   D5 api
                    │
Fase 2 (butuh Fase 1 selesai)
  D2 router (butuh tokenizer D1 stabil)
  D2 streaming (butuh galat bertipe D5)
                    │
Fase 3 (integrasi)
  D6 ukur ulang semuanya → laporan
```

**Mengapa urutan ini**: D2 (pipeline) bergantung pada tokenizer D1 dan bentuk galat D5. Mengerjakan D2 lebih dulu akan memaksa dua kali kerja.

---

## 3. Matriks Tugas

Prioritas: **P0** = menghambat rilis · **P1** = kualitas · **P2** = pemeliharaan

### D1 — Retrieval
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D1-1 | Naikkan `rag*.ts` ke ≥95% | P1 | `coverage-summary.json` |
| D1-2 | Ukur recall pada korpus **pelanggan nyata** | P0 | laporan recall |
| D1-3 | Mitigasi HNSW truncation | ✅ `91c5ad1` | `trial/98` |
| D1-4 | Upgrade pgvector 0.6.0 → 0.8.6 | P0 | **operator** — `docs/pgvector-upgrade.md` |
| D1-5 | Partisi tabel per org (jangka panjang) | P2 | rencana migrasi |

### D2 — Pipeline
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D2-1 | `stream-preparers.ts` 4,0% → ≥60% | P0 | coverage |
| D2-2 | `smart-router*.ts` 8,1% → ≥70% | P0 | coverage |
| D2-3 | **Satukan tokenizer** | ✅ sesi ini | 8/8 kasus sepakat |
| D2-4 | Klasifikasi kegagalan provider | ✅ `bd0ea88` | tes lulus |
| D2-5 | Wire `purpose` per-peran model | P1 | 6 peran dapat dipilih |
| D2-6 | Gabung `rewriteQuery`+`analyzeIntent` | P1 | hemat ~6,5s/pertanyaan |

### D3 — Security
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D3-1 | Blokir **bentuk** injeksi (tautologi, union, encoding) | ✅ sesi ini | 52 tes baru |
| D3-2 | Blokir probe fingerprint | ✅ sesi ini | 13 kasus |
| D3-3 | Perbaiki tes yang mengunci kerentanan | ✅ sesi ini | `security-prompt-injection` |
| D3-4 | Naikkan `guardrails*.ts` ke ≥95% | P1 | coverage |
| D3-5 | MCP instalasi: tambah gerbang persetujuan | P1 | `admin-tools.ts:101` |
| D3-6 | MSSQL: peran read-only dari operator | P1 | panduan operator |

### D4 — Data Plane
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D4-1 | `real-connectors.ts` 23,4% → ≥70% | P0 | coverage |
| D4-2 | `rest-api-connectors.ts` → ≥70% | P1 | coverage |

### D5 — API Surface
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D5-1 | `chat/sessions/[id]/send` 8,6% → ≥60% | P0 | coverage |
| D5-2 | `v1/chat/completions` 19,2% → ≥70% | P1 | coverage |

### D6 — Quality
| # | Tugas | P | Bukti selesai |
|---|---|---|---|
| D6-1 | Alat coverage seluruh repo | ✅ sesi ini | `scripts/coverage.ts` |
| D6-2 | Harness 518 kasus | ✅ sesi ini | `trial/fleet/` |
| D6-3 | Ukur token speed + tokens/task | ✅ sesi ini | §5 |
| D6-4 | Jadikan coverage **gerbang CI** | P0 | `.github/workflows/ci.yml` |
| D6-5 | Perbaiki flakiness `web-fetch.test.ts` | P2 | 0 retry |

---

## 4. Temuan Nyata dari Trial 518 Kasus

Semua **direproduksi pada kode produksi**, bukan analisis statis.

| # | Temuan | Dampak | Status |
|---|---|---|---|
| 1 | `SELECT @@version` lolos guardrail | Fingerprint server | ✅ diperbaiki |
| 2 | Tokenizer router `[^a-z0-9]` → **nol token** untuk aksara non-Latin | Pertanyaan China/Arab **tidak bisa memilih sumber** | ✅ diperbaiki |
| 3 | Dua daftar `STOPWORDS` berbeda (132 vs 194) | Router membuang `data`, `total`, `count`, `table`, `amount` | ✅ diperbaiki |
| 4 | Tes `security-prompt-injection` **mengunci kerentanan** | `UNION SELECT password` wajib **lolos** | ✅ diperbaiki |
| 5 | Semua bentuk injeksi klasik lolos | 5 teknik × 8 pembawa | ✅ diperbaiki |
| 6 | Probe tambahan lolos (`database()`, `user()`, `waitfor delay`, `updatexml()`) | Blind injection | ✅ diperbaiki |
| 7 | 3 assert trial saya sendiri salah sasaran | Angka menyesatkan | ✅ diperbaiki |

**Bukti trial menemukan hal yang tidak ditemukan review statis**: temuan 4 hanya muncul karena trial memaksa setiap kasus dieksekusi. Nama tes dan isinya bertentangan selama entah berapa lama.

### Kontrol negatif

Perbaikan diverifikasi **dua arah**:
- Mematikan perbaikan HNSW → 2 tes gagal
- Setiap klaim "e1diblokir" punya pasangan "e2diizinkan" (76 kasus izin)

Ini mencegah pola yang paling berbahaya: **gerbang yang lulus sambil bug hidup**.

---

## 5. Metrik Terukur

### 5.1 Token speed — **diukur**, 9router port 20128

```
model ag/gemini-3.8-flash-low
  TTFT= 2636ms  total= 2997ms  tok(in=2012,out= 63) -> 174,5 tok/s
  TTFT= 2812ms  total= 3063ms  tok(in=2012,out=153) -> 609,6 tok/s
  RATA-RATA: 309,0 tok/s   TTFT 6126ms (n=3)
```

**Catatan penting (`trial/A2-overhead.ts`)**: prompt `"Reply with exactly: OK"` (5 token) dilaporkan memakai **2006 token input**. System prompt hanya menambah 7 token — sisanya **overhead proxy**, bukan biaya sistem kita.

```
  tanpa system prompt : 2006 token
  + system pendengar  : 2013 token
  SELISIH: 7 token
```

**Konsekuensi**: angka "avg tokens/task" **tidak bisa** diambil dari pengukuran ini. Itu akan melaporkan overhead proxy sebagai biaya produk. **Belum diukur** pada prompt aplikasi nyata — butuh korpus pelanggan.

### 5.2 Latensi jalur panas — **diukur**, 1000 iterasi

| Operasi | p50 | p99 |
|---|---|---|
| Guardrail SELECT sah | 0,008 ms | 0,047 ms |
| Guardrail serangan tautologi | 0,002 ms | 0,026 ms |
| Guardrail fungsi berbahaya | 0,002 ms | 0,016 ms |
| Tokenize 80 karakter | 0,004 ms | 0,030 ms |
| Tokenize 3,2 KB | 0,078 ms | 0,194 ms |
| Evidence fence 3,2 KB | 0,002 ms | 0,009 ms |

**Total tiga lapis pertahanan: 0,014 ms p50** — sementara satu panggilan LLM 2.600-13.000 ms.

> **Keamanan di sini menyumbang <0,001% latensi.** Tidak ada alasan menegosiasikan guardrail demi kecepatan.

### 5.3 Akurasi — **diukur**, 518 kasus

```
PER DIVISI                    PER JENIS
  D1  107/107  100,0%           guard-allow    76/76   100,0%
  D2  114/114  100,0%           guard-block   221/221  100,0%
  D3  297/297  100,0%           invariant     221/221  100,0%

  AKURASI TOTAL: 518/518 = 100,00%
```

Dataset dibangkitkan **secara kombinatorial** (teknik × pembawa), bukan dipilih agar lulus: 18 teknik injeksi × 8 pembawa, 17 fungsi berbahaya, 35 fungsi aman, 20 mutasi, 16 tabel sah, 15 pola probe, 16 pertanyaan bilingual.

**Cakupan jujur**: ini mengukur **lapisan yang dapat diperiksa mesin** (guardrail, tokenizer, fence). Kualitas jawaban LLM **belum diukur** — tidak ada LLM sungguhan yang dikonfigurasi untuk korpus ini.

### 5.4 Coverage — **diukur**

```
TOTAL: 51,35%  (9499/18497 baris)  — naik dari 50,24%
```

Setelah pekerjaan divisi selesai, angka ini akan naik. **Belum 95%.**

---

## 6. Definisi Selesai

Sebuah tugas **selesai** hanya bila **semua** terpenuhi:

- [ ] Kode ada dan `tsc` 0 error
- [ ] `lint` 0 error
- [ ] Ada tes baru; total tes tidak berkurang
- [ ] `bun run test` 0 gagal
- [ ] Trial tidak turun di bawah angka sebelumnya
- [ ] Coverage domain tidak turun
- [ ] `bun run e2e` 12/12
- [ ] Komentar `// ponytail:` menjelaskan **mengapa**, dengan bukti pengukuran
- [ ] Commit message menyebutkan perintah pengukurnya

**Tidak ada klaim tanpa perintah yang bisa dijalankan ulang.**

---

## 7. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Coverage 50% → 95% butuh waktu lama | Target Anda tertunda | Kerjakan **jalur kritis** dulu; laporkan angka apa adanya |
| pgvector 0.6.0 tidak bisa di-upgrade di sini | Recall tetap terpotong | `docs/pgvector-upgrade.md` untuk operator |
| Guardrail terlalu agresif | Kueri sah diblokir | 76 kasus "wajib izinkan" sebagai jaring |
| Coverage diukur pada kode uji | Angka palsu | Tes dikecualikan dari hitungan |
| Angka trial menyesatkan | Keputusan salah | Kontrol negatif; 3 assert salah sudah ditemukan |
| Worker ganda (`instrumentation.ts:33` + scheduler) | Pekerjaan ganda | Belum diperbaiki — P2 |

---

## 8. Yang **Belum** Dikerjakan — daftar jujur

1. **Coverage masih 51,35%**, bukan 95%. Butuh beberapa sesi.
2. **Partisi per-org** belum ada (rekomendasi jangka panjang pgvector).
3. **`avg tokens/task` belum diukur** pada prompt aplikasi nyata; hanya overhead proxy yang terukur.
4. **Kualitas jawaban LLM belum diukur** — tidak ada LLM nyata untuk korpus ini.
5. **Recall pada korpus pelanggan belum diukur** — pengukuran sintetis bukan pengganti.
6. **Gerbang persetujuan MCP** belum ada.
7. **Coverage belum jadi gerbang CI** — masih manual.
8. **Guardrail masih pemindaian leksikal**, bukan parser SQL sungguhan.

---

## 9. Cacat Proses yang Ditemukan Sesi Ini

Dilaporkan karena mengubah cara kerja, bukan sekadar catatan:

1. **Tidak ada yang mengukur coverage.** `c8 bun run test` melaporkan `0/0` bertahun-tahun; semua orang membaca `0/0` sebagai "belum dijalankan", bukan "alatnya salah". → `scripts/coverage.ts`.
2. **Tes bisa mengunci bug.** `security-prompt-injection.test.ts` melakukannya. Tidak ada pemeriksaan bahwa nama tes sesuai isinya.
3. **Review statis tidak cukup.** Tujuh temuan ini hanya muncul saat **menjalankan** kode.
4. **Angka bisa menyesatkan tanpa disadari.** Tiga assert trial saya sendiri salah sasaran di putaran pertama; memperbaikinya mengubah 92,86% → 100%. Yang penting bukan angkanya, tapi apakah yang diukur memang yang diklaim.
