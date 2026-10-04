# Repository audit — 2026-10-04

Audit terhadap HEAD `184d85f` beserta perubahan working tree yang sudah ada. Tidak ada perbaikan kode dalam audit ini. Penilaian meliputi pembacaan lintas domain, pemeriksaan statis, unit suite resmi dan probe terisolasi tanpa perubahan database aplikasi.

Rating merupakan penilaian engineering, bukan persentase fitur atau sertifikasi keamanan. Skala: 9–10 membutuhkan bukti operasional dan pengujian independen yang kuat; 7–8 menunjukkan fondasi baik dengan kekurangan nyata; 5–6 menunjukkan kelemahan penting. Ketidaktersediaan bukti produksi membatasi rating, tetapi tidak membuktikan fitur gagal.

## Rating per domain

| Domain | Rating /10 | Dasar dan pembatas |
|---|---:|---|
| Arsitektur dan maintainability | 7.5 | Modul shared, tenant extension dan invariant jelas; real-connectors 1.239 baris, AI 1.046, settings view 1.196 meningkatkan beban review. Ukuran bukan bukti defect. |
| Isolasi tenant dan otorisasi | 8.0 | Runtime menolak konteks hilang, scoped unique reads dan foreign predicates; raw SQL serta nested relations tetap membutuhkan ownership manual. Tidak dilakukan pentest independen. |
| Autentikasi dan sesi | 6.5 | Scrypt, HMAC cookie dan session version; idle timeout dapat dilewati setelah key Redis expired. |
| Lisensi dan BYOK | 5.5 | Konfigurasi BYOK per-org dan signed validation tersedia; register menerbitkan sesi untuk status `none`, yang tidak dikunci gate. |
| RAG dan kualitas jawaban | 7.5 | Tenant-local lexical statistics, hybrid retrieval, diversity dan reranking memiliki test; belum ada evaluasi customer corpus dengan judge independen pada audit ini. |
| Text-to-SQL dan konektor | 8.0 | Driver statis, deny-list, query timeout dan read-only defenses; akurasi terhadap schema/provider pelanggan belum diukur. |
| Ingestion dan knowledge lifecycle | 7.0 | Batas upload/chunk, status cognify dan parser lossless-or-empty; real PDF → embedding → cognify → jawaban bercitation belum dijalankan. |
| Database, migrasi dan durability | 5.5 | Baseline migration, private atomic backup dan transactional restore dirancang baik; transfer restore terbukti dapat mengirim SQL kosong sambil mengembalikan sukses. |
| Deployment dan supply chain | 7.0 | Bun dipin, standalone tracing dan e2e dev/prod di CI; build/publish workflow tidak bergantung langsung pada keberhasilan CI atau live eval. Audit CVE dan image release tidak dijalankan. |
| Testing dan quality gates | 8.0 | Runner per-file, 327 file dan invariant suite; satu kegagalan restore nyata, test DNS bergantung lingkungan, tiga route tanpa test yang terdeteksi script. Coverage belum diukur ulang. |
| Frontend, UX dan accessibility | 7.0 | shadcn primitives dan e2e alur utama/mobile tersedia; belum ada audit browser visual, keyboard menyeluruh atau screen reader pada sesi ini. |
| Performance dan scalability | 6.0 | Concurrency/candidate limits dan benchmark latency tersedia; proxy membaca respons penuh sebelum truncation, belum ada load test hardware sasaran. |
| Observability dan operasi | 6.0 | Metrics, audit log dan dashboard tersedia; token-only Prometheus scrape tertahan middleware. Alert delivery dan outage drills belum diuji. |
| API, integrasi dan SDK | 7.5 | Typed errors, API-key auth dan Fetch SDK; proxy response limit serta test route masih perlu diperkuat. Compatibility matrix consumer belum diuji. |
| Dokumentasi dan onboarding | 7.0 | Referensi dan prosedur cukup luas; readiness berbeda dari hasil audit baru, architecture reference memuat deskripsi SDK/test inventory historis. Instalasi fresh machine belum diuji. |

Rata-rata sederhana: **6.9/10** setelah pembulatan satu desimal. Tidak berbobot; blocker lisensi dan restore tetap harus diselesaikan sebelum menganggap repo siap rilis, terlepas dari rata-rata.

## Temuan prioritas

### P1 — Restore bisa sukses dengan SQL kosong

