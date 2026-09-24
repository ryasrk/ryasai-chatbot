# Plan: production integration for retrieval ranking

Status: proposed, not started. Written 2026-09-24.

Predecessor: `docs/entity-hop-retrieval-plan.md` (Phases 1-3 executed, verdict **DO NOT SHIP**)
and `benchmark/results/retrieval-arms-decision.md`.

---

## 1. What this plan integrates, and what it explicitly does not

**Not Entity-Hop.** It failed two of its four pre-registered criteria on a held-out split, and its
reach on real prose is bounded by 7.0% entity coverage. That work stays a benchmark. Nothing in this
plan adds a hop step to production.

Sourcing note, because the two files disagree and a reader will notice: the ablation runner writes
criterion 3 as `NOT COMPUTABLE` (`benchmark/results/entity-hop-ablation.json`), because it only grades
the synthetic corpus. The real-prose verdict comes from a separate run,
`benchmark/results/real-prose-arm.json`. Together:

| criterion | measured | verdict | recorded in |
|---|---|---|---|
| 1. medium+hard gain vs production | +0.1230 | PASS | `entity-hop-ablation.json` |
| 2. easy recall@10 drop | 0.0133 (one question of 75) | FAIL | `entity-hop-ablation.json` |
| 3. not worse than production on real data | recall tied 0.9752, MRR 0.6132 vs 0.6254 | **FAIL** (−0.0121) | `real-prose-arm.json` |
| 4. added p50 | +0.31 ms | PASS | `entity-hop-ablation.json` |

**What ships is the two production findings that outlived it.** Both were measured, both are small,
and both are candidates to change code that is already live:

| # | Finding | Where | Evidence |
|---|---|---|---|
| F1 | `RRF_K = 60` is nearly flat, so cross-leg agreement outweighs a strong single-leg rank | `src/lib/rag-ranking.ts:129` | `retrieval-arms-decision.md` §2b |
| F2 | `tokenize` drops identifier prefixes; `B-0001`/`INV-0001`/`PO-0001`/`AR-0001` all become `0001` | `src/lib/rag.ts` | `retrieval-arms-decision.md` §3 |

**The honest starting position: neither is proven in production.** Both were measured offline on
`benchmark/arms/hybrid-arm.ts`, which deliberately omits production's reranker, its knowledge-graph
leg, and its `keywords` field, and which was documented as a *lower bound* on production. The offline
numbers therefore **overstate** the production damage, because a reranker can recover a
mid-ranking hit that a raw fused list would bury. Section 5 measures before anything changes.

### Where the ranking actually reaches a user

Traced, not assumed:

```
POST /api/chat/sessions/[id]/send
  → stream-preparers.ts:104 prepareRagStream
      → intent-pipeline.ts retrieveWithReflection({ query, topK: 4 })
          → rag-retrieval.ts:54 retrieveRelevantChunks
              → rag-retrieval.ts:235 retrieveAndFuse
                  · rerankEnabled  = RAG_LLM_RERANK !== 'false'   → default ON (line 102)
                  · retrievalTopK  = topK * 3 when reranking      → 12, line 103
                  · rankings       = [vectorRanking, toRanking(bm25), kgRanking?]
                  · fused          = fuseRankings(rankings)       → line 289, default k
                  · selectTopRetrievedChunks(scored, topK=12)
              → dispatchRerank(query, merged, topK=4)             → order changes, score does NOT
  → stream-preparers.ts:145-150 buildDocumentCitation({ ...score }) → UI
```

Three consequences that shape the whole plan:

1. **`fuseRankings` is called without a `k` argument** (line 289), so F1 is fixed by adding a
   parameter that already exists — not by restructuring anything.
2. **The reranker only ever sees `topK * 3 = 12` candidates.** If the fused list buries the answer
   below rank 12, no reranker can rescue it: the ranking decision happens *before* the precision
   step. That is the mechanism by which F1 can affect an answer.
3. **`selectTopRetrievedChunks` caps 3 chunks per document** (`RAG_MAX_PER_DOCUMENT = 3`), so a
   ranking change interacts with the diversity cap — a chunk promoted to rank 1 can still be dropped
   if its document already contributed three.

## 2. Hard constraints this repo imposes on the change

These were found by reading the guards, not by running into them. Each one is a blocker; all are
cheap to satisfy if anticipated.

### 2.1 `invariants.test.ts` asserts the literal call, and will fail on the obvious edit

`src/lib/invariants.test.ts` ("semantic similarity is not silently discarded from ranking") asserts:

```js
expect(src).toMatch(/fuseRankings\(rankings\)/)
```

Verified by execution against the real regex:

| source text | `/fuseRankings\(rankings\)/` |
|---|---|
| `fuseRankings(rankings)` (today) | matches |
| `fuseRankings(rankings, fusionK)` (the edit F1 needs) | **does not match** |

So the one-line change breaks a CI guard. Per AGENTS.md these guards encode real incidents and must
not be deleted or weakened — **relax the pattern to accept the optional second argument, and keep the
property it actually protects** (that `vectorRanking` is an element of the array being fused):

```js
expect(src).toMatch(/const rankings = \[[^\]]*\bvectorRanking\b[^\]]*\]/)
expect(src).toMatch(/fuseRankings\(rankings(?:,\s*[^)]*)?\)/)
```

I verified the relaxed pattern still rejects both regressions it exists for: a renamed array
(`fuseRankings(otherRankings)`) and a dropped fuse call. Negative-control it in the test itself, so
the relaxation cannot silently become "matches anything".

### 2.2 `env-schema.ts` validates env vars, and its failure modes have bitten before

`RAG_LLM_RERANK` is declared `z.enum(['true', 'false']).optional()` (`env-schema.ts:55`), and
validation is fatal in production. A new `RAG_FUSION_K` must be declared there too, as a validated
optional (coerce to int, bounded), not read raw.

Note the recorded lesson from `ALIGNMENT_CHECK`: the schema accepted `'llm'` while all call sites
compared against `'true'`, so setting the documented value silently DISABLED the guardrail. **The
schema's accepted values and the code's comparison must be the same set, and a test must assert
that** — not just that each exists.

### 2.3 `/api/metrics` is gated

`src/app/api/metrics/route.ts` requires a `METRICS_TOKEN` bearer token, or an admin session
(`requireRole(user, 'admin')`). Every "check `/api/metrics`" step below needs the token or an admin
session; a 401 there is not evidence the metric is missing.

