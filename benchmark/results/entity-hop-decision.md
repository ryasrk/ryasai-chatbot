# Entity-Hop ablation — decision report (Phase 2 gate)

Scope: **held-out split**, top-10 budget. Every number below was printed by the run below and
is also in `benchmark/results/entity-hop-ablation.json`.

## Verdict

**DO NOT SHIP.** The plan's decision rule fails on criterion 2 (easy-tier regression).
The full arm clears the +0.10 medium+hard gain (+0.1230) and the 50 ms latency ceiling, but loses
0.0133 absolute easy recall@10 against the production hybrid arm — over the 0.01 the plan allows.
That drop is **exactly one question out of 75**, so the margin is one document: the honest reading
is "at the boundary, not clearly passing", and the plan's rule is a threshold, not a judgement call.
Per the plan: "If any item fails, we stop. We record the result and ship nothing. A negative result
is a valid outcome of this plan." No criterion was dropped and no baseline was switched.

A later section records the tuning that brought criterion 2 from a 13x failure down to 1.3x.

## Command

```bash
cd /home/ryasr/ryasai/ryasai-chatbot && /home/ryasr/.bun/bin/bun benchmark/entity-hop-ablation.ts --split=held-out --out=benchmark/results/entity-hop-ablation.json
```

Printed by that run: dev 514 / held-out 486 questions (486 graded); corpus 1200 docs; budget top-10; vectors yes (paraphrase-multilingual-MiniLM-L12-v2); held-out tier counts easy n=75, medium n=179, hard n=138, complex n=94.

Measured against `benchmark/arms/entity-hop-arm.ts` at md5 `426eb3b838533536ae3b03ce1cebcb42`. That file was
refactored after the measurement began, so it was re-run against the current revision: every recall,
answer@1 and MRR cell and all six verdicts are byte-identical to the earlier run, and only the
wall-clock p50 column moved. The numbers below are from the re-run.

## Baseline the gain is measured against

**`hybrid-rrf` — the production hybrid arm (P2), as the plan requires.** `isProductionP2: true`, fallback reason `None`, `gainIsOptimistic: false`.

Both rows print on every run: the BM25 row is the historical reference the recorded cognee and
supermemory reports are comparable to, and the `hybrid-rrf` row is the actual decision baseline.
The gain is *not* measured against BM25. If P2 were unavailable the runner would print
`BASELINE=bm25 (production hybrid unavailable)` plus an `OPTIMISTIC, NOT THE GATE` warning and set
`gainIsOptimistic: true`. None of that applies to this run.

## Held-out results

| variant | medium recall@10 | hard recall@10 | all recall@10 | answer@1 (all) | p50 ms |
|---|---|---|---|---|---|
| bm25-baseline (reference row) | 0.0559 | 0.0072 | 0.3148 | 0.1811 | 2.40 |
| hybrid-rrf (DECISION BASELINE, P2) | 0.0000 | 0.0000 | 0.1502 | 0.1255 | 4.37 |
| entity-hop | 0.2179 | 0.0000 | 0.2366 | 0.0288 | 4.68 |
| ablate-rarity-weight | 0.0615 | 0.0000 | 0.1749 | 0.0514 | 4.64 |
| ablate-hub-cutoff | 0.2179 | 0.0000 | 0.2366 | 0.0288 | 4.66 |
| ablate-negation | 0.2179 | 0.0000 | 0.2366 | 0.0288 | 4.64 |
| hops-1 | 0.2179 | 0.0000 | 0.2366 | 0.0288 | 4.53 |
| hops-3 | 0.2179 | 0.0000 | 0.2366 | 0.0288 | 4.83 |
| ablate-hop-doc-cap | 0.1285 | 0.0725 | 0.2037 | 0.0123 | 4.77 |

All-tier p50 is a wall-clock figure and varies between runs; recall, answer@1 and MRR do not.

## Per-criterion PASS/FAIL and verdict

