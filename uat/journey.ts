/**
 * UAT — User Acceptance Test of the three data planes, walked the way a USER
 * walks them.
 *
 * The point of a UAT is the journey, not the units. Each step below is an HTTP
 * call to the running application, in the order an operator would actually make
 * them: sign in, connect a source, wait for the app to understand it, ask a
 * question in plain Indonesian, then READ THE ANSWER AND CHECK IT. A step that
 * returns 200 but a wrong number is a FAILURE -- status codes are not acceptance.
 *
 * Steps record what the user would SEE, so a failure report is readable by
 * someone who does not know the code: "asked X, expected 9,366,000, got 13,944,000".
 *
 * Usage: bun uat/journey.ts [--plane vector|db|rest|all] [--json out.json]
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const argv = process.argv.slice(2)
const PLANE = argv.includes('--plane') ? argv[argv.indexOf('--plane') + 1] : 'all'
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null

// Komponen koneksi dipakai terpisah, sesuai kontrak route (bukan connection string).
const UAT_DB_PARTS = { host: 'localhost', port: 5432, username: 'ryasai', password: 'ryasai_dev', database_name: 'uat_demo' }
// The fixture is bound to loopback, and the connector route runs the SSRF blocklist
// on create -- correctly, so `127.0.0.1` is REFUSED. A real self-hosted source is
// reached the way the operator declares it: a NAME in LLM_ALLOWED_HOSTS. The fixture
// is therefore addressed by a NAME, `127.0.0.1.nip.io`, which resolves to loopback
// without needing to edit /etc/hosts, and the server runs with that name in
// LLM_ALLOWED_HOSTS. That exercises the supported path instead of weakening the
// guard for the test.
const UAT_REST = 'http://127.0.0.1.nip.io:4501'
const UAT_REST_TOKEN = 'uat-token-9f3a'

interface Step {
  plane: string
  step: string
  /** What the user is trying to accomplish, in their words. */
  intent: string
  ok: boolean
  detail: string
  expected?: string
  got?: string
}
const steps: Step[] = []

function record(s: Step) {
  steps.push(s)
  console.log(`${s.ok ? 'PASS' : 'FAIL'} [${s.plane}] ${s.step}`)
  console.log(`       niat  : ${s.intent}`)
  console.log(`       hasil : ${s.detail}`)
  if (!s.ok && s.expected !== undefined) console.log(`       HARAP : ${s.expected}\n       DAPAT : ${s.got}`)
}

const TOKEN = await (async () => {
  const p = Bun.spawnSync(['bun', 'trial/live/session.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const out = new TextDecoder().decode(p.stdout).trim().split('\n').pop() ?? ''
  return (JSON.parse(out) as { token: string }).token
})()

const H = { Cookie: `x-active-user=${TOKEN}` }
const HJ = { ...H, 'Content-Type': 'application/json' }

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } })
  const text = await res.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, body, text }
}

