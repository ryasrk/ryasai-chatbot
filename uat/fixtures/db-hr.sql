-- Database 2: HR. Deliberately DIFFERENT table names and counts from sales, so a
-- question about "jumlah karyawan" can only be answered here and a wrong route gives
-- a visibly wrong number instead of a plausible one.
DROP TABLE IF EXISTS absensi CASCADE;
DROP TABLE IF EXISTS cuti CASCADE;
DROP TABLE IF EXISTS karyawan CASCADE;
DROP TABLE IF EXISTS departemen CASCADE;

CREATE TABLE departemen (id serial PRIMARY KEY, nama text NOT NULL, kepala text NOT NULL);
CREATE TABLE karyawan (id serial PRIMARY KEY, nama text NOT NULL, departemen_id int REFERENCES departemen(id), jabatan text NOT NULL, gaji numeric(12,2) NOT NULL, aktif boolean NOT NULL DEFAULT true);
CREATE TABLE cuti (id serial PRIMARY KEY, karyawan_id int REFERENCES karyawan(id), jenis text NOT NULL, mulai date NOT NULL, hari int NOT NULL, status text NOT NULL);
CREATE TABLE absensi (id serial PRIMARY KEY, karyawan_id int REFERENCES karyawan(id), tanggal date NOT NULL, hadir boolean NOT NULL);

INSERT INTO departemen (nama, kepala) VALUES
 ('Teknologi','Budi Santoso'),('Keuangan','Siti Nurhaliza'),('Operasional','Agus Wijaya'),('SDM','Dewi Lestari');

INSERT INTO karyawan (nama, departemen_id, jabatan, gaji, aktif) VALUES
 ('Andi Pratama',1,'Software Engineer',14000000,true),('Rina Marlina',1,'QA Engineer',11000000,true),
 ('Joko Susilo',2,'Accountant',9500000,true),('Maya Sari',2,'Finance Manager',18000000,true),
 ('Hendra Gunawan',3,'Supervisor',10500000,true),('Lina Kusuma',3,'Staf Operasional',7000000,true),
 ('Bayu Setiawan',4,'HR Specialist',9000000,true),('Citra Dewi',1,'Data Analyst',12500000,true),
 ('Eko Prasetyo',3,'Staf Operasional',6800000,false),('Fitri Handayani',4,'Recruiter',8500000,true);

INSERT INTO cuti (karyawan_id, jenis, mulai, hari, status) VALUES
 (1,'tahunan','2026-01-05',5,'disetujui'),(2,'sakit','2026-01-20',2,'disetujui'),
 (3,'tahunan','2026-02-10',12,'disetujui'),(4,'tahunan','2026-02-17',3,'ditolak'),
 (5,'sakit','2026-03-02',1,'disetujui'),(6,'tahunan','2026-03-16',7,'menunggu'),
 (7,'melahirkan','2026-04-01',90,'disetujui'),(8,'tahunan','2026-04-20',4,'disetujui'),
 (10,'tahunan','2026-05-05',6,'menunggu');

INSERT INTO absensi (karyawan_id, tanggal, hadir) VALUES
 (1,'2026-05-04',true),(1,'2026-05-05',true),(2,'2026-05-04',true),(2,'2026-05-05',false),
 (3,'2026-05-04',true),(3,'2026-05-05',true),(4,'2026-05-04',true),(5,'2026-05-04',false),
 (5,'2026-05-05',true),(6,'2026-05-04',true),(7,'2026-05-04',true),(8,'2026-05-05',true),
 (10,'2026-05-04',true);
