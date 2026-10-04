# STANDAR OPERASIONAL PROSEDUR
## PENANGANAN GANGGUAN DAN INSIDEN TEKNOLOGI INFORMASI

**Kode Dokumen:** SOP-IT-OPS-004  
**Versi:** 2.1  
**Tanggal Efektif:** 19 Januari 2026  
**Departemen Pemilik:** Departemen Teknologi Informasi  

---

### 1. TUJUAN DAN RUANG LINGKUP
1.1. Prosedur ini mengatur tata laksana identifikasi, mitigasi, eskalasi, serta pemulihan insiden sistem teknologi informasi guna menjaga kelancaran rantai pasok *freight forwarding*, pergudangan (*warehousing*), dan pengiriman jarak akhir (*last-mile delivery*) pada PT Arunika Logistik Nusantara ("Arunika").  
1.2. Ruang lingkup prosedur ini mencakup seluruh infrastruktur TI dan aplikasi di Kantor Pusat (Jl. Rungkut Industri III No. 18, Surabaya) serta lima hub gudang operasional: Hub Surabaya (SBY-01, 18.000 m²), Hub Jakarta Cikarang (JKT-02, 24.500 m²), Hub Medan (MDN-03, 9.200 m²), Hub Makassar (MKS-04, 7.800 m²), dan Hub Balikpapan (BPN-05, 6.100 m²).  
1.3. Prosedur ini berlaku mengikat bagi 1.240 karyawan dan sistem inti Arunika, yaitu WMS *Gudangku v4*, TMS *RuteKu*, ERP *SAP Business One*, serta platform *Jira Service Management* yang terhubung dengan operasional 312 unit truk dan 58 van.

---

### 2. KANAL PELAPORAN DAN OPERASIONAL HELPDESK TI
2.1. Setiap anomali atau gangguan operasional sistem TI wajib dilaporkan secara resmi melalui sistem tiket *Jira Service Management* (ars.helpdesk.arunika.co.id).  
2.2. Jam operasional Helpdesk Dukungan Tingkat 1 (L1 Support):
* **Hari Kerja Reguler:** Senin sampai dengan Jumat, pukul 08:00 – 17:00 WIB.
* **Nomor Ekstensi Telepon Internal:** Ext. 1041 dan Ext. 1042.

2.3. Mengingat aktivitas pergudangan di lima fasilitas berjalan penuh dalam 3 shift (24/7), Tim TI menyediakan personil siaga (*on-call engineer*) di luar jam reguler melalui **Hotline Darurat TI Ext. 1099** (saluran luar: +62 31 8432199 Ext. 1099) khusus untuk pelaporan insiden prioritas P1 dan P2.

---

### 3. KLASIFIKASI PRIORITAS INSIDEN DAN SERVICE LEVEL AGREEMENT (SLA)

Klasifikasi dampak insiden dan target SLA penanganan ditetapkan sebagai berikut:

| Tingkat Prioritas | Definisi dan Kriteria Dampak Operasional | Waktu Respon Maksimal | Target Waktu Resolusi |
| :--- | :--- | :--- | :--- |
| **P1 - Kritis** | Sistem inti mati total (*critical outage*); operasional gudang utama atau rantai pasok terhenti penuh; tidak ada *workaround* manual yang memadai. | 15 menit | 2 jam |
| **P2 - Tinggi** | Kerusakan fungsi mayor pada aplikasi inti; memengaruhi kelancaran distribusi lebih dari 20% armada (truk/van) atau sebagian area dok gudang. | 30 menit | 4 jam |
| **P3 - Sedang** | Penurunan performa sistem (misal kelambatan modul pelaporan ERP *SAP Business One*); kendala fungsi parsial tanpa menghentikan jadwal kirim. | 2 jam | 12 jam |
| **P4 - Rendah** | Gangguan individual, galat minor antarmuka, permohonan hak akses standar, atau asistensi teknis yang tidak menghambat alur kerja harian. | 4 jam | 48 jam |

---