Lokasi: `src/lib/postgres-backup.ts:75`, `src/lib/postgres-backup.test.ts:54`.

`decoded.on('data', ...)` dipasang sebelum pipeline ke stdin proses psql. Pada eksekusi Bun 1.4.2 yang diuji, aliran terhitung sebagai berisi byte tetapi penerima mendapatkan string kosong. Test gagal baik dalam suite resmi maupun saat dijalankan sendiri. Probe lain memakai executable Python untuk menerima stdin, sehingga hasil tidak hanya berasal dari mock Bun stdin: penerima tetap mendapat `""`, sementara `restorePostgres` resolve.

Dampak: restore dapat melaporkan selesai tanpa memulihkan data. Perbaikan: hitung byte melalui Transform di dalam pipeline, lalu ulangi populated real-Postgres backup/restore dan bandingkan isi/row counts. Periksa juga listener byte counter pada jalur backup terhadap pola yang sama; audit ini tidak membuktikan backup mengalami kehilangan byte.

### P1 — Registrasi tanpa aktivasi lolos gate lisensi

Lokasi: `src/app/api/auth/register/route.ts:50`, `src/lib/license-client.ts:207`, `src/lib/session.ts:172`.

Register membuat organisasi dengan `licenseStatus: 'none'` dan menerbitkan signed session. `getLockdownReason('none', null)` menghasilkan `null`. Chat-session route hanya memanggil auth/license gate tersebut dan tidak memeriksa aktivasi atau setup completion. Test yang ada justru mematok `none → null` dan register → `none`.

Dampak berdasarkan penelusuran kode: akun pending tidak diblokir oleh gate lisensi pada API yang mengandalkannya. Ini bertentangan dengan model signed entitlement. Probe mengeksekusi predicate asli dan mengonfirmasi `null`; end-to-end akun baru terhadap database tidak dijalankan. Perbaikan harus mempertahankan akses terbatas untuk setup, aktivasi dan pembelian, sambil menolak pekerjaan produk bagi akun pending. Jangan menjadikan UI activation screen sebagai kontrol akses.

### P2 — Idle timeout sesi kehilangan bukti ketika TTL habis

Lokasi: `src/lib/session.ts:69–86`.

Activity timestamp diberi TTL yang sama dengan timeout 30 menit. Setelah idle melebihi batas itu, Redis menghapus key; `if (!last) return false` memperbolehkan sesi, lalu aktivitas diperbarui. Probe terhadap function body asli dengan Redis key hilang menghasilkan `false` (tidak expired). Tidak dilakukan penantian 30 menit dengan Redis nyata.

Perbaikan: simpan timestamp melampaui masa timeout atau gunakan expiry sesi yang bisa diverifikasi saat key hilang. Bedakan first request dari sesi yang catatan aktivitasnya expired; tambah test melewati batas TTL.

### P2 — Scrape Prometheus dengan token tertahan middleware

Lokasi: `src/middleware.ts:40`, `src/middleware.ts:208–214`, `src/app/api/metrics/route.ts:53`.

Handler mendukung METRICS_TOKEN, tetapi `/api/metrics` tidak termasuk public middleware paths. Request Bearer tanpa cookie dihentikan sebelum handler memverifikasi token. Probe memanggil middleware asli dengan NextRequest token-only dan mendapat HTTP 401. Token fixture tidak perlu valid untuk menunjukkan bahwa request tidak diteruskan ke handler.

Perbaikan: teruskan path metrics melalui middleware, dengan autentikasi tetap diwajibkan handler; verifikasi token valid, invalid, hilang, serta mode admin-session.

### P2 — Batas respons proxy diterapkan setelah seluruh body dibaca

Lokasi: `src/app/api/integration-api/test/route.ts:104`.

`response.text()` membaca seluruh respons sebelum `.slice(0, 200000)`. Batas hanya membatasi payload yang dikembalikan, bukan penggunaan memori. Kegagalan membaca body diubah menjadi string kosong, sehingga respons HTTP upstream yang sukses bisa menghasilkan `ok: true` dengan body hilang.

Temuan berasal dari kode, tanpa simulasi respons besar. Perbaikan: batasi byte saat streaming, hentikan pembacaan saat batas tercapai dan laporkan truncation/read failure secara eksplisit. Route sudah admin-only; itu membatasi pihak yang bisa memicu, tetapi tidak membatasi ukuran respons upstream.

