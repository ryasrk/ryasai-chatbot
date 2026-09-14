-- Database 1: SALES. Distinct content from HR and LOGISTICS on purpose: the
-- cross-source test needs a question whose correct answer differs per database, so a
-- confusing route produces a VISIBLY wrong number rather than a plausible one.
DROP TABLE IF EXISTS produk CASCADE;
DROP TABLE IF EXISTS pelanggan CASCADE;
DROP TABLE IF EXISTS pesanan CASCADE;
DROP TABLE IF EXISTS pesanan_item CASCADE;

CREATE TABLE pelanggan (id serial PRIMARY KEY, nama text NOT NULL, kota text NOT NULL, tipe text NOT NULL);
CREATE TABLE produk (id serial PRIMARY KEY, nama text NOT NULL, kategori text NOT NULL, harga numeric(12,2) NOT NULL);
CREATE TABLE pesanan (id serial PRIMARY KEY, pelanggan_id int REFERENCES pelanggan(id), status text NOT NULL, total numeric(14,2) NOT NULL, tanggal date NOT NULL);
CREATE TABLE pesanan_item (id serial PRIMARY KEY, pesanan_id int REFERENCES pesanan(id), produk_id int REFERENCES produk(id), qty int NOT NULL, subtotal numeric(14,2) NOT NULL);

INSERT INTO pelanggan (nama, kota, tipe) VALUES
 ('Toko Sinar Jaya','Bandung','retail'),('CV Mitra Abadi','Jakarta','grosir'),
 ('UD Sumber Rejeki','Surabaya','grosir'),('Toko Berkah Mandiri','Bandung','retail'),
 ('PT Anugerah Niaga','Medan','korporat'),('Toko Harapan Baru','Yogyakarta','retail'),
 ('CV Karya Utama','Jakarta','korporat'),('UD Tani Makmur','Semarang','grosir');

INSERT INTO produk (nama, kategori, harga) VALUES
 ('Kopi Arabika 1kg','Minuman',185000.00),('Teh Hijau Premium 500g','Minuman',92000.00),
 ('Beras Pandan Wangi 5kg','Sembako',78000.00),('Gula Pasir 1kg','Sembako',17500.00),
 ('Minyak Goreng 2L','Sembako',38000.00),('Kemasan Plastik 100pcs','Peralatan',45000.00),
 ('Label Stiker 500pcs','Peralatan',27000.00);

INSERT INTO pesanan (pelanggan_id, status, total, tanggal) VALUES
 (1,'selesai',370000.00,'2026-01-12'),(2,'selesai',1240000.00,'2026-01-19'),
 (3,'diproses',203500.00,'2026-02-03'),(4,'selesai',136000.00,'2026-02-11'),
 (5,'dibatalkan',920000.00,'2026-02-18'),(6,'selesai',111000.00,'2026-03-05'),
 (7,'selesai',1854000.00,'2026-03-14'),(8,'diproses',156000.00,'2026-03-22'),
 (1,'selesai',74000.00,'2026-04-02'),(2,'pending',380000.00,'2026-04-15'),
 (4,'selesai',27000.00,'2026-04-28'),(6,'dibatalkan',185000.00,'2026-05-06');

INSERT INTO pesanan_item (pesanan_id, produk_id, qty, subtotal) VALUES
 (1,1,2,370000.00),(2,1,4,740000.00),(2,4,10,175000.00),(2,5,5,190000.00),(2,6,3,135000.00),
 (3,2,2,184000.00),(3,7,1,27000.00),(4,2,1,92000.00),(4,7,1,27000.00),(5,4,20,350000.00),
 (6,3,1,78000.00),(6,7,1,27000.00),(7,1,10,1850000.00),(8,3,2,156000.00),(9,4,4,70000.00),
 (10,1,2,370000.00),(11,7,1,27000.00),(12,1,1,185000.00);
