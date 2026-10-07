# Database Schema v1 — ryasai License Validator

Dokumentasi skema database v1 untuk **`ryasai-LicenseValidator`** (engine SQLite via `node:sqlite` pada `/data/license.db`).

---

## 1. Diagram Relasi Entitas (ERD)

```
license_plans ────────┐
  code (PK)           │ plan_code
                      ▼
license_statuses ──► licenses ◄──────────── license_renewals
  code (PK)   status_code   id (PK)   license_id (CASCADE)    id (PK)
                            license_key (UQ)                  reference (UQ)
                            slug (IX)
                              ▲      ▲
          license_id (CASCADE)│      │license_id (SET NULL)
                              │      │
machine_statuses ──► machine_activations     validation_logs ◄── validation_results
  code (PK)   status_code   id (PK)            id (PK)     result_code   code (PK)
                            (license_id, machine_id) UQ

admin_users   (stands alone)
```

---

## 2. Definisi Skema SQL (DDL v1)

```sql
PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. Master Tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS license_plans (
    code        VARCHAR(20) NOT NULL,             -- starter | pro | enterprise | flat
    name        VARCHAR(50) NOT NULL,             -- Label tampilan di dashboard
    description TEXT,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS license_statuses (
    code               VARCHAR(20) NOT NULL,      -- active | revoked
    name               VARCHAR(50) NOT NULL,
    description        TEXT,
    allows_validation  BOOLEAN     NOT NULL DEFAULT 1,
    sort_order         INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS machine_statuses (
    code          VARCHAR(20) NOT NULL,           -- active | deactivated | replaced | stale
    name          VARCHAR(50) NOT NULL,
    description   TEXT,
    occupies_slot BOOLEAN     NOT NULL DEFAULT 1,
    sort_order    INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS validation_results (
    code        VARCHAR(20) NOT NULL,             -- valid | invalid | inactive | expired | machine_limit | wrong_product
    name        VARCHAR(50) NOT NULL,
    description TEXT,
    is_success  BOOLEAN     NOT NULL DEFAULT 0,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (code)
);

-- ============================================================================
-- 2. Data Tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS licenses (
    id             VARCHAR(36)  NOT NULL,         -- UUID v4
    license_key    VARCHAR(64)  NOT NULL,         -- Format: RYASAI-XXXXXXXX-XXXXXXXX-XXXXXXXX
    customer_name  VARCHAR(200) NOT NULL,         -- Nama pelanggan / organisasi
    customer_email VARCHAR(200) NOT NULL,         -- Email kontak
    plan_code      VARCHAR(20)  NOT NULL DEFAULT 'starter',
    status_code    VARCHAR(20)  NOT NULL DEFAULT 'active',
    product        VARCHAR(50)  NOT NULL DEFAULT '', -- Legacy/opsional (pengecekan produk telah ditiadakan)
    slug           VARCHAR(100),                  -- Downstream organisation slug untuk perpanjangan otomatis
    max_machines   INTEGER      NOT NULL DEFAULT 1 CHECK (max_machines >= 1),
    expires_at     DATETIME,                      -- Tanggal kedaluwarsa ISO (NULL = lifetime)
    created_at     DATETIME     NOT NULL,
    updated_at     DATETIME     NOT NULL,
    notes          TEXT,
    PRIMARY KEY (id),
    FOREIGN KEY (plan_code) REFERENCES license_plans (code) ON UPDATE CASCADE,
    FOREIGN KEY (status_code) REFERENCES license_statuses (code) ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_licenses_license_key ON licenses (license_key);
CREATE INDEX IF NOT EXISTS ix_licenses_slug ON licenses (slug);
CREATE INDEX IF NOT EXISTS ix_licenses_status_code ON licenses (status_code);
CREATE INDEX IF NOT EXISTS ix_licenses_plan_code ON licenses (plan_code);

CREATE TABLE IF NOT EXISTS machine_activations (
    id                VARCHAR(36)  NOT NULL,      -- UUID v4
    license_id        VARCHAR(36)  NOT NULL,
    machine_id        VARCHAR(255) NOT NULL,      -- Identifier stabil ({slug}:{host})
    status_code       VARCHAR(20)  NOT NULL DEFAULT 'active',
    hostname          VARCHAR(200),
    os_info           VARCHAR(200),
    ip_address        VARCHAR(45),
    first_seen        DATETIME     NOT NULL,
    last_seen         DATETIME     NOT NULL,
    status_changed_at DATETIME,
    PRIMARY KEY (id),
    FOREIGN KEY (license_id) REFERENCES licenses (id) ON DELETE CASCADE,
    FOREIGN KEY (status_code) REFERENCES machine_statuses (code) ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_machine_activations_license_machine ON machine_activations (license_id, machine_id);
CREATE INDEX IF NOT EXISTS ix_machine_activations_license_id ON machine_activations (license_id);
CREATE INDEX IF NOT EXISTS ix_machine_activations_status_code ON machine_activations (status_code);
CREATE INDEX IF NOT EXISTS ix_machine_activations_ip_address ON machine_activations (ip_address);

CREATE TABLE IF NOT EXISTS validation_logs (
    id          VARCHAR(36) NOT NULL,             -- UUID v4
    license_id  VARCHAR(36),
    license_key VARCHAR(64) NOT NULL,
    machine_id  VARCHAR(255) NOT NULL,
    result_code VARCHAR(20) NOT NULL,
    ip_address  VARCHAR(45),
    timestamp   DATETIME    NOT NULL,
    metadata    JSON,                             -- Payload client (hostname, version, os_info)
    PRIMARY KEY (id),
    FOREIGN KEY (license_id) REFERENCES licenses (id) ON DELETE SET NULL,
    FOREIGN KEY (result_code) REFERENCES validation_results (code) ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_validation_logs_license_id ON validation_logs (license_id);
CREATE INDEX IF NOT EXISTS ix_validation_logs_timestamp ON validation_logs (timestamp);
CREATE INDEX IF NOT EXISTS ix_validation_logs_result_code ON validation_logs (result_code);

CREATE TABLE IF NOT EXISTS license_renewals (
    id                  VARCHAR(36)  NOT NULL,    -- UUID v4
    license_id          VARCHAR(36)  NOT NULL,
    reference           VARCHAR(100) NOT NULL,    -- Idempotency key (ID transaksi pembayaran)
    source              VARCHAR(50),              -- e.g. "ryasai-chatbot"
    extend_days         INTEGER,                  -- Hari yang ditambahkan
    previous_expires_at DATETIME,
    new_expires_at      DATETIME     NOT NULL,
    created_at          DATETIME     NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (license_id) REFERENCES licenses (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_license_renewals_reference ON license_renewals (reference);
CREATE INDEX IF NOT EXISTS ix_license_renewals_license_id ON license_renewals (license_id);

CREATE TABLE IF NOT EXISTS admin_users (
    id            VARCHAR(36)  NOT NULL,          -- UUID v4
    email         VARCHAR(200) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,          -- Bcrypt hash
    is_active     BOOLEAN      NOT NULL DEFAULT 1,
    token_version INTEGER      NOT NULL DEFAULT 1,-- Invalidation token on password change
    created_at    DATETIME     NOT NULL,
    updated_at    DATETIME,
    PRIMARY KEY (id),
    UNIQUE (email)
);
```

