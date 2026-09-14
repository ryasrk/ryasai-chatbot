/**
 * REST service 3 of 3: LOGISTICS lookups (port 4513).
 *
 * Holds the stock and shipment views. `/stok-rendah` exists specifically so a
 * question about LOW STOCK can be answered by REST even though the same concept is
 * also reachable through the logistics SQL database -- that overlap is what makes the
 * SQL-vs-REST choice measurable rather than theoretical.
 */
export const PORT = Number(process.env.UAT_REST_LOGISTICS_PORT ?? 4513)

const STOK = [
  { gudang: 'Gudang Utama', nama_barang: 'Kopi Arabika 1kg', kategori: 'Minuman', jumlah: 120 },
  { gudang: 'Gudang Utama', nama_barang: 'Teh Hijau Premium 500g', kategori: 'Minuman', jumlah: 85 },
  { gudang: 'Gudang Utama', nama_barang: 'Beras Pandan Wangi 5kg', kategori: 'Sembako', jumlah: 240 },
  { gudang: 'Gudang Utama', nama_barang: 'Gula Pasir 1kg', kategori: 'Sembako', jumlah: 500 },
  { gudang: 'Gudang Utama', nama_barang: 'Minyak Goreng 2L', kategori: 'Sembako', jumlah: 220 },
  { gudang: 'Gudang Bandung', nama_barang: 'Kopi Arabika 1kg', kategori: 'Minuman', jumlah: 45 },
  { gudang: 'Gudang Bandung', nama_barang: 'Minyak Goreng 2L', kategori: 'Sembako', jumlah: 60 },
  { gudang: 'Gudang Bandung', nama_barang: 'Kemasan Plastik 100pcs', kategori: 'Peralatan', jumlah: 300 },
  { gudang: 'Gudang Surabaya', nama_barang: 'Beras Pandan Wangi 5kg', kategori: 'Sembako', jumlah: 180 },
  { gudang: 'Gudang Surabaya', nama_barang: 'Label Stiker 500pcs', kategori: 'Peralatan', jumlah: 150 },
  { gudang: 'Gudang Surabaya', nama_barang: 'Teh Hijau Premium 500g', kategori: 'Minuman', jumlah: 95 },
  { gudang: 'Gudang Surabaya', nama_barang: 'Gula Pasir 1kg', kategori: 'Sembako', jumlah: 410 },
]

const PENGIRIMAN = [
  { kode: 'SHP-001', asal: 'Gudang Utama', tujuan: 'Bandung', status: 'terkirim', berat_kg: 120.5 },
  { kode: 'SHP-002', asal: 'Gudang Utama', tujuan: 'Medan', status: 'dalam_perjalanan', berat_kg: 340 },
  { kode: 'SHP-003', asal: 'Gudang Bandung', tujuan: 'Yogyakarta', status: 'terkirim', berat_kg: 85.25 },
  { kode: 'SHP-004', asal: 'Gudang Surabaya', tujuan: 'Semarang', status: 'terkirim', berat_kg: 210.75 },
  { kode: 'SHP-005', asal: 'Gudang Utama', tujuan: 'Surabaya', status: 'tertunda', berat_kg: 95 },
  { kode: 'SHP-006', asal: 'Gudang Surabaya', tujuan: 'Jakarta', status: 'dalam_perjalanan', berat_kg: 400 },
  { kode: 'SHP-007', asal: 'Gudang Bandung', tujuan: 'Bandung', status: 'terkirim', berat_kg: 60 },
  { kode: 'SHP-008', asal: 'Gudang Utama', tujuan: 'Yogyakarta', status: 'terkirim', berat_kg: 175.5 },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/health') return json({ ok: true, service: 'rest-logistics' })

    // GET /stok -> stock rows, filterable by gudang and kategori
    if (p === '/stok') {
      const gudang = url.searchParams.get('gudang')
      const kategori = url.searchParams.get('kategori')
      let rows = STOK
      if (gudang) rows = rows.filter((r) => r.gudang.toLowerCase() === gudang.toLowerCase())
      if (kategori) rows = rows.filter((r) => r.kategori.toLowerCase() === kategori.toLowerCase())
      return json({ data: rows, total: rows.length })
    }

    // GET /stok-rendah -> items at or below a threshold (default 100)
    if (p === '/stok-rendah') {
      const batas = Number(url.searchParams.get('batas') ?? 100)
      const rows = STOK.filter((r) => r.jumlah <= batas)
      return json({ data: rows, total: rows.length, batas, keterangan: `Barang dengan jumlah stok <= ${batas} dianggap stok rendah` })
    }

    // GET /pengiriman -> shipments, filterable by status
    if (p === '/pengiriman') {
      const status = url.searchParams.get('status')
      let rows = PENGIRIMAN
      if (status) rows = rows.filter((r) => r.status.toLowerCase() === status.toLowerCase())
      return json({ data: rows, total: rows.length })
    }

    return json({ error: 'not found', path: p }, 404)
  },
})
console.log(`rest-logistics listening on ${PORT}`)
