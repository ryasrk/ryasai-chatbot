# PT ARUNIKA LOGISTIK NUSANTARA
## KEBIJAKAN KEAMANAN INFORMASI (INFORMATION SECURITY POLICY)

**Nomor Dokumen:** ALN-POL-IT-004  
**Versi:** 3.0  
**Tanggal Berlaku:** 15 Januari 2026  
**Departemen Pemilik:** Departemen Teknologi Informasi & Keamanan Siber  
**Klasifikasi Dokumen:** Internal Korporat  

---

### 1. Tujuan dan Ruang Lingkup

1.1. **Tujuan**: Kebijakan ini menetapkan kerangka kerja tata kelola perlindungan data dan aset teknologi informasi di lingkungan PT Arunika Logistik Nusantara guna menjaga aspek kerahasiaan (*confidentiality*), integritas (*integrity*), dan ketersediaan (*availability*) aset informasi perusahaan dari ancaman siber internal maupun eksternal.

1.2. **Ruang Lingkup**: Kebijakan ini mengikat secara operasional dan hukum bagi seluruh 1.240 karyawan PT Arunika Logistik Nusantara tanpa terkecuali, meliputi Kantor Pusat Surabaya (Jl. Rungkut Industri III No. 18), unit armada logistik (312 truk dan 58 van), serta 5 fasilitas gudang operasional:
- Gudang Surabaya (SBY-01, kapasitas 18.000 m²)
- Gudang Jakarta Cikarang (JKT-02, kapasitas 24.500 m²)
- Gudang Medan (MDN-03, kapasitas 9.200 m²)
- Gudang Makassar (MKS-04, kapasitas 7.800 m²)
- Gudang Balikpapan (BPN-05, kapasitas 6.100 m²)

Sistem yang dicakup mencakup Enterprise Resource Planning (ERP) SAP Business One, Warehouse Management System (WMS) Gudangku v4, Transportation Management System (TMS) RuteKu, portal Jira Service Management, serta seluruh infrastruktur pendukung operasional 3 shift pergudangan.

---

### 2. Klasifikasi Data

Seluruh data, arsip elektronik, dokumen cetak, dan rekaman digital diklasifikasikan ke dalam 4 (empat) tingkatan:

| Level | Klasifikasi | Definisi & Kriteria | Contoh Data | Aturan Penanganan & Akses |
| :--- | :--- | :--- | :--- | :--- |
| **Level 1** | **Publik** | Informasi yang diperuntukkan bagi konsumsi umum dan tidak menimbulkan risiko kerugian jika disebarluaskan. | Materi promosi, tarif umum angkutan, publikasi siaran pers, nomor telepon kontak kantor pusat. | Bebas diakses dan didistribusikan melalui persetujuan Divisi Komunikasi Perusahaan. |
| **Level 2** | **Internal** | Informasi kegiatan bisnis harian yang hanya ditujukan bagi kalangan internal PT Arunika Logistik Nusantara. | Jadwal kerja 3 shift gudang, direktori ekstensi telepon internal, notula rapat operasional mingguan. | Pembatasan akses hanya melalui akun intranet resmi perusahaan; dilarang dibagikan ke pihak ketiga. |
| **Level 3** | **Rahasia** | Data sensitif operasional dan data klien yang berdampak negatif terhadap reputasi dan finansial bila bocor. | Manifes pengiriman harian TMS RuteKu, layout rak dan peta stok WMS Gudangku v4, data kontrak vendor truk. | Akses terbatas berbasis peran (*Role-Based Access Control*); transmisi wajib terenkripsi. |
| **Level 4** | **Sangat Rahasia** | Data kepemilikan bernilai kritikal tinggi yang berdampak pada keberlanjutan bisnis atau tuntutan hukum berat (>Rp1.000.000.000). | Laporan keuangan ERP SAP Business One, master payroll karyawan (CHRO), kredensial root database, private key SSL. | Enkripsi end-to-end, verifikasi otorisasi Direksi, audit jejak log akses (*access log*) mingguan. |

---

### 3. Kontrol Akses, Kata Sandi, dan Autentikasi

3.1. **Standar Kompleksitas Kata Sandi (Password)**:
- Setiap akun pengguna wajib memiliki panjang kata sandi **minimal 12 karakter**, yang mengombinasikan minimal 1 huruf kapital, 1 huruf kecil, 1 angka numerik, dan 1 simbol karakter khusus.
- Masa kedaluwarsa kata sandi adalah **90 hari kalender**. Setelah 90 hari, sistem secara otomatis mengunci sesi hingga pengguna melakukan pembaruan kata sandi.
- Riwayat 5 (lima) kata sandi sebelumnya tidak dapat digunakan kembali.

3.2. **Kewajiban Autentikasi Multi-Faktor (MFA)**:
- Autentikasi Multi-Faktor (MFA) berbasis aplikasi (*Time-based One-Time Password*) **wajib diaktifkan** untuk seluruh akun tanpa kecuali pada sistem SAP Business One, Gudangku v4, RuteKu, Jira Service Management, dan email resmi korporat.
- Akses administratif (Admin Privileged Access) wajib menggunakan MFA berbasis token fisik atau aplikasi autentikator terdaftar milik Departemen TI.