### 2.4 A new route must declare its org context

`src/lib/tenant-route-guard.test.ts` statically enforces `enterWithOrg(...)` (or an explicit
`bypassOrg`) on every route. Any route added by this plan must comply, or that guard fails — and per
AGENTS.md it must not be loosened.

## 3. Preconditions — do not start Phase 5 without these

| # | Precondition | Why | How to check |
|---|---|---|---|
| P1 | A deployment with **50+ documents** | The predecessor's gate 3 was only partly evaluable here (9 documents, 114 chunks). Deltas from 9 documents are indicative, not decisive. | `select count(*) from "Document"` |
| P2 | A golden set with labelled expected sources | Without labels `scoreRetrieval` returns 0 by design (`rag-eval.ts:99`) | `bun run benchmark/golden-set.ts --org=<id> --out=…` |
| P3 | Redis running, so uploads are processed by the job worker | `enqueueOrSync` (`job-processor.ts:244`) runs the handler inline WITHOUT Redis and queues it WITH Redis. Either path works, but the plan's timing claims assume one. | `bun run start` brings up the scheduler worker |
| P4 | Fusion config in the RAG cache key | Phase 4 below. Without it, every A/B number measures the cache. | code change |

Because this product is deployed **on-prem, one install per customer**, P1 is satisfied by any real
install — including the one being upgraded. That is the corpus to measure on, not a synthetic one.

If P1 cannot be met, **stop after Phase 4**. A flag that is merged but unmeasured is worse than an
unmerged one, because it looks available.

## 4. Phase 1 — make the ranking observable before changing it

Neither item changes retrieval behaviour.

### 4a. The cache key must include the fusion config

`ragCacheKey` is `rag:${orgId}:${topK}:${query.slice(0,500).toLowerCase().trim()}`
(`rag-retrieval.ts:47`) with a 60 s TTL (`RAG_CACHE_TTL_MS`, `constants.ts:20`) and no notion of the
ranking configuration. With a per-request A/B override:

- a query run under config A is served from cache to a request asking for config B, for up to 60 s;
- the A/B result becomes a measurement of cache warmth, in whichever direction the first request
  happened to land.

**Change:** add a short config tag to the key. `invalidateRagCache()` is `cacheDel('rag:')` (line 51),
so it already flushes the whole prefix and keeps working.

**Tests:** two different configs never share a key; a key WITHOUT org context still returns `null`.
The null branch is load-bearing — the comment at line 40 records a cross-tenant leak that fell out of
a `'global'` fallback, so the new tag must not reintroduce a shared key.

### 4b. Emit retrieval metrics

`src/lib/metrics.ts` exports `counter`/`gauge`/`histogram`/`observe`; `prometheusText()` renders them.
Add at the end of `retrieveRelevantChunks`:

- `rag_retrieval_latency_ms` (histogram), labelled by fusion config
- `rag_retrieval_candidates` (histogram) — `candidatesScanned`
- `rag_retrieval_results` (histogram) — `chunks.length`
- `rag_cache_hit_total` / `rag_cache_miss_total` (counters) — the existing `log.debug` calls at lines
  70 and 138 are the placement

**Why before the change:** without a pre-change baseline a post-change regression cannot be
distinguished from normal variation, and the inherited 50 ms budget has no production counterpart.

**Tests:** one per metric on its label set; and a cache hit must NOT observe a latency bucket —
otherwise the histogram mixes hits with real retrievals and reads optimistically.

## 5. Phase 2 — the flag

### Shape: environment variable, with a guarded per-request override

The precedent is `SIMPLE_PIPELINE` plus the `x-pipeline` header (`send/route.ts:252-260`). Copy the
safety property its comment states verbatim:

> A per-request override exists ONLY for the A/B harness, and only while the deployment-wide flag is
> on: an operator who has not enabled the new pipeline cannot have a client switch it on.

So:

- `RAG_FUSION_K` — unset means today's behaviour (`RRF_K = 60`). Nothing changes for an install that
  does not set it. Declared in `env-schema.ts` per §2.2.
- `x-fusion-k` request header — honoured **only** when `RAG_FUSION_K` is set.
- Invalid values (0, negative, non-numeric) fall back to the default and log a warning, rather than
  reaching `1/(k + rank)` with `k = 0`.

**Do not add a per-org database flag in this phase.** There is no flag table or column
(`Organization`, `LlmConfig`: none), so it needs a migration, a settings UI, an audit entry, and a
cache-invalidation path — four moving parts for a value whose correct setting is not yet known. An
env var reverts with a restart and no migration. If the measured value differs *by org*, that finding
justifies the schema work later.

`retrieveAndFuse` reads the value once per call and passes it explicitly: `fuseRankings(rankings, k)`.
Keep `RRF_K` as the default so every existing call site and import keeps its meaning — and relax the
invariant per §2.1 in the same commit.

### Tests

- unset → output identical to today (golden test, so the default cannot drift silently)
- set → `fuseRankings` receives that `k` (mock assertion, same style as `rag-retrieval.test.ts:1481`)
- a request header is **ignored** when the env var is unset — the security property above
- env-schema acceptance and code comparison agree on the same value set (§2.2)

## 6. Phase 3 — measure on real data before believing anything

Reuse what exists. Three tools are already in the repo and none of them needs building.

### 6a. Product-surface A/B, via the existing eval endpoint

`POST /api/rag/evaluate` (`src/app/api/rag/evaluate/route.ts`) runs up to 50 real retrievals,
admin-only, and returns `summarizeRagEval` output. `compareRagEval(before, after, minDelta = 0.02)`
(`rag-eval.ts:138`) returns `better | worse | inconclusive` over recall@k + MRR.

**Runner:** follow `trial/live/head-to-head.ts` — same server process, per-request override header,
same questions, so a difference is attributable to the fusion and not to a restarted process or a
warm cache. That file's header states this reasoning; follow it rather than inventing a second
approach.

**Pre-registered decision rule, fixed before the run:**

1. `compareRagEval` returns `better`, not `inconclusive`, at the default `minDelta = 0.02`.
2. p50 retrieval latency does not rise by more than **50 ms** (the inherited budget, so the two
   measurements are comparable).
