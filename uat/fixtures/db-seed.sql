-- ============================================================================
-- UAT fixture: a small but REALISTIC company database.
--
-- Design rules, so the UAT can tell a correct answer from a plausible one:
--   * Every aggregate has a hand-computable answer written into
--     `uat/expected-answers.md`. If a number cannot be verified by hand, it does
--     not belong here.
--   * Deliberate non-uniform data: one branch with zero sales, one customer with
--     no orders, one customer with two cities. A naive JOIN or a missing LEFT
--     JOIN then produces a WRONG answer rather than a slightly-off one.
--   * Names are Indonesian so a language mix-up is visible.
--   * Money is stored in integer rupiah, never floats, so no answer is ambiguous
--     through rounding.
-- ============================================================================

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE cabang (
  id          serial PRIMARY KEY,
  kode        varchar(8)  NOT NULL UNIQUE,
  nama        varchar(64) NOT NULL,
  kota        varchar(64) NOT NULL
);

CREATE TABLE pelanggan (
  id           serial PRIMARY KEY,
  nama         varchar(96) NOT NULL,
  kota         varchar(64) NOT NULL,
  segmen       varchar(16) NOT NULL CHECK (segmen IN ('ritel','korporat','umkm')),
  bergabung    date NOT NULL
);

CREATE TABLE produk (
  id        serial PRIMARY KEY,
  sku       varchar(16) NOT NULL UNIQUE,
  nama      varchar(96) NOT NULL,
  kategori  varchar(32) NOT NULL,
  harga     integer NOT NULL CHECK (harga > 0)
);

CREATE TABLE pesanan (
  id           serial PRIMARY KEY,
  nomor        varchar(16) NOT NULL UNIQUE,
  pelanggan_id integer NOT NULL REFERENCES pelanggan(id),
  cabang_id    integer NOT NULL REFERENCES cabang(id),
  tanggal      date NOT NULL,
  status       varchar(16) NOT NULL CHECK (status IN ('selesai','dibatalkan','diproses'))
);

CREATE TABLE pesanan_item (
  id          serial PRIMARY KEY,
  pesanan_id  integer NOT NULL REFERENCES pesanan(id),
  produk_id   integer NOT NULL REFERENCES produk(id),
  qty         integer NOT NULL CHECK (qty > 0),
  harga_saat  integer NOT NULL CHECK (harga_saat > 0)
);

-- One branch (cok-04, Cirebon) has NO orders at all: a report that INNER JOINs
-- cabang will silently omit it, and the answer to "sales per branch" becomes wrong.
INSERT INTO cabang (kode, nama, kota) VALUES
  ('jkt-01','Cabang Jakarta Pusat','Jakarta'),
  ('bdg-02','Cabang Bandung','Bandung'),
  ('sby-03','Cabang Surabaya','Surabaya'),
  ('cok-04','Cabang Cirebon','Cirebon');

-- Pelanggan 5 has NO orders (LEFT JOIN trap). Pelanggan 3 has orders from TWO
-- different branches, so a per-customer-per-branch grouping differs from
-- per-customer alone.
INSERT INTO pelanggan (nama, kota, segmen, bergabung) VALUES
  ('Toko Sinar Jaya','Jakarta','ritel','2023-01-15'),
  ('PT Maju Bersama','Bandung','korporat','2023-03-02'),
  ('CV Karya Abadi','Surabaya','umkm','2023-05-20'),
  ('UD Berkah Mulia','Jakarta','umkm','2024-01-08'),
  ('Toko Sejahtera','Cirebon','ritel','2024-02-11');

INSERT INTO produk (sku, nama, kategori, harga) VALUES
  ('SKU-001','Kopi Arabika 1kg','Minuman',120000),
  ('SKU-002','Teh Hijau 500g','Minuman',75000),
  ('SKU-003','Gula Pasir 1kg','Sembako',18000),
  ('SKU-004','Beras Premium 5kg','Sembako',78000),
  ('SKU-005','Minyak Goreng 2L','Sembako',42000),
  ('SKU-006','Mesin Kopi Otomatis','Peralatan',4500000);

-- 12 orders, 10 selesai + 1 dibatalkan + 1 diproses. Cancelled and in-progress
-- orders must be EXCLUDED from revenue; including them is the most common wrong
-- answer, so the figures are chosen to differ clearly.
--
-- These three totals were COMPUTED from the rows below, not written from memory:
--   semua status    = 13,944,000
--   'selesai' only  =  9,366,000   <- the correct revenue
--   'dibatalkan'    =  4,500,000
--   'diproses'      =     78,000
-- An earlier draft of this comment carried figures that disagreed with the INSERTs
-- below it. The seed was corrected to the measured values rather than the reverse,
-- because a fixture whose comment contradicts its data is worse than no comment.
INSERT INTO pesanan (nomor, pelanggan_id, cabang_id, tanggal, status) VALUES
  ('ORD-0001',1,1,'2024-03-01','selesai'),
  ('ORD-0002',1,1,'2024-03-15','selesai'),
  ('ORD-0003',2,2,'2024-03-04','selesai'),
  ('ORD-0004',3,3,'2024-03-09','selesai'),
  ('ORD-0005',3,1,'2024-04-02','selesai'),
  ('ORD-0006',4,1,'2024-04-11','selesai'),
  ('ORD-0007',2,2,'2024-04-18','dibatalkan'),
  ('ORD-0008',1,1,'2024-05-06','selesai'),
  ('ORD-0009',3,3,'2024-05-21','selesai'),
  ('ORD-0010',4,2,'2024-06-03','selesai'),
  ('ORD-0011',2,2,'2024-06-19','diproses'),
  ('ORD-0012',1,1,'2024-06-25','selesai');

INSERT INTO pesanan_item (pesanan_id, produk_id, qty, harga_saat) VALUES
  (1,1,2,120000),   -- 240000
  (2,2,4,75000),    -- 300000
  (3,6,1,4500000),  -- 4500000
  (4,3,10,18000),   -- 180000
  (5,1,1,120000),   -- 120000
  (6,4,5,78000),    -- 390000
  (7,6,1,4500000),  -- 4500000  (dibatalkan)
  (8,5,3,42000),    -- 126000
  (9,2,2,75000),    -- 150000
  (10,1,3,120000),  -- 360000
  (11,4,1,78000),   -- 78000    (diproses)
  (12,6,1,3000000); -- 3000000  (harga diskon, selesai)

CREATE INDEX ON pesanan (tanggal);
CREATE INDEX ON pesanan (status);
CREATE INDEX ON pesanan_item (pesanan_id);