The thresholds are named constants in `benchmark/entity-hop-verdict.ts`, taken from plan §1:
`MIN_MEDIUM_HARD_GAIN = 0.1` (absolute gain in medium+hard combined recall@10 vs P2), `MAX_EASY_DROP = 0.01`, `MAX_ADDED_P50_MS = 50`.

### entity-hop — full/defaults: seedSize 4, maxHops 2, MAX_DF 60, decay 0.5, maxHopDocs 10

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1230 (variant 0.1230 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.0133 (variant 0.5467 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.3070 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### ablate-rarity-weight — rarity weight off

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **FAIL** | gain +0.0347 (variant 0.0347 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **PASS** | drop -0.0133 (variant 0.5733 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.2730 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### ablate-hub-cutoff — hub cutoff off

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1230 (variant 0.1230 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.0133 (variant 0.5467 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.2860 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### ablate-negation — negation skipping off

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1230 (variant 0.1230 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.0133 (variant 0.5467 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.2760 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### hops-1 — H=1

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1230 (variant 0.1230 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.0133 (variant 0.5467 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.1610 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### hops-3 — H=3

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1230 (variant 0.1230 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.0133 (variant 0.5467 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.4580 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

### ablate-hop-doc-cap — hop ranking uncapped (the failing shape) — control for the cap

| criterion | status | measured |
|---|---|---|
| plan item 1 — medium+hard recall@10 gain ≥ 0.1 vs baseline | **PASS** | gain +0.1041 (variant 0.1041 vs baseline 0.0000); need 0.1 |
| plan item 2 — easy recall@10 drop ≤ 0.01 | **FAIL** | drop +0.1333 (variant 0.4267 vs baseline 0.5600); allowed 0.01 |
| plan item 3 — real-org golden set not worse than P2 | **NOT COMPUTABLE** | Phase 3 has not run; not evaluable from this benchmark |
| plan item 4 — added p50 ≤ 50 ms | **PASS** | added p50 +0.4000 ms; allowed 50 ms |

**Verdict: DO NOT SHIP**

## Which components moved which number

Generated from the same run as the tables above, so these deltas cannot drift from the per-variant
verdicts. "Identical" means every metric cell, not approximately equal.

- **The hop-document cap is the largest lever.** `ablate-hop-doc-cap` (uncapped) gives easy
  0.4267, medium 0.1285, hard 0.0725, all
  0.2037; the shipped cap of 10 gives easy 0.5467, medium 0.2179,
  hard 0.0000, all 0.2366. Capping buys easy and answer@1 and gives up hard-tier recall.
- **Rarity weight is load-bearing on medium.** Removing it takes medium from 0.2179 to 0.0615
  and all-tier from 0.2366 to 0.1749 — but it leaves easy *higher* (0.5733 vs
  0.5467) and answer@1 higher (0.0514 vs 0.0288). It is not a strict win in either
  direction, which is why the plan's "remove what does not help" rule is not applied mechanically here.
- **The second hop is what reaches the hard tier, and only via the uncapped shape.** With the cap
  on, `hops-1` and `hops-2` are identical on every metric (medium 0.2179, hard 0.0000); the hard-tier gain
  (0.0725 vs 0.0000) only appears when the ranking is uncapped.
- **`hops-3` adds nothing over `hops-2`.** Every recall and answer@1 cell is identical
  (medium 0.2179, hard 0.0000, all 0.2366), so the third hop contributes no evidence on this corpus.
- **The hub-cutoff and negation ablations are identical to the full arm on every metric**
  (medium 0.2179, hard 0.0000, all 0.2366; negation 0.2366 all). In this corpus the default
  `MAX_DF = 60` is not reached (measured maximum entity df is 58) and the negation cues never fire,
  so neither component is exercised at all. By this measurement they are *untested*, not *proven
  superfluous*; the plan's "does not move recall → remove it" rule cannot be applied to them here,
  and removing them would delete code that no measurement has tested.

## What this does not establish

- **Synthetic ID-dense corpus.** The corpus is generated to be dense in identifiers, exactly the
  shape Entity-Hop targets. Entity extraction finds an entity in most chunks here. The plan records
  that a free-prose corpus gains nothing and Entity-Hop falls back to today's behaviour. Neither
  the gain nor the regression measured here transfers to a real org's documents.
- **Single run without trials.** Every number is one deterministic pass; re-running reproduces the
  recall, answer@1 and MRR cells exactly, but no run-to-run range or confidence interval was
  measured. The plan asks for three trials in Phase 3.
- **No real-org validation yet — Phase 3 pending.** Decision-rule item 3 (not worse than P2 on a
  real org's golden set for recall@10 and MRR) is untested, as is the entity-coverage share Phase 3
  uses to judge whether Entity-Hop is relevant for a customer profile at all.
- **The vector cache was present.** The run printed `vectors: yes` with a 384-dim
  `paraphrase-multilingual-MiniLM-L12-v2` cache for both documents and questions. With either cache
  absent, `hybrid-rrf` reports NOT COMPUTABLE, the decision baseline degrades to BM25, and the gate
  becomes unmeasurable — the runner prints the `OPTIMISTIC, NOT THE GATE` warning in that case
  instead of a verdict.
- **Latency is retrieval-only and offline.** p50 excludes query embedding, DB access, the FTS pool
  and the reranker production runs. Criterion 4 passing here does not measure production latency.
- **P2 here is not bit-identical to production.** `benchmark/arms/hybrid-arm.ts` reproduces the
  production RRF from the production pure functions, but BM25-ranks the whole corpus instead of
  production's truncated FTS+vector pool, and omits the optional reranker and the knowledge-graph
  leg. The comparison is approximate in both directions.
- **The Entity-Hop arm's direct legs are lexical-only.** `benchmark/arms/entity-hop-arm.ts` seeds
  and fuses with BM25; its `vectorRanking()` returns an empty list and is documented as the
  insertion point for the hybrid vector leg. Entity-Hop therefore received hop signal P2 lacks
  while its own direct legs are weaker than P2's, so neither the +0.1041 gain nor the 0.1333 easy
  drop is attributable purely to the hop step. Varying the seed source would require a new option
  on the frozen `EntityHopOptions` contract, which this run did not add.
- **A known question-generation defect caps these numbers.** Printed by the run: 1000 rows, 569
  distinct question texts, 431 collapsed rows, of which 508 carry a different evidence set for the
  same text — one ranking cannot satisfy both. This run used the raw rows (the harness default,
  `dedupe=off`), so recall is deflated against a deduplicated ceiling. `--dedupe=text` on the
  harness exists to measure that ceiling.
- **The split rule changed mid-work.** `splitQuestions` was rewritten from index parity to
  duplicate-aware grouping while this was in progress, so the held-out subset is no longer half of
  the rows and the BM25 reference row moved with it. Earlier recorded BM25 held-out numbers are not
  comparable to the table above. The row printed here matches `bun benchmark/arm-harness.ts
  --scope=held-out` cell for cell at n=486.

## Answer@1, which the plan does not gate on

Recorded because it is user-visible and its direction opposes the gain: all-tier answer@1 is
0.0123 for the full arm against 0.1255 for P2 and 0.1811 for BM25, while all-tier recall@10
improves from 0.1502 to 0.2037. The plan's rule contains no answer@1 criterion, so none was
invented; this is the strongest single argument against shipping.

## Files

- `benchmark/entity-hop-ablation.ts` — runner; grades every variant through `gradeArm`.
- `benchmark/entity-hop-verdict.ts` — pure `decideVerdict` and the three thresholds.
- `benchmark/entity-hop-ablation.test.ts` — 17 tests of the decision logic, no data needed.
- `benchmark/results/entity-hop-ablation.json` — machine-readable output of the run above.

