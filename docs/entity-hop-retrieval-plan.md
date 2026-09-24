# Plan: Entity-Hop Retrieval

Status: proposed, not started. Written 2026-09-24.

> **Execution log — 2026-09-24.** Phase 1-2 are being executed. See section 8 for what has
> been built, what is measured, and what is currently blocked.

## 1. Goal and decision rule

**Goal:** answer multi-hop questions better than the current production retrieval. Stay
deterministic and cheap: no LLM call per document, and the same input always gives the same
output. Show the user the path that joined the evidence.

**Decision rule, fixed before any code:** Entity-Hop ships only if every item below holds.

1. It beats the production pipeline (arm P2) on clean-set medium + hard recall@10 by at least
   **+0.10 absolute**, with the same 10-document budget.
2. Easy-tier recall@10 does not drop by more than 0.01 against P2.
3. On a real org golden set it is not worse than P2 on recall@10 or MRR.
4. The p50 added retrieval latency is at most **50 ms**.

If any item fails, we stop. We record the result and ship nothing. A negative result is a valid
outcome of this plan.

The claim we are allowed to make afterwards is only what these numbers support. "Revolutionary"
and "new algorithm" are not claims this plan can produce.

## 2. What we already know (measured, see `benchmark/results/`)

| fact | number | source |
|---|---|---|
| Keyword search is perfect on single-document ID questions | easy 1.0000 | `cognee-1000-bm25-baseline.md` |
| One extra search round, from the IDs in the first results, helps a lot | medium 0.0571 → 0.4486 | same |
| That crude iteration still fails 3-hop questions | hard 0.0100 → 0.0300 | same |
| The only cognee run we have is invalid | easy 0.2733, no embedder recorded | `cognee-benchmark-report.ts` exits 1 |

**What we do NOT know:** how the production pipeline (`retrieveAndFuse`: vector + BM25 + RRF) scores on
this benchmark. It has never been measured here. That is Phase 1, and it can end the plan early.

## 3. Algorithm (the whole thing)

Entity-Hop is **one more ranking fed into the RRF that already exists** in
`src/lib/rag-retrieval.ts → retrieveAndFuse`. It does not add a new pipeline, service, or storage
engine.

```
seed      = top S chunks of the existing fused ranking          (S = 4)
frontier  = entities(seed) − entities(query)
for hop in 1..H:                                               (H = 2)
    for e in frontier, highest weight first:
        weight(e) = log(N / df(e))                              # rare entity = strong bridge
        skip e if df(e) > MAX_DF                                # hub entities (a warehouse) flood results
        for chunk in index[e], not yet seen, not negative-for(e):
            score[chunk] += weight(e) * decay^(hop-1)           (decay = 0.5)
            parent[chunk] = (e, source chunk)                   # the evidence path
    frontier = entities(chunks added this hop) − already visited
hopRanking = chunks sorted by score, best first
final      = fuseRankings([vectorRanking, bm25Ranking, hopRanking])
```

Three differences from the prototype `iterativeTopK`, each aimed at a measured failure:

- **Per-entity hops, not one merged query.** The prototype joins every discovered ID into a
  single BM25 query. A hub ID then outranks the one rare ID that actually bridges to the answer.
  *Hypothesis:* this is why hard stays at 0.03. It is untested, so Phase 2 measures it first.
- **Rarity weight + hub cutoff.** An entity found in 300 documents is not a bridge.
- **Fused, not appended.** The hop ranking goes into RRF alongside vector and BM25. It cannot
  push out a strong direct hit, so the easy tier stays protected.

**Negation (deliberately minimal):** skip a hop through chunk X for entity E when X contains a
negation cue within the same sentence as E (`no record`, `not attached`, `does not apply`,
`tidak ada`, `bukan`). Use a fixed regex list and nothing more. The ablation in Phase 2 decides
whether it stays.

### Entity extraction (deterministic, no LLM)

