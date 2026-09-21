# BM25 baseline — the row that makes the cognee number interpretable

Regenerate: `bun benchmark/cognee-bm25-baseline.ts --out-json=/tmp/bm25.json`
(needs no server — it reads `corpus.textsById` + `evidenceDocIds` from the committed
raw run below).

**Source of the cognee row:** `benchmark/results/cognee-1000-results.json` (1200 docs,
1000 questions, cognee 1.5.4, `searchType=CHUNKS`, topK 10).
**Comparison window:** top-10, the same window the cognee arm used.

---

## The result

| tier | n | recall@5 | recall@10 | recall@20 | answer@1 | MRR |
|---|---|---|---|---|---|---|
| easy | 150 | 1.0000 | **1.0000** | 1.0000 | 0.8200 | 0.9089 |
| medium | 350 | 0.0371 | 0.0400 | 0.0543 | 0.0000 | 0.0089 |
| hard | 300 | 0.0033 | 0.0033 | 0.0033 | 0.0433 | 0.0733 |
| complex | 200 | 0.3250 | 0.3250 | 0.3250 | 0.1500 | 0.2316 |
| **ALL** | **1000** | **0.2290** | **0.2300** | **0.2350** | **0.1660** | **0.2078** |

**Side by side at recall@10:**

| arm | recall@10 | answer@1 | MRR |
|---|---|---|---|
| BM25 (lexical, no LLM, no graph) | **0.2300** | **0.1660** | **0.2078** |
| cognee 1.5.4 (graph + vectors) | 0.1030 | 0.0390 | 0.0579 |

BM25 **more than doubles** recall@10 and quadruples answer@1, at ~0 marginal cost per
query and no per-document LLM pipeline. On the **easy** tier — one evidence document,
answer present as a literal token — BM25 scores **1.0000** against cognee's **0.2733**.

## Why this is credible rather than a scoring artefact

Two controls run on every invocation and both PASS:

| control | result | what a failure would mean |
|---|---|---|
| 200 gibberish queries must return **no** hit | 0/200 PASS | a tokenizer or corpus leak is scoring without matching |
| same rankings graded against a **random** evidence id | real 165/300 vs random 2/300 PASS | `evidenceHitAtK` is not measuring retrieval |

The metric is the **same evidence rule** the main report uses (`evidence_hit@k` = *every*
evidence doc in the top-k), graded on the same questions, so the two rows are directly
comparable. The implementation is pinned by `benchmark/cognee-bm25-baseline.test.ts`
(20 tests: IDF sign, `k1` saturation, `b` length penalty, distinct-query-term handling,
and the docId tie-break that keeps results independent of insertion order).

## The mechanism, measured — cognee is single-hop

Splitting each question's evidence set into "all retrieved / some retrieved / none":

| tier | n | all evidence | **some evidence** | none |
|---|---|---|---|---|
| easy | 150 | 41 | 0 | 109 |
| medium | 350 | **0** | 186 | 164 |
| hard | 300 | **0** | 41 | 259 |
| complex | 200 | 62 | 70 | 68 |

On **650 medium+hard questions cognee retrieves one evidence document but never both.**
That is the signature of single-hop matching: it finds the document containing the
question's keywords and cannot traverse to the join. It is also why the graph layer
loses to a keyword index — BM25 is *supposed* to be good at exactly this, and the graph
is not beating it where the graph is supposed to win.

cognee returned exactly **10 distinct documents per query** in all 1000 cases, so this is
not a case-window shortage; the correct document is simply not in the returned set
(easy: present anywhere in top-10 for only 41/150).

## Scope — what this does NOT establish

1. **Retrieval, not answer quality.** A hit means the evidence was *findable*. Neither
   arm's retrieval score says the final reply used it or stated it correctly.
2. **One synthetic corpus, single run, no trials.** The main report already measured that
   repeated verdicts move (string-answer accuracy 0.2778 → 0.3889 on a re-ask over an
   unchanged store). Treat these as one measurement, not a rate.
3. **The cognee artifact does not record which embedding model served the run.** It carries
   no `embedding`/model field at all, and the lab had two candidate fixtures — a real
   multilingual MiniLM endpoint and a hashed bag-of-words one whose own docstring says it
   is "NOT a semantic model". A fixture difference is therefore **not ruled out from the
   artifact alone**, and the vector arm's score should be re-measured with the model
   recorded before anyone treats 0.1030 as the vector layer's true ceiling.
4. **BM25 is not stemmed here** (neither is cognee's retrieval), and this is BM25's
   portable implementation, not Postgres `ts_rank`. A stemmed/`ts_rank` arm would likely
   score higher, so 0.2300 is not an upper bound on lexical retrieval.
5. **Not a verdict on the dependency.** BM25 beating cognee on recall does not by itself
   say remove cognee: cognee also provides KG extraction for RAG, entity/relation
   structure, and cross-session memory. What it does say is that **the graph layer is not
   currently adding retrieval value on this corpus, and that has to be explained or
   fixed** before "multi-hop graph" is claimed as a benefit.
6. **`recall@20` is reported only for BM25** (it has no window cap); the cognee arm cannot
   reach k=20 because the server returns at most 10 chunks, which is why the main report
   marks its own recall@20 NOT COMPUTABLE.

## What to do next, in order

1. **Re-measure the cognee arm with the embedding model recorded in the artifact**, and
   with the real MiniLM fixture confirmed live. If the vector arm was accidentally served
   by the hashed fixture, 0.1030 is a broken measurement and the real comparison is still
   open. This is the single highest-value next experiment.
2. If the vector arm is confirmed at ~0.10 with a real model, investigate why a
   single-hop query does not surface a document containing the literal token, and why
   every recall stops at 10.
3. Add `--trials` before treating any of these as rates.