### 4. PROSEDUR PENANGANAN DAN JALUR ESKALASI
4.1. **Penerimaan Tiket:** Petugas Helpdesk L1 menerima laporan di *Jira*, mengonfirmasi gejala gangguan kepada pelapor, dan menetapkan tingkat keparahan sesuai kriteria SLA.  
4.2. **Eskalasi Teknis Berjenjang:**
* **Tingkat 1 (L1 Support):** Verifikasi dan diagnosa dasar. Bila kendala tidak tuntas dalam 15 menit, tiket otomatis diekskalasikan ke Tingkat 2.
* **Tingkat 2 (L2 Specialist):** Analisis teknis mendalam oleh Administrator Basis Data, Jaringan, atau Spesialis Aplikasi (*Gudangku v4*, *RuteKu*, atau *SAP Business One*).
* **Tingkat 3 (L3 Expert / Principal):** Eskalasi ke Principal Vendor eksternal atau Arsitek Infrastruktur TI jika memerlukan *patching* kode atau perbaikan perangkat keras utama.

4.3. **Eskalasi Manajemen:** Untuk insiden P1, Manajer Operasional TI wajib membentuk ruang koordinasi darurat (*Incident War Room*) dalam waktu 20 menit sejak laporan masuk, serta menyampaikan perkembangan status penanganan kepada CTO Hendra Gunawan dan COO Yusuf Halim setiap 30 menit.

---

### 5. CONTOH KASUS PENANGANAN INSIDEN P1 (WMS DOWN)
5.1. **Skenario Kejadian:** Server basis data WMS *Gudangku v4* mengalami *crash* mendadak di Hub JKT-02 Cikarang pada Shift 2 pukul 14:15 WIB. Pemindai nirkabel (*barcode scanner*) kehilangan koneksi, proses bongkar muat terhenti, dan 45 unit truk CDD/CDE tertahan di area dok inbound.  
5.2. **Tindakan Mitigasi:**
* Supervisor Gudang menghubungi Hotline Darurat Ext. 1099; Helpdesk menerbitkan tiket berkategori P1 di *Jira* pada pukul 14:20 WIB.
* L2 Database Specialist mengeksekusi pengalihan darurat (*failover*) ke klaster server replikasi cadangan Cikarang pada pukul 14:48 WIB.
* Staf gudang memberlakukan prosedur surat jalan darurat manual sesuai otorisasi Manajer Operasional selama sinkronisasi data berlangsung.
* WMS *Gudangku v4* pulih seutuhnya pada pukul 15:35 WIB (total waktu resolusi 1 jam 15 menit, memenuhi batas SLA P1 di bawah 2 jam).

---

### 6. OTORISASI BIAYA PENANGANAN DARURAT
Biaya perbaikan mendesak (pembelian suku cadang server darurat, lisensi pemulihan, atau intervensi teknis pihak ketiga) diatur dengan batas kewenangan mata uang IDR sebagai berikut:
* Nilai hingga **IDR 15.000.000**: Otorisasi tunggal oleh IT Operations Lead.
* Nilai **IDR 15.000.001 s.d. IDR 50.000.000**: Otorisasi oleh CTO Hendra Gunawan.
* Nilai **di atas IDR 50.000.000**: Otorisasi tertulis bersama oleh CTO Hendra Gunawan dan CFO Dimas Prasetyo.

---

### 7. POST-INCIDENT REVIEW (PIR) DAN AKAR MASALAH
7.1. Sesi *Post-Incident Review* (PIR) wajib dilaksanakan selambat-lambatnya **5 (lima) hari kerja** setelah insiden P1 atau P2 dinyatakan terselesaikan (*resolved*).  
7.2. Dokumen Analisis Akar Masalah (*Root Cause Analysis* / RCA) harus memuat:
* Garis waktu kejadian terperinci per menit.
* Analisis metode *5-Whys* terkait sumber kegagalan teknis maupun prosedural.
* Evaluasi kepatuhan terhadap batasan target SLA.
* Matriks Tindakan Korektif dan Preventif (*Corrective and Preventive Action* / CAPA) beserta penanggung jawab dan tenggat waktunya.

7.3. Laporan final PIR didistribusikan kepada jajaran Direksi: CEO Ratna Wijayakusuma, COO Yusuf Halim, CFO Dimas Prasetyo, CHRO Sekar Ayuningtyas, dan CTO Hendra Gunawan.

---

### 8. LEMBAR PENGESAHAN DOKUMEN

| Diajukan Oleh | Ditinjau Oleh | Disetujui Oleh |
| :--- | :--- | :--- |
| **Bambang Kurniawan**<br>IT Operations Lead | **Ahmad Fauzan**<br>IT Infrastructure Manager | **Hendra Gunawan**<br>Chief Technology Officer (CTO) |
| Tanggal: 14 Januari 2026 | Tanggal: 16 Januari 2026 | Tanggal: 19 Januari 2026 |
