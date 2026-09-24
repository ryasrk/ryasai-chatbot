# Remaining PRs — cognee benchmark & memory layer

Status at time of writing: benchmark **committed** as `cb1ded3` ("complete 1000-question
cognee benchmark, harden installer & license authority"). Headline report:
`benchmark/results/cognee-1000-report.md`.

Every item below is independently shippable and states what it unblocks. Ordered by what
currently invalidates the most claims.

---

## PR-1 — `bm25_naive`: the baseline that makes our own score interpretable

**Status: COMPLETED.** Added in `04b6807`; iterative mode added in the benchmark-audit commit. See `benchmark/results/cognee-1000-bm25-baseline.md`.

- Clean question set (`benchmark/data/`): recall@10 single **0.3080**, iterative **0.4760**.
- Pre-audit question set (the one cognee and supermemory ran): recall@10 single **0.2300**, iterative **0.5070**.
- Verified by 22 unit tests in `benchmark/cognee-bm25-baseline.test.ts` (including determinism, tie-breaking, k1 saturation, length penalty, and multi-hop entity traversal).
- Automated self-controls (200 gibberish queries = 0 hits, random evidence id divergence) pass on every invocation.

---

## PR-2 — Mirror-dataset controls (unanswerable + dataset-scope)

**Status: BLOCKING for any "retrieval works" claim.**

Two controls are registered in the design and reported **NOT COMPUTABLE** in the committed run:

| control | why it cannot run today |
|---|---|
| `unanswerable-control` | the run contains 0 unanswerable questions |
| `dataset-scope` | no disjoint second dataset was populated or queried |

§2.1/§7.2 place 100 unanswerable questions in `bench:cognee1000:mirror`, built by the same
generator under a different seed. The report is explicit about why the gap is dangerous:

> A control that is absent reads as a passing control. These are listed as rows rather than
> omitted, because the probe's 100% was meaningless for exactly this reason.

**Do:** add `--mirror` to the generator (same world, different seed) and have the runner
ingest it as a second dataset, then ask corpus questions against it. Both controls must
report as rows even when they fail.

---

## PR-3 — LLM judge (§5.2), or drop the metric from the docs

**Status: reported metric is mislabelled today.**

`judged_answer_accuracy` in the report is the **§4.3.3 string rule**, not a judge, and
`judge_disagreement_rate` is NOT COMPUTABLE. The report says so, which is correct, but a
reader grepping the metric name will misread it.

**Do (either):**
- implement the 3×-repeat binary judge with `judge_disagreement_rate` and the ">5% ⇒ report
  null" rule, **using a different model than the generator** (self-judging is ruled out by
  design §5.2 and by the repo's own `AGENTS.md` note on `rag-eval`); **or**
- rename the field so the string rule is never quoted as a judged metric.

---

## PR-4 — `--trials`: turn a run into a rate

**Status: the report already measured that this matters.**

From the committed report's own scope section:

> **Measured here, not assumed:** the smoke set was asked twice against the SAME populated
> dataset with no re-ingest, and the verdicts moved — MRR 0.1944 -> 0.1852 and string-answer
> accuracy 0.2778 -> 0.3889.

A 21pp swing in string-answer accuracy on a repeat of an unchanged store means **single-run
per-tier numbers are not quotable as rates.** Add `--trials N` on a stratified subset and
report variance alongside every headline number.

---

## PR-5 — `SUMMARIES` arm (chunk-only vs graph-augmented)

The committed run is `searchType=CHUNKS` — i.e. it measures the **flat chunk store**, which
is the very thing a graph layer is supposed to beat. The design's comparison is `CHUNKS`
versus `CHUNKS + SUMMARIES`.

**Do:** `--search-type=SUMMARIES --skip-ingest` against the same populated dataset, then
report both arms side by side. `--skip-ingest` exists precisely so this costs no re-ingest.

---

## PR-6 — `no_filler` corpus-size arm

§6.4 requires it as corpus-size-control evidence, never as a benchmark result. Needs a
separate 200-document corpus build. Lower priority than PR-1/PR-2.

---

## PR-7 — Land the in-flight local-embeddings work

**Status: uncommitted in the working tree** (6 files modified + 1 new):
`.env.example`, `.github/workflows/build-images.yml`, `docker-compose.yml`, `install.sh`,
`src/app/api/llm-config/route.ts`, `src/lib/embeddings.ts`, `tools/local-embeddings/Dockerfile`.

This is a **separate concern from the benchmark** and looks close to done. Its own comment
records the point of the Dockerfile:

> a plain `pip install sentence-transformers` pulls torch WITH CUDA … MEASURED on the lab
> host: that image was 9.55 GB … Installing torch from `download.pytorch.org/whl/cpu`
> instead produced 1.99 GB with IDENTICAL output.

**Do:** finish, verify, and commit it on its own so it does not ride along with benchmark work.

---

## PR-8 — Spike: evaluate supermemory as a cognee replacement (decision, not a migration)

**Status: COMPLETED** (Runner: `benchmark/supermemory-arm.ts`, Report: `benchmark/results/supermemory-vs-bm25-vs-cognee.md`).

Key verified findings:
1. **Measured Retrieval:** recall@10 = **0.0780** on the pre-audit question set (BM25 on the same set: 0.2300 single / 0.5070 iterative; cognee 0.1030, a run its own report marks INVALID). The readiness wait in that run confirmed only one document, so the number is unverified until re-run behind the new gate.
2. **Auditability:** The self-hosted binary is an executable Bun bundle containing readable JavaScript (`Usage metering is disabled in self-hosted builds`, `SUPERMEMORY_DISABLE_TELEMETRY=1`, `sm_self_hosted: true`).
3. **Embedder Bottleneck:** Default local embedder (`Xenova/bge-base-en-v1.5`, 768d) suffers severe cosine compression on templated enterprise docs (within-question spread p50 is only 0.0301), causing retrieval to collapse onto 33% of the corpus.
4. **Route Bug:** Self-hosted v0.0.8 `/v3/search` returns 0 results for all queries; the working route is `/v4/search`.
5. **Conclusion:** Migrating cognee → supermemory for document retrieval is **not justified on this evidence**. Re-run both dense arms on the clean question set before a final call. Keep supermemory in consideration only for user-level conversation memory and user profiles.

---

## Notes for whoever picks these up

- The benchmark sources are committed and **deterministic** — regenerate the corpus and the
  1000 questions rather than hand-editing artifacts.
- **The embedding fixture decides the result.** A hashed/fake fixture produces retrieval
  scores of ~0 that look like a product failure. Use
  `uat/fixtures/embedding-server-real.py` (`paraphrase-multilingual-MiniLM-L12-v2`, dim 1536)
  and verify `curl localhost:4503/health` before any run. This trap cost the most time in the
  original effort; the pre-flight check is: cosine(query, its own target doc) must be clearly
  greater than cosine(query, an unrelated doc).
- **Do not lower a coverage floor.** Nothing in this list touches `src/`, and `benchmark/` is
  outside the test and coverage globs, so these add no CI cost.
- `recall@20` is NOT COMPUTABLE on this server (it returns at most 10 chunks per recall).
  Do not reintroduce a wider k-window claim without changing how the arm is measured.
