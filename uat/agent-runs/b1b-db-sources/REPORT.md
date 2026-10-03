# B1b — DATABASE (NL→SQL) across three seeded sources

Reconstructed by the coordinating agent from the run's own artifacts (`out-a-perdb.json`, `out-b-selection.json`,
`out-c-ambiguity2.json`, `schemas.json`), because the agent process stopped before writing its report. Expected
values were computed with `psql` by the agent BEFORE each question — that is how the table below can grade an answer
instead of describing it.

## Environment

- Org `zz-agent-database` (isolated), app v2.1.0.
- Sources: `ZZ Sales` → uat_sales, `ZZ HR` → uat_hr, `ZZ Logistics` → uat_logistics (all POSTGRESQL, all `active`).
- 27 graded cases across three batteries. Every numeric expectation is a value the agent computed from the database
  itself, not from the answer.

## Results

### Battery A — one database at a time (12 cases)

| question | expected (psql) | actual | verdict |
|---|---|---|---|
| Ada berapa pesanan yang tercatat di aplikasi penjualan? | 12 | "**12 pesanan** secara keseluruhan" | CORRECT |
| SUM nilai pesanan | 1,105,000 | matched | CORRECT |
| pelanggan filtered by tipe | list | listed, "kota" filter applied | CORRECT |
| JOIN pesanan+produk | 1,019,000 | matched | CORRECT |
| Ada berapa karyawan? | 10 | matched | CORRECT |
| SUM gaji (hr) | 114 | matched | CORRECT |
| departemen with 3 karyawan | list | "Departemen Operasional memiliki 3 karyawan" | CORRECT |
| JOIN hr | 37,500,000 | matched | CORRECT |
| jumlah gudang | 3 | matched | CORRECT |
| SUM stok | 652 | matched | CORRECT |
| pengiriman berstatus dalam_perjalanan | list | 2 codes named | CORRECT |
| JOIN logistics | 205 | matched | CORRECT |

### Battery B — source selection (9 cases)

| case | expected source | what happened | verdict |
|---|---|---|---|
| "Di database penjualan, berapa pesanan status selesai?" | ZZ Sales | 7 (psql: 7) | CORRECT source |
| "Di database HR, berapa departemen?" | ZZ HR | 4 (psql: 4) | CORRECT source |
| logistics question, db unnamed | ZZ Logistics | 740 (psql: 740) | CORRECT source |
| sales question, db unnamed | ZZ Sales | list returned | CORRECT source |
| hr question, db unnamed | ZZ HR | 9 (psql: 9) | CORRECT source |
| "Minuman" (product word in two schemas) | ambiguous | 2, scoped explicitly to `produk` | see F1 |
| "Jakarta" (city in two schemas) | ambiguous | 2 | see F1 |
| policy question (no DB holds it) | refuse | "belum memiliki dokumen kebijakan" | CORRECT (honest) |

### Battery C — repeat + unanswerable (6 cases)

`sel-log-named` 2,405 (psql: 2,405) CORRECT; `unans-policy-repeat` refused to guess the leave cap and offered ways to
supply the policy; `unans-average` correctly explained that `karyawan` has NO start-date column, so average tenure is
not computable. Both unanswerable cases were answered **honestly**, which is the behaviour under test.

**Numeric agreement: 16 of 16 verifiable numeric expectations matched exactly.**

## Findings

### F1 — MAJOR: a generic question is answered from ONE source while claiming to be complete

`amb-none-2`: "Berapa banyak data yang tersimpan di sistem?"

Answer: *"Sistem kamu saat ini menyimpan total **45 baris data** yang tersebar di empat tabel utama"* — four SALES
tables. The citation proves the scope: `source: "ZZ Sales.pelanggan"`, one query counting `pelanggan`, `pesanan`,
`pesanan_item`, `produk`.

MEASURED against the databases: sales 45 + hr 36 (`departemen 4 + karyawan 10 + cuti 9 + absensi 13`) + logistics 23
(`gudang 3 + stok_gudang 12 + pengiriman 8`) = **104 rows across 12 tables in 3 databases**. The answer reports 45 and
calls it the system's total. `amb-none-1` shows the same shape in prose: "ringkasan lengkap dari seluruh data yang
tersedia (**tanpa filter apa pun**)" followed by a summary of ONE source.

This is the "reports success for work it did not do" class: the user asks about the system, gets a confident total
that is a strict subset, and nothing in the answer says the other two sources were not consulted. **Not fixed here** —
the remedy is a routing decision (refuse to aggregate across un-named sources, or name the source in the answer), and
that changes behaviour for every install. Recorded with the numbers so it can be decided on evidence.

### F2 — LOW / informational: an "ambiguous" case was silently scoped, arguably correctly

`amb-minuman-repeat` ("berapa item kategori Minuman") returned 2 from `produk` and then EXPLAINED that it is the
catalogue count, not the order-line count — a defensible disambiguation, but it did not ASK. `ambiguousStreamNote`
(`src/lib/stream-preparers.ts`) exists for the case where the product cannot tell which source is meant; here it
picked one and disclosed the choice. Whether that is good (helpful) or bad (guessing) is a product call; the answer
was factually right for the source it named.

### F3 — observed, not a defect: latency 9 s for a 4-table aggregate
`toolRuns: [{type:"SQL", status:"success", latencyMs:9045}]` on the multi-count query. Within the observed SQL range
and consistent with the earlier latency work; recorded for the tail picture.

## Not verified

- Cross-source aggregation behaviour when the question DOES name two sources (battery C stopped at 6 cases).
- Whether F1 also occurs on the REST or RAG paths (out of this agent's scope).
- Schema reflection quality beyond the table/column lists in `schemas.json`.
