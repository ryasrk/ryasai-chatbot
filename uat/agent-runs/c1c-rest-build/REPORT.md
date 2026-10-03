# C1C — REST path verification (ryasai chatbot v2.1.0)

Agent: **C1** (REST path). Workdir: `uat/agent-runs/c1c-rest-build/`.
Org: **`zz-agent-rest`**. App: `http://localhost:3000` (dev, v2.1.0, healthy at start).
Nothing was started except a logging proxy (see **F1**); the three shared fixtures were already up.
No product code was edited, no `git` command was run, no test suite or build was run.

**Headline:** 7 of 8 mission questions were correct **and provably answered from the live fixture**
(fixture-side request line + the product's own `RestApiRequestLog` both agree, and every expected value was
computed by curling the fixture *before* asking). The 8th exposed a real, reproducible routing defect
(**F2**, MAJOR). The mission's premise that *"the fixtures log requests"* is **false** — I had to build an
instrument to satisfy the requirement honestly (**F1**).

> Process note: this file was written once and then **deleted from the workdir by something outside my
> session** (the directory mtime jumps to 01:51:21 with no `REPORT.md` in it; another agent's `e2e:prod`
> run and a `d1c` probe were active at the time). It is reproduced here identically. A copy is kept at
> `/tmp/c1c-REPORT-backup.md`. No product file was touched.

---

## Environment

### Connectors used

All three were created by me in `zz-agent-rest`. **I did not reuse the pre-existing `C1 Enterprise
Nusantara API`**: I verified with curl that it points at `http://127.0.0.1.nip.io:4521`, and **nothing is
listening on 4521** (`ss -ltn` shows only 4511/4512/4513 in the 45xx range; `curl 4521/health` →
`000` unreachable). It is a dead target, so reusing it could not have served any question.

| id | name | baseUrl | isActive | timeoutMs | endpoints |
|---|---|---|---|---|---|
| `cmusqffnw00e9h89h6e2fcg20` | C1C Sales API | `http://127.0.0.1.nip.io:14611` | true | 15000 | 3 |
| `cmusqffrh00eph89hlpt3vrs4` | C1C HR API | `http://127.0.0.1.nip.io:14612` | true | 15000 | 3 |
| `cmusqffu600f5h89hu7npqpwf` | C1C Logistics API | `http://127.0.0.1.nip.io:14613` | true | 15000 | 3 |

Ports 14611/14612/14613 are my logging proxy, which forwards **verbatim** to the real shared fixtures on
4511/4512/4513 (see **F1**). Verified byte-identical: `md5(curl 4511/x) == md5(curl 14611/x)` for
`/pelanggan?kota=Bandung`, `/karyawan?departemen=Teknologi`, `/stok?gudang=Gudang+Bandung`, `/stok-rendah`.

### Full endpoint list (method, path, id)

**C1C Sales API** — `cmusqffnw00e9h89h6e2fcg20`
| method | path | id |
|---|---|---|
| GET | `/pelanggan` | `cmusqffoy00edh89hf2u1723y` |
| GET | `/pesanan` | `cmusqffps00ehh89h1h92xdgw` |
| GET | `/kota-ringkasan` | `cmusqffqh00elh89hi9zc7yi7` |

**C1C HR API** — `cmusqffrh00eph89hlpt3vrs4`
| method | path | id |
|---|---|---|
| GET | `/karyawan` | `cmusqffs000eth89h9xmrbmix` |
| GET | `/karyawan-aktif` | `cmusqffsq00exh89h7jnk3c2b` |
| GET | `/departemen` | `cmusqffta00f1h89hgxr515e3` |

**C1C Logistics API** — `cmusqffu600f5h89hu7npqpwf`
| method | path | id |
|---|---|---|
| GET | `/stok` | `cmusqffup00f9h89ht20k94sx` |
| GET | `/stok-rendah` | `cmusqffv800fdh89h4729m0iy` |
| GET | `/pengiriman` | `cmusqffvt00fhh89hjac0bwyg` |

All 9 are `isEnabled=true`; all 3 connectors `isActive=true`. Read back from
`GET /api/data-sources/rest-connectors` and `.../{id}/endpoints`.

