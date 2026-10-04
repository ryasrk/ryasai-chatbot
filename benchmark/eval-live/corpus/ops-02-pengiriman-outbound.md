# STANDAR OPERASIONAL PROSEDUR
## PICKING, PACKING, DAN PENGIRIMAN (OUTBOUND)
**PT ARUNIKA LOGISTIK NUSANTARA**

| Informasi Dokumen | Spesifikasi Administrasi |
| :--- | :--- |
| **Nomor Dokumen** | SOP-OPS-OUT-2026-004 |
| **Versi Dokumen** | Versi 4.2 |
| **Tanggal Efektif** | 15 Januari 2026 |
| **Departemen Pemilik** | Departemen Operasional Pergudangan & Logistik |
| **Kantor Pusat** | Jl. Rungkut Industri III No. 18, Surabaya |
| **Klasifikasi Akses** | Internal Dokumen Perusahaan |

---

### 1. TUJUAN DAN RUANG LINGKUP
1.1. Prosedur ini mengatur tata cara standar pelaksanaan operasional barang keluar (*outbound fulfillment*), yang mencakup pemrosesan pesanan, pengambilan barang (*picking*), pengemasan (*packing*), penimbangan berat-dimensi, hingga serah terima kepada armada pengiriman di lingkungan PT Arunika Logistik Nusantara ("Arunika").  
1.2. SOP ini berlaku wajib bagi seluruh staf pergudangan di 5 (lima) fasilitas pergudangan Arunika:
- SBY-01: Hub Surabaya (18.000 m²)
- JKT-02: Hub Cikarang (24.500 m²)
- MDN-03: Hub Medan (9.200 m²)
- MKS-04: Hub Makassar (7.800 m²)
- BPN-05: Hub Balikpapan (6.100 m²)  
1.3. Seluruh fasilitas gudang beroperasi penuh 24 jam dengan skema 3 shift kerja: Shift 1 (08.00–16.00 WIB), Shift 2 (16.00–24.00 WIB), dan Shift 3 (00.00–08.00 WIB).

### 2. KETENTUAN CUT-OFF TIME OUTBOUND
2.1. Batas waktu (*cut-off time*) penerimaan data Sales Order (SO) untuk pengiriman hari yang sama (*same-day dispatch*) ditetapkan seragam pada pukul **14:00 WIB** setiap hari kerja operasional.  
2.2. Dokumen SO yang terverifikasi di sistem ERP SAP Business One sebelum pukul 14:00 WIB wajib ditransmisikan secara otomatis ke WMS "Gudangku v4". Proses pemetikan dan pengemasan pesanan tersebut harus diselesaikan selambat-lambatnya pukul 17:30 WIB pada hari yang sama.  
2.3. Pesanan yang masuk setelah pukul 14:00 WIB otomatis dialokasikan ke Shift 3 untuk diproses sebagai *Next-Day Dispatch* dengan jadwal pemuatan ke armada sebelum pukul 09:30 WIB hari berikutnya.

### 3. METODE DAN AKURASI PROSES PICKING
3.1. Operator *picker* menjalankan instruksi tugas pemetikan menggunakan pemindai nirkabel RF (*Radio Frequency*) Scanner yang terhubung langsung dengan sistem Gudangku v4.  
3.2. Penentuan alokasi lot/batch stok barang wajib mengikuti kaidah sistem:
- **Metode FEFO (*First Expired, First Out*)**: Diterapkan secara mutlak pada produk FMCG, bahan makanan basah/kering, suplemen kesehatan, kosmetik, dan barang dengan masa simpan kedaluwarsa. Sistem Gudangku v4 memblokir pengambilan batch barang dengan sisa kedaluwarsa di bawah 90 hari kalender.
- **Metode FIFO (*First In, First Out*)**: Diterapkan untuk produk *general cargo*, suku cadang industri, pakaian, dan elektronik.  
3.3. **Target Akurasi Picking**: Setiap shift operasional wajib memenuhi target akurasi pengambilan barang minimal sebesar **99,8%** (toleransi deviasi maksimal 0,2%).  
3.4. Selisih barang (*discrepancy*) fisik otomatis menerbitkan tiket investigasi insiden pada Jira Service Management. Kesalahan pemetikan akibat kelalaian personal dikenakan audit operasional dan biaya penanganan ulang stok sebesar Rp50.000 per nomor SKU yang salah.

