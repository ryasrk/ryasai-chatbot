# Remaining PRs — cognee benchmark & memory layer

Status at time of writing: benchmark **committed** as `cb1ded3` ("complete 1000-question
cognee benchmark, harden installer & license authority"). Headline report:
`benchmark/results/cognee-1000-report.md`.

Every item below is independently shippable and states what it unblocks. Ordered by what
currently invalidates the most claims.

---

## PR-1 — `bm25_naive`: the baseline that makes our own score interpretable

**Status: BLOCKING. Nothing else on this list matters as much.**

The committed report's own text says it plainly:

> **NOT COMPUTABLE.** … It is deliberately NOT approximated with a token-overlap proxy —
> §6.4 is the only baseline that decides whether the graph layer earns its place, and a
> proxy would be quoted as though it were BM25.
>
> **Consequence, stated plainly:** without this row, the cognee score above is **not
> interpretable**.

Today we have recall@10 = **0.1030** overall (easy 0.2733, medium **0.0000**, hard **0.0000**,
complex 0.3100). We cannot yet say whether that is bad — a plain lexical index might score
0.30, or 0.03. Those are opposite conclusions about whether the graph layer is worth its
operational cost.

**Do:** build a lexical index over the same corpus + questions (Postgres `ts_rank`, or reuse
`src/lib/rag-fts.ts`) and add it as a real baseline arm. `benchmark/cognee-retrieval-runner.ts`
records the corpus texts, so no re-ingest is required.

**Trap:** a token-overlap proxy is not BM25 and must not be labelled as such. If the index
cannot be built, keep the NOT COMPUTABLE row rather than substituting a proxy.

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

**Status: NOT STARTED. Verify before believing anything below.**

### What is actually open source (verified against the repo, not the marketing)

`supermemoryai/supermemory` is **MIT**, but the licence covers the *clients*, not the engine.
Repository contents: `apps/{web,mcp,docs,memory-graph-playground,raycast-extension,sdk-playground}`
and `packages/{ai-sdk,tools,hooks,ui,validation,lib,memory-graph,*-sdk-python}`.

**There is no server engine directory.** The local server is a **prebuilt binary** from
GitHub Releases — `supermemory-server-linux-x64`, **~312 MB** at `server-v0.0.8`. So:
SDKs/plugins/MCP/dashboard = auditable; **the memory engine itself = closed, unauditable.**

### Facts that bear on our deployment model

| fact | source | why it matters here |
|---|---|---|
| Local mode is **one binary, offline-capable**, BYO model (incl. Ollama) | README | genuinely fits an air-gapped on-prem install |
| **Air-gapped self-hosting is an Enterprise (paid) tier** feature | `llms-full.txt` pricing | we ship exactly that to customers; this becomes a commercial/redistribution question |
| Pricing is **usage-based, metered in SM tokens** | `llms-full.txt` | conflicts with our signed-licence model, where metering is deliberately absent. Local-binary metering behaviour is **unverified** |
| **v0.0.8**, and the 0.0.7 release notes record an upgrade that **silently wiped search vectors** | releases API | a data-loss bug in an upgrade path, at 0.0.x, on a system that would hold customer knowledge |
| **No Docker image** published (no Docker Hub namespace found) | registry check | our install path is compose-first; a 312 MB binary is packaging friction |
| Benchmark claims (#1 LongMemEval / LoCoMo / ConvoMem, "95% Recall@15") are **the vendor's own** | README | treat as unverified by us until we reproduce on our corpus |

### Why this is a spike and not a migration

1. **We cannot currently justify replacing cognee, because PR-1 is missing.** Our cognee
   score is uninterpretable without `bm25_naive`. Switching dependencies before establishing
   the baseline risks re-running the same unknown with a different vendor and calling it an
   improvement.
2. **The engine is a closed binary.** This product's own invariants (`AGENTS.md`) lean on
   being able to read and patch what we ship to customer premises — see the cognee
   `NATURAL_LANGUAGE`/kuzu gate and the `@cognee/cognee-ts` upgrade guard, both of which exist
   because we could measure and inspect the dependency. A black-box engine removes that.
3. **The operational failure we hit with cognee may not be fixed by switching.** cognee's
   crash was `RuntimeError: cannot schedule new futures after shutdown` under sustained
   ingest. supermemory ingests asynchronously (its API is explicitly async + a `dreaming`
   operation), so it may well be better here — but that is a *hypothesis to measure*.

### Minimum viable spike (time-boxed)

1. Install the local binary on the lab host; confirm **offline** operation and whether it
   meters, phones home, or requires any licence key. *(Unverified today — do this first; it
   can end the spike immediately.)*
2. Ingest the **same 1200-doc corpus** from `benchmark/cognee-corpus.ts` and ask the **same
   1000 questions**. Reuse `benchmark/cognee-benchmark-report.ts` unchanged — it is a pure
   scorer over a raw-results file, so a new runner only has to emit the same shape.
3. Report **both** vendors against **PR-1's bm25_naive baseline**, plus ingest throughput and
   the sustained-ingest stability result.
4. Decide on: licence/redistribution terms, binary auditability, and whether the
   `SCORE = cognee vs supermemory vs bm25` table justifies the migration.

**Do not** treat the vendor's benchmark numbers as a substitute for step 3 on our corpus.

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