Registration note: my first `register.ts` run was not endpoint-idempotent — a second run created a
**duplicate** of every endpoint (9 → 18). I caught it, deleted the 9 duplicates (`dedupe.ts`), and confirmed
3 connectors / 9 endpoints. Duplicates matter because the REST router prompt lists every enabled endpoint of
every active connector, so a doubled list hands the model two identical candidates.

### How "expected" was established

For every question the expected answer was computed **before** asking, by curling the fixture **directly**
(port 4511/4512/4513 — not via the proxy), and saved under `evidence/*.json`. The expected value is
therefore independent of both the app and the instrument.

### How the REST call was proven (two independent witnesses)

1. **`proxy-requests.jsonl`** — the fixture-side truth: the request actually arrived on the wire, with
   path, query, headers, upstream status and latency. Because expectations were curled on the *direct*
   ports, no product-issued line here can be one of my own expectation curls.
2. **`RestApiRequestLog`** — the product's own outbound audit row, in
   `evidence/product-restapirequestlog.txt`, recording the connector it dialled, `method`, `path`, `query`,
   `statusCode`/`errorMessage` and latency. Independent of my proxy.

For every turn both witnesses agree on connector, path and query. Tool runs:
`evidence/product-toolruns.txt`.

**Provenance of the proxy lines, stated precisely** (so no line is over-claimed). The proxy records the
inbound `user-agent`, which separates the sources: **18 lines carry `user-agent: node`** (the product) and
**5 carry `curl/8.5.0`** (not the product). Of the curl lines, seq 1–4 are my own md5 pass-through parity
checks, sent deliberately straight at 14611–14613 to prove the proxy is faithful, and seq 23 (18:47:25,
`GET /pelanggan` — after my run finished) is an **external agent** hitting my proxy port; it is left in the
file for honesty but is not used as evidence for anything. The 10 expectation curls never appear: they went
to the fixtures' **direct** ports, so they cannot be confused with a product request.

