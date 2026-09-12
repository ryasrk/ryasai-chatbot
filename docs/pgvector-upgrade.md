# Upgrade pgvector 0.6.0 → 0.8.6 (memperbaiki recall retrieval)

## Kenapa ini perlu

`DocumentChunk` menyimpan vektor tiap organisasi dalam **satu tabel**, dengan
**satu index HNSW**, disaring `organizationId`:

```sql
WHERE embedding IS NOT NULL
  AND "organizationId" = $org
ORDER BY embedding <=> $vec
LIMIT $n
```

HNSW menerapkan `WHERE` **setelah** approximate scan-nya. Jadi scan menelusuri
graf tetangga terdekat **seluruh tabel**, lalu filter organisasi membuang hampir
semuanya. Kalau organisasi Anda minoritas di tabel itu, hasilnya bisa jauh lebih
sedikit dari `$n` — atau **nol**.

Diukur pada pgvector 0.6.0 (`trial/98`): dua tabel identik, 20.000 vektor dibagi
100 organisasi (masing-masing 1% tabel), query identik `LIMIT 20`:

```
DocumentChunk + index HNSW   ->  0 baris
Tabel sama TANPA index       -> 20 baris
ef_search = 1000 (maksimum)  ->  5 baris
```

Nol baris. Dan tidak ada error apa pun — retrieval sekadar mengembalikan sedikit
atau tidak sama sekali, lalu jawaban disusun tanpa konteks dokumen.

Dokumentasi resmi pgvector mengonfirmasi bentuk masalahnya:

> "With approximate indexes, filtering is applied *after* the index is scanned.
> If a condition matches 10% of rows, with HNSW and the default
> `hnsw.ef_search` of 40, only 4 rows will match on average."

dan bagian **Multitenancy**-nya:

> "For applications with multiple tenants, sharing an approximate index between
> tenants means vectors from one tenant can affect recall (and speed) for other
> tenants. For tenant isolation, use list partitioning or separate tables."

## Yang sudah dilakukan di kode (tanpa upgrade)

Karena 0.6.0 tidak punya `iterative_scan`, kode sekarang berbuat sebisanya:

1. **`ef_search` dinaikkan proporsional** terhadap jumlah hasil yang diminta
   (`min(max(limit * 4, 100), 1000)`), bukan dibiarkan di default 40.
2. **`iterative_scan` dideteksi, bukan diasumsikan** — `SHOW hnsw.iterative_scan`
   dijalankan sekali per proses. Pada 0.6.x GUC itu tidak ada dan akan melempar
   `42704`, jadi mengeluarkannya tanpa cek akan merusak setiap query.
3. **Hasil yang kurang dianggap GAGAL**, bukan sukses. Ini pertahanan yang
   sebenarnya: bila pgvector mengembalikan lebih sedikit dari yang diminta,
   kode jatuh ke external vector store (Qdrant/Milvus/Pinecone/Chroma) yang
   exact, dan mencatat peringatan.

Poin 3 penting dan sebelumnya salah: `pgScores.size > 0` dianggap sukses, jadi
kaki vektor yang sebagian (atau kosong) menang diam-diam dan store external
tidak pernah dicoba.

**Tapi ini hanya mitigasi.** Tanpa `iterative_scan`, recall tetap terpotong dan
`ef_search` tidak bisa menyelamatkannya (maksimum 1000, terverifikasi: nilai
4000 ditolak dengan `22023`).

## Upgrade

Butuh akses root pada server. Verifikasi dulu versi yang terpasang:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

### Opsi A — paket resmi (paling mudah)

Repo APT Ubuntu hanya menyediakan 0.6.0. Pakai repo PostgreSQL APT supaya dapat
versi terbaru:

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt update
sudo apt install -y postgresql-16-pgvector
```

### Opsi B — build dari source

```bash
sudo apt install -y postgresql-server-dev-16 build-essential
cd /tmp
git clone --branch v0.8.6 https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

Kedua opsi memerlukan `postgresql-server-dev-16` (header `postgres.h`). Pada
instalasi ini header tersebut belum ada dan tanpa sudo tidak bisa dipasang.

### Terapkan ke database

Index HNSW **tidak** perlu dibangun ulang untuk fitur ini:

```sql
ALTER EXTENSION vector UPDATE;
SELECT extversion FROM pg_extension WHERE extname = 'vector';  -- harus >= 0.8.0
```

Bila memakai Docker/compose, ganti image Postgres ke
`pgvector/pgvector:pg16-trixie` (berisi 0.8.6) lalu jalankan
`ALTER EXTENSION vector UPDATE` di database yang ada.

## Setelah upgrade

`hasIterativeScan()` akan mendeteksi dukungan dan mulai mengeluarkan:

```sql
SET LOCAL hnsw.iterative_scan = relaxed_order;
```

yang "automatically scan more of the index until enough results are found" —
persis masalah di atas. Tidak ada perubahan konfigurasi tambahan.

`relaxed_order` dipilih karena recall-nya lebih baik; urutan ketat bisa
dipulihkan bila perlu dengan materialized CTE (lihat README pgvector).

## Verifikasi

Setelah upgrade, ulangi pengukuran ini — hasilnya harus mendekati baris tanpa
index:

```bash
bun trial/98-final-proof.ts    # harus menunjukkan HNSW ~= exact
bun trial/99-efsearch-real.ts  # ef_search tidak lagi jadi faktor penentu
```

Tes regresi yang mengunci perilaku ini ada di
`src/lib/rag-hnsw-truncation.test.ts` (7 tes) dan dua guard statis di
`src/lib/invariants.test.ts`.

## Jangka panjang: partisi per organisasi

`iterative_scan` memperbaiki recall, tetapi biayanya tetap ada: setiap query
menelusuri index bersama. Dokumentasi pgvector menyarankan **list partitioning**
atau tabel terpisah untuk isolasi tenant yang sesungguhnya:

```sql
CREATE TABLE "DocumentChunk" (...) PARTITION BY LIST ("organizationId");
```

Ini bukan pekerjaan satu kali — Prisma tidak mengelola tabel terpartisi, jadi
perlu migrasi manual plus perubahan pada `ensureVectorIndexes()`. Layak
dipertimbangkan bila satu instalasi menampung banyak organisasi dengan korpus
besar. Untuk saat ini, `iterative_scan` sudah menyelesaikan masalah recall-nya.