## Pemeriksaan yang dijalankan

Hasil berikut berasal dari invocation terpisah, bukan satu combined gate:

| Pemeriksaan | Hasil | Exit |
|---|---|---:|
| `bun run test` | 327/327 file; 8.010 pass, 2 fail, 82 skip | 1 |
| `bunx tsc --noEmit` | Tidak ada error | 0 |
| `bun run lint` | 0 error, 173 warning | 0 |
| `bun test src/lib/invariants.test.ts` | 55 pass, 0 fail | 0 |
| `bun test src/lib/postgres-backup.test.ts` | 7 pass, 1 fail; penerima SQL kosong | 1 |
| Plugin suite di luar sandbox dengan env runner resmi | 61 pass, 0 fail | 0 |
| `python3 scripts/audit-route-tests.py` | 101 route; 92 test berdampingan, 6 referensi URL, 3 orphan | 0 |
| `bun run coverage:gate` | 212 module floors lolos memakai coverage-summary yang sudah ada | 0 |
| Probe penerima Python dan session predicate | SQL kosong; key sesi hilang tidak expired | 0 |
| Probe middleware metrics | HTTP 401 tanpa cookie | 0 |
| Probe license predicate | Pending `none` menghasilkan lockdown `null` | 0 |

Kegagalan plugin pada suite resmi berada pada hostname `localtest.me` yang membutuhkan DNS publik. Dengan akses DNS di luar sandbox dan `LLM_ALLOWED_HOSTS=`, `LLM_ALLOW_BLOCKED_HOSTS=`, `E2E_TEST_MODE=` sesuai runner resmi, file lulus. Rerun awal yang belum membersihkan allowlist lokal gagal pada tiga test internal-host; hasil itu tidak sebanding dengan runner resmi. Kegagalan DNS tidak diklaim sebagai exploit SSRF terkonfirmasi. DNS-failure branch pada guard memang fail-open; rebinding/connection address pinning masih membutuhkan audit khusus.

Route yang script identifikasi tanpa test: `auth/activate-license`, `integration-api/test`, `integrations/[id]/init-context`. Deteksi berdasarkan file dan referensi URL, bukan bukti bahwa semua route lain mempunyai test behavioral yang memadai.

`python3 scripts/audit-test-holders.py` juga dijalankan dan menghasilkan kandidat heuristic; kandidat tersebut tidak dipakai sebagai jumlah defect karena banyak variabel lokal muncul sebagai false positive. `python3 scripts/coverage-honest.py` tanpa argumen gagal dengan IndexError; script ternyata memerlukan target dan daftar test, jadi bukan global audit command yang siap dijalankan langsung dari package script.

Coverage-summary yang tersedia mencatat 75.51% lines dan 89.46% functions. Itu **artefak sebelumnya**, bukan coverage fresh audit ini. Demikian juga build, e2e dev/prod, live tenant dan restore results pada `docs/quality-readiness.md` merupakan laporan historis yang belum direproduksi di sini. Perbedaan hasil restore harus diselesaikan, bukan ditutupi dengan angka lama.

Tidak dilakukan: production build/e2e baru, reset/restore database aplikasi, live provider quality eval, real-PDF cognify/citation, load test, dependency advisory scan, git-history secret scan, penetration test, audit visual/WCAG atau release-image pull. Scan pola credential pada source tidak mengungkap credential nyata dari pola yang diperiksa; ini bukan jaminan bebas secret. Tidak ada guard baru yang dibuat atau negative-controlled dalam audit ini, sehingga invariant pass tidak dinyatakan sebagai bukti semua guard kebal terhadap mutasi.

## Urutan tindak lanjut

1. Perbaiki transfer restore dan buktikan pemulihan database berisi data pada Bun yang dipin.
2. Tutup jalur pending-license dan perbaiki idle expiry, dengan test perilaku pada consumer.
3. Perbaiki routing metrics serta streaming limit/error proxy.
4. Jalankan ulang suite, ukur coverage fresh, build, e2e dev dan production.
5. Lengkapi bukti eksternal: real PDF, reviewed live RAG/SQL cases, load test, restore drill, dan aksesibilitas.

Tidak ada rekomendasi metering, billing token atau penghapusan multi-tenancy: model produk tetap on-prem, signed flat license dan BYOK.