The product-issued lines, in order: seq 5 and 14–15 (through the product's own `.../test` route), seq 6
(smoke turn), seq 7–13 (the R1–R8 mission turns — R5 correctly **absent**, because its request never left
the process), seq 16–22 (`repro-f2.ts` attempts and the E1 error turn). Per-turn attribution in the Results
table is keyed by timestamp and `sessionId` in `results.json`, and cross-checked against the product's own
`RestApiRequestLog`.

**On the requested evidence log** — the mission asked me to quote `/tmp/agentsvc/rest-sales.log`.
That is impossible and I say so rather than fabricate a quote: those fixtures contain **no logging in their
request handler**. Measured: `wc -c /tmp/agentsvc/rest-sales.log` is **29 bytes before and 29 after** a real
`GET /pelanggan?kota=Bandung`; the whole file is the single startup line
`rest-sales listening on 4511`. Full detail in **F1**.

---

## Results

All timings are from the SSE stream (`firstTokenMs` = first `token`/`answer` frame, from the harness).
"Fixture request logged" quotes **`proxy-requests.jsonl`** (fixture-side) and, where useful, the product's
own `RestApiRequestLog` row. Every quoted line is real output captured during this run.

### Raw expectation curls (run BEFORE asking; direct ports, unmodified output)

These are the exact commands whose output became the "expected" column. They were sent to the fixtures'
**direct** ports 4511/4512/4513, so they are not confused with anything the product did.

```
$ curl -s "http://127.0.0.1.nip.io:4511/pelanggan?kota=Bandung"
{"data":[{"id":1,"nama":"Toko Sinar Jaya","kota":"Bandung","tipe":"retail"},{"id":4,"nama":"Toko Berkah Mandiri","kota":"Bandung","tipe":"retail"}],"total":2}

$ curl -s "http://127.0.0.1.nip.io:4511/pesanan?status=selesai"
{"data":[{"id":1,"pelanggan_id":1,"status":"selesai","total":370000},{"id":2,"pelanggan_id":2,"status":"selesai","total":1240000},{"id":4,"pelanggan_id":4,"status":"selesai","total":136000},{"id":6,"pelanggan_id":6,"status":"selesai","total":111000},{"id":7,"pelanggan_id":7,"status":"selesai","total":1854000},{"id":9,"pelanggan_id":1,"status":"selesai","total":74000},{"id":11,"pelanggan_id":4,"status":"selesai","total":27000}],"total":7}
# sum of the seven `total` fields: 370000+1240000+136000+111000+1854000+74000+27000 = 3812000

$ curl -s "http://127.0.0.1.nip.io:4512/karyawan-aktif"
{"data":[{"id":1,"nama":"Andi Pratama",...,"aktif":true}, ... 8 more ...],"total":9}

$ curl -s "http://127.0.0.1.nip.io:4512/departemen"
{"data":[{"id":1,"nama":"Teknologi","kepala":"Budi Santoso","jumlah_anggota":3},{"id":2,"nama":"Keuangan","kepala":"Siti Nurhaliza","jumlah_anggota":2},{"id":3,"nama":"Operasional","kepala":"Agus Wijaya","jumlah_anggota":3},{"id":4,"nama":"SDM","kepala":"Dewi Lestari","jumlah_anggota":2}],"jumlah":4}

$ curl -s "http://127.0.0.1.nip.io:4513/stok?gudang=Gudang+Bandung"
{"data":[{"gudang":"Gudang Bandung","nama_barang":"Kopi Arabika 1kg","kategori":"Minuman","jumlah":45},{"gudang":"Gudang Bandung","nama_barang":"Minyak Goreng 2L","kategori":"Sembako","jumlah":60},{"gudang":"Gudang Bandung","nama_barang":"Kemasan Plastik 100pcs","kategori":"Peralatan","jumlah":300}],"total":3}

$ curl -s "http://127.0.0.1.nip.io:4513/pengiriman?status=dalam_perjalanan"
{"data":[{"kode":"SHP-002","asal":"Gudang Utama","tujuan":"Medan","status":"dalam_perjalanan","berat_kg":340},{"kode":"SHP-006","asal":"Gudang Surabaya","tujuan":"Jakarta","status":"dalam_perjalanan","berat_kg":400}],"total":2}

$ curl -s "http://127.0.0.1.nip.io:4513/stok-rendah?batas=50"
{"data":[{"gudang":"Gudang Bandung","nama_barang":"Kopi Arabika 1kg","kategori":"Minuman","jumlah":45}],"total":1,"batas":50,"keterangan":"Barang dengan jumlah stok <= 50 dianggap stok rendah"}
# NOTE: the same URL WITHOUT ?batas=50 returns total=4 (default batas=100) — so R7's
# correct 1-row answer is only reachable if the parameter actually reached the fixture.

$ curl -s "http://127.0.0.1.nip.io:4511/pelanggan?kota=Atlantis"
{"data":[],"total":0}

$ curl -s "http://127.0.0.1.nip.io:4512/karyawan?departemen=Pemasaran"
{"data":[],"total":0}
```

(The full untruncated outputs are saved verbatim in `evidence/*.json`; the `/karyawan-aktif` row above is
elided for width, the file `evidence/` does not contain it — that one is quoted from the curl run, and its
`total:9` is the value the answer matched.)

### Per-turn results

| # | Question (Indonesian) | Expected (from the curls above) | Actual (verbatim) | Fixture request logged | Verdict | firstTokenMs |
|---|---|---|---|---|---|---|
| **R1** | Dari API pelanggan, ada berapa pelanggan yang berdomisili di Bandung? Sebutkan juga namanya. | `{"data":[{"id":1,"nama":"Toko Sinar Jaya","kota":"Bandung","tipe":"retail"},{"id":4,"nama":"Toko Berkah Mandiri",...}],"total":2}` → **2**, those two names | "Dari API pelanggan, terdapat **2 pelanggan** yang berdomisili di Bandung, yaitu: 1. **Toko Sinar Jaya** (id 1, tipe retail) 2. **Toko Berkah Mandiri** (id 4, tipe retail) Keduanya bertipe retail, dan jumlah total sesuai dengan kolom `total` pada respons API." | proxy seq 7 `sales GET /pelanggan?kota=Bandung -> 200`; product log 18:38:19 `C1C Sales API 200 {"method":"GET","path":"/pelanggan","query":{"kota":"Bandung"}}` | ✅ correct | 6209 |
| **R2** | Dari API pesanan, berapa total nilai seluruh pesanan yang berstatus selesai? Sebutkan juga jumlah pesanannya. | `/pesanan?status=selesai` → 7 rows, sum **3 812 000** | "terdapat **7 pesanan** berstatus "selesai", dengan rincian nilai: 370.000 + 1.240.000 + 136.000 + 111.000 + 1.854.000 + 74.000 + 27.000. Total nilai ... **Rp3.812.000**." | proxy seq 8 `sales GET /pesanan?status=selesai -> 200`; product log 18:38:29 `C1C Sales API 200 {"path":"/pesanan","query":{"status":"selesai"}}` | ✅ correct | 6398 |
| **R3** | Menurut API HR, ada berapa karyawan yang masih aktif bekerja di perusahaan? | `/karyawan-aktif` → `"total":9` | "ada **9 karyawan** yang masih aktif bekerja. Kesembilan orang tersebut semuanya berstatus aktif (`aktif: true`) … Jumlah ini juga sesuai dengan nilai `total` yang dikembalikan API, yaitu 9." | proxy seq 9 `hr GET /karyawan-aktif? -> 200`; product log 18:38:38 `C1C HR API 200 {"path":"/karyawan-aktif","query":{}}` | ✅ correct | 5944 |
| **R4** | Dari API HR, siapa kepala departemen Keuangan dan berapa jumlah anggotanya? | `/departemen` → `kepala:"Siti Nurhaliza"`, `jumlah_anggota:2` | "Departemen Keuangan dikepalai oleh Siti Nurhaliza, dengan jumlah anggota 2 orang." | proxy seq 10 `hr GET /departemen? -> 200`; product log 18:38:47 | ✅ correct | 6044 |
| **R5** | Dari API stok, ada berapa jenis barang di Gudang Bandung? Sebutkan nama barang dan jumlah stoknya. | `/stok?gudang=Gudang Bandung` → **3** rows: Kopi Arabika 1kg=45, Minyak Goreng 2L=60, Kemasan Plastik 100pcs=300 | **"Maaf, permintaan ke API stok gagal dengan error **"fetch failed"** … Saya tidak mau menebak-nebak data stok"** | **proxy: 0 requests.** Product log 18:38:57: `C1 Enterprise Nusantara API, {"path":"/inventaris","query":{"gudang":"Gudang Bandung"}}`, `statusCode=NULL error="fetch failed"` | ❌ **wrong connector → failure** (see F2) | 13308 |
| **R6** | Dari API pengiriman, ada berapa pengiriman yang statusnya dalam_perjalanan? | `/pengiriman?status=dalam_perjalanan` → **2** (SHP-002, SHP-006) | "ada **2 pengiriman** dengan status `dalam_perjalanan`, yaitu SHP-002 (Gudang Utama → Medan, 340 kg) dan SHP-006 (Gudang Surabaya → Jakarta, 400 kg)." | proxy seq 11 `logistics GET /pengiriman?status=dalam_perjalanan -> 200`; product log 18:39:14 | ✅ correct | 6357 |
| **R7** (param) | Dari API stok, barang apa saja yang jumlah stoknya 50 atau kurang? Sebutkan gudang dan jumlahnya. | `/stok-rendah?batas=50` → **1** row: Kopi Arabika 1kg, Gudang Bandung, 45 | "hanya ada satu barang dengan jumlah stok 50 atau kurang: **Kopi Arabika 1kg** (kategori Minuman) — **Gudang Bandung**, jumlah stok **45**. API menandai total 1 barang … (ambang batas ≤ 50)" | proxy seq 12 `logistics GET /stok-rendah?batas=50 -> 200` | ✅ correct | 5463 |
| **R8** (error) | Dari API pelanggan, ada berapa pelanggan yang berdomisili di kota Atlantis? | `/pelanggan?kota=Atlantis` → `{"data":[],"total":0}` → must be **0 / not found**, not invented | "tidak ada pelanggan yang berdomisili di kota Atlantis. Respons API mengembalikan daftar data kosong dengan nilai total 0, sehingga jumlah pelanggan di kota tersebut adalah **0 orang**." | proxy seq 13 `sales GET /pelanggan?kota=Atlantis -> 200` | ✅ honest | 6985 |

REST API tool runs observed (`tool_end`): R1–R4, R6–R8 `type=REST_API status=success`; R5
`type=REST_API status=error`. Full per-turn `toolRuns` in `results.json`.

**Verbatim proof for R7 that the parameter was passed** — the proxy line carries the query string and the
parsed value: `GET /stok-rendah?batas=50`, `"query": {"batas": "50"}` (raw `rawQueryString: "batas=50"`).
The answer's own words confirm it used the requested threshold rather than the endpoint's default of 100:
"jumlah stoknya 50 atau kurang … ambang batas ≤ 50". Had the model omitted the parameter, the fixture would
have applied `batas=100` and returned **4** rows; it returned the 1-row / 50 answer, which is only reachable
with the parameter. **Parameter pass-through: confirmed.**

**Verbatim proof for R5/R1-scoped parameter (space + case in value)** — proxy
`GET /stok?gudang=Gudang+Bandung`, `"query": {"gudang": "Gudang Bandung"}` (space correctly URL-encoded to
`+` and decoded back by the fixture). So a parameter containing a space survives the round trip.

**Fixtures registered/enabled:** 3 of 3 (target was ≥2), 9 endpoints, all enabled — see the tables above.

---

## Error path

Two error paths were tested, and they behave **differently** — which is the honest finding.

### E1 — record does not exist, live connector: **correct**

Question: *"Dari API HR, ada berapa karyawan di departemen Pemasaran?"*
Expected (curled first): `curl 4512/karyawan?departemen=Pemasaran` → `{"data":[],"total":0}`.

Actual, verbatim:

> "Menurut hasil dari API HR, tidak ada karyawan yang terdata di departemen Pemasaran. Respons yang
> dikembalikan berisi daftar kosong dengan nilai total 0, jadi jumlahnya nol. Perlu saya sampaikan bahwa saya
> hanya bisa melaporkan apa yang dikembalikan API tersebut — hasilnya kosong, dan saya tidak menemukan
> informasi lebih lanjut mengenai penyebabnya dalam data ini."

`toolRuns=[{"type":"REST_API","status":"success","latencyMs":2959}]`.
Evidence: proxy seq 22 `hr GET /karyawan?departemen=Pemasaran -> 200` (18:46:27).
It did **not** invent a headcount or a reason. This is the desired behaviour.

### E2 — record does not exist, **misrouted**: honest, but for the wrong reason

Question: *"Dari API stok, ada berapa barang di Gudang Medan?"*
Expected (curled first): `curl 4513/stok?gudang=Gudang+Medan` → `{"data":[],"total":0}`.

The turn never reached my logistics connector. `toolRuns=[{"type":"REST_API","status":"error",...}]`, **no
citation**, and the product log shows it dialled the dead `C1 Enterprise Nusantara API /inventaris`:
`statusCode=NULL error="fetch failed"`.

Actual, verbatim (excerpt):

> "Permintaan ke REST API stok gagal (`fetch failed`), jadi saya belum punya datanya. Perlu dicatat: `fetch
> failed` adalah error di level jaringan/koneksi — bukan error dari server API-nya … **Langkah yang bisa kita
> lakukan:** … **Alternatif lewat database** — kalau data stok ada di DB, saya bisa hitung langsung via SQL.
> Misalnya dengan asumsi umum: ```sql SELECT COUNT(DISTINCT s.kode_barang) AS jumlah_barang FROM stok s JOIN
> gudang g ON g.kode_gudang = s.kode_gudang WHERE g.nama = 'Gudang Medan';``` Kalau nama tabel/kolomnya
> berbeda, beri tahu saya skemanya … Mau saya coba panggil ulang API-nya …"

**Positive:** it invented no stock figures, no cities, no headcount — the honest-answer requirement holds even
on the failure path, and the `fetch failed` text was surfaced to the user rather than hidden.
**Negative:** it also **invented a SQL query against a schema it has never seen** (this org has **zero** DB
integrations — `select ... from "Integration" where "organizationId"='zz-agent-rest'` returns 0 rows) and
offered to run it. That is speculative content presented as a plausible next step, worth a note under F2.

### Why R8's "not found" case passed cleanly

Because R8's question names `/pelanggan`, which has an unambiguous live competitor, the router picked the
live endpoint — so the empty-result path was exercised end-to-end and the model answered `0` with no
invention. The **empty data** path therefore works; what fails (R5) is **endpoint selection**, not the
empty/failure narration.

---

## Findings

### F1 — MINOR (test harness, not product): the three shared fixtures do not log requests

**Severity:** minor — it does not affect the product, but it breaks the mission's stated verification
method, and "quote the log line" cannot be satisfied as written.

**Evidence, measured.** `uat/fixtures/rest-sales.ts`, `rest-hr.ts`, `rest-logistics.ts` each contain exactly
one `console.log`, on the **last line**, outside the handler:
`console.log(\`rest-sales listening on ${PORT}\`)`. There is no `console.log`/`appendFileSync` inside the
`fetch(req)` handler. Confirmed by running a real request and diffing the file size:

```
bytes before=29 after=29          # after: curl -s "http://127.0.0.1.nip.io:4511/pelanggan?kota=Bandung"
cat -A /tmp/agentsvc/rest-sales.log
rest-sales listening on 4511$      # the entire file
```

Current sizes: `rest-sales.log` **29 B**, `rest-hr.log` **26 B**, `rest-logistics.log` **33 B** — all three
are startup banners only, unchanged since 01:19:59.
`grep -n "console\|log(" uat/fixtures/*.ts` returns one line per fixture, the banner. (Contrast: the *other*
C1 fixture at `/tmp/agentsvc/c1-api-requests.log` **does** write JSONL per request — that pattern simply was
not applied to these three.)

**Reproducible:** yes, trivially — `wc -c` the log before and after any request.

**What I did instead of fabricating a quote.** I added a pass-through reverse proxy
(`uat/agent-runs/c1c-rest-build/c1c-logging-proxy.ts`) in front of the unmodified fixtures on
14611/14612/14613, registered the connectors against the proxy, and kept curling the real fixtures directly
for expectations. It forwards status/headers/body verbatim (md5-identical on four paths, quoted above), and
so the product under test is the only possible source of every product line in the log. I did **not** modify
the fixtures, and I did not start anything other than this proxy. Evidence:
`uat/agent-runs/c1c-rest-build/evidence/proxy-requests.jsonl`.

Note for the harness owner: the proxy is my instrument, not a product fix; if fixture logging is expected to
exist, this is a gap in the shared fixtures that every REST agent will hit.

### F2 — MAJOR, reproducible: "stok per gudang" misroutes to a dead connector, turning an answerable question into a failure

**Severity:** major — a user question that the system *can* answer returns an error, and it is not random
noise (40% in the measured sample). It is not an HTTP-200-with-a-wrong-answer, but it is the same class of
harm: the turn is spent, the LLM is billed, and the user gets nothing.

**What happens.** For *"Dari API stok, ada berapa jenis barang di Gudang Bandung? …"*, the REST router
sometimes selects the pre-existing endpoint `C1 Enterprise Nusantara API GET /inventaris`
(id `cmusielaf00sxh8l5ana1dr5k`, baseUrl `http://127.0.0.1.nip.io:4521`), which is **dead** — nothing
listens on 4521. The request therefore never reaches a fixture, and the turn ends in
`status=error error="fetch failed"`.

The two endpoints are near-synonyms in the router prompt, and this is the mechanism — both descriptions
attract the same question:

* `C1 Enterprise Nusantara API GET /inventaris` — *"Stok barang per gudang. Filter dengan query gudang
  (mis. "Gudang Bandung", "Gudang Surabaya", "Gudang Medan"). … Gunakan endpoint ini untuk pertanyaan
  inventaris, **stok barang**, atau isi gudang tertentu."*
* `C1C Logistics API GET /stok` — *"Daftar **stok** barang per gudang … Filter dengan query gudang (mis.
  "Gudang Utama", "Gudang Bandung", "Gudang Surabaya") …"*

Both mention "stok", "barang", "per gudang" and *"Gudang Bandung"* verbatim. Selection is an LLM call at a
non-zero temperature, so the tie is broken randomly.

**Evidence — endpoint named by the product's own log.** Definitive tally over all in-org attempts of this
question form, straight from `ToolRun` joined to `RestApiConnector`:

| question form | attempts | routed to dead `/inventaris` | rate |
|---|---|---|---|
| "…stok … Gudang Bandung" (R5 + 2 runs of `repro-f2.ts`) | 9 | 3 | **33%** |
| "…barang di Gudang Medan" (E2) | 1 | 1 | 1/1 |
| **combined** | **10** | **4** | **40%** |

Raw rows (excerpt; full table in `evidence/product-toolruns.txt`):

```
18:39:06 | error   | /inventaris | C1 Enterprise Nusantara API | baseUrl=http://127.0.0.1.nip.io:4521 | fetch failed
18:41:44 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:41:55 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:42:15 | error   | /inventaris | C1 Enterprise Nusantara API | baseUrl=http://127.0.0.1.nip.io:4521 | fetch failed
18:42:25 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:43:40 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:43:57 | error   | /inventaris | C1 Enterprise Nusantara API | baseUrl=http://127.0.0.1.nip.io:4521 | fetch failed
18:44:06 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:44:15 | success | /stok       | C1C Logistics API           | baseUrl=http://127.0.0.1.nip.io:14613 | -
18:46:43 | error   | /inventaris | C1 Enterprise Nusantara API | baseUrl=http://127.0.0.1.nip.io:4521 | fetch failed
```

Corresponding `RestApiRequestLog` row for the first failure:

```
18:38:57 | C1 Enterprise Nusantara API | {"method":"GET","path":"/inventaris","query":{"gudang":"Gudang Bandung"},
          "headers":{"X-API-Key":"••••"}} | statusCode=NULL | error=fetch failed
```

and the fixture-side witness for the failed turn is an **absence**: `proxy-requests.jsonl` has **zero**
entries for that turn (compare seq 7–13 for the other turns). Both witnesses agree: the product dialled the
wrong host.

**Reproducible:** yes. `bun run uat/agent-runs/c1c-rest-build/repro-f2.ts` (with `C1C_REPRO_N=4`) re-asks the
identical question; I ran it **twice** (18:41 and 18:43) and each run returned **3 live / 1 dead**, so the
defect is per-attempt, not per-run.

**Three contributing product defects, distinct from the pre-existing fixture data:**

1. **No failover or second attempt when the chosen endpoint fails.** `prepareRestStream`
   (`src/lib/stream-preparers.ts:774`) calls `executeRestRequest`, and on `!result.ok` it immediately returns
   the error turn (`~line 790-798`) — it never tries the next-best candidate even though a live candidate
   exists in the same prompt. The user gets a failure from a question the system can answer.
2. **The circuit breaker is not wired to this path.** `src/lib/tool-circuit-breaker.ts` — which exists
   precisely to stop repeated calls to a failing tool — is used by `agent-orchestrator.ts` and `planner.ts`
   only. Verified by count: `toolCircuitBreaker` occurs **5×** in `agent-orchestrator.ts`, **7×** in
   `planner.ts`, and **0×** in both `stream-preparers.ts` and `tool-branches.ts`. So a permanently dead
   connector is re-selected indefinitely; 4 failures produced no penalty.
3. **Consequence on the error path:** `describeConnectionError` (`real-connectors.ts`) already classifies
   DNS/refused/timeout failures for DB connectors, but the REST path does not use it, so the user sees the
   raw `fetch failed`. That is what pushed the model to *invent a SQL query against a schema it has never
   seen* and offer to run it (E2) — the model is improvising because the error is unclassified.

**Scope caveat (stated, not assumed):** the dead endpoint is **pre-existing fixture data in my org**, not
something I created — the `C1 Enterprise Nusantara API` connector points at 4521 and predates my run. I was
told not to create duplicates, so I registered my own connectors instead of touching it. The *product*
behaviour under test — selecting an enabled endpoint of an active connector that happens to be unreachable,
with no failover, no breaker, and an unclassified error — is independent of why 4521 is down. On a real
install the same shape appears when a tenant's REST backend goes down: questions keep routing to it, and
every affected turn fails forever.

### F3 — INFO: honest-hallucination boundary holds

No fabricated numbers were observed on any of the 11 turns (8 mission + E1 + E2 + smoke). On the two empty
result sets (R8, E1) the model said 0 / not found and explicitly declined to speculate — verbatim, from R5:
*"Saya tidak mau menebak-nebak data stok, karena itu bisa menyesatkan"*, and from E1: *"saya tidak
menemukan informasi lebih lanjut mengenai penyebabnya dalam data ini"*. The one speculative artefact is the
invented SQL *offer* in E2 (no data invented, no query executed — this org has no DB integration, so it
could not have run). Recorded for completeness, not as a data-integrity defect.

---

## Not verified

* **The requested log files as evidence.** `/tmp/agentsvc/rest-sales.log` cannot prove anything (F1); I
  quoted it as-is and substituted a fixture-side proxy + the product's own log. If the grader requires the
  literal `rest-sales.log` line, that line does not exist for any request.
* **`/kota-ringkasan` and `/karyawan` (unfiltered) were registered but never exercised by a turn.** The
  router chose `/karyawan-aktif` for R3 and `/pelanggan` for R1/R8, so those two endpoints have no
  turn-level evidence. `/pesanan` and `/departemen` were exercised.
* **`/inventaris`'s intended behaviour.** I could not read its fixture source (it is not among
  `uat/fixtures/`), so I cannot say what it *would* have returned at 4521. I verified only that the port is
  closed. My claim is limited to "the product dialled a host that does not answer", proven by
  `statusCode=NULL error="fetch failed"` plus zero proxy lines.