3. No per-tier regression beyond that tier's measurement noise, reported **per tier** — F1's whole
   mechanism is a head-versus-tail trade that an all-questions average hides.
4. Run **3 times** and report the spread. The predecessor work measured an 11-point move from
   re-asking the same question, so one run is not evidence.

If the rule fails: **do not ship, and do not retune on the same data.** Tuning a constant against the
set it is graded on is exactly how the predecessor's `maxHopDocs` produced a zero drop on dev and a
non-zero one on held-out.

### 6b. Offline check, reusing the committed benchmark

`benchmark/` already has the four-arm harness (`arm-harness.ts`), the doc/query vector caches, and
`real-prose-arm.ts`, which grades the app's own chunks through the same grader. Add one arm that
calls `fuseRankings` with candidate `k` values and report recall@10 / MRR per tier.

This does **not** replace 6a — it cannot see the reranker or the KG leg — but it costs one run and
tells us whether the production result is plausible before spending eval budget.

### 6c. F2 (tokeniser) is a separate decision, not a rider on F1

The two candidate tokenisers did not dominate each other offline (all-tier 0.3803 vs 0.4577 on the
same split), and 975 of 1200 synthetic documents carry a bare-digit token, so the synthetic result
cannot settle it. **Measure F2 with the same 6a harness and the same rule, in its own run.**
Shipping both at once makes a regression unattributable.

There is also a real repo-level interaction to check: the `RETRIEVAL` invariants and
`rag-fts.test.ts` assert on tokenisation behaviour, so F2 starts by reading those guards, not by
editing `tokenize`.

## 7. UI work

### 7a. The citation percentage is already wrong — a bug, not a regression

`citation-list.tsx:65` renders `relevance {score}%` where the value is
`Math.round(c.score * 100)` (lines 33-34), and `c.score` is the **fused RRF score** assigned at
`rag-retrieval.ts:312` and passed through `buildDocumentCitation` (`tool-utils.ts:119-133`)
unchanged. `dispatchRerank` reorders chunks but preserves their `score`.

Measured, with the values production actually produces today:

| document | fused score at `k = 60` | UI renders | at `k = 10` | at `k = 1` |
|---|---|---|---|---|
| found by both legs, rank 1 | 0.0328 | **"3%"** | "18%" | "100%" |
| found by one leg, rank 1 | 0.0164 | **"2%"** | "9%" | "50%" |

The best possible citation in production today displays **3% relevance**. This is not a scale error
introduced by lowering `k`: the number is already meaningless as a percentage, and lowering `k`
changes *which* meaningless number it shows. Shipping F1 without fixing this would make a misleading
label more prominent, because "50%" and "100%" read as real confidences.

**Options, decided in Phase 3** (the right answer depends on whether `k` changes):

| Option | Behaviour | Tradeoff |
|---|---|---|
| (a) Rank label — "Match #1" | truthful, honest about being ordinal | loses the "how confident" affordance |
| (b) Relabel the number — "RRF 0.016" | truthful, useful to an operator | meaningless to an end user |
| (c) Normalise to the top hit | reads as relative confidence | "100%" on the best hit invites over-trust |
| (d) Hide the number | cannot mislead | removes information users may rely on |

**Recommendation: (a) in the citation list, (b) in the search tester**, where the audience is an
operator. Note the fields that *do* mean something as a percentage already exist and are populated
separately — `scoreBreakdown.semanticSimilarity`, `bm25`, `semanticScore`
(`rag-retrieval.ts:313-319`) — so if a real confidence is wanted it must come from
`semanticSimilarity`, never from `score`.

**Test:** the citation list renders a label for a fused score of 0.0164 and does not render `2%`.
Negative-control it so it cannot pass on a component that simply stopped rendering a score.

### 7b. Search tester: decide, do not assume

`/api/documents/search` has **no UI consumer** — the only reference under `src/components/` is a
comment (`knowledge-base-view.tsx:8`), and the Knowledge view's tabs are `documents`, `vector`,
`cognee` only. The route, its `scoreBreakdown` hoist, and `rag-search-tester.ts`
(`normalizeRagSearchResponse`) are tested; nothing tests a UI, because there is none.

**Decision needed with an owner:** if operators use this endpoint, it needs a UI before the fusion
change, because it is the only surface exposing `bm25` and `semanticSimilarity` separately and thus
the only way to diagnose a ranking complaint from inside the product. If it is unused, delete it in
its own PR rather than leaving an unexercised surface to interpret the change.

## 8. E2E chat flow — and the measured reason it cannot detect a ranking change today

### 8.1 What the current spec verifies

`e2e/03-knowledge-chat.spec.ts` uploads one TXT, waits for it to appear, asks "What is the main
warehouse code?", and asserts `/jawaban uji/i`. That string is the mock's **canned** reply
(`mock-llm.ts:172`). It proves the chat transport works. It proves **nothing about retrieval**: a run
in which the retriever returned the wrong document, or no document, produces the same string and the
same pass. No spec asserts on citations at all.

### 8.2 Measured: the vector leg is empty in E2E, so `k` is unobservable there

This is the finding that governs the E2E work, and it was verified by execution rather than read:

| fact | value | source |
|---|---|---|
| mock embedding dimension | **64** | `mock-llm.ts:215` — `new Array(64).fill(0.001)` |
| pgvector column dimension | **384** | `prisma/schema.prisma:277` — `vector(384)` |
| writer behaviour on mismatch | stores `embeddingJson` only, pgvector left NULL, warns once | `embeddings.ts:297-311` |
| e2e DB state | **1 chunk, 0 with a non-NULL `embedding`** | queried directly |
| a 64-dim query against the column | returns no rows | queried directly |

So in E2E `resolveVectorScores` returns nothing, `vectorRanking` is empty, and
`fuseRankings([[], lexicalRanking])` is handed **one** non-empty ranking. Since `1/(k + rank)` is
strictly decreasing in `rank` for every `k > 0`, the fused order then equals the lexical order for
**any** `k`. A fusion change is therefore **invisible** to E2E as it stands — not "hard to detect",
but arithmetically undetectable.

There is a second, independent degeneracy even if the dimension matched: the mock returns the **same
vector for every input**, so every cosine is 1.0 and the leg carries no signal.

### 8.3 Changes required, in order

**Step 1 — make the mock embeddings usable, then vary them.** Two edits to `e2e/mock-llm.ts`:

1. return **384** dims, matching `vector(384)`, so `pgvectorSimilaritySearch` can return rows;
2. derive the vector deterministically from the input text (a stable hash), so different chunks get
   different vectors. Determinism is required — a random vector makes E2E flaky, and this repo already
   treats flaky E2E as a serious cost.

Both are needed: (1) alone leaves every cosine tied at 1.0; (2) alone still writes zero pgvector rows.

**This changes E2E retrieval behaviour, so it is its own commit** with the existing spec run before
and after, and **no production change in it**. If the spec fails on this step alone, that is a finding
about how brittle the current assertions are and belongs in the PR description, not inside a larger
commit. Note the app must regenerate chunk embeddings in the e2e DB — uploads go through
`enqueueOrSync` (`job-processor.ts:244`), which runs inline without Redis and queues with it, so
confirm which path is active before assuming a stale row.

**Step 2 — assert the citation, not just the answer.** Extend the spec to upload **two** documents
where only the second contains the answer (one chunk per document puts the two legs in a position to
disagree, which is what makes fusion observable at all), then after the reply:

- open the `Sources (n)` collapsible (`citation-list.tsx` has `useState(true)`, but do not rely on
  default state);
- assert the citation list names the **second** document;
- assert the label is a rank label once 7a lands.

That is the assertion that would have caught a fusion regression. Without it, Phase 6 could pass and
a later `k` change could still degrade the product with E2E green.

**Step 3 — guard the override boundary.** One test asserting that with `RAG_FUSION_K` unset, sending
`x-fusion-k: 1` does **not** change the result. It fails loudly if the header is ever wired without
the guard.

**Step 4 — keep the canned-answer assertion.** It is not redundant: it guards the transport (stream
setup, SSE framing, message persistence), which is orthogonal to retrieval.

### 8.4 Run both E2E modes

`bun run e2e` runs specs against `next dev`; `bun run e2e:prod` runs the same specs against
`.next/standalone/server.js` with `NODE_ENV=production` and `E2E_TEST_MODE=true`. AGENTS.md is explicit
that dev and the shipped artifact diverge in ways invisible in dev, and that every blocker in the
2026-09 audit surfaced by changing the environment. **This plan's E2E steps are not done until both
configs pass.** Note the specs gate on `E2E_TEST_MODE` and the mock LLM on `:4545`; a failure to
reach it is an environment problem, not a retrieval result.

### 8.5 What E2E still cannot cover

E2E runs a small corpus through a mock embedder. It cannot say whether real retrieval improved. It
exists to prove the **flow** does not break — ingestion, indexing, retrieval, citation rendering,
streaming. Phase 6 proves the quality claim on real data, using `bun run rag-eval`
(`benchmark/rag-eval.ts`) for RAGAS-style scoring. Do not let a green E2E run substitute for Phase 6,
and do not let Phase 6 substitute for E2E.

## 9. Rollback plan

Per `mohitagw15856/pm-claude-skills/rollback-plan` (skill corpus), so the reverse is boring at 2am.

**Owner:** unassigned · **Approver for rollback:** on-call engineer with deploy access ·
**Rollout window:** unassigned

### 9.1 The change

A ranking constant (F1) and, separately, a tokeniser (F2). F1 is gated by `RAG_FUSION_K`. No schema
change, no migration, no backfill. Blast radius: the RAG chat path and `/api/documents/search`.

### 9.2 Trigger conditions — roll back if ANY holds

| Signal | Threshold | Window | Where |
|---|---|---|---|
| `compareRagEval` re-run returns `worse` | any | immediate | Phase 6a runner |
| RAG retrieval latency | p90 up > 100%, or p50 up > 50 ms | 15 min sustained | `rag_retrieval_latency_ms` via `/api/metrics` (token/admin — §2.3) |
| `rag_retrieval_results` | down > 20% relative to the pre-change baseline | 15 min sustained | same |
| RAG turns silently degrading to plain chat | any rise in the `prepareRagStream` catch path | 15 min sustained | server logs |
| "The chatbot no longer finds a document it used to" | one credible report | — | support |

Also roll back on any P1/P2 incident opened against the chat path during the window.

### 9.3 The reverse — exact steps

1. **Announce** in the ops channel: what is being reverted and why.
2. **Unset the flag.** `RAG_FUSION_K` unset restores `RRF_K = 60` on the next request; the value is
   read per call, so no restart is needed. Verify: `/api/metrics` labels show only the default config.
3. **Flush the RAG cache.** `invalidateRagCache()` → `cacheDel('rag:')`. Required even with the config
   in the cache key, because entries written under the experimental config are dead weight and,
   without §4a, they would be served to default-config requests. Verify: `rag_cache_miss_total`
   increments on the next query.
4. **If the flag is not enough** (F2 shipped): `git revert <sha>` on the tokeniser commit only — it is
   a separate commit precisely so this is one action.
5. **No data reversal.** Neither change writes data. Cached entries expire within `RAG_CACHE_TTL_MS`
   (60 s) and step 3 clears them sooner.
6. **Verify recovery.** Re-run Phase 6a and confirm `compareRagEval` is not `worse` against the
   pre-change baseline, and `rag_retrieval_results` has returned to baseline.

### 9.4 Data safety

- **New writes:** none. Retrieval is read-only for both changes.
- **Reversibility:** ✅ in place, by flag, no migration.
- **PII / compliance:** none touched. The cache key carries `orgId` and the new tag must not remove
  it — §4a's test covers this, and AGENTS.md records that this module leaked cross-tenant once before.
- **Backups:** none beyond the standard policy, because there is no write.

### 9.5 Verification checklist (post-rollback)

- [ ] `RAG_FUSION_K` unset in the running environment
- [ ] `/api/metrics` shows only the default fusion label
- [ ] RAG cache flushed; next query is a miss
- [ ] `bun run e2e` **and** `bun run e2e:prod` green, including the new citation assertions
- [ ] `compareRagEval` against the pre-change baseline is not `worse`
- [ ] The incident channel is told the revert is complete

## 10. Task list

Ordered; each row independently reviewable. Rows 1-4 change no behaviour.

