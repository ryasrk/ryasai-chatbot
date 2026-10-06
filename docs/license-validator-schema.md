# Database Schema — ryasai License Validator

Dokumentasi skema database untuk **`ryasai-LicenseValidator`** (engine SQLite via `node:sqlite` pada `/data/license.db`).

---

## 1. Diagram Relasi Entitas (ERD)

```
┌─────────────────────────────────┐
│           admin_users           │
├─────────────────────────────────┤
│ id (PK)                         │
│ email (UQ)                      │
│ password_hash                   │
│ is_active                       │
│ created_at                      │
└─────────────────────────────────┘

┌─────────────────────────────────┐        1:N        ┌─────────────────────────────────┐
│            licenses             │ ───────────────── │       machine_activations       │
├─────────────────────────────────┤                   ├─────────────────────────────────┤
│ id (PK)                         │                   │ id (PK)                         │
│ license_key (UQ, IX)            │                   │ license_id (FK -> licenses.id)  │
│ customer_name                   │                   │ machine_id                      │
│ customer_email                  │                   │ hostname                        │
│ plan                            │                   │ os_info                         │
│ product                         │                   │ ip_address                      │
│ slug (IX)                       │                   │ first_seen                      │
│ max_machines                    │                   │ last_seen                       │
│ is_active                       │                   │ is_active                       │
│ expires_at                      │                   └─────────────────────────────────┘
│ created_at                      │
│ updated_at                      │        1:N        ┌─────────────────────────────────┐
│ notes                           │ ───────────────── │         validation_logs         │
└─────────────────────────────────┘                   ├─────────────────────────────────┤
                                                      │ id (PK)                         │
                                                      │ license_id (FK -> licenses.id)  │
                                                      │ license_key                     │
                                                      │ machine_id                      │
                                                      │ result                          │
                                                      │ ip_address                      │
                                                      │ timestamp                       │
                                                      │ metadata                        │
                                                      └─────────────────────────────────┘
```

---

## 2. Definisi Skema SQL (DDL)

```sql
-- ============================================================================
-- 1. Tabel Utama Lisensi (licenses)
-- Menyimpan kunci lisensi, batas kuota mesin, dan masa aktif
-- ============================================================================
CREATE TABLE IF NOT EXISTS licenses (
    id              VARCHAR(36)  NOT NULL,            -- UUID v4
    license_key     VARCHAR(64)  NOT NULL,            -- Format: PREFIX-XXXX-XXXX-XXXX
    customer_name   VARCHAR(200) NOT NULL,            -- Nama pemilik / organisasi
    customer_email  VARCHAR(200) NOT NULL,            -- Email pemilik
    plan            VARCHAR(20)  NOT NULL,            -- starter | pro | enterprise | flat
    product         VARCHAR(50)  NOT NULL DEFAULT '', -- Legacy/opsional (e.g. ryasai-chatbot, visia)
    slug            VARCHAR(100),                     -- Slug organisasi downstream (anchor perpanjangan otomatis)
    max_machines    INTEGER      DEFAULT 1,           -- Batas maksimal node mesin yang diizinkan aktif
    is_active       BOOLEAN      DEFAULT 1,           -- 1 = aktif, 0 = dinonaktifkan/revoked
    expires_at      DATETIME,                         -- Tanggal kedaluwarsa ISO 8601 (NULL = lifetime)
    created_at      DATETIME,                         -- Waktu pembuatan lisensi
    updated_at      DATETIME,                         -- Waktu pembaruan data lisensi
    notes           TEXT,                             -- Catatan admin
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_licenses_license_key ON licenses (license_key);
CREATE INDEX IF NOT EXISTS ix_licenses_slug ON licenses (slug);


-- ============================================================================
-- 2. Tabel Aktivasi Mesin (machine_activations)
-- Mencatat mesin/kontainer yang mengaktifkan lisensi
-- ============================================================================
CREATE TABLE IF NOT EXISTS machine_activations (
    id          VARCHAR(36)  NOT NULL,            -- UUID v4
    license_id  VARCHAR(36)  NOT NULL,            -- Foreign Key merujuk ke licenses.id
    machine_id  VARCHAR(64)  NOT NULL,            -- Identifier mesin stabil ({slug}:{host})
    hostname    VARCHAR(200),                     -- Nama host mesin
    os_info     VARCHAR(200),                     -- Informasi OS mesin klien
    ip_address  VARCHAR(45),                      -- IP publik/private klien saat request
    first_seen  DATETIME,                         -- Waktu aktivasi pertama kali
    last_seen   DATETIME,                         -- Waktu verifikasi heartbeat terakhir
    is_active   BOOLEAN      DEFAULT 1,           -- 1 = slot terpakai, 0 = slot telah dideaktivasi
    PRIMARY KEY (id),
    FOREIGN KEY (license_id) REFERENCES licenses (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_machine_activations_license_id ON machine_activations (license_id);


-- ============================================================================
-- 3. Tabel Riwayat Audit Validasi (validation_logs)
-- Log audit setiap kali endpoint /api/v1/license/validate dipanggil
-- ============================================================================
CREATE TABLE IF NOT EXISTS validation_logs (
    id          VARCHAR(36) NOT NULL,             -- UUID v4
    license_id  VARCHAR(36),                      -- Nullable jika kunci tidak ditemukan
    license_key VARCHAR(64) NOT NULL,             -- Kunci lisensi yang di-submit
    machine_id  VARCHAR(64) NOT NULL,             -- Machine ID yang di-submit
    result      VARCHAR(20) NOT NULL,             -- valid | invalid | inactive | expired | machine_limit
    ip_address  VARCHAR(45),                      -- IP pemanggil
    timestamp   DATETIME,                         -- Waktu percobaan validasi
    metadata    JSON,                             -- Data tambahan request
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS ix_validation_logs_license_id ON validation_logs (license_id);


-- ============================================================================
-- 4. Tabel Administrator (admin_users)
-- Akun administrator untuk login ke Dashboard License Validator
-- ============================================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id            VARCHAR(36)  NOT NULL,          -- UUID v4
    email         VARCHAR(200) NOT NULL,          -- Email login admin
    password_hash VARCHAR(200) NOT NULL,          -- Bcrypt hash (cost factor 12)
    is_active     BOOLEAN      DEFAULT 1,         -- Status keaktifan admin
    created_at    DATETIME,                       -- Waktu pembuatan akun
    PRIMARY KEY (id),
    UNIQUE (email)
);
```