- **ID pattern:** `\b[A-Z]{1,5}-\d{2,6}\b` catches `DL-106`, `INV-0001`, `PO-0054`, `W-01`, `AF-012`.
- **Organisation names:** `PT <Capitalised> <Capitalised>?`.
- **Other names** (`Project Alpha`, people): only when they appear in ≥ 2 chunks as the same
  Capitalised bigram. Singletons cannot bridge anything, so they are not worth storing.
- **Normalise** to upper-case ID / lower-case name for matching.

**Known limit:** documents with no IDs and no Capitalised names (free prose) gain nothing, and the
algorithm falls back to exactly today's behaviour. That is acceptable. We accept it and do not
engineer around it.

## 4. Phases and to-do

Each phase ends in a go/no-go. Do not start a phase before the previous gate passes.

### Phase 1 — Measure production (1–2 days)

Question to answer: how does what we actually ship score on the clean set?

- [ ] Create `benchmark/prod-rag-arm.ts`. It imports the **pure** functions only
      (`bm25Rank`, `fuseRankings`, `toRanking` from `src/lib/rag-ranking.ts`, `tokenize` from
      `src/lib/rag.ts`). It takes no DB, no Prisma, and no org context, over
      `benchmark/data/cognee-1000-corpus.json` + `cognee-1000-questions.jsonl`.
- [ ] **Arm P1:** BM25 + RRF, the lexical leg only. No server is needed.
- [ ] **Arm P2:** P1 + vector leg. Embed the 1200 docs once with the real local model
      (`uat/fixtures/embedding-server-real.py`, `paraphrase-multilingual-MiniLM-L12-v2`) and cache
      the vectors in `benchmark/data/`. The vector ranking is cosine top-k. Write the model name
      into the output (the `embedder-recorded` rule applies here too).
- [ ] Reuse the grading from `cognee-bm25-baseline.ts` (`evidenceHitAtK`, `finalHopRank`), plus
      per-hop recall: the share of each question's evidence documents found.
- [ ] Output `benchmark/results/prod-rag-arm.json` with per-tier recall@5/@10, answer@1, MRR, per-hop
      recall, and the command that produced it.
- [ ] Test file: grading on a 3-document fixture (hit, miss, partial).

**Gate:** record P2's numbers. If P2 medium + hard recall@10 ≥ 0.80, Entity-Hop has little room to
win. Stop and write that down.

**Constraint:** do not refactor `rag-retrieval.ts` to make it callable from the benchmark. If
`retrieveAndFuse` cannot run offline, re-assemble it from the pure functions in the arm and state
the difference in the output. Candidate pools differ: production pulls its pool from FTS +
vector, while the arm uses the whole corpus.

### Phase 2 — Prototype Entity-Hop in the benchmark (2–3 days)

- [ ] `benchmark/entity-hop.ts`: `extractEntities(text)`, `buildEntityIndex(chunks)`,
      `entityHopRanking(query, seedIds, index, opts)`. Pure functions, about 150 lines.
- [ ] Arm **E** = P2 + hop ranking in RRF. Same 10-document budget.
- [ ] Ablations, one flag each, all on the clean set:
      - E without rarity weight
      - E without the hub cutoff
      - E without negation
      - E with H=1 vs H=2
      - E with merged-query hops (reproduce the prototype)
      Each ablation must earn its place. A component that does not move recall is removed.
- [ ] Tune `S`, `H`, `MAX_DF`, `decay` on a **dev split** (questions with an even index). Report
      final numbers on the **held-out split** (odd index). Fix the split before tuning.
- [ ] Test file: a 4-chunk fixture where only a 2-hop entity path reaches the answer; a hub-entity
      fixture that must be skipped; a negation fixture.

**Gate:** decision-rule items 1, 2 and 4 on the held-out split. Fail → stop.

### Phase 3 — Validate on real data (1–2 days)

- [ ] Pick one real org with ≥ 50 documents. Generate its golden set:
      `bun run benchmark/golden-set.ts --org <id> --limit 40 --out …`.