| # | Task | Files | Done when |
|---|---|---|---|
| 1 | Fusion config in the RAG cache key + tests | `rag-retrieval.ts` | two configs never share a key; no-org case still `null` |
| 2 | Retrieval metrics + tests | `rag-retrieval.ts`, `metrics.ts` | visible at `/api/metrics`; cache hits excluded from latency |
| 3 | Baseline capture on a real install | Phase 6a runner | pre-change recall@k, MRR, p50 recorded and committed |
| 4 | `RAG_FUSION_K` + `env-schema.ts` entry + guarded header + tests | `rag-ranking.ts`, `rag-retrieval.ts`, `env-schema.ts` | unset is identical to today; header ignored when unset |
| 5 | **Relax the `fuseRankings` invariant with a negative control** | `invariants.test.ts` | relaxed pattern still rejects a renamed array and a dropped call — in its own commit, §2.1 |
| 6 | Offline `k` sweep as a benchmark arm | `benchmark/arms/*` | recall@10 / MRR per tier per candidate `k` |
| 7 | Phase 6a A/B, rule applied, 3 runs | `trial/live/*` | verdict recorded, spread reported |
| 8 | Citation label fix | `citation-list.tsx` | label is rank-based; test negative-controlled |
| 9 | Search-tester decision (expose or delete) | `knowledge-base-view.tsx`, or a deletion PR | written decision with an owner |
| 10 | E2E: mock returns 384-dim, input-derived vectors | `e2e/mock-llm.ts` | existing spec green, **no production change in the commit** |
| 11 | E2E: two-document corpus + citation assertion | `e2e/03-knowledge-chat.spec.ts` | names the correct document; fails if the order is reversed |
| 12 | E2E: override-guard test | `e2e/03-knowledge-chat.spec.ts` | header ignored when `RAG_FUSION_K` is unset |
| 13 | F2 tokeniser measured separately | `rag.ts`, Phase 6a runner | its own run and its own verdict |

Row 5 must land **before or with** row 4, or CI fails. Rows 10-12 gate confidence in the E2E
counterpart to row 7, and row 10 must be its own commit with a before/after spec run because it
changes E2E retrieval behaviour.

## 11. What this does not establish

- **It is not a quality claim yet.** Every number in §1 is offline and from a lower-bound arm. Phase 6
  may find production is unaffected — the reranker only sees 12 candidates, but it does see them, and
  it may be doing the work. A negative result retires both findings, and that is a valid outcome.
- **F1 and F2 interact.** Lowering `k` makes the ranking more head-weighted; changing the tokeniser
  changes which documents are in the head. Measuring them together makes either regression
  unattributable, which is why §6c separates them.
- **`k` is a constant, not a theory.** The offline shape (`k = 1` best for the easy tier) is specific
  to a corpus where one leg is far stronger. The right value may differ per install — the only
  argument for the per-org flag deferred in §5.
- **The synthetic corpus overstates identifier effects** — 975 of 1200 documents carry a bare-digit
  token, which real prose does not (measured: 7.0% entity coverage and near-zero identifier density
  on the app's own chunks). F2's real-world effect is unmeasured.
- **No trials have been run.** Every figure is a single measurement; Phase 6a's three-run requirement
  exists because the predecessor measured an 11-point swing from re-asking the same question.
- **The 50 ms budget is inherited**, from the predecessor plan, not derived from an SLO. If the
  product has a stricter budget, use that.
- **E2E coverage of fusion is new, and therefore unproven.** Steps in §8.3 make fusion observable in
  E2E for the first time; until row 11 lands and passes in both modes, treat the claim "E2E guards the
  ranking" as aspirational, not established.

---

## 11. Execution log

### 2026-09-24 — rows 1, 2, 4, 5, 6, 8, 10, 11, 12 implemented

Six commits, each independently reviewable. Nothing changes production behaviour: `RAG_FUSION_K`
unset resolves to the documented default, asserted by test rather than assumed.

| # | task | state |
|---|---|---|
| 1 | fusion config in the RAG cache key | done |
| 2 | retrieval metrics, cache hits excluded from latency | done |
| 4 | `RAG_FUSION_K` + guarded `x-fusion-k` + env-schema | done |
| 5 | relaxed the `fuseRankings` invariant, with a negative control | done |
| 6 | offline `k` sweep | done — result below |
| 7 | Phase 6a A/B on a real install | **not done** — needs a 50+ document deployment |
| 8 | citation badge shows a rank, not a percentage | done |
| 9 | search-tester decision | **not done** — needs an owner (see §7b) |
| 10 | e2e mock returns 384-dim input-derived vectors | done |
| 11 | e2e citation assertion on a two-document corpus | done |
| 12 | e2e override guard | done |
| 13 | F2 tokeniser measured separately | **not started** — deliberately separated (§6c) |

### The offline `k` sweep result — suggestive, and NOT the decision

*[SUPERSEDED by §12: this command and its artefacts were removed once production stopped
having a `k`. The table below is kept as the measurement that motivated the redesign.]*

`bun benchmark/fusion-k-sweep.ts --scope=held-out --out=benchmark/results/fusion-k-sweep.json`
(n=486, budget top-10, deterministic across runs):

| k | easy r@10 | medium | hard | complex | ALL r@10 | ALL MRR | ans@1 |
|---|---|---|---|---|---|---|---|
| **1** | **1.0000** | 0.0000 | 0.0145 | 0.3298 | **0.2222** | 0.2038 | 0.1049 |
| 5 | 1.0000 | 0.0000 | 0.0000 | 0.3298 | 0.2181 | 0.2075 | 0.1235 |
| 10 | 0.7600 | 0.0000 | 0.0000 | 0.3298 | 0.1811 | 0.2026 | 0.1235 |
| 20 | 0.5733 | 0.0000 | 0.0000 | 0.3298 | 0.1523 | 0.2072 | 0.1276 |
| 40 | 0.5600 | 0.0000 | 0.0000 | 0.3298 | 0.1502 | 0.2053 | 0.1276 |
| *60* | 0.5600 | 0.0000 | 0.0000 | 0.3298 | 0.1502 | 0.2038 | 0.1255 |
| 100 | 0.5200 | 0.0000 | 0.0000 | 0.3298 | 0.1440 | 0.2027 | 0.1255 |
| 200 | 0.5067 | 0.0000 | 0.0000 | 0.3298 | 0.1420 | 0.2022 | 0.1255 |

The easy tier falls **monotonically** in `k` (1.0000 → 0.5067) and the all-tier recall@10 is best
at `k = 1` (+0.0720 over the shipped value). The mechanism §2b describes is therefore real and
measured across the whole range, not just at two points.

**Two reasons this must not be shipped on the strength of this table:**

1. **answer@1 gets slightly WORSE at k=1** (0.1255 → 0.1049) while MRR is flat (0.2038 → 0.2038).
   Recall improves by pulling evidence into the window without putting it first, which is the
   least useful kind of movement for a citation a user reads — and it is the same pattern that
   sank Entity-Hop. A recall-only reading of this table would hide it.
2. It is **offline**, inheriting every documented difference from production (no reranker, no
   knowledge-graph leg, no `keywords` field, whole-corpus lexical leg). §6a on a real install is
   what decides, with three runs.

So the honest summary is: the constant is load-bearing, the sweep says a lower value is plausibly
better, and the deciding measurement has not been run because it needs a corpus this repository
does not have.

### Two things found that were NOT in the plan

**A migration the schema needs and never got.** `prisma/schema.prisma` declares
`embedding Unsupported("vector(384)")`, but the local dev and e2e databases both still carry
`vector(1536)`. Commit `63c2c21` changed the schema and its own message says "BREAKING FOR EXISTING
INSTALLS — this needs a migration", yet shipped no migration, and `prisma db push` cannot resize an
`Unsupported("vector(n)")` column — verified by probing a scratch database, where a FRESH push
correctly creates 384. So a standing install keeps a 1536 column and the vector leg stays dead
there. The e2e database was resized by hand to unblock the e2e work; the dev database was left
alone because its 114 stored vectors are at 1536 and resizing drops them. **This needs the
documented migration (`tools/local-embeddings/README.md`) and is the one open item that affects
production rather than the harness.**

**The e2e suite is fixed and still cannot see a fusion change.** Both halves of that statement are
measured. The mock now returns 384-dim input-derived vectors, so chunks do reach pgvector (1 non-null
`embedding`, up from 0) and citations DO render — the new test proves the RAG branch runs
(`ToolRun` type `RAG`), that the answering document is cited, and that the badge is a rank rather
than a percentage. But `resolveVectorScores` discards the vector leg below
`MIN_VECTOR_LEG_ROWS = 8`, and with 3-4 chunks the log reads
`requested: 96, received: 4` — so `vectorRanking` is empty, `fuseRankings` gets one non-empty list,
and `1/(k + rank)` is monotonic for every `k`. Enlarging the fixture was tried and reverted: the
mock embedder is a hash bag of tokens, and ten filler documents made meeting-room text outrank the
document that literally answers the question. A test asserting rank order over that would be
measuring the hash. The limitation is documented in the spec's header rather than worked around.

### What remains

1. **Phase 6a on a real install** (row 7) — the only thing that can decide `RRF_K`, and it needs
   50+ documents. Nothing else in this plan can substitute for it.
2. **The vector-column migration** for standing installs, above.
3. **The search-tester decision** (row 9) — expose it in the UI or delete it; needs an owner.
4. **F2 tokeniser** (row 13) — its own run and its own verdict, per §6c.

### 2026-09-24 (later): the data already answers the questions §11 left open

The same `k` arms were run on the app's own prose (`benchmark/real-prose-arm.ts`, 114 chunks,
121 questions, real `paraphrase-multilingual-MiniLM-L12-v2` vectors):