---

## 3. Tipe Antarmuka TypeScript (`src/server/db.ts`)

```typescript
export interface LicenseRow {
  id: string
  license_key: string
  customer_name: string
  customer_email: string
  plan: 'starter' | 'pro' | 'enterprise' | 'flat' | string
  product: string
  slug?: string | null
  max_machines: number
  is_active: number // 1 atau 0 (SQLite boolean)
  expires_at: string | null // ISO 8601 string atau null (lifetime)
  created_at: string | null
  updated_at: string | null
  notes: string | null
}

export interface MachineActivationRow {
  id: string
  license_id: string
  machine_id: string
  hostname: string | null
  os_info: string | null
  ip_address: string | null
  first_seen: string | null
  last_seen: string | null
  is_active: number
}

export interface ValidationLogRow {
  id: string
  license_id: string | null
  license_key: string
  machine_id: string
  result: 'valid' | 'invalid' | 'inactive' | 'expired' | 'machine_limit'
  ip_address: string | null
  timestamp: string | null
  metadata?: string | null
}

export interface AdminUserRow {
  id: string
  email: string
  password_hash: string
  is_active: number
  created_at: string | null
}
```

---

## 4. Mekanisme & Kebijakan Validasi

1. **Peniadaan Pembatasan Jenis Produk (`product`):**
   - Kolom `product` tetap disimpan di tabel untuk menjaga kompatibilitas histori dan perpanjangan, namun pada saat validasi `/api/v1/license/validate`, pengecekan kecocokan produk telah ditiadakan.
   - Semua lisensi aktif divalidasi murni berdasarkan `license_key`, `is_active`, `expires_at`, dan kuota `max_machines`.
2. **Auto-Migration Kolom `slug`:**
   - Server mengecek skema secara otomatis saat boot menggunakan `PRAGMA table_info(licenses)`. Bila kolom `slug` belum ditemukan pada database warisan, query `ALTER TABLE licenses ADD COLUMN slug VARCHAR(100)` dan pembuatan index `ix_licenses_slug` dieksekusi secara otomatis.
3. **Re-identifikasi Mesin Berbasis IP:**
   - Bila sebuah kontainer klien dibuat ulang (*container recreation*) sehingga nilai `machine_id` berubah, sistem mencocokkan IP klien yang sama dengan lisensi terkait untuk memperbarui `machine_id` tanpa memakan kuota slot mesin baru.