---

### 4. Keamanan Perangkat Komputer dan Jaringan

4.1. **Enkripsi Komputer Jinak (Laptop)**:
- Seluruh unit laptop dinas (sejumlah 420 unit laptop operasional dan manajerial) wajib menerapkan enkripsi diska penuh (*Full Disk Encryption*) menggunakan standar enkripsi minimal XTS-AES 256-bit (BitLocker untuk Windows atau FileVault untuk macOS).
- Kunci pemulihan (*recovery key*) dikelola terpusat oleh tim TI dan dilarang disimpan secara lokal pada perangkat pengguna.

4.2. **Larangan Penggunaan Media Portabel (USB)**:
- Dilarang keras menghubungkan segala bentuk media penyimpanan eksternal berbasis USB (flash disk, external hard disk, portable SSD) ke seluruh perangkat komputer inventaris perusahaan.
- Departemen TI mengunci seluruh port USB penyimpanan secara terpusat (*port restriction via policy*). Izin transfer data hanya diberikan melalui cloud storage internal resmi Arunika atau tiket dispensasi khusus pada Jira Service Management dengan izin Kepala Departemen TI.

4.3. **Koneksi Jaringan Virtual Private Network (VPN)**:
- Akses sistem internal (SAP Business One, Gudangku v4, RuteKu) dari luar perimeter kantor atau jaringan gudang wajib menggunakan koneksi resmi Arunika Corporate VPN.
- Penggunaan VPN pihak ketiga atau proxy tidak sah di dalam lingkungan perangkat korporat dilarang keras dan akan langsung diputus oleh sistem firewall.

---

### 5. Cadangan Data (Backup) dan Retensi

5.1. **Jadwal Pencadangan**:
- Pencadangan (*backup*) basis data operasional ERP SAP Business One, Gudangku v4, dan RuteKu wajib dilakukan secara otomatis setiap hari (**harian**) mulai pukul 23:00 WIB.
- Proses pencadangan menerapkan metode *snapshot incremental* harian dan *full synthetic backup* setiap hari Minggu pukul 01:00 WIB.

5.2. **Masa Retensi Cadangan**:
- Arsip cadangan data wajib disimpan dengan masa **retensi selama 35 hari kalender**.
- File cadangan disimpan pada penyimpanan sekunder terpisah (*off-site cloud storage*) yang berlokasi di data center tersertifikasi Tier-3 di Indonesia serta diamankan dengan enkripsi AES-256.

---

### 6. Pelaporan Insiden Keamanan Informasi

6.1. **Batas Waktu Pelaporan**:
- Setiap insiden, anomali jaringan, infeksi ransomware, indikasi pembajakan akun, maupun kehilangan aset fisik terenkripsi **wajib dilaporkan dalam waktu maksimal 1 (satu) jam** sejak insiden pertama kali teridentifikasi.

6.2. **Kanal dan Prosedur Pelaporan**:
- Pelaporan wajib diajukan melalui portal **Jira Service Management** pada modul *Incident Management* kategori *Security Incident* dengan tingkat prioritas P1-Critical.
- Dalam situasi darurat di luar jam kantor (Senin-Jumat 08:00-17:00 WIB) atau shift malam gudang, pelapor wajib menghubungi nomor hotline Security Operations Center (SOC) Arunika di +62 811-3400-8899.

---

### 7. Kepatuhan dan Sanksi

7.1. Pelanggaran terhadap kepatuhan keamanan informasi (seperti pembagian kata sandi, penonaktifan sepihak sistem enkripsi laptop, penancapan USB terlarang, atau kelalaian melapor insiden melebihi batas 1 jam) akan dikenakan sanksi disipliner bertingkat:
- **Tingkat Ringan**: Surat Peringatan Pertama (SP 1) dan kewajiban mengikuti pelatihan ulang kesadaran siber.
- **Tingkat Sedang**: Surat Peringatan Ketiga (SP 3) serta penonaktifan hak akses sistem selama 14 hari kalender.
- **Tingkat Berat**: Pemutusan Hubungan Kerja (PHK) tanpa pesangon dan pengenaan denda ganti rugi pemulihan data minimal Rp15.000.000 serta pelaporan pidana sesuai ketentuan regulasi pelindungan data yang berlaku di Republik Indonesia.

---

### 8. Pengesahan Dokumen

Dokumen kebijakan ini disahkan di Surabaya pada tanggal 15 Januari 2026 dan mengikat seluruh jajaran kerja PT Arunika Logistik Nusantara.

| Disusun Oleh, | Ditinjau Bersama, | Disetujui Oleh, |
| :--- | :--- | :--- |
| **Hendra Gunawan**<br>Chief Technology Officer | **Dimas Prasetyo**<br>Chief Financial Officer | **Ratna Wijayakusuma**<br>Chief Executive Officer |
| **Sekar Ayuningtyas**<br>Chief Human Resources Officer | **Yusuf Halim**<br>Chief Operating Officer | |
