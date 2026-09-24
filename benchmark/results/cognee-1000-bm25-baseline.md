# BM25 baseline — the row that makes the cognee number interpretable

Regenerate: `bun benchmark/cognee-bm25-baseline.ts --out-json=benchmark/results/cognee-1000-bm25.json`
(needs no server — runs deterministically over the corpus and questions).

**Provenance:**
- Corpus: 1200 documents (`--docs=1200 --with-contradictions`, seed 20260916).
- Questions: 1000 questions (150 easy / 350 medium / 300 hard / 200 complex), verified by `benchmark/cognee-gt-lint.ts` with 0 violations.
- Comparison window: top-10, matching the cognee and supermemory benchmark arms.

---

## 1. Benchmark Audit Findings & Revisions (2026-09-24)

An audit of the initial benchmark run identified six critical methodological defects that have now been addressed:

1. **Positive-Only Chains (Audit Fix 1):** In the original question generator, 445/1000 chains traversed `no_record_for` (negative evidence) hops. Medium and hard multi-hop tiers now strictly enforce `POSITIVE_CHAIN_PREDICATES` allowlist.
2. **Repaired Complex-Tier Keys (Audit Fix 3):** Fixed delivery display identifiers in questions (using `delivery DL-XXX` instead of raw unrendered `dlv-XXX`), and grounded vendor linking documents in the dock intake summary (`from_vendor` relation docId) rather than arbitrary vendor master records.
3. **Automated GT Linting (MuSiQue Discipline):** Added `benchmark/cognee-gt-lint.ts` enforcing that 100% of hop documents contain both entities, no chains traverse negative edges, and no early documents leak answers.
4. **Iterative Search Mode (Audit Fix 2):** Because multi-hop questions contain no vocabulary from later hops in their question text, a single keyword search cannot find subsequent evidence documents. Iterative search (2-round entity traversal under a strict 10-document budget) tests true multi-hop retrieval capability.

---

## 2. Results: Single-Search vs. Iterative-Search BM25

### Single-Search BM25 (1 Query, Fixed Budget: 10 Docs)

| tier | n | recall@5 | recall@10 | recall@20 | answer@1 | MRR |
|---|---|---|---|---|---|---|
| easy | 150 | 1.0000 | **1.0000** | 1.0000 | 0.8200 | 0.9089 |
| medium | 350 | 0.0000 | **0.0571** | 0.0829 | 0.0000 | 0.0083 |
| hard | 300 | 0.0100 | **0.0100** | 0.4167 | 0.1000 | 0.2073 |
| complex | 200 | 0.6600 | **0.6750** | 0.6950 | 0.1500 | 0.3763 |
| **ALL** | **1000** | **0.2850** | **0.3080** | **0.4430** | **0.1830** | **0.2767** |

### Iterative BM25 (Audit Fix 2 — 2 Rounds, Discovered Entity Follow-up, Fixed Budget: 10 Docs)

| tier | n | recall@5 | recall@10 | answer@1 | MRR |
|---|---|---|---|---|---|
| easy | 150 | 1.0000 | **1.0000** | 0.8200 | 0.9089 |
| medium | 350 | 0.0457 | **0.4486** | 0.0000 | 0.0690 |
| hard | 300 | 0.0000 | **0.0300** | 0.1000 | 0.2232 |
| complex | 200 | 0.6850 | **0.8000** | 0.1500 | 0.3953 |
| **ALL** | **1000** | **0.3030** | **0.4760** | **0.1830** | **0.3065** |

---

## 3. Head-to-Head Comparison @ Top-10

| arm | recall@10 | answer@1 | MRR | Latency p50 |
|---|---|---|---|---|
| **BM25 (iterative 2-round, 10-doc budget)** | **0.4760** | **0.1830** | **0.3065** | ~0 ms |
| **BM25 (single-query, 10-doc budget)** | **0.3080** | **0.1830** | **0.2767** | ~0 ms |
| cognee 1.5.4 (`CHUNKS`, single-query)* | 0.1030 | 0.0390 | 0.0579 | 3 426 ms |
| supermemory 0.0.8 (`superrag`, single-query) | 0.0780 | 0.0580 | 0.0721 | 60 ms |

*\*Note on Cognee:* The committed cognee 1.5.4 run was flagged by the audit for failing the design's ceiling check (`easy.recall10 = 0.2733 < 0.95`, triggering `RUN INVALID`), and likely used an unverified embedding model.

---

## 4. Self-Controls (Mechanical Proof of Harness Validity)

Two automated controls run on every invocation and both PASS:

| control | result | what a failure would mean |
|---|---|---|
| 200 gibberish queries must return **no** hit | 0/200 PASS | a tokenizer or corpus leak is scoring without matching |
| same rankings graded against a **random** evidence id | real 160/300 vs random 3/300 PASS | `evidenceHitAtK` is not measuring retrieval |

The metric is the **same evidence rule** the main report uses (`evidence_hit@k` = *every*
evidence doc in the top-k), graded on the clean question set verified by `cognee-gt-lint.ts`.
The implementation is pinned by `benchmark/cognee-bm25-baseline.test.ts` (IDF sign, `k1`
saturation, `b` length penalty, distinct-query-term handling, iterative multi-round retrieval,
and the docId tie-break).

---

## 5. Scope & Limitations

1. **Retrieval, not answer quality.** A hit means the evidence was *findable*. Neither
   arm's retrieval score says the final reply used it or stated it correctly.
2. **Synthetic templated corpus.** Identifiers like `DL-001`, `B-0001`, `INV-0001` strongly
   benefit lexical search. In real unstructured text with synonyms and OCR noise, dense
   retrieval has different trade-offs.
3. **BM25 is unstemmed.** A stemmed BM25 or Postgres `ts_rank` arm would score higher.
4. **Iterative search bridges multi-hop.** Multi-hop questions cannot be answered by single-shot
   lexical queries; when given 2 rounds within the same 10-document budget, BM25 recall
   jumps from 0.0571 to 0.4486 on medium tier.
