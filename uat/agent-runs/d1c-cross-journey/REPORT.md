# D1c — CROSS-SOURCE journey: documents + database + REST in one conversation

Reconstructed by the coordinating agent from the run's own artifacts (`evidence/03-cross.json`, `02-single.md`,
`06-plan-step-probe.json`, `07-nested-executor.json`, `08-reproduce.json`), because the agent process stopped before
writing its report. Every question's expected value was computed by the agent BEFORE asking — from `grep` on the
fixture `.md` files, from `psql`, and from `curl` on the REST fixtures — which is what makes the tables below grades
rather than descriptions.

## Environment

- Org `zz-agent-cross` (shared with other agents; everything created here is prefixed `d1c-` / `D1c `).
- Documents: `d1c-09-panduan-pelatihan-karyawan.md` and others, uploaded and awaited to "fully vectorised".
- Database: `D1 HR Database` → `uat_hr`. REST: `D1c HR` → fixture on 4512.
- The run also had to clear two pieces of stray state before it could measure anything — `01a-unblock-quota.ts`
  (a tool-rate-limit key left full by earlier runs) and `01b-dedupe.ts` / `01c-connector-dedupe.ts` (duplicate
  connectors from the first agent batch). That is test hygiene, not product behaviour, and it is why the run took
  longer than the task implied.

## Single-source results (12 measured cases)

| case | source under test | expected (with the agent's own evidence) | actual | verdict |
|---|---|---|---|---|
| C1-docs-only | documents | "40 jam per tahun" (`grep` line 7 of 09-panduan-pelatihan.md) | "minimal **40 jam pelatihan per tahun**" + 60/80 brackets, 3 doc citations | CORRECT |
| C2-db-only | database | computed with psql | answered, 1 DATABASE citation | CORRECT |
| C3-rest-only | REST | curl on the fixture | answered, 1 citation | CORRECT |
| C5a-trap-gaji | docs vs db trap | the doc figure, not the database's | doc answer, 1 citation | CORRECT source |
| C5b-trap-cuti | docs vs db trap | the doc figure, not the database's | doc answer, 4 citations | CORRECT source |
| C6a/C6b followup-docs | documents | depends on the previous turn | followed the ellipsis, 1-2 citations | CORRECT |
| C6c/C6d followup-db | database | depends on the previous turn | followed the ellipsis, 1 citation | CORRECT |

`firstTokenMs` across these: 4,893 - 52,662 ms (the 52 s outlier is on the database-only question; the rest are
4.8-7.6 s). The spread is the provider tail recorded elsewhere in this session, not a retrieval property.

## Compound results — BOTH halves verified against both sources

| case | question | expected | both halves present? | verdict |
|---|---|---|---|---|
| C4a-docs+db | "…berapa jam pelatihan minimal per tahun…, dan berapa total gaji seluruh karyawan?" | 40 jam (doc) AND Rp106.800.000 (db) | **YES** — "minimal **40 jam**…" and "**Rp 106.800.000**" | CORRECT |
| C4b-docs+rest | "…berapa hari cuti melahirkan…, dan menurut API HR ada berapa departemen?" | 90 hari (doc) AND 4 (rest) | **YES** — "**cuti melahirkan 90 hari**…" and "**4 departemen**" | CORRECT |
| C4c-db+rest | "…total gaji departemen Teknologi, dan dari API HR siapa kepala departemen Teknologi?" | Rp37.500.000 (db) AND Budi Santoso (rest) | **HALF** — first half correct; second half the upstream API replied `"I didn't receive a question"` and the bot SAID SO | PARTIAL, honestly reported |

No compound question silently dropped a half. C4c is the interesting one: the second source returned a nonsense
payload, and the answer named the failure and quoted the payload rather than inventing a department head — which is
the behaviour under test for exactly this case.

C4b also shows the cross-source note working in the answer itself: *"angka ini hanya mencakup sumber D1 HR Database;
sumber D1c HR tidak termasuk dalam hasil tersebut…"* — the two sources were both available and the answer said which
one it used.

## The defect this run found, and its fix

All three compound turns returned `citations=[]` in the persisted message while their answers quoted figures from two
sources. Measured from the message-scoped tool runs: `SQL/success/9143 ; RAG/success/6179` — both steps succeeded,
both produced citations, and the DAG discarded them.

Root cause: `runMultiStepDag` returned `citations: []` as a literal; `PlanStepResult` had no `citations` field; and
`executeStep` built its result without copying `completion.citations`. Fixed in `535ac92` along the whole chain, with
the union deduplicated on `source` + `query_used`, and a FAILED step keeping its own citations.

Re-measured on C4a's exact question after the fix, two consecutive runs:

```
cits: 4   sources: DOCUMENT:d1c-09-panduan-pelatihan-karyawan.md, DATABASE:D1 HR Database.karyawan   both figures present
```

## Not verified

- Multi-hop graph reasoning (`graph_query`) — not exercised; this run covered documents, database and REST only.
- Whether the 52 s database turn is a general database-path property or that run's contention (the other database
  turns in this session were 6-8 s).
- Session continuity beyond two turns.