* **Whether F2 is a regression or long-standing.** Not determined — I ran no `git` command, per
  instructions, so I cannot date the missing failover/breaker wiring.
* **Cross-agent interference.** I found REST `ToolRun`s from `zz-agent-cross` (`D1c HR API`,
  `baseUrl=http://127.0.0.1.nip.io:4512`) in the shared tables during my window. They are in a different org,
  do not touch my connectors, and all 11 of my turns are attributed by `sessionId` in `results.json`. I did
  **not** control for other agents' concurrent load on the shared LLM endpoint, which is the most likely
  cause of the variable `firstTokenMs` (R5's 13308 ms was also the failing turn, but I cannot separate
  "router was slow" from "another agent was mid-turn"). One external `curl` also hit my proxy port after my
  run (seq 23); it is documented above and excluded from evidence.
* **Latency as a defect.** `firstTokenMs` ranged 5463–13308 ms (median **6283 ms** across the 8 mission
  turns). I did not attempt to characterise this — the shared endpoint was under concurrent load from other
  agents, so the numbers are reported for the record only, not as a performance verdict.
* **No test suite, build, lint or typecheck was run**, per the mission instructions. F2 is therefore a
  behaviour measured live, not a code-level root cause; I read `stream-preparers.ts` and
  `tool-circuit-breaker.ts` to describe the mechanism, but did not execute any test that would confirm the
  fix boundary.