- [ ] Score P2 vs E on it. Three trials each, report mean and range.
- [ ] Count how many of the org's chunks contain at least one extracted entity. If under 20%,
      Entity-Hop is irrelevant for that customer profile. Record the share either way.

**Gate:** decision-rule item 3. Fail → stop.

**Constraint:** read-only against the org. No schema change, no writes. Run inside
`enterWithOrg` so every query stays tenant-scoped.

### Phase 4 — Ship behind a flag (3–4 days)

Only after gates 1–3 pass.

- [ ] Move the pure functions to `src/lib/rag-entity-hop.ts` + `rag-entity-hop.test.ts`.
- [ ] **Storage:** one new column `DocumentChunk.entities String?` (JSON array), written at chunk
      time next to `keywords`, plus a backfill on the existing reprocess path. No new table and no
      graph database. Lookup is a `findMany` on the candidate org's chunks whose `entities`
      contains the ID. Add a GIN index only if Phase 4 latency measurement needs it.
- [ ] Wire into `retrieveAndFuse`: compute `hopRanking` from the fused top S, then pass it as one
      more entry in `rankings`. That is one call site; `fuseRankings` already takes N rankings.
- [ ] Flag `RAG_ENTITY_HOP` (env, default **off**). Flip the default to on only after one release
      with it on in the e2e suite.
- [ ] Evidence path: extend the existing `CitationTrail` (`src/lib/citation-trail.ts`, which
      already has `entity` / `relation` / `chunkId`) with the hop parents. No new UI component;
      the trail already renders.
- [ ] Tests:
      - unit tests for extraction, weighting, cutoff and negation;
      - a `rag-retrieval` test that the flag off gives byte-identical rankings to today;
      - a tenant test that the entity lookup never returns another org's chunk.
- [ ] Verification: `bun test src/lib/invariants.test.ts`, the area tests, `bun run test`,
      `bun run e2e`, `bun run e2e:prod`, and the real-PDF ingestion check from `AGENTS.md`.

### Phase 5 — Decide cognee (half a day, after Phase 4)

- [ ] Re-run the cognee arm on the clean set with a recorded real embedder.
- [ ] If cognee does not beat E, propose making it opt-in instead of default. This is a
      separate decision with its own PR; this plan does not remove it.

## 5. Constraints (what we will NOT do)

- **No LLM** at ingest or in the hop step. The existing LLM reranker stays as it is and is
  optional.
- **No new service, no graph database, no new vector store, no new dependency.**
- **No change to the existing vector or BM25 legs.** Entity-Hop is additive and flag-gated.
- **No learned model, no training, no embedding fine-tuning.**
- **No per-tenant entity-pattern configuration UI.** The regex list is code; add patterns only
  when a real customer corpus shows a miss.
- **No coreference or entity resolution** ("the vendor" → PT X). If needed later, that is a
  separate plan.
- **No tuning on the reported split.** Tune on dev, report on held-out.
- **No claims beyond the measured numbers.** Reports state the question set, the command, and the
  run count, as the audit fixes now require.

## 6. Risks and how each is caught

| risk | caught by |
|---|---|
| The synthetic corpus is ID-dense and favours this method | Phase 3 real-org run + the entity-coverage share |
| Tuning overfits the benchmark | dev/held-out split fixed before Phase 2 tuning |
| Hub entities flood the ranking | `MAX_DF` cutoff + its ablation |
| Easy tier regresses | decision-rule item 2; RRF fusion instead of append |
| Latency on large orgs | Phase 4 p50 measurement against the 50 ms limit; GIN index only if needed |
| Cross-tenant leak through the new lookup | tenant test in Phase 4; lookup goes through the tenant-scoped Prisma client, never raw SQL |

## 7. Effort and order

| phase | effort | depends on | can end the plan |
|---|---|---|---|
| 1 Measure production | 1–2 d | — | yes (if P2 is already ≥ 0.80) |
| 2 Prototype + ablate | 2–3 d | 1 | yes |
| 3 Real-org check | 1–2 d | 2 | yes |
| 4 Ship behind flag | 3–4 d | 3 | — |
| 5 cognee decision | 0.5 d | 4 | — |