### 4. STANDAR PACKING DAN PERHITUNGAN BERAT DIMENSI
4.1. **Faktor Berat Volumetrik**: Sesuai regulasi standar industri kargo nasional, perhitungan berat dimensi wajib menggunakan faktor pembagi 6000 dengan rumus matematis:  
$$\text{Berat Volumetrik (kg)} = \frac{\text{Panjang (cm)} \times \text{Lebar (cm)} \times \text{Tinggi (cm)}}{6000}$$  
Petugas packing menimbang koli pada timbangan digital terkalibrasi dan mengukur sisi terluar paket. Besaran beban pengiriman (*chargeable weight*) pada SAP Business One ditetapkan dari nilai tertinggi antara berat aktual timbangan dan berat volumetrik.  
4.2. Spesifikasi bahan kemasan dan proteksi packing ditetapkan berdasarkan kategori barang pada tabel berikut:

| Kategori Barang | Kemasan Luar | Material Proteksi Internal | Standar Segel & Lakban | Label Wajib |
| :--- | :--- | :--- | :--- | :--- |
| **General Cargo** | Box Double Wall K150 | Bubble wrap 1 lapis tebal 5 mm | Lakban cokelat Arunika 50 mm segel-H | Barcode Gudangku v4 & Resi RuteKu |
| **Elektronik & Fragile** | Box Triple Wall K275 + Siku Karton | Bubble wrap 3 lapis + Busa PE 20 mm | Lakban sekuriti (*tamper-evident*) + Strapping | Stiker Fragile & Arah Panah Tegak |
| **FMCG & Makanan** | Master Box K200/M150 | Kantong plastik PE anti-lembab + Silica gel | Lakban Arunika 50 mm lapis ganda | Label FEFO & Tanggal Kedaluwarsa |
| **Cairan Non-B3** | Jeriken pabrik + Peti kayu lapis | Kantong klip kedap + Serbuk penyerap | Lakban anti-air (*waterproof duct tape*) | Stiker Arah Panah & Awas Bahan Cair |

### 5. PROSEDUR SERAH TERIMA KE DRIVER DENGAN DIGITAL POD
5.1. Tim Staging mengelompokkan paket koli berdasarkan rute TMS "RuteKu" dan alokasi daya angkut armada Arunika (total armada 312 unit truk: Tronton 24 unit kapasitas 25 ton, Fuso 52 unit kapasitas 15 ton, CDD 140 unit kapasitas 8 ton, CDE 96 unit kapasitas 4 ton; serta 58 unit van kapasitas 1,2 ton).  
5.2. Tim Staging dan Driver memverifikasi fisik koli secara simultan (*co-scanning*) menggunakan pemindai barcode sebelum koli dinaikkan ke bak muatan.  
5.3. **Penerapan Digital Proof of Delivery (POD)**:  
- Serah terima dilaksanakan secara nirkertas (*paperless*) melalui modul Digital POD pada aplikasi mobile TMS RuteKu yang terpasang pada gawai operasional driver.  
- Driver menandatangani berita acara digital yang merekam titik koordinat GPS gudang, stempel waktu (*timestamp*), nomor polisi kendaraan, dan foto kondisi segel pintu belakang truk.  
- Data penyerahan otomatis memperbarui status muatan di Gudangku v4 dan SAP Business One menjadi *“In-Transit”*.  
5.4. Keterlambatan jadwal keberangkatan armada (*departure delay*) akibat kelalaian operasional gudang yang melebihi batas toleransi 30 menit dikenakan penalti kompensasi armada internal sebesar Rp150.000 per armada.

### 6. PENGESAHAN DOKUMEN
Dokumen SOP ini disahkan dan mengikat secara hukum operasional terhitung mulai tanggal 15 Januari 2026.

- **Ditinjau oleh:** Hendra Gunawan (Chief Technology Officer)
- **Disetujui oleh:** Yusuf Halim (Chief Operating Officer)
- **Mengetahui:** Ratna Wijayakusuma (Chief Executive Officer)
