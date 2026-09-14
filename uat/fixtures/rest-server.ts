/**
 * UAT fixture: a real REST API the application can call as a data source.
 *
 * It is a plain Bun server on 127.0.0.1:4501 -- NOT a mock inside the test
 * process. That distinction is the point of a UAT: the app must resolve a host,
 * open a socket, send a real HTTP request, parse the response and shape it, exactly
 * as it would for a customer's API. A mock would bypass every one of those steps,
 * including the SSRF guard that a real host has to pass.
 *
 * Endpoints are chosen so a WRONG call is visibly wrong:
 *   - /orders filters by status, so ignoring the filter returns 12 rows instead of 10
 *   - /orders?page= returns paginated envelopes, so reading the wrong field yields 0
 *   - /slow sleeps 3s, so a missing timeout would hang rather than fail
 *   - /boom returns 500, so an unhandled error surfaces instead of being swallowed
 *   - /auth requires a bearer token, so a missing header is a 401, not empty data
 */
export const PORT = Number(process.env.UAT_REST_PORT ?? 4501)
const AUTH_TOKEN = 'uat-token-9f3a'

const ORDERS = [
  { id: 1, nomor: 'ORD-0001', pelanggan: 'Toko Sinar Jaya', kota: 'Jakarta', total: 240000, status: 'selesai', tanggal: '2024-03-01' },
  { id: 2, nomor: 'ORD-0002', pelanggan: 'Toko Sinar Jaya', kota: 'Jakarta', total: 300000, status: 'selesai', tanggal: '2024-03-15' },
  { id: 3, nomor: 'ORD-0003', pelanggan: 'PT Maju Bersama', kota: 'Bandung', total: 4500000, status: 'selesai', tanggal: '2024-03-04' },
  { id: 4, nomor: 'ORD-0004', pelanggan: 'CV Karya Abadi', kota: 'Surabaya', total: 180000, status: 'selesai', tanggal: '2024-03-09' },
  { id: 5, nomor: 'ORD-0005', pelanggan: 'CV Karya Abadi', kota: 'Surabaya', total: 120000, status: 'selesai', tanggal: '2024-04-02' },
  { id: 6, nomor: 'ORD-0006', pelanggan: 'UD Berkah Mulia', kota: 'Jakarta', total: 390000, status: 'selesai', tanggal: '2024-04-11' },
  { id: 7, nomor: 'ORD-0007', pelanggan: 'PT Maju Bersama', kota: 'Bandung', total: 4500000, status: 'dibatalkan', tanggal: '2024-04-18' },
  { id: 8, nomor: 'ORD-0008', pelanggan: 'Toko Sinar Jaya', kota: 'Jakarta', total: 126000, status: 'selesai', tanggal: '2024-05-06' },
  { id: 9, nomor: 'ORD-0009', pelanggan: 'CV Karya Abadi', kota: 'Surabaya', total: 150000, status: 'selesai', tanggal: '2024-05-21' },
  { id: 10, nomor: 'ORD-0010', pelanggan: 'UD Berkah Mulia', kota: 'Jakarta', total: 360000, status: 'selesai', tanggal: '2024-06-03' },
  { id: 11, nomor: 'ORD-0011', pelanggan: 'PT Maju Bersama', kota: 'Bandung', total: 78000, status: 'diproses', tanggal: '2024-06-19' },
  { id: 12, nomor: 'ORD-0012', pelanggan: 'Toko Sinar Jaya', kota: 'Jakarta', total: 3000000, status: 'selesai', tanggal: '2024-06-25' },
]

const STOK = [
  { sku: 'SKU-001', nama: 'Kopi Arabika 1kg', kategori: 'Minuman', stok: 42, gudang: 'Jakarta' },
  { sku: 'SKU-002', nama: 'Teh Hijau 500g', kategori: 'Minuman', stok: 8, gudang: 'Jakarta' },
  { sku: 'SKU-003', nama: 'Gula Pasir 1kg', kategori: 'Sembako', stok: 150, gudang: 'Bandung' },
  { sku: 'SKU-004', nama: 'Beras Premium 5kg', kategori: 'Sembako', stok: 3, gudang: 'Bandung' },
  { sku: 'SKU-005', nama: 'Minyak Goreng 2L', kategori: 'Sembako', stok: 0, gudang: 'Surabaya' },
  { sku: 'SKU-006', nama: 'Mesin Kopi Otomatis', kategori: 'Peralatan', stok: 2, gudang: 'Jakarta' },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (p === '/health') return json({ ok: true, service: 'uat-rest-fixture' })

    // Requires a bearer token: a source configured without one gets 401, not [].
    if (p.startsWith('/secure')) {
      if (req.headers.get('authorization') !== `Bearer ${AUTH_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401)
      }
      return json({ ok: true, secret: 'nilai-terlindungi' })
    }

    if (p === '/orders') {
      const status = url.searchParams.get('status')
      const kota = url.searchParams.get('kota')
      let rows = ORDERS
      if (status) rows = rows.filter((o) => o.status === status)
      if (kota) rows = rows.filter((o) => o.kota.toLowerCase() === kota.toLowerCase())
      // Paginated envelope: the array is under `data`, not at the top level. A reader
      // that assumes a bare array returns zero rows rather than erroring.
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('per_page') ?? '100')
      const start = (page - 1) * perPage
      const slice = rows.slice(start, start + perPage)
      return json({ data: slice, meta: { page, per_page: perPage, total: rows.length, total_pages: Math.max(1, Math.ceil(rows.length / perPage)) } })
    }

    if (p === '/stok') {
      const kategori = url.searchParams.get('kategori')
      const rows = kategori ? STOK.filter((s) => s.kategori.toLowerCase() === kategori.toLowerCase()) : STOK
      return json(rows)
    }

    if (p === '/slow') {
      await new Promise((r) => setTimeout(r, 3000))
      return json({ ok: true, note: 'responded after 3s' })
    }

    if (p === '/boom') return json({ error: 'internal server error' }, 500)
    if (p === '/teapot') return json({ error: 'I am a teapot' }, 418)

    return json({ error: 'not found', path: p }, 404)
  },
})

console.log(`UAT REST fixture listening on http://127.0.0.1:${PORT}`)