---

## 3. Tipe Antarmuka TypeScript (`src/server/db.ts`)

```typescript
export interface LicensePlanRow {
  code: string // starter, pro, enterprise, flat
  name: string
  description: string | null
  sort_order: number
}

export interface LicenseStatusRow {
  code: string // active, revoked
  name: string
  description: string | null
  allows_validation: number
  sort_order: number
}

export interface MachineStatusRow {
  code: string // active, deactivated, replaced, stale
  name: string
  description: string | null
  occupies_slot: number
  sort_order: number
}

export interface ValidationResultRow {
  code: string // valid, invalid, inactive, expired, machine_limit, wrong_product
  name: string
  description: string | null
  is_success: number
  sort_order: number
}

export interface LicenseRow {
  id: string
  license_key: string
  customer_name: string
  customer_email: string
  plan_code: string // -> license_plans.code
  status_code: string // -> license_statuses.code
  product: string
  slug: string | null
  max_machines: number
  expires_at: string | null
  created_at: string
  updated_at: string
  notes: string | null
}

export interface MachineActivationRow {
  id: string
  license_id: string
  machine_id: string
  status_code: string // -> machine_statuses.code
  hostname: string | null
  os_info: string | null
  ip_address: string | null
  first_seen: string
  last_seen: string
  status_changed_at: string | null
}

export interface ValidationLogRow {
  id: string
  license_id: string | null
  license_key: string
  machine_id: string
  result_code: string // -> validation_results.code
  ip_address: string | null
  timestamp: string
  metadata: string | null
}

export interface LicenseRenewalRow {
  id: string
  license_id: string
  reference: string
  source: string | null
  extend_days: number | null
  previous_expires_at: string | null
  new_expires_at: string
  created_at: string
}

export interface AdminUserRow {
  id: string
  email: string
  password_hash: string
  is_active: number
  token_version: number
  created_at: string
  updated_at: string | null
}
```

---

## 4. Endpoint Integrasi

1. **`POST /api/v1/license/validate` (Client Apps)**
   * Divalidasi secara kriptografis menggunakan Ed25519 response signature.
   * Pengecekan produk ditiadakan: lisensi apa pun yang aktif dan belum kedaluwarsa akan langsung lolos validasi.
2. **`POST /internal/licenses/generate` (Downstream Settlement / QRIS)**
   * Dipanggil oleh `ryasai-chatbot` via `X-Internal-Secret`.
   * Otomatis menerbitkan kunci lisensi berpaket `flat` untuk slug organisasi pembeli.
3. **`POST /api/v1/license/renew` (HMAC Signed Renewal)**
   * Endpoint perpanjangan lisensi berbasis tanda tangan HMAC-SHA256 (`SECRET_KEY`).
   * Idempoten berdasarkan `reference` transaksi.
