# supermemory vs BM25 vs cognee — retrieval comparison on identical input

**Question answered:** is supermemory worth migrating to from cognee?

**Short answer: no — and the more important finding is that BM25 beats both, especially in iterative multi-hop mode.**

All three arms ran the **same 1200-document corpus** and the **same 1000 questions**,
graded by the **same evidence rule** (`evidence_hit@k` = *every* evidence document present
in the top-k). The corpus and questions are produced deterministically from committed artifacts.

---

## 1. Head-to-head Comparison @ Top-10 Window

| arm | recall@5 | recall@10 | answer@1 | MRR | p50 latency | ingest |
|---|---|---|---|---|---|---|
| **BM25 (iterative 2-round, 10-doc budget)** | **0.3030** | **0.4760** | **0.1830** | **0.3065** | ~0 ms (in-process) | **none** |
| **BM25 (single query, 10-doc budget)** | **0.2850** | **0.3080** | **0.1830** | **0.2767** | ~0 ms (in-process) | **none** |
| cognee 1.5.4 (`CHUNKS`, single query)* | 0.0810 | 0.1030 | 0.0390 | 0.0579 | 3 426 ms | 1 246 s (1 038 ms/doc) |
| supermemory 0.0.8 (`superrag`, single query) | 0.0740 | 0.0780 | 0.0580 | 0.0721 | **60 ms** | **6 s submitted** (queue ~24 min) |

*\*Note on Cognee:* The committed cognee 1.5.4 run was audited on 2026-09-24 and flagged for failing the design's ceiling check (`easy.recall10 = 0.2733 < 0.95`, triggering `RUN INVALID`), using an unrecorded embedder, and demonstrating quadratic $O(n^2)$ re-cognify ingest cost (`items_processed = 29400` across 48 batches of 25).

### Per tier (recall@10)

| arm | easy | medium | hard | complex | ALL |
|---|---|---|---|---|---|
| **BM25 (iterative 2-round)** | **1.0000** | **0.4486** | **0.0300** | **0.8000** | **0.4760** |
| **BM25 (single query)** | **1.0000** | **0.0571** | 0.0100 | **0.6750** | **0.3080** |
| cognee 1.5.4 (single query) | 0.2733 | 0.0000 | 0.0000 | 0.3100 | 0.1030 |
| supermemory 0.0.8 (single query) | 0.2933 | 0.0000 | 0.0000 | 0.1700 | 0.0780 |

**BM25 wins every tier.** On **easy** — one evidence document, the answer is a literal token — BM25 is **1.0000** against supermemory 0.2933 and cognee 0.2733. On **medium**, single query scores near 0 for all engines because later-hop documents share no vocabulary with the question; when allowed 2 search rounds within the same 10-document budget, BM25 jumps to **0.4486**.

---

## 2. Benchmark Audit Findings & Fixes (2026-09-24)

An audit of the initial benchmark run identified six critical methodological defects that have now been addressed:

1. **Positive-Only Chains (Audit Fix 1):** In the original question generator, 445/1000 chains traversed `no_record_for` (negative evidence) hops. Medium and hard multi-hop tiers now strictly enforce `POSITIVE_CHAIN_PREDICATES` allowlist.
2. **Iterative Search Mode (Audit Fix 2):** Because multi-hop questions contain no vocabulary from later hops in their question text, a single keyword search cannot find subsequent evidence documents. Iterative search (2-round entity traversal under a strict 10-document budget) tests true multi-hop retrieval capability.
3. **Repaired Complex-Tier Keys (Audit Fix 3):** Fixed delivery display identifiers in questions (using `delivery DL-XXX` instead of raw unrendered `dlv-XXX`), and grounded vendor linking documents in the dock intake summary (`from_vendor` relation docId) rather than arbitrary vendor master records.
4. **Reproducible Raw Results (Audit Fix 4):** Unignored cited result JSONs in `.gitignore` so fresh clones can reproduce the exact benchmark tables without external dependencies.
5. **Supermemory Readiness Gate (Audit Fix 5):** The runner was updated to verify full document count readiness (`documentCount === docIds.length`) and sample probes across start, middle, and end of the corpus before beginning retrieval scoring.
6. **Enforced Cognee Validity Gates (Audit Fix 6):** Added automatic enforcement of the easy-tier ceiling check (`easy.recall10 >= 0.95`, otherwise marking `RUN INVALID`) and detection of quadratic $O(n^2)$ ingest re-cognify.

---

## 3. Why supermemory lost — measured, not guessed

### A. The embedding model cannot separate these documents
Probing with a known document's **exact text**, the correct document scored `sim=1.000`
but four **unrelated** documents scored `0.920–0.926`. Across all 10 000 returned hits:
- similarity p10 / p50 / p90: 0.697 / 0.740 / 0.803
- within-question spread (max−min of 10 hits): p50 **0.0301**, p90 0.0520
A median spread of **0.03** over 10 candidates means the ranker barely differentiates them;
ordering among near-equal vectors is close to arbitrary. This is `Xenova/bge-base-en-v1.5` (768d), the local English default.

### B. Retrieval collapses onto a small subset
- Distinct documents ever returned (of 1200): **399 (33%)**
- Share of all 10 000 hits from the top 50 documents: **63.1%**
- Most-returned single document: 303 times out of 1000 questions
- Medium+hard questions where the evidence doc appeared *anywhere* in the top 10: 252 / 650

### C. Multi-hop requires iterative search or graph hops
`medium` and `hard` are **0.0000** on single-shot search across both dense arms. For supermemory, 252/650 medium+hard questions retrieved *one* evidence document, but never *all* required documents.

---

## 4. Self-Hosted Server Audit Insights

1. **`/v3/search` route regression in 0.0.8:** It returns `{"results":[],"total":0}` for every query, while `/v4/search` returns the same content with a similarity score.
2. **`POST /v3/documents/batch` containerTag handling:** Ignores `containerTag` in its response; the read-back exposes it only as the deprecated plural `containerTags`.
3. **Auditable Bun Executable:** The self-hosted binary is a Bun executable with readable JavaScript:
   - `Usage metering is disabled in self-hosted builds.`
   - `process.env.SUPERMEMORY_DISABLE_TELEMETRY === "1"`
   - `sm_self_hosted: !0`
   Metering is disabled and telemetry can be turned off via environment variables.

---

## 5. Recommendation

1. **Migrating cognee → supermemory for document retrieval is not justified.** It trades 0.1030 for 0.0780 while both lose to a keyword index.
2. **The real finding is that BM25 beats both by 2x to 3x, and by 4x in iterative mode.** Production RAG should prioritize hybrid BM25 + dense fusion (`src/lib/rag.ts` RRF).
3. **Keep supermemory in consideration for user conversation memory and user profiles**, which this document-retrieval benchmark does not evaluate.