| arm | r@5 | r@10 | MRR | ans@1 |
|---|---|---|---|---|
| **bm25 only** | **1.0000** | **1.0000** | **0.9725** | **0.9504** |
| hybrid k=1 | 0.9917 | 1.0000 | 0.7928 | 0.6364 |
| hybrid k=5 | 0.9917 | 1.0000 | 0.7469 | 0.5868 |
| hybrid k=20 | 0.9091 | 1.0000 | 0.6605 | 0.4959 |
| hybrid k=60 (shipped) | 0.8347 | 0.9752 | 0.6254 | 0.4628 |
| hybrid k=200 | 0.8182 | 0.9587 | 0.6186 | 0.4628 |

And on the dev database, a 384-dim query against the live `vector(1536)` column fails with
`different vector dimensions 1536 and 384`, so today's production vector leg errors out and
retrieval is effectively BM25.

Three conclusions follow, and none of them needs another run:

1. **Do NOT run the vector-column migration on its own.** It is the change that turns the
   vector leg ON, and on real prose that moves answer@1 from BM25's 0.9504 to hybrid-k60's
   0.4628. The "fix" is a regression of roughly half the first-place answers. The migration
   may only ship together with a fusion change, and after the next point.
2. **No value of `k` rescues the hybrid.** Lower is better monotonically on both corpora, but
   the best hybrid (k=1, ans@1 0.6364) is still 31 points below BM25 alone. Tuning `k` narrows
   a loss; it does not create a win. The synthetic answer@1 dip at k=1 (61 → 51 of 486) is
   noise next to that.
3. **The row-7 A/B is not needed to decide this.** It was blocked on "a real install with 50+
   documents"; the dev database IS 114 chunks of the product's real documents. What is still
   worth measuring is a *different* design (vector as a fallback when BM25 finds nothing, or a
   BM25-weighted fusion), not another value of `k`.

Caveat, stated because it biases the table: the questions are extractive, built from the
documents' own sentences, which favours lexical matching. That is why BM25 is near-perfect and
why paraphrased questions could narrow the gap. It does not change conclusion 1: a change that
turns the vector leg on must be measured before it ships, and on the only real corpus
available it measures as a large regression.


---

## 12. The design chosen, and what shipped

§11 concluded that no value of `k` rescues RRF fusion, and §11's own measurement already
contained the answer: BM25 alone beat every fused variant, while `vector-only` scored
answer@1 0.2149 — the vector leg is the weaker retriever on this corpus, so giving it an
equal vote can only cost ranking quality. The fix is not to tune the vote, it is to stop
holding one.

**Shipped: lexical-first with a scoring tokenizer.**

1. `lexicalFirst` (`src/lib/rag-ranking.ts`) keeps the BM25 order exactly and appends
   vector/KG-only ids after it, deduped, scored `1/(rank+1)`. It replaced `fuseRankings`,
   which is retained for the offline comparison arms only.
2. `tokenizeForScoring` (`src/lib/rag.ts`) keeps term frequency (so BM25 is real BM25, not
   a set overlap) and keeps hyphenated identifiers whole as well as split.

