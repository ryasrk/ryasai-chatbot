# Decision record: retrieval arms on the clean question set

Written 2026-09-24. Numbers produced by the commands quoted beside each table. This file records
what was measured and what it means for the Entity-Hop plan (`docs/entity-hop-retrieval-plan.md`).
It does not authorise a shipping change; see section 6.

---

## 1. What was built

| file | role |
|---|---|
| `benchmark/arm-types.ts` | Frozen contract: `Arm`, `ArmContext`, `EntityHopOptions`, corrected split |
| `benchmark/arm-harness.ts` | One shared loader, split, grader, table renderer, arm registry |
| `benchmark/arm-harness.test.ts` | 17 tests pinning the grader and the vector-input contract |
| `benchmark/arms/hybrid-arm.ts` | Arm P2 — production vector + BM25 + RRF, importing production functions |
| `benchmark/arms/entity-hop-arm.ts` | The prototype under test |
| `benchmark/embed-cache.py` | Regenerates both caches from the local model |
| `benchmark/data/cognee-1000-embeddings.json` | 1200 doc vectors, 384d, 4.2 MB |
| `benchmark/data/cognee-1000-question-embeddings.json` | 569 query vectors, 384d, 2.1 MB |

Every arm is graded by the same code in `gradeArm`, at the same 10-document budget, with one
discarded warm-up call so lazy index construction is not charged to the first question.

## 2. Two measurement defects found and fixed before any arm was trusted

### 2a. The question set has 431 duplicate rows, and the split leaked

```
rows 1000 · distinct question texts 569 · 431 rows collapse onto a repeated text
508 of those rows carry a DIFFERENT evidence set for the same text
```

The templates name a start entity, so the same sentence recurs across different chains —
"Starting from W-01, follow two intermediate records: which serial is reached at the end of that
chain?" appears 9 times over 9 different evidence sets.

An index-parity split therefore put **146 of 569 texts on both sides**, so a "held-out" score was
partly memorisation. `splitQuestions` now groups by distinct text and alternates groups; the
harness prints `texts straddling the split` and warns when it is non-zero. Measured after the fix:
**0 straddling texts**, dev 514 / held-out 486.

A second consequence is unavoidable and is now printed: because 508 rows share a text but not an
evidence set, a single ranking cannot satisfy them. `--dedupe=text` collapses each text to one row,
making the measurable ceiling 1.0; both modes are reported below.

### 2b. `RRF_K = 60` makes rank nearly irrelevant, and that is what breaks the hybrid pipeline

This was found by asking why the hybrid arm scores below plain keyword search. It is not the pool
size, not the vector leg alone, and not the hop mechanism — it is the fusion constant.

With `k = 60`, rank 1 and rank 10 differ by 15% in weight (`1/61` vs `1/70`), so RRF stops
measuring *how well* each leg ranked a document and starts measuring *whether* each leg found it.
A document that both legs rank somewhere in their top 80 scores up to `2/61 = 0.0328`, while a
document the lexical leg ranks **first** but the vector leg does not contain at all scores
`1/61 = 0.0164`. The mediocre-but-agreed document wins.

Measured, deduped held-out, top-10
(`bun benchmark/arm-harness.ts --scope=held-out --dedupe=text`):

| fusion | easy | medium | hard | complex | ALL |
|---|---|---|---|---|---|
| lexical only | 1.0000 | 0.0660 | 0.2609 | 0.2586 | 0.3803 |
| vector only | 0.3243 | 0.0000 | 0.0000 | 0.2414 | 0.1338 |
| **RRF k=60** (production) | **0.5676** | 0.0000 | 0.0000 | 0.2586 | **0.2007** |
| RRF k=1 | **1.0000** | 0.0000 | 0.0435 | 0.2586 | 0.3204 |
| lexical first, vector appended | 1.0000 | 0.0660 | 0.2609 | 0.2586 | 0.3803 |

The same collapse appears on the raw (non-deduped) split, so it is not an artefact of deduping:
`bun benchmark/arm-harness.ts --scope=held-out` gives hybrid easy **0.5733** versus lexical
**1.0000**.

Consequences, stated plainly:

- On this corpus the shipped hybrid pipeline scores **below plain keyword search** (0.2007 vs
  0.3803 deduped; 0.2020 vs 0.3120 raw).
- `RRF_K = 60` is the load-bearing cause of the easy-tier collapse, not the vector leg's quality.
  Lowering it to 1 restores easy to 1.0000 and lifts ALL from 0.2007 to 0.3204.
- The vector leg still does not pay for itself here. At either k the fused score stays at or below
  the lexical-only score, consistent with the query-vector measurement of 0.3680 recall@10 over
  all 1000 rows (median best-evidence rank 21).

RRF k=60 is the value from Cormack et al. 2009 and the default in Elasticsearch and Vespa, and it
is documented in `src/lib/rag-ranking.ts`. The measurement above says the constant deserves to
depend on the number of legs and on each leg's calibration — with two legs where one is much
stronger, a flat curve hands the weak leg equal weight at the head.

## 3. The production tokenizer drops the letter from identifiers

`tokenize` in `src/lib/rag.ts` strips every non-alphanumeric character, then drops tokens shorter
than 2 characters. Applied to this corpus:

```
W-01      -> ["01"]           B-0001   -> ["0001"]
DL-106    -> ["dl","106"]     INV-0001 -> ["inv","0001"]
```

The letter prefix is lost, so `B-0001`, `INV-0001`, `PO-0001` and `AR-0001` all reduce to the bare
token `0001`. Measured on the corpus: **975 of 1200 documents contain a bare-digit token**, and
there are **705 distinct bare-digit tokens**, the most common being `000` in 43 documents.

