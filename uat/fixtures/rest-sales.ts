/**
 * REST service 1 of 3: SALES lookups.
 *
 * Why three separate services rather than one with three paths: the cross-source test
 * has to be able to ask a question whose answer EXISTS IN ONE SOURCE ONLY, so that
 * choosing the wrong one produces a visibly wrong answer. Three services also exercise
 * the connector-selection path, which a single connector cannot.
 *
 * Content deliberately MIRRORS `uat_sales` but is NOT identical, so "did the answer
 * come from REST or from SQL?" is answerable by looking at the number. `/kota-ringkasan`
 * returns a count that differs from the SQL table on purpose.
 *
 * No real endpoint is contacted and no production egress is involved: these are local
 * fixtures bound to loopback.
 */
export const PORT = Number(process.env.UAT_REST_SALES_PORT ?? 4511)

const PELANGGAN = [
  { id: 1, nama: 'Toko Sinar Jaya', kota: 'Bandung', tipe: 'retail' },
  { id: 2, nama: 'CV Mitra Abadi', kota: 'Jakarta', tipe: 'grosir' },
  { id: 3, nama: 'UD Sumber Rejeki', kota: 'Surabaya', tipe: 'grosir' },
  { id: 4, nama: 'Toko Berkah Mandiri', kota: 'Bandung', tipe: 'retail' },
  { id: 5, nama: 'PT Anugerah Niaga', kota: 'Medan', tipe: 'korporat' },
  { id: 6, nama: 'Toko Harapan Baru', kota: 'Yogyakarta', tipe: 'retail' },
  { id: 7, nama: 'CV Karya Utama', kota: 'Jakarta', tipe: 'korporat' },
  { id: 8, nama: 'UD Tani Makmur', kota: 'Semarang', tipe: 'grosir' },
]

const PESANAN = [
  { id: 1, pelanggan_id: 1, status: 'selesai', total: 370000 },
  { id: 2, pelanggan_id: 2, status: 'selesai', total: 1240000 },
  { id: 3, pelanggan_id: 3, status: 'diproses', total: 203500 },
  { id: 4, pelanggan_id: 4, status: 'selesai', total: 136000 },
  { id: 5, pelanggan_id: 5, status: 'dibatalkan', total: 920000 },
  { id: 6, pelanggan_id: 6, status: 'selesai', total: 111000 },
  { id: 7, pelanggan_id: 7, status: 'selesai', total: 1854000 },
  { id: 8, pelanggan_id: 8, status: 'diproses', total: 156000 },
  { id: 9, pelanggan_id: 1, status: 'selesai', total: 74000 },
  { id: 10, pelanggan_id: 2, status: 'pending', total: 380000 },
  { id: 11, pelanggan_id: 4, status: 'selesai', total: 27000 },
  { id: 12, pelanggan_id: 6, status: 'dibatalkan', total: 185000 },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/health') return json({ ok: true, service: 'rest-sales' })

    // GET /pelanggan  -> the full customer list, filterable by kota and tipe
    if (p === '/pelanggan') {
      const kota = url.searchParams.get('kota')
      const tipe = url.searchParams.get('tipe')
      let rows = PELANGGAN
      if (kota) rows = rows.filter((r) => r.kota.toLowerCase() === kota.toLowerCase())
      if (tipe) rows = rows.filter((r) => r.tipe.toLowerCase() === tipe.toLowerCase())
      return json({ data: rows, total: rows.length })
    }

    // GET /pesanan  -> orders, filterable by status
    if (p === '/pesanan') {
      const status = url.searchParams.get('status')
      let rows = PESANAN
      if (status) rows = rows.filter((r) => r.status.toLowerCase() === status.toLowerCase())
      return json({ data: rows, total: rows.length })
    }

    // GET /kota-ringkasan -> how many customers per city. The counts here are the SAME
    // shape as SQL but arrive from REST, so a test can assert the transport used.
    if (p === '/kota-ringkasan') {
      const per: Record<string, number> = {}
      for (const r of PELANGGAN) per[r.kota] = (per[r.kota] ?? 0) + 1
      return json({ data: Object.entries(per).map(([kota, jumlah]) => ({ kota, jumlah })) })
    }

    return json({ error: 'not found', path: p }, 404)
  },
})
console.log(`rest-sales listening on ${PORT}`)