Measured, 121 questions over the app's own 114 chunks (real MiniLM vectors):

| ranking | recall@10 | MRR | ans@1 |
|---|---|---|---|
| BM25 only, shipped tokenizer | 1.0000 | 0.9139 | 0.8347 |
| RRF fusion (what was shipping) | 0.9752 | 0.6254 | 0.4628 |
| **lexical-first + scoring tokenizer (now shipping)** | **1.0000** | **0.9731** | **0.9504** |
| vector leg alone | 0.5620 | 0.3254 | 0.2149 |

Synthetic held-out (n=486) confirms the direction on a corpus with tiers keyword search
cannot solve: recall@10 0.3848 → 0.4342, hard tier 0.4638 → 0.3768 at the same time as the
complex tier rises 0.3404 → 0.7340.

**Consequences that had to be handled, not deferred:**

- `RAG_FUSION_K`, the `x-fusion-k` header, and `rag-fusion-config.ts` are DELETED. They
  configured a constant that no longer exists. A leftover header is inert, asserted through
  `/api/rag/evaluate`.
- The cache key's `k<value>` segment became `RANKING_VERSION` ('lex1'). The old tag existed
  so an A/B could not read a stale ranking's order; the same hazard now applies across a
  release, so the segment stays and is bumped with the ranking.
- Retrieval metrics are labelled `ranking="lex1"` instead of `k="60"`, for the same reason.
- The benchmark arms now import the production tokenizer and combination, so the numbers
  above describe the product rather than a copy (the entity-hop arm's base too, or its
  measured delta would be against a ranking that no longer exists).
- The `k` sweep, its arm and its result file are removed: they measured a parameter
  production no longer has.

**What this still does not prove.** The benchmark questions are extractive, built from the
documents' own sentences, which favours lexical matching — that is why BM25 is near-perfect
here and why the vector leg has little room to help. The vector leg's value should show up on
PARAPHRASED questions, which this corpus cannot generate honestly. On a deployment with real
user traffic, §6a's product-surface A/B is still worth running once paraphrase data exists;
until then the evidence supports lexical-first and nothing stronger.

### 2026-09-24 (last): the vector-column migration, applied

§11 recorded a migration that commit `63c2c21` declared necessary and never shipped. With
data cleanup authorised — this is a fresh program, so the 114 stored `uat-deterministic-1536`
vectors were expendable — it is now APPLIED to the dev database, and the vector leg is live
for the first time.

What was done, in the documented order (`tools/local-embeddings/README.md`):

1. `DROP INDEX "DocumentChunk_embedding_hnsw"` — the HNSW index is bound to the column type.
2. `ALTER TABLE "DocumentChunk" DROP COLUMN embedding` then `ADD COLUMN embedding vector(384)`.
   `prisma/schema.prisma` already declared `vector(384)`; the live column was the stale part,
   so no schema edit was needed and `prisma db push` cannot do this (it is opaque to
   `Unsupported("vector(n)")` — verified earlier by probing a scratch database).
3. Re-embedded all 114 chunks from the cached MiniLM vectors (`/tmp/real-doc-embeddings.json`,
   the same ones the benchmark used), rewriting `embedding`, `embeddingJson`, `embeddingModel`
   and `embeddedAt` together so the three cannot disagree.
4. Rebuilt the HNSW index; `indisvalid` and `indisready` both true.

**`LLM_ALLOWED_HOSTS=127.0.0.1` was the missing piece.** `isBlockedHost()` refuses loopback and
private hosts to prevent SSRF, and the self-hosted embedding server listens on loopback — so
the query embedding came back `null` and retrieval silently degraded to lexical-only. The
operator-facing fix is `LLM_ALLOWED_HOSTS` (checked BEFORE the blocklist, exact hostnames),
NOT the test marker `LLM_ALLOW_BLOCKED_HOSTS`, which `env-schema.ts` refuses in production.
This is documented in `tools/local-embeddings/README.md` and was simply not set in `.env`.

Setting it broke six security test files, all asserting the DEFAULT posture. That was fixed
in the test RUNNER, not by weakening the guard — see the commit for the three levers that did
and did not work.

**The result, and why it matters more than the benchmark did.** The benchmark built its
questions from the documents' own sentences, which is why BM25 scored ~perfect and the vector
leg had no room to help. Asking a question the corpus shares no vocabulary with shows the
other side:

```
Q: "how many annual leave days do employees get?"     (English; corpus is Indonesian)
  #1 01-kebijakan-cuti.md            bm25=0    sim=0.7791
  #2 01-kebijakan-cuti.md            bm25=0    sim=0.5843
  #3 01-kebijakan-cuti.md            bm25=0    sim=0.6521
  #4 09-panduan-pelatihan-karyawan.md bm25=0    sim=0.5734
```

Every hit has `bm25=0`: the lexical leg found NOTHING, and the vector leg alone produced the
correct annual-leave policy at rank 1. That is the case lexical-first was designed to keep
working — the vector leg fills in behind a lexical head rather than competing with it — and it
is the first direct evidence in this document that the vector leg earns its place. The
benchmark could not have produced it, because its questions were lexical by construction.


### 2026-09-24 (close-out): the paraphrase gap, closed by independent measurement

§12 ended by naming the one thing the benchmark could NOT test: its questions were built from
the documents' own sentences, so they are lexical by construction, which flatters BM25 and
leaves the vector leg no room. It said the vector leg's value "should appear on PARAPHRASED
questions, which this corpus cannot generate honestly."

That gap is now measured, on five English questions against the Indonesian corpus — a
paraphrase, no shared token, and unmapped vocabulary, so the lexical leg has nothing to match:

| question | result | lexical score of the hits |
|---|---|---|
| how many annual leave days do employees get? | HIT | bm25 = 0 on every hit |
| what is the reimbursement limit for business travel? | HIT | bm25 = 0 on every hit |
| what are the laptop memory requirements? | HIT | bm25 = 4.46 (partial match) |
| how long does an employee have to submit an expense claim? | MISS | — |
| when are fire drills conducted? | MISS | — |

**3 of 5.** The load-bearing column is the third one: on all three hits the lexical leg
scored ZERO, so the hits are attributable to the vector leg alone and the "no embeddings →
0/5" counterfactual holds by construction rather than by argument. A document could not have
been found by keyword search at all.

