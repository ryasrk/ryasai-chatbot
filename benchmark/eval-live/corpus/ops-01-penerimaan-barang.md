# PT ARUNIKA LOGISTIK NUSANTARA
## STANDAR OPERASIONAL PROSEDUR
### Penerimaan Barang (Inbound) Gudang

| Parameter Dokumen | Rincian Ketentuan |
| :--- | :--- |
| **Nomor Dokumen** | SOP-OPS-WH-004 |
| **Versi / Revisi** | 2.1 / Rev. 02 |
| **Tanggal Efektif** | 15 Januari 2026 |
| **Departemen Pemilik** | Departemen Operasional Pergudangan |
| **Disetujui Oleh** | Yusuf Halim (Chief Operating Officer) |

---

### 1. TUJUAN DAN RUANG LINGKUP
1.1. Prosedur ini menetapkan tata kelola baku aktivitas penerimaan barang (*inbound*) di PT Arunika Logistik Nusantara ("Arunika") guna menjamin kesesuaian fisik, ketepatan administrasi, penanganan deviasi, dan kecepatan penataan barang (*putaway*).
1.2. SOP ini berlaku di 5 fasilitas pergudangan Arunika:
- SBY-01 Surabaya (18.000 m²)
- JKT-02 Jakarta Cikarang (24.500 m²)
- MDN-03 Medan (9.200 m²)
- MKS-04 Makassar (7.800 m²)
- BPN-05 Balikpapan (6.100 m²)
1.3. Layanan beroperasi 24 jam dalam 3 shift (Shift 1: 07:00–15:00, Shift 2: 15:00–23:00, Shift 3: 23:00–07:00 WIB), mencakup armada internal (312 truk: CDD, CDE, Fuso, Tronton) dan armada pihak ketiga.

### 2. SISTEM DAN DOKUMEN ACUAN
2.1. **Gudangku v4**: Sistem WMS utama untuk manajemen slot docking, inspeksi, dan alokasi rak.
2.2. **RuteKu**: Sistem TMS pemantau kedatangan armada distribusi.
2.3. **SAP Business One**: Sistem ERP untuk pencatatan *Goods Receipt PO* (GRPO).
2.4. **Jira Service Management**: Sistem tiket penanganan selisih dan insiden barang rusak.

### 3. PROSEDUR OPERASIONAL INBOUND

#### 3.1. Slot Booking dan Toleransi Kedatangan Truk
1. Transporter atau vendor wajib melakukan reservasi jadwal pembongkaran (*slot booking*) melalui modul *Dock Appointment* pada WMS Gudangku v4 paling lambat **H-1 pukul 15:00 WIB**.
2. Waktu kedatangan armada mengacu pada slot terkonfirmasi dengan ketentuan **toleransi keterlambatan truk 30 menit**.
3. Jika truk tiba melampaui batas toleransi 30 menit:
   - Alokasi *docking bay* otomatis dibatalkan oleh sistem WMS.
   - Armada dialihkan ke antrean tunggu non-prioritas pada shift berikutnya.
   - Dikenakan biaya administrasi penataan jadwal ulang sebesar IDR 150.000 per armada.

#### 3.2. Pembongkaran (Unloading) dan Verifikasi Awal
1. Petugas *Inbound Admin* memeriksa kesesuaian Surat Jalan (SJ) dan *Packing List* fisik terhadap data pesanan pada SAP Business One.
2. Operator *forklift* membongkar palet menuju area *staging inbound* untuk identifikasi visual nomor palet dan integritas segel muatan.

#### 3.3. Metode Pemeriksaan Barang: 100% vs Sampling
Petugas *Quality Control* (QC) Inbound melakukan verifikasi mutu dan kebenaran SKU dengan metode berikut:

