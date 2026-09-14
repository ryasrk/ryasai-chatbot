-- Database 3: LOGISTICS. Table names overlap with NEITHER of the other two, and the
-- concept of "stok" lives ONLY here -- which is what makes REST-vs-SQL routing
-- decidable by measurement rather than by a guess.
DROP TABLE IF EXISTS pengiriman CASCADE;
DROP TABLE IF EXISTS stok_gudang CASCADE;
DROP TABLE IF EXISTS gudang CASCADE;

CREATE TABLE gudang (id serial PRIMARY KEY, nama text NOT NULL, kota text NOT NULL, kapasitas int NOT NULL);
CREATE TABLE stok_gudang (id serial PRIMARY KEY, gudang_id int REFERENCES gudang(id), nama_barang text NOT NULL, kategori text NOT NULL, jumlah int NOT NULL);
CREATE TABLE pengiriman (id serial PRIMARY KEY, kode text NOT NULL, asal_gudang_id int REFERENCES gudang(id), tujuan_kota text NOT NULL, status text NOT NULL, berat_kg numeric(10,2) NOT NULL);

INSERT INTO gudang (nama, kota, kapasitas) VALUES
 ('Gudang Utama','Jakarta',10000),('Gudang Bandung','Bandung',6000),('Gudang Surabaya','Surabaya',7500);

INSERT INTO stok_gudang (gudang_id, nama_barang, kategori, jumlah) VALUES
 (1,'Kopi Arabika 1kg','Minuman',120),(1,'Teh Hijau Premium 500g','Minuman',85),
 (1,'Beras Pandan Wangi 5kg','Sembako',240),(1,'Gula Pasir 1kg','Sembako',500),
 (2,'Kopi Arabika 1kg','Minuman',45),(2,'Minyak Goreng 2L','Sembako',60),
 (2,'Kemasan Plastik 100pcs','Peralatan',300),(3,'Beras Pandan Wangi 5kg','Sembako',180),
 (3,'Label Stiker 500pcs','Peralatan',150),(3,'Teh Hijau Premium 500g','Minuman',95),
 (3,'Gula Pasir 1kg','Sembako',410),(1,'Minyak Goreng 2L','Sembako',220);

INSERT INTO pengiriman (kode, asal_gudang_id, tujuan_kota, status, berat_kg) VALUES
 ('SHP-001',1,'Bandung','terkirim',120.50),('SHP-002',1,'Medan','dalam_perjalanan',340.00),
 ('SHP-003',2,'Yogyakarta','terkirim',85.25),('SHP-004',3,'Semarang','terkirim',210.75),
 ('SHP-005',1,'Surabaya','tertunda',95.00),('SHP-006',3,'Jakarta','dalam_perjalanan',400.00),
 ('SHP-007',2,'Bandung','terkirim',60.00),('SHP-008',1,'Yogyakarta','terkirim',175.50);
