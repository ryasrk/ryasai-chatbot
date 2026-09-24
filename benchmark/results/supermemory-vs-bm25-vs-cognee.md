# supermemory vs BM25 vs cognee — retrieval comparison

**Question:** should we migrate from cognee to supermemory?

**Answer:** no. The recorded runs do not support it, and they do not support "BM25 beats both by
3×" either. That claim came from a benchmark whose answer keys were about half wrong. The audit
of 2026-09-24 corrected the ground truth and the harness. The corrected numbers are below, split
by the question set each arm actually ran.

---

## 1. What is comparable today

All three arms ran the same 1200-document corpus and the **pre-audit** 1000-question set stored in
`benchmark/results/cognee-1000-results.json`. They used the same evidence rule: every evidence
document must be in the top 10. On that set:

| arm | recall@10 | run status |
|---|---|---|
| BM25, single search | 0.2300 | valid (self-controls pass) |
| BM25, iterative (2 rounds, 10-doc budget) | 0.5070 | valid |
| cognee 1.5.4 (`CHUNKS`) | 0.1030 | **INVALID**: easy recall@10 is 0.2733 (below 0.95), and no embedding model is recorded |
| supermemory 0.0.8 (`superrag`, `searchMode=hybrid`) | 0.0780 | **unverified**: the run's readiness wait confirmed only 1 document was searchable |

The pre-audit question set has known defects. 445 chains pass through a `no_record_for` link. 70
complex questions name deliveries as `dlv-NNN`, an identifier that appears in no document. The
table above therefore compares the arms against each other only, not against a correct answer key.

Reproduce the BM25 rows:
`bun benchmark/cognee-bm25-baseline.ts --results=benchmark/results/cognee-1000-results.json`.
Reproduce the cognee verdict:
`bun benchmark/cognee-benchmark-report.ts --results=benchmark/results/cognee-1000-results.json`
(exits 1; the metric tables are withheld).

## 2. The clean question set (BM25 only so far)

`benchmark/data/cognee-1000-questions.jsonl` passes `gt-lint` with 0 violations. BM25 on it:

| mode | easy | medium | hard | complex | all |
|---|---|---|---|---|---|
| single | 1.0000 | 0.0571 | 0.0100 | 0.6750 | 0.3080 |
| iterative | 1.0000 | 0.4486 | 0.0300 | 0.8000 | 0.4760 |

cognee and supermemory have **not** been run on this set. Both need their servers; neither was
reachable when this was written. Until they are re-run, no cross-engine claim on the clean set is
possible.

## 3. What the audit changed in the harness

| # | defect | change |
|---|---|---|
| 1 | 445 chains followed `no_record_for`, a "not related" link | medium and hard chains draw only from an allowlist of positive predicates |
| 2 | Medium and hard cannot be answered in one search | BM25 reports single and iterative modes under the same 10-document budget |
| 3 | Complex questions named `dlv-NNN`; vendor evidence was the vendor master record | the question names `delivery DL-NNN`; evidence is the document asserting that delivery's vendor or project |
| 4 | The cited results file was gitignored | the cited JSON files and the clean corpus and questions are committed; the cognee report prints the results file's sha256 and git status |
| 5 | supermemory readiness stopped at the first hit | the arm waits until 50 sampled documents, spread across the corpus, each come back by their own `customId`; the report records the count and wait time |
| 6 | cognee's easy-tier rule was not enforced | the report fails `easy-ceiling` and `embedder-recorded`, titles the report RUN INVALID, and withholds the metric tables; the runner refuses to start without a named, non-fixture embedder |

Correction to the audit on finding 6. `items_processed = 29400` is **not** evidence of
quadratic ingest. It is a cumulative counter (25 + 50 + … + 1200). Measured per-batch wall time
grew only from 19.3s to 31.8s (first-5 vs last-5 mean, 1.64×). Quadratic ingest would have grown
about 48×. The report now judges ingest scaling on batch time, and this run passes.

## 4. What the supermemory run did show

These observations do not depend on the answer keys:

- **Similarity is compressed.** Across 10,000 returned hits, the median spread between the top
  and bottom of a question's 10 hits was 0.030. The embedder was `Xenova/bge-base-en-v1.5` (768d).
- **Results are concentrated.** Only 399 of 1200 documents were ever returned, and one document
  was returned for 303 questions. A partially built index would also produce this, so it is not
  attributable to the embedder until the run is repeated behind the new readiness gate.
- **`/v3/search` returns nothing on 0.0.8.** It returned `{"results":[],"total":0}` for every
  query, while `/v4/search` worked.
- **Self-hosted telemetry and metering.** The binary is a Bun bundle with readable JavaScript:
  metering is disabled in self-hosted builds, and `SUPERMEMORY_DISABLE_TELEMETRY=1` turns off
  telemetry.

## 5. Recommendation

1. **Do not migrate** cognee → supermemory for document retrieval on this evidence. Neither dense
   arm has a valid run that beats keyword search.
2. **Re-run both dense arms on the clean question set** before drawing any cross-engine conclusion:
   - cognee with a real, recorded embedder;
   - supermemory behind the new readiness gate.
3. **Compare against keyword + vector fusion** (`src/lib/rag.ts`), not only against plain BM25.
   That is what production runs.
4. **Keep supermemory in view for conversation memory**, which this benchmark does not measure.