Total if every gate passes: about 8–12 working days. Phases 1–3 alone (5–7 days) already answer
whether this is worth building.

---

## 8. Execution log

### 2026-09-24 — Phase 1-2 infrastructure landed

Built before any algorithm work, so that all arms are graded by one piece of code:

| file | role |
|---|---|
| `benchmark/arm-types.ts` | Frozen contract: `Arm`, `ArmContext`, `EntityHopOptions`, `EntityHopAblation`, `splitQuestions`, `ARM_BUDGET = 10` |
| `benchmark/arm-harness.ts` | Shared loading, dev/held-out split, grading, tables, arm registry |
| `benchmark/arm-harness.test.ts` | 15 tests pinning the grader against hand-computed values |
| `benchmark/embed-cache.py` | Regenerates the vector cache from the local model |
| `benchmark/data/cognee-1000-embeddings.json` | 1200 documents x 384 dims, `paraphrase-multilingual-MiniLM-L12-v2`, 4.2 MB |
| `benchmark/embed-cache.test.ts` | 11 tests: shape, L2 norm, determinism, and a similarity floor |

**Split defect found and fixed (this was mine).** The first split alternated on row index. The
generated set has 1000 rows but only **569 distinct question texts** — the templates repeat a
sentence across different chains (one appears 9 times) — so an index-parity split placed
**146 of 569 texts on BOTH sides**, and a "held-out" score was partly memorisation. 508 of the 431
duplicate rows also carry a DIFFERENT evidence set for the same text, which one ranking cannot
satisfy. `splitQuestions` now groups by distinct text and alternates groups; the harness prints
`texts straddling the split` and warns when it is non-zero. Current split: **dev 514 / held-out 486,
straddling texts 0**. `--dedupe=text` collapses each text to one row (n=284) where the ceiling is
a clean 1.0; both modes are reported.

Any number taken before this fix used the parity split and is **stale**. The BM25 row that was
0.3120 on the old split reads 0.3148 on the current one — close, but quote only current numbers.

**Embedder quality check (relevant to the earlier supermemory finding).** On this corpus the
model separates topics cleanly: the worst same-topic pair scores 0.8047 while the best
cross-topic pair scores 0.5467 — a margin of 0.258. The supermemory run's within-question
spread was 0.030. So the compressed similarity measured there was not this model on this corpus.

**Measured baselines (current split, n=486, top-10):**

| arm | easy | medium | hard | complex | all |
|---|---|---|---|---|---|
| BM25 | 1.0000 | 0.0559 | 0.0072 | 0.7128 | 0.3148 |
| production hybrid (P2) | 0.5600 | 0.0000 | 0.0000 | 0.3298 | 0.1502 |

Per-hop recall for BM25 is **0.850 / 0.271 / 0.413**. The second hop is where it collapses.
On this corpus **BM25 beats the shipped hybrid pipeline** (0.3148 vs 0.1502) because `RRF_K = 60`
dilutes the head — see `benchmark/results/retrieval-arms-decision.md` §2b for the arithmetic and
the measured sweep. That finding is larger than the one this plan set out to test.

**Grader consistency check.** The harness reproduces the published BM25 figure exactly on
`--scope=all`: recall@10 0.3080, answer@1 0.1830. MRR differs by 0.0012 (0.2755 vs 0.2767)
because `cognee-bm25-baseline.ts` computes MRR over a 20-document window while the harness uses
the shared 10-document budget. Both are now documented at their definition sites; verdicts use
recall@10, which is identical under both windows.

**Latency fairness.** `gradeArm` performs one discarded warm-up call, so an arm that builds its
index lazily does not hide that cost inside its first graded question. A test asserts this.

### Phase 3 blocked on data (needs a decision)

Phase 3 requires one real org with at least 50 documents. Measured on the local database:

```
Organization rows: 1
Documents:         9   (chunks: 114)
```

That is below the threshold, so the real-org validation in Phase 3 **cannot run today**. Two ways
forward, and this needs an operator decision rather than an agent one:

1. Point the benchmark at a real deployment's database, or
2. Ingest a realistic customer-shaped document set (multi-page PDFs, tables, prose without IDs)
   into a scratch org and treat it as the Phase 3 corpus.

Until one of those happens, any Phase 2 pass is a pass on a **synthetic, ID-dense corpus only**.
The plan's gate 3 stays open, and no shipping claim may skip it.

### 2026-09-24 — Phase 2 complete: verdict DO NOT SHIP

All three arms and the decision rule are now in place and every number below is reproducible with
one command per table.

**The gate, on held-out (chosen before any code was written):**

| criterion | measured | verdict |
|---|---|---|
| medium+hard gain ≥ +0.10 vs production hybrid | +0.1230 | PASS |
| easy drop ≤ 0.01 | 0.0133 | **FAIL** |
| real-org golden set not worse | not runnable (see above) | NOT COMPUTABLE |
| added p50 ≤ 50 ms | +0.31 ms | PASS |

**One defect the plan did not anticipate, and it was the dominant one.** The walk returned 91–145
hop documents per question (p50 102, never zero), and `RRF_K = 60` barely discriminates rank, so the
whole tail collected credit and a hop document at hop-rank 1 outbid a direct leg at leg-rank 9. That
cost the easy tier 0.1333 — a 13x breach of its allowance. Capping hop documents at 10 (`maxHopDocs`,
tuned on DEV only, exactly as Phase 2 prescribes) cut the easy breach to 0.0133, i.e. **one question
out of 75**, while raising the medium+hard gain to +0.1230. The dev split predicted a zero drop; the
held-out split gave 0.0133. A 0.01 allowance is inside the noise of a 75-question tier, and the
report records that rather than re-tuning on held-out.

No cap improves every tier: raising it buys hard-tier recall (0.1667 at cap 80) and pays in easy
(0.3867) and answer@1 (0.0058). That tradeoff is the honest summary of the mechanism here.

**The larger finding is not about Entity-Hop.** On this corpus the shipped hybrid pipeline scores
recall@10 0.1502 against plain keyword search's 0.3148, and BM25 answers the easy tier perfectly
(1.0000) where the fused pipeline manages 0.5600. The cause is measured and is arithmetic, not
corpus-specific: `RRF_K = 60` is nearly flat, so cross-leg agreement outweighs a strong single-leg
rank. See `benchmark/results/retrieval-arms-decision.md` §2b.

**Two more results worth keeping:**

- **Tokenisation.** `src/lib/rag.ts` maps `W-01` to `["01"]` and `B-0001` to `["0001"]`, collapsing
  `B-0001`/`INV-0001`/`PO-0001`/`AR-0001` onto one token. 975 of 1200 documents carry a bare-digit
  token. The production tokenizer and the benchmark tokenizer disagree materially on the same split
  (all-tier 0.3803 vs 0.4577), and neither dominates. Not changed; documented.
- **Ablations that do nothing are reported as untested, not as validated.** Hub-cutoff and negation
  are inert here because `MAX_DF = 60` is never reached and the negation cues never fire.

### Phase 3 remains blocked, and it is now the only thing gating any shipping decision

Phase 3 needs one org with 50+ documents. The local database has **one org with 9 documents**, so it
cannot run. Two options, both needing an operator decision:

1. Point the benchmark at a real deployment's database, or
2. Ingest a customer-shaped document set — multi-page PDFs, tables, prose **without** identifiers —
   into a scratch org and treat it as the Phase 3 corpus. Note `test-data/wikipedia/` already holds
   12 real prose articles (37–94 KB each) that contain almost no identifiers, which is exactly the
   corpus shape this benchmark is weakest on.

Until then, every number in this plan is a measurement on a **synthetic, ID-dense corpus**, and no
shipping claim may skip gate 3.