* **Auth/header minimisation.** All three C1C connectors use `authType=NONE`, so the `headers:{}` in the
  audit rows is expected; I did not test BEARER/API_KEY routing. The dead `C1` connector is
  `API_KEY_HEADER`, and its audit row shows `X-API-Key: ••••` — masking itself works, but that is the only
  credential-path observation I have.

---

## Artifacts

| path | what |
|---|---|
| `results.json` | all 8 mission turns: question, expected, verbatim answer, firstTokenMs, toolRuns, citations, proxy lines, product-log delta |
| `proxy-requests.jsonl` | fixture-side evidence, 23 lines (18 product `user-agent: node`, 5 curl); verbatim copy in `evidence/` |
| `evidence/product-restapirequestlog.txt` | the product's own outbound audit rows, with connector + baseUrl + status/error |
| `evidence/product-toolruns.txt` | `ToolRun` rows with connector + endpoint path per question |
| `evidence/*.json` | the curl'd expectations (s1, s3, s4, h1, h3, h4, l1, l2, l2b, l3) |
| `c1c-logging-proxy.ts` | the instrument (F1) — pass-through proxy, unmodified fixtures behind it |
| `register.ts`, `dedupe.ts` | connector/endpoint registration, and the duplicate cleanup |
| `drive.ts`, `errors.ts`, `repro-f2.ts`, `smoke.ts` | the turn drivers |
| `/tmp/agentsvc/c1c-drive.log`, `c1c-errors.log`, `c1c-repro.log`, `c1c-proxy.log` | raw run logs |
| `/tmp/c1c-REPORT-backup.md` | backup of this report (it was deleted once mid-session) |