The benchmark's own tokenizer (`benchmark/cognee-bm25-baseline.ts`) deliberately keeps `dl-106`
whole *and* split, which is why the two disagree materially on the same split:

| lexical leg | easy | medium | hard | complex | ALL |
|---|---|---|---|---|---|
| benchmark tokenizer (keeps `w-01`) | 1.0000 | 0.0472 | 0.0217 | 0.8621 | 0.4577 |
| production tokenizer (strips to `01`) | 1.0000 | 0.0660 | 0.2609 | 0.2586 | 0.3803 |

Neither dominates, which is itself the finding: identifier handling is the single largest
unexplored lever on this corpus, and it is currently an accident of which tokenizer a code path
happens to use.

## 4. Did Entity-Hop meet the pre-registered gate? Partly — and it still must not ship.

Gate from the plan: **at least +0.10 absolute recall@10 on medium + hard combined versus the
production hybrid arm**, with the same 10-document budget and no easy-tier loss over 0.01.

Measured on the CURRENT frozen split (text-disjoint, n=486; medium+hard n=317). I ran this
myself with `gradeArm`, and the ablation runner reproduces every cell:

| arm | easy | medium | hard | complex | ALL | answer@1 |
|---|---|---|---|---|---|---|
| hybrid-rrf (P2, the bar) | 0.5600 | 0.0000 | 0.0000 | 0.3298 | 0.1502 | 0.1255 |
| entity-hop | 0.4267 | 0.1285 | 0.0725 | 0.2989 | 0.2037 | 0.0123 |
| bm25-baseline (reference) | 1.0000 | 0.0559 | 0.0072 | 0.7128 | 0.3148 | 0.1811 |

| criterion | measured | verdict |
|---|---|---|
| 1. medium+hard gain ≥ +0.10 vs P2 | **+0.1041** | PASS (barely) |
| 2. easy drop ≤ 0.01 | **0.1333 drop** | **FAIL — 13x over the limit** |
| 3. not worse than P2 on a real-org golden set | not runnable (see §5) | NOT COMPUTABLE |
| 4. added p50 ≤ 50 ms | +0.67 ms | PASS |

**Verdict: DO NOT SHIP.** One gate passes, one fails catastrophically, one cannot be evaluated.

Two independent reasons to stop, not one:

- The easy-tier collapse (0.5600 → 0.4267) is the same `RRF_K = 60` dilution described in §2b,
  now with a third ranking added to the fusion.
- **answer@1 regresses 10x**: 0.1255 → 0.0123, while ALL recall@10 improves only 0.1502 → 0.2037.
  Recall asks "is the evidence anywhere in the top 10"; answer@1 asks "is it first". Entity-Hop
  moves evidence into the window without moving it to the top, which is the least useful kind of
  improvement for a user-facing citation. The plan's rule does not gate on answer@1; it should.

The ablations are mostly uninformative, and the runner reports that rather than dressing it up:
`ablate-hub-cutoff`, `ablate-negation` and `hops-3` are numerically IDENTICAL to the full variant
on every metric. Hub cutoff does nothing because the default `maxDocumentFrequency = 60` exceeds
any real entity's document frequency in a 1200-document corpus; the negation regex never fires on
this corpus. Both components are therefore **untested by this benchmark, not validated by it**.
Real signal exists in only two ablations: removing the rarity weight costs 0.063 on medium+hard
(load-bearing), and `hops-1` fails the hard tier altogether (0.0000 vs 0.0725), which is what makes
the 2-hop depth meaningful.

A limitation the ablation author reported and I am carrying forward: `EntityHopOptions` has no
seed-source field, and this arm hardcodes a **lexical-only seed**, so the shipped `entity-hop` row
is a lexical-seeded hop ranking compared against a P2 that has a vector leg. That comparison is
mildly favourable to Entity-Hop. Adding `seedSource: 'hybrid' | 'lexical'` to the contract is the
clean fix and has not been done.

## 5. What is NOT established

- **Synthetic, ID-dense corpus.** Every number here is on 1200 templated procurement documents
  full of `DL-001` and `PT …` names. Identifier handling dominates, and prose-heavy customer
  documents may behave differently.
- **Single run, no trials.** No confidence intervals. An earlier session measured an 11-point
  move from re-asking the same question, so these are point estimates.
- **No real-org validation.** Phase 3 requires an org with 50+ documents. The local database has
  one org with **9 documents**, so Phase 3 has not run and cannot run here.
- **The vector cache is `paraphrase-multilingual-MiniLM-L12-v2` (384d)**, not any customer's
  configured model.
- **The hybrid arm is not production**, it is a faithful offline re-assembly of it. It differs in
  four documented ways (candidate pool, no reranker, no knowledge-graph leg, no keyword field),
  each listed in the arm's header.
- **The `RRF_K = 60` finding is measured on a synthetic corpus.** The mechanism is arithmetic and
  therefore general, but the size of the effect on real documents is not.

## 6. Recommended next steps, in order

1. **Treat the `RRF_K = 60` result as the primary finding.** Before building anything new, measure
   the production pipeline with `k` as a tunable on a real corpus. It is a constant, not an
   architecture.
2. **Fix the identifier tokenization question deliberately**: decide whether identifiers keep
   their prefix, then measure both lexical legs with the same grader. This is a small change with
   a measured effect on the largest tier gap.
3. **Re-measure Entity-Hop against corrected fusion.** Its medium-tier movement (0.0000 → 0.1132)
   is the one result that suggests the hop step adds something, and it was measured against a
   baseline that is itself losing 43% of the easy tier.
4. **Do not run Phase 4 (shipping) yet.** Gate 1 is not met, gate 3 cannot be evaluated, and the
   mechanism behind the easy-tier loss is now understood well enough that re-measuring is cheap.