| Kategori Barang | Nilai / Spesifikasi SKU | Metode Pemeriksaan | Parameter Pengujian |
| :--- | :--- | :--- | :--- |
| **High-Value Goods** | Nilai > IDR 5.000.000/koli | Pemeriksaan 100% | Buka kemasan, verifikasi serial number, cek kelengkapan unit |
| **Dangerous Goods** | Bahan kimia, B3, aerosol | Pemeriksaan 100% | Cek integritas fisik wadah/drum, segel, dan label MSDS |
| **Fast Moving FMCG** | Produk pangan/ritel kartonan | Sampling (AQL 1.0) | Sampel acak 10% koli per lot sesuai standar ISO 2859-1 |
| **General Cargo** | Suku cadang, nilai ≤ IDR 5.000.000 | Sampling (AQL 1.5) | Sampel acak 5% dari total koli per Surat Jalan |

#### 3.4. Toleransi Selisih Kuantitas
1. Batas **toleransi selisih kuantitas** fisik terhadap dokumen pengiriman adalah maksimal **0,5%** khusus untuk barang curah (*bulk cargo*) yang bertimbangan variabel.
2. Untuk barang ritel, kemasan karton (*unitized piece*), dan barang bernilai tinggi (*high-value*), berlaku toleransi **0,0%** (*zero tolerance*).
3. Apabila selisih melebihi 0,5% pada barang curah atau selisih ≥ 1 unit pada barang unitized:
   - Proses inbound SKU tersebut dihentikan seketika.
   - Petugas *tally* dan pengemudi wajib melakukan penghitungan ulang bersama (*joint count*).
   - *Inbound Admin* menerbitkan Berita Acara Selisih (BAS) serta tiket Jira Service Management kategori "Inbound Discrepancy" dalam waktu 45 menit.

#### 3.5. Penanganan Barang Rusak (Damaged Goods)
1. Barang rusak, kemasan pecah, bocor, atau cacat dipisahkan langsung dari barang berkondisi baik (*good stock*).
2. Muatan rusak segera dipindahkan ke area karantina tertutup (*Red Quarantine Zone*).
3. Status barang pada WMS Gudangku v4 langsung dikunci menjadi `BLOCKED-DMG` agar tidak dapat dialokasikan untuk pesanan keluar.
4. Petugas QC mengambil foto bukti kerusakan (4 sisi) dan menerbitkan Berita Acara Kerusakan Barang (BAKB).
5. Kerusakan dengan estimasi nilai di atas IDR 1.000.000 wajib dieskalasikan melalui Jira Service Management ke CFO Dimas Prasetyo dalam 1x24 jam untuk pengajuan klaim asuransi atau pembebanan retur vendor.

#### 3.6. Sistem Kode Lokasi Rak (Rack Location Coding)
Barang yang dinyatakan lolos inspeksi diberi label palet barcode dengan format alamat lokasi rak 6 segmen:
`Gudang-Zona Suhu-Lorong-Rak-Tingkat-Bin`
- **Segmen 1 (Gudang):** SBY01, JKT02, MDN03, MKS04, atau BPN05.
- **Segmen 2 (Zona):** DRY (Kering), ACZ (AC 18–22°C), CLD (Cold Room 2–8°C).
- **Segmen 3–6:** Lorong (2 digit), Blok Rak (1 huruf), Tingkat (2 digit), Nomor Bin (2 digit).
- *Contoh format:* `JKT02-DRY-04-B-03-01` (Gudang Cikarang, Zona Kering, Lorong 04, Rak B, Level 3, Bin 01).

#### 3.7. Target SLA Putaway
1. Target penyelesaian penataan rak (**putaway SLA**) adalah maksimal **4 jam** sejak proses verifikasi QC selesai tercatat di WMS Gudangku v4 (*status: Staged*) hingga palet tersimpan di rak definitif.
2. Operator *reach truck* memindai barcode palet dan barcode lokasi rak menggunakan RF Scanner untuk validasi peletakan sistem.
3. Keterlambatan melebihi 4 jam memicu alarm eskalasi otomatis pada dashboard *Inbound Supervisor*.

### 4. PENUTUPAN ADMINISTRASI DAN INTEGRASI SISTEM
4.1. Setelah putaway selesai 100%, data WMS Gudangku v4 tersinkronisasi otomatis dengan ERP SAP Business One untuk pembuatan dokumen *Goods Receipt PO* (GRPO).
4.2. Inbound Admin mencap basah Surat Jalan vendor dan menyerahkan lembar bukti terima kepada pengemudi maksimal 30 menit setelah pembongkaran rampung.