### What is NOT being done, deliberately

Phase 4 (ship behind a flag) is **not** started. Gate 1's easy criterion fails, gate 3 cannot be
evaluated, and the `RRF_K` finding needs a decision on real data before any fusion change — that is
a change to production behaviour and the plan's own §5 forbids it in this phase.

### 2026-09-24 — Phase 3 executed on the real corpus available here (partially unblocked)

Phase 3 was recorded as blocked because no org held 50+ documents. The *coverage* half of gate 3
does not need that many, and it turned out to be the half that decides the mechanism's reach, so it
was run on the app's own stored chunks via `benchmark/real-prose-arm.ts` (read-only, same grader,
same 10-document budget).

**Corpus:** 114 real chunks of Indonesian policy prose from the running database — the shape this
product actually stores. **121 extractive questions** were built from its sentences.

**Entity coverage — the number the plan requires be recorded either way:**

| corpus | chunks/docs | with ≥1 entity | entities per doc | bridges (df ≥ 2) |
|---|---|---|---|---|
| **real prose** (app DB) | 114 | **8 (7.0%)** | 0.07 | 3 |
| synthetic benchmark | 1200 | 1200 (100.0%) | 3.34 | 431 |

That is the decisive Phase 3 result: **Entity-Hop can only hop where an entity exists, and in real
prose that is 7% of chunks.** The synthetic benchmark is 100%. The mechanism's reach on this
customer-shaped corpus is therefore about an order of magnitude narrower than the benchmark implies,
and no amount of tuning changes that — extraction is the gate, not the ranking.

**Single-hop retrieval on real prose (both arms find every answer, but not equally):**

| arm | n | recall@5 | recall@10 | MRR | gold chunk ranked 1st |
|---|---|---|---|---|---|
| bm25-baseline | 121 | 1.0000 | **1.0000** | **0.9725** | **115/121** |
| hybrid-rrf (P2) | 121 | 0.8347 | 0.9752 | 0.6254 | — |
| entity-hop | 121 | 0.8264 | 0.9752 | 0.6132 | 95/121 |

Vectors for this corpus were built with the same model as the synthetic cache
(`paraphrase-multilingual-MiniLM-L12-v2`, 384d), so the hybrid arm is computable here.

**Gate 3 result: FAIL.** Criterion 3 asks whether Entity-Hop is worse than P2 on real data.
It ties on recall@10 (0.9752 both) and is **worse on MRR** (0.6132 vs 0.6254, −0.0121), so it is
worse on the metric that can discriminate. The first run of this check, before the vector caches
existed, showed a larger MRR gap (0.8891 vs 0.9725) on a lexical-only path; with vectors the gap
narrows but the sign does not change.

**The larger result on real prose: every arm loses to plain keyword search.** BM25 scores
recall@10 1.0000 and MRR 0.9725 where the shipped hybrid pipeline scores 0.9752 and 0.6254. Hybrid
retrieval *loses* 2.5% of recall and 36% of MRR to a keyword index on the product's own documents.
This is the same direction as the synthetic finding in `retrieval-arms-decision.md` §2b and is now
reproduced on real text, so it is not an artefact of the synthetic corpus.

Both dense arms also cost 20 of 121 questions their rank-1 position relative to BM25, which is the
tail-dilution mechanism again — a fused ranking adds documents ahead of a chunk the lexical leg
already ranked first.

**What Phase 3 does NOT establish, stated plainly.** These 121 questions are single-hop and
extractive, so they test only whether the right chunk is returned. Gate 3 asks whether the arm is
worse than production on real data; on the metric available it is (MRR), and on recall it is tied.
A multi-hop comparison on real prose was deliberately **not** fabricated: there is no ground-truth
relation graph for these chunks, and inventing one is exactly the defect the earlier benchmark audit
found. Gate 3 therefore remains **partially** satisfied — the coverage question is answered, the
multi-hop question is not, and it still needs a real corpus with a real answer key.