/** Ask a question through the real chat path and return the assembled answer. */
async function ask(question: string): Promise<{ answer: string; error: string; ms: number }> {
  let s: Awaited<ReturnType<typeof api>>
  try {
    s = await api('/api/chat/sessions', { method: 'POST', headers: HJ, body: '{}' })
  } catch (e) {
    return { answer: '', error: `session create threw: ${errText(e)}`, ms: 0 }
  }
  const sessionId = s.body?.id
  if (!sessionId) return { answer: '', error: `session create failed: ${s.status}`, ms: 0 }
  const t0 = Date.now()
  // A reasoning model can hold a turn open for minutes, and MID-STREAM the socket
  // can fail rather than the server sending an `error` event -- observed as a bare
  // `TimeoutError: The operation timed out.` whose `stack` is the empty string, so an
  // unguarded throw loses the whole run. Every failure here is turned into a graded
  // FAIL instead: a UAT must report what went wrong, not die on it.
  let res: Response
  try {
    res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/send`, {
      method: 'POST', headers: HJ, body: JSON.stringify({ text: question }),
    })
  } catch (e) {
    return { answer: '', error: `send threw: ${errText(e)}`, ms: Date.now() - t0 }
  }
  if (!res.body) return { answer: '', error: 'no response body', ms: Date.now() - t0 }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', event = '', answer = '', error = ''
  while (true) {
    let done = false, value: Uint8Array | undefined
    try {
      const chunk = await reader.read()
      done = chunk.done; value = chunk.value
    } catch (e) {
      error = `stream read threw: ${errText(e)}`
      break
    }
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('event: ')) { event = t.slice(7); continue }
      if (!t.startsWith('data: ')) continue
      let p: any
      try { p = JSON.parse(t.slice(6)) } catch { continue }
      if (event === 'token' && typeof p.content === 'string') answer += p.content
      else if (event === 'answer' && typeof p.content === 'string') answer = p.content
      else if (event === 'error') error = String(p.message ?? p.code ?? 'error')
      event = ''
    }
  }
  return { answer, error, ms: Date.now() - t0 }
}

/** Normalise an answer so a number comparison is about VALUE, not formatting. */
/**
 * Readable text for any thrown value.
 *
 * A DOMException in Bun arrives with `stack: ''` and serialises to `{}` through
 * JSON.stringify, so the message that says WHAT timed out is lost unless it is read
 * from `name` and `message` explicitly.
 */
function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown }
    if (o.name || o.message) return `${String(o.name ?? 'Error')}: ${String(o.message ?? '')}`
  }
  return String(e)
}

const digits = (s: string) => s.replace(/[^0-9]/g, '')
function expectNumber(plane: string, step: string, intent: string, q: string, expected: number, answer: { answer: string; error: string; ms: number }) {
  const got = digits(answer.answer)
  const want = String(expected)
  const ok = !answer.error && got.includes(want)
  record({
    plane, step, intent, ok,
    detail: answer.error ? `ERROR: ${answer.error}` : `${answer.ms}ms :: ${answer.answer.replace(/\s+/g, ' ').slice(0, 150)}`,
    expected: want, got: got || '(tidak ada angka)',
  })
}
function expectContains(plane: string, step: string, intent: string, expected: string[], answer: { answer: string; error: string; ms: number }) {
  const low = answer.answer.toLowerCase()
  const missing = expected.filter((e) => !low.includes(e.toLowerCase()))
  const ok = !answer.error && missing.length === 0
  record({
    plane, step, intent, ok,
    detail: answer.error ? `ERROR: ${answer.error}` : `${answer.ms}ms :: ${answer.answer.replace(/\s+/g, ' ').slice(0, 150)}`,
    expected: expected.join(' + '), got: missing.length ? `tidak mengandung: ${missing.join(', ')}` : 'semua ada',
  })
}

// ===========================================================================
// PLANE 1 — VECTOR KNOWLEDGE
// ===========================================================================
if (PLANE === 'all' || PLANE === 'vector') {
  const KB = [
    { file: 'uat/fixtures/knowledge/01-kebijakan-cuti.md', category: 'HR', desc: 'Kebijakan cuti karyawan' },
    { file: 'uat/fixtures/knowledge/02-sop-layanan-pelanggan.md', category: 'Operasional', desc: 'SOP layanan pelanggan dan keluhan' },
    { file: 'uat/fixtures/knowledge/03-panduan-onboarding.md', category: 'HR', desc: 'Panduan onboarding karyawan baru' },
    { file: 'uat/fixtures/knowledge/04-panduan-keamanan-data.md', category: 'Keamanan', desc: 'Panduan keamanan dan klasifikasi data' },
  ]
  const uploaded: string[] = []
  for (const d of KB) {
    const bytes = readFileSync(d.file)
    const fd = new FormData()
    fd.set('file', new File([bytes], d.file.split('/').pop()!, { type: 'text/markdown' }))
    fd.set('category', d.category)
    fd.set('description', d.desc)
    const r = await api('/api/documents', { method: 'POST', body: fd })
    const id = r.body?.document?.id ?? r.body?.id
    if (id) uploaded.push(id)
    record({
      plane: 'vector', step: `unggah "${d.file.split('/').pop()}"`,
      intent: 'Saya mengunggah dokumen kebijakan supaya bisa ditanyakan',
      ok: r.status < 300 && !!id,
      detail: `HTTP ${r.status} ${id ? `id=${id}` : r.text.slice(0, 120)}`,
    })
  }

  // The user waits for indexing, then checks it happened. Asking a question before
  // indexing would fail for a reason that is NOT the retrieval quality.
  const ready = await (async () => {
    for (let i = 0; i < 40; i++) {
      const r = await api('/api/documents')
      const items: any[] = r.body?.items ?? r.body?.documents ?? []
      const done = items.filter((x) => uploaded.includes(x.id) && ['ready', 'READY', 'indexed'].includes(String(x.status)))
      if (done.length >= uploaded.length) return done.length
      await new Promise((res) => setTimeout(res, 3000))
    }
    return -1
  })()
  record({
    plane: 'vector', step: 'tunggu dokumen selesai diindeks',
    intent: 'Saya menunggu sistem selesai memproses dokumen',
    ok: ready === uploaded.length,
    detail: ready < 0 ? 'timeout menunggu status ready' : `${ready}/${uploaded.length} dokumen siap`,
  })

  expectNumber('vector', 'tanya: cuti tahunan', 'Saya ingin tahu jatah cuti tahunan saya',
    'Berapa hari cuti tahunan untuk karyawan tetap? Jawab angkanya saja.', 12, await ask('Berapa hari cuti tahunan untuk karyawan tetap? Jawab angkanya saja.'))
  expectNumber('vector', 'tanya: cuti melahirkan', 'Saya ingin tahu hak cuti melahirkan',
    'Berapa hari cuti melahirkan? Jawab angkanya saja.', 90, await ask('Berapa hari cuti melahirkan? Jawab angkanya saja.'))
  expectNumber('vector', 'tanya: waktu respon kritis', 'Berapa lama saya harus menunggu kalau layanan mati total',
    'Keluhan kritis harus direspon dalam berapa menit? Jawab angkanya saja.', 15, await ask('Keluhan kritis harus direspon dalam berapa menit? Jawab angkanya saja.'))
  expectNumber('vector', 'tanya: masa percobaan', 'Berapa lama masa percobaan karyawan baru',
    'Berapa bulan masa percobaan karyawan baru? Jawab angkanya saja.', 3, await ask('Berapa bulan masa percobaan karyawan baru? Jawab angkanya saja.'))
  expectNumber('vector', 'tanya: panjang kata sandi', 'Berapa panjang minimal kata sandi',
    'Berapa karakter minimal untuk kata sandi? Jawab angkanya saja.', 14, await ask('Berapa karakter minimal untuk kata sandi? Jawab angkanya saja.'))
  expectContains('vector', 'tanya: sisa cuti hangus', 'Kapan sisa cuti saya hangus',
    ['31 maret'], await ask('Sisa cuti tahunan di atas 6 hari hangus pada tanggal berapa?'))

  // A question the documents DO NOT answer must not be answered from imagination.
  const off = await ask('Berapa harga tiket pesawat Jakarta ke Bali hari ini?')
  const low = off.answer.toLowerCase()
  const invented = /\b\d{1,3}(\.\d{3})+\b/.test(low) && !/tidak (memiliki|ada|tersedia)|tidak dapat|di luar|tidak tahu|maaf/i.test(low)
  record({
    plane: 'vector', step: 'tanya hal yang TIDAK ada di dokumen',
    intent: 'Saya tidak ingin sistem mengarang jawaban yang tidak ada di dokumen',
    ok: !off.error && !invented,
    detail: `${off.ms}ms :: ${off.answer.replace(/\s+/g, ' ').slice(0, 160)}`,
    expected: 'mengaku tidak tahu / mengarahkan ke sumber lain', got: invented ? 'mengarang angka' : 'tidak mengarang',
  })
}

// ===========================================================================
// PLANE 2 — DATABASE
// ===========================================================================
if (PLANE === 'all' || PLANE === 'db') {
  const created = await api('/api/integrations', {
    method: 'POST', headers: HJ,
    // Contract read from the route, not guessed: `type` must be the literal
    // 'DATABASE' (a REST source goes to a different endpoint entirely), `provider`
    // must be one of ALLOWED_DATABASE_PROVIDERS, and the config is SPLIT FIELDS
    // rather than a connection string. Sending the wrong shape returns 400 with a
    // readable message, which is what this UAT is for -- but a UAT that only ever
    // exercises the happy path would never have discovered it.
    body: JSON.stringify({
      name: 'UAT Demo Company DB', type: 'DATABASE', provider: 'POSTGRESQL',
      config: UAT_DB_PARTS,
    }),
  })
  const integId = created.body?.data?.id ?? created.body?.id
  record({
    plane: 'db', step: 'hubungkan database perusahaan',
    intent: 'Saya menghubungkan database penjualan kami',
    ok: created.status < 300 && !!integId,
    detail: `HTTP ${created.status} ${integId ? `id=${integId}` : created.text.slice(0, 140)}`,
  })

  if (integId) {
    const t = await api(`/api/integrations/${integId}/test`, { method: 'POST', headers: HJ })
    record({
      plane: 'db', step: 'uji koneksi',
      intent: 'Saya memastikan koneksi database benar sebelum dipakai',
      ok: t.status < 300 && (t.body?.ok !== false),
      detail: `HTTP ${t.status} ${JSON.stringify(t.body).slice(0, 140)}`,
    })
    // The app reflects the schema so the router can pick tables. Without this the
    // questions below would fail for a setup reason rather than a routing reason.
    // GET, not POST: the schema route exports GET (reflect) and PATCH (edit).
    const sc = await api(`/api/integrations/${integId}/schema`, { method: 'GET', headers: HJ })
    record({
      plane: 'db', step: 'baca skema (reflection)',
      intent: 'Saya biarkan sistem membaca tabel yang tersedia',
      ok: sc.status < 300,
      detail: `HTTP ${sc.status} ${JSON.stringify(sc.body).slice(0, 160)}`,
    })

    // The decisive checks: a number that can only be right if the JOIN, the status
    // filter and the row count are all correct.
    expectNumber('db', 'tanya: pendapatan selesai', 'Saya ingin total penjualan yang benar-benar terjadi (bukan yang dibatalkan)',
      'Berapa total nilai penjualan dari pesanan yang berstatus selesai?', 9366000,
      await ask('Berapa total nilai penjualan dari pesanan yang berstatus selesai? Jawab angkanya saja.'))
    expectNumber('db', 'tanya: jumlah pesanan dibatalkan', 'Saya ingin tahu berapa pesanan yang batal',
      'Berapa jumlah pesanan yang dibatalkan?', 1,
      await ask('Ada berapa pesanan yang berstatus dibatalkan? Jawab angkanya saja.'))
    expectNumber('db', 'tanya: cabang tanpa penjualan', 'Saya ingin tahu cabang mana yang belum menjual',
      'Berapa jumlah cabang yang tidak memiliki pesanan selesai sama sekali?', 1,
      await ask('Ada berapa cabang yang sama sekali tidak punya pesanan selesai? Jawab angkanya saja.'))
    expectNumber('db', 'tanya: jumlah pelanggan', 'Saya ingin tahu berapa pelanggan terdaftar',
      'Berapa jumlah pelanggan yang terdaftar?', 5,
      await ask('Ada berapa pelanggan yang terdaftar? Jawab angkanya saja.'))
    expectContains('db', 'tanya: kota pelanggan tanpa pesanan', 'Saya ingin tahu siapa pelanggan yang belum pernah memesan',
      ['sejahtera'], await ask('Pelanggan mana yang belum pernah membuat pesanan sama sekali? Sebutkan namanya.'))
  } else {
    record({
      plane: 'db', step: 'lanjutan UAT database',
      intent: 'Semua langkah berikutnya bergantung pada langkah ini',
      ok: false, detail: 'integrasi gagal dibuat, sisa langkah dilewati',
    })
  }
}

// ===========================================================================
// PLANE 3 — REST API
// ===========================================================================
if (PLANE === 'all' || PLANE === 'rest') {
  const conn = await api('/api/data-sources/rest-connectors', {
    method: 'POST', headers: HJ,
    body: JSON.stringify({
      name: 'UAT Order Service', baseUrl: UAT_REST, authType: 'BEARER',
      authConfig: { token: UAT_REST_TOKEN }, timeoutMs: 10000,
    }),
  })
  const connId = conn.body?.data?.id
  record({
    plane: 'rest', step: 'hubungkan REST API eksternal',
    intent: 'Saya menghubungkan API pesanan perusahaan kami',
    ok: conn.status < 300 && !!connId,
    detail: `HTTP ${conn.status} ${connId ? `id=${connId}` : conn.text.slice(0, 140)}`,
  })

  if (connId) {
    const endpoints = [
      { method: 'GET', path: '/orders', description: 'Daftar pesanan. Filter dengan query status (selesai, dibatalkan, diproses) atau kota. Hasil ada di field data.', parameterSchema: { status: 'string', kota: 'string' }, sampleResponse: { data: [{ nomor: 'ORD-0001', total: 240000, status: 'selesai', kota: 'Jakarta' }] } },
      { method: 'GET', path: '/stok', description: 'Daftar stok barang per gudang. Filter dengan query kategori (Minuman, Sembako, Peralatan).', parameterSchema: { kategori: 'string' }, sampleResponse: [{ sku: 'SKU-001', nama: 'Kopi Arabika 1kg', stok: 42 }] },
      { method: 'GET', path: '/secure', description: 'Endpoint yang memerlukan token bearer. Mengembalikan nilai terlindungi.', sampleResponse: { ok: true, secret: 'nilai-terlindungi' } },
    ]
    let okCount = 0
    for (const e of endpoints) {
      const r = await api(`/api/data-sources/rest-connectors/${connId}/endpoints`, { method: 'POST', headers: HJ, body: JSON.stringify(e) })
      if (r.status < 300) okCount++
      record({
        plane: 'rest', step: `daftarkan endpoint ${e.method} ${e.path}`,
        intent: 'Saya memberi tahu sistem endpoint mana yang boleh dipanggil',
        ok: r.status < 300, detail: `HTTP ${r.status} ${r.status < 300 ? '' : r.text.slice(0, 140)}`,
      })
    }

    // The test route REQUIRES a path and a method; an empty body is correctly
    // refused with "Test path is required." (HTTP 400). A user clicking "Test" in the
    // UI picks an endpoint, so the journey must pick one too rather than post `{}`.
    const t = await api(`/api/data-sources/rest-connectors/${connId}/test`, {
      method: 'POST', headers: HJ,
      body: JSON.stringify({ method: 'GET', path: '/orders', query: { status: 'selesai' } }),
    })
    record({
      plane: 'rest', step: 'uji koneksi API',
      intent: 'Saya memastikan API bisa dijangkau dan mengembalikan data',
      // Assert the DATA, not only the status: a 200 with an empty body would pass a
      // status-only check while proving nothing about reachability.
      ok: t.status < 300 && JSON.stringify(t.body ?? '').includes('ORD-'),
      detail: `HTTP ${t.status} ${JSON.stringify(t.body).slice(0, 180)}`,
      expected: 'HTTP < 300 dan berisi data pesanan (ORD-)',
      got: t.status < 300 ? 'tidak ada data pesanan pada respons' : `HTTP ${t.status}`,
    })

    // Allow the LLM first-scan to write endpoint descriptions; generateRestCall
    // matches questions against those, so asking immediately can fail on setup.
    await new Promise((r) => setTimeout(r, 8000))

    if (okCount > 0) {
      expectNumber('rest', 'tanya: pesanan selesai lewat API', 'Saya ingin tahu nilai pesanan selesai dari sistem pesanan',
        'Dari API pesanan, berapa nilai pesanan yang berstatus selesai?', 9366000,
        await ask('Dari API pesanan, berapa total nilai pesanan yang berstatus selesai? Jawab angkanya saja.'))
      expectNumber('rest', 'tanya: stok menipis', 'Saya ingin tahu barang yang stoknya hampir habis',
        'Dari API stok, ada berapa item yang stoknya 5 atau kurang?', 3,
        await ask('Dari API stok, berapa item yang stoknya 5 atau kurang? Jawab angkanya saja.'))
      expectContains('rest', 'tanya: endpoint terlindungi', 'Saya ingin membuktikan autentikasi benar-benar terkirim',
        ['nilai-terlindungi'], await ask('Panggil endpoint ./secure pada API pesanan. Apa nilainya?'))
    }
  } else {
    record({
      plane: 'rest', step: 'lanjutan UAT REST',
      intent: 'Semua langkah berikutnya bergantung pada langkah ini',
      ok: false, detail: 'connector gagal dibuat, sisa langkah dilewati',
    })
  }
}

// ===========================================================================
const byPlane = new Map<string, { n: number; ok: number }>()
for (const s of steps) {
  const b = byPlane.get(s.plane) ?? { n: 0, ok: 0 }
  b.n++; if (s.ok) b.ok++
  byPlane.set(s.plane, b)
}
const ok = steps.filter((s) => s.ok).length
console.log('\n' + '='.repeat(72))
console.log(`UAT: ${ok}/${steps.length} langkah lulus = ${((ok / steps.length) * 100).toFixed(2)}%`)
for (const [p, b] of byPlane) console.log(`  ${p.padEnd(8)} ${b.ok}/${b.n} = ${((b.ok / b.n) * 100).toFixed(0)}%`)
const failed = steps.filter((s) => !s.ok)
if (failed.length) {
  console.log(`\nLANGKAH GAGAL (${failed.length}):`)
  for (const f of failed) console.log(`  [${f.plane}] ${f.step} :: ${f.detail.slice(0, 200)}`)
}
if (JSON_OUT) {
  await Bun.write(JSON_OUT, JSON.stringify({ measuredAt: new Date().toISOString(), base: BASE, plane: PLANE, total: steps.length, passed: ok, steps }, null, 2))
  console.log(`\nJSON -> ${JSON_OUT}`)
}
process.exit(0)