Two things follow, and they are the honest reading:

1. The vector leg EARNS ITS PLACE, but only where lexical matching fails. That is precisely
   what lexical-first is built to exploit — the leg fills in behind an intact BM25 head
   instead of competing with it — and it is why the two changes belong together: under RRF
   this same leg, on this same corpus, measured answer@1 0.2149 and dragged the fused result
   below BM25 alone.
2. 3/5 is an improvement, not a solution. Two of five questions still miss, and the model is
   384-dim MiniLM-class. A larger multilingual model would do better at the cost of a column
   resize; that trade is a separate decision with its own measurement.

The numbers come from a single corpus of 114 chunks in one language pair, so they bound the
claim rather than settle it. What they DO settle is the question §12 left open: the vector leg
contributes real retrieval, measurably, in exactly the case the benchmark could not reach.


### Caveats that bound §7 and §12, measured after the fact

Two gaps between the benchmark and the pipeline it claims to describe. Both were found by
auditing the arms rather than by a failure, and both mean the numbers above are narrower than
they first read.

**1. The benchmark has no reranker; production re-ranks by default.**
`RAG_LLM_RERANK !== 'false'`, so production retrieves `topK * 3` candidates, fuses them, then
has the reranker pick `topK` from that head. Every arm here stops at fusion. So the quantity
that actually decides a production answer is recall at the RERANKER's budget (~12 for
`topK=4`), not recall at 10 — and the deciding property is whether the answer is IN that head,
because the reranker can promote within it but cannot recover a chunk that never arrived.
Measured on the synthetic held-out split:

| budget | BM25 recall@10 | shipped hybrid recall@10 |
|---|---|---|
| 4 | 0.2901 | 0.2181 |
| 12 (what the reranker sees) | 0.3292 | 0.2695 |
| 30 | 0.4938 | 0.3066 |

**2. On synthetic data the shipped TOKENIZER is weaker than the reference baseline, and the
gap is not the fusion.** Isolating the two factors at the reranker's budget:

| arm | recall@10 | MRR | ans@1 |
|---|---|---|---|
| `bm25-baseline` (reference tokenizer) | 0.3292 | 0.2830 | 0.1811 |
| `bm25-only` (shipped tokenizer) | 0.2695 | 0.2526 | 0.1749 |
| **shipped hybrid** (lexical-first) | **0.2695** | **0.2526** | **0.1749** |
| `vector-only` | 0.1132 | 0.1053 | 0.0576 |

Two things follow, and the first is the reassuring one: `bm25-only` and the shipped hybrid are
IDENTICAL to four decimal places, so lexical-first costs nothing against lexical-alone. The
fusion is not the problem on this corpus. The second is not reassuring: the 0.06 gap to
`bm25-baseline` is a TOKENIZER difference, and it goes the wrong way. `rag-ranking`'s IDF
prefers corpus-wide `df` from `ts_stat` and falls back to pool-local `df` when that table is
empty — which offline it always is. On a small pool a rare term collapses toward zero
discriminating weight. Production populates `CORPUS_DF` from the FTS rebuild, so this is
partly measurement artefact: on the app's OWN 114 chunks the shipped tokenizer measured
BETTER (ans@1 0.9504 vs 0.8347), where the corpus statistics exist.

The honest reading is that the two corpora disagree, and the reason is a known mechanism
rather than noise: corpus-level IDF helps and the offline harness cannot supply it. **The
real-prose numbers (§12) are the ones to trust for this deployment**, because they were
measured with the app's own documents and the shipped tokenizer; the synthetic sweep remains
useful for DIRECTION and for per-tier shape, not for absolute quality.

**A third caveat, on the reranker itself:** it is never exercised in this environment (the
configured chat endpoint requires an API key that is not available here), and when it fails at
runtime `dispatchRerank` falls back to `chunks.slice(0, topK)` — the fused order unchanged. So
the fused order is the floor a production deployment gets even with a dead reranker, and every
number in §7 and §12 describes that floor.


### 2026-09-24 (with a real LLM): the "3/5" was measuring the corpus, not the retrieval

§12 and the close-out above both quoted **3/5** on hard paraphrase questions and treated the
two misses as a ranking shortfall. That reading was WRONG, and a real LLM endpoint made the
error visible.

**The two "misses" asked about things the corpus does not contain.** Counted directly:

| term | chunks in corpus |
|---|---|
| `kebakaran` | 0 |
| `fire drill` | 0 |
| `reimburse` | 0 |
| `klaim` | 0 |

So those questions could not be answered by ANY ranking — the retrieval was being blamed for
a missing document. Re-run against eight paraphrase questions whose answers DO exist
(English questions, Indonesian corpus, no shared vocabulary):

| | top-1 | in top-5 |
|---|---|---|
| reranker OFF | **8/8** | 8/8 |
| reranker ON | **8/8** | 8/8 |

**8 of 8 at rank 1, and `bm25=0` on seven of them** — the lexical leg found nothing at all on
those seven, so the vector leg alone put the correct document first. That is much stronger
evidence for the vector leg than the 3/5 it replaces, and it is the honest number: the
earlier figure understated it by measuring topic coverage.

**The reranker is confirmed working, and confirmed to change nothing measurable here.** Its
existence had been an assumption in §11-12 (no reranker in the offline arms). Now verified
against the real model:

- it returns well-formed scores and promotes correctly — given a mid-list paternity-leave
  chunk among three distractors it returned `index 2 -> 10` against `1, 1, 1` for the rest;
- end-to-end grounding, 4 questions, **4/4 GROUNDED** at ~1.1-1.7 s each, with every figure
  correct (`5 working days`, `Rp 7.500.000`, `5 members`, `16 GB`);
- on absent topics it **admits ignorance in 3/3 cases** rather than inventing an answer, even
  at `semanticSimilarity` 0.614 where a weaker model would have been tempted;
- toggling `RAG_LLM_RERANK` moves none of the eight paraphrase questions, because when the
  vector leg already puts the right document first there is nothing for a reranker to fix.

**What this changes in the conclusion.** Retrieval quality on this corpus is better than §12
claimed: rank-1 on every paraphrase question that has an answer, with the vector leg doing the
work and the lexical leg contributing nothing on seven of eight. What remains unmeasured is
ANSWER quality on questions whose answers exist but require synthesis across documents, and
anything resembling a real user population.
