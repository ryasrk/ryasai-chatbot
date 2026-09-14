/**
 * REST service 2 of 3: HR lookups (port 4512).
 *
 * A different DOMAIN from sales on purpose: the aggregate-route test needs a question
 * that only one service can answer, and "jumlah karyawan" must not be satisfiable by
 * the sales service or by the logistics one.
 */
export const PORT = Number(process.env.UAT_REST_HR_PORT ?? 4512)

const KARYAWAN = [
  { id: 1, nama: 'Andi Pratama', departemen: 'Teknologi', jabatan: 'Software Engineer', aktif: true },
  { id: 2, nama: 'Rina Marlina', departemen: 'Teknologi', jabatan: 'QA Engineer', aktif: true },
  { id: 3, nama: 'Joko Susilo', departemen: 'Keuangan', jabatan: 'Accountant', aktif: true },
  { id: 4, nama: 'Maya Sari', departemen: 'Keuangan', jabatan: 'Finance Manager', aktif: true },
  { id: 5, nama: 'Hendra Gunawan', departemen: 'Operasional', jabatan: 'Supervisor', aktif: true },
  { id: 6, nama: 'Lina Kusuma', departemen: 'Operasional', jabatan: 'Staf Operasional', aktif: true },
  { id: 7, nama: 'Bayu Setiawan', departemen: 'SDM', jabatan: 'HR Specialist', aktif: true },
  { id: 8, nama: 'Citra Dewi', departemen: 'Teknologi', jabatan: 'Data Analyst', aktif: true },
  { id: 9, nama: 'Eko Prasetyo', departemen: 'Operasional', jabatan: 'Staf Operasional', aktif: false },
  { id: 10, nama: 'Fitri Handayani', departemen: 'SDM', jabatan: 'Recruiter', aktif: true },
]

const DEPARTEMEN = [
  { id: 1, nama: 'Teknologi', kepala: 'Budi Santoso', jumlah_anggota: 3 },
  { id: 2, nama: 'Keuangan', kepala: 'Siti Nurhaliza', jumlah_anggota: 2 },
  { id: 3, nama: 'Operasional', kepala: 'Agus Wijaya', jumlah_anggota: 3 },
  { id: 4, nama: 'SDM', kepala: 'Dewi Lestari', jumlah_anggota: 2 },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/health') return json({ ok: true, service: 'rest-hr' })

    // GET /karyawan -> staff, filterable by departemen and aktif
    if (p === '/karyawan') {
      const dep = url.searchParams.get('departemen')
      const aktif = url.searchParams.get('aktif')
      let rows = KARYAWAN
      if (dep) rows = rows.filter((r) => r.departemen.toLowerCase() === dep.toLowerCase())
      if (aktif !== null) rows = rows.filter((r) => String(r.aktif) === aktif.toLowerCase())
      return json({ data: rows, total: rows.length })
    }

    // GET /departemen -> departments with their headcount
    if (p === '/departemen') {
      return json({ data: DEPARTEMEN, jumlah: DEPARTEMEN.length })
    }

    // GET /karyawan-aktif -> ONLY the active staff, a server-side filtered view
    if (p === '/karyawan-aktif') {
      const rows = KARYAWAN.filter((r) => r.aktif)
      return json({ data: rows, total: rows.length })
    }

    return json({ error: 'not found', path: p }, 404)
  },
})
console.log(`rest-hr listening on ${PORT}`)
