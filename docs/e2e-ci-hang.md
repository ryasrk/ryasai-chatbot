TEMUAN: kenapa job `e2e` CI macet 30 menit lalu dibatalkan

Reproduksi lokal dengan perintah webServer PERSIS dari playwright.config.ts:
  env DATABASE_URL=... LICENSE_VALIDATOR_URL=http://localhost:4546 ... PORT=3105 bun next dev -p 3105

Hasil: health TIDAK PERNAH 200 selama 135 detik, lalu Playwright menyerah setelah 120 detik.
Penyebab di log app:

  ⨯ Unable to acquire lock at <repo>/.next/dev/lock, is another instance of next dev running?

Dua penyebab terpisah yang saya temukan berturut-turut:

1. .next/dev CORRUPT: 952 MB, 0 file .sst, dan Turbopack PANIC:
     tokio-runtime-worker panicked ... Unable to open static sorted file 00008610.sst
     No such file or directory (os error 2)
   Ini membuat `next dev` mati sebelum melayani. Cache ini terakumulasi lokal; di CI ia dibuat
   segar, jadi CI kena masalah BERIKUTNYA.

2. LOCK .next/dev/lock: `next dev` hanya boleh SATU instance per direktori proyek. CI menjalankan
   `bun run e2e` (dev) lalu `bun run e2e:prod` (standalone) di workspace yang SAMA. Selama lock
   dari proses sebelumnya belum dilepas, instance berikutnya GAGAL START dan Playwright hanya bisa
   menunggu URL 120 detik lalu timeout. Job e2e punya timeout 30 menit.

   Bukti: lock tertinggal dari uji saya sendiri pada port berbeda (3996) tetap memblokir instance
   di port 3105 — port tidak relevan, lock berbasis direktori.

KEADAAN SEBELUM PERBAIKAN SAYA: job `lint-typecheck-test` GAGAL di "Coverage gate", sehingga job
`e2e` di-SKIP sepenuhnya (needs:). Jadi e2e TIDAK PERNAH berjalan di CI sejak 2026-09-15. Run
terakhir yang benar-benar hijau: 2026-09-15T17:51, dengan KEDUA mode e2e sukses.

Setelah perbaikan gate, e2e AKHIRNYA berjalan di CI — dan langsung mengungkap masalah lama ini.
Jadi perbaikan saya bekerja; ia menyingkap cacat yang selama 11 hari tersembunyi di balik
gate yang merah.

Catatan: e2e LOKAL lulus 16/16 dalam 2,0-2,2 menit. Kegagalan hanya terjadi pada kondisi CI
(dua mode berurutan di workspace yang sama).
