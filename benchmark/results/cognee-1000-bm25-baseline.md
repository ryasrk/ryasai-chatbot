# BM25 baseline — single search and iterative search

No server is needed. Every number below comes from one of these two commands:

```bash
# A. Clean question set (the default input, committed under benchmark/data/)
bun benchmark/cognee-bm25-baseline.ts --out-json=benchmark/results/cognee-1000-bm25.json

# B. The pre-audit question set, as recorded inside the cognee run
bun benchmark/cognee-bm25-baseline.ts --results=benchmark/results/cognee-1000-results.json
```

## Inputs

| input | file | how it was made |
|---|---|---|
| corpus | `benchmark/data/cognee-1000-corpus.json` | `bun benchmark/cognee-corpus.ts --docs=1200 --with-contradictions` |
| clean questions | `benchmark/data/cognee-1000-questions.jsonl` | `bun benchmark/cognee-question-gen.ts --corpus=… --easy=150 --medium=350 --hard=300 --complex=200` (seed 20260916) |
| pre-audit questions | inside `benchmark/results/cognee-1000-results.json` | the question set cognee and supermemory were run on |

The clean set passes `bun benchmark/cognee-gt-lint.ts` with 0 violations. The generator runs the
same lint and exits non-zero on any violation.

Neither question set is a subset of the other. The generator fixes changed which chains exist, so
the two sets are different questions over the same corpus.

## Results on the clean question set (command A)

Both modes use a 10-document budget. Iterative mode takes the top 4 documents for the question,
then searches for the identifiers those documents mention. It adds new documents until it reaches 10.

| tier | n | single @10 | iterative @10 | single answer@1 | single MRR |
|---|---|---|---|---|---|
| easy | 150 | 1.0000 | 1.0000 | 0.8200 | 0.9089 |
| medium | 350 | 0.0571 | 0.4486 | 0.0000 | 0.0083 |
| hard | 300 | 0.0100 | 0.0300 | 0.1000 | 0.2073 |
| complex | 200 | 0.6750 | 0.8000 | 0.1500 | 0.3763 |
| **all** | **1000** | **0.3080** | **0.4760** | **0.1830** | **0.2767** |

Hard stays near 0 in both modes. Iterative mode runs 2 rounds, and hard questions need 3 hops.
Running a third round inside the same budget did not change the result.

## Results on the pre-audit question set (command B)

| mode | recall@10 |
|---|---|
| single | 0.2300 |
| iterative | 0.5070 |

## Comparison with cognee and supermemory

These results cannot be compared to the other engines yet:

- **Different questions.** The recorded cognee (0.1030) and supermemory (0.0780) runs used the
  pre-audit question set. Command B grades BM25 on those same questions (single 0.2300), so only
  that row compares directly. The clean-set numbers above have no cognee or supermemory
  counterpart until both arms are re-run.
- **The cognee run is invalid.** Its report fails two gates: easy recall@10 is 0.2733 (below
  0.95), and no embedding model is recorded. Check with:
  `bun benchmark/cognee-benchmark-report.ts --results=benchmark/results/cognee-1000-results.json`
  (exits 1 and withholds the metric tables).

## Self-controls (command A, both PASS)

| control | result |
|---|---|
| 200 gibberish queries return no hit | 0/200 |
| real vs random evidence id, first 300 questions | 160/300 vs 3/300 |

## Limits

- **Retrieval only.** A hit means the evidence documents were in the top 10, not that an answer was
  correct.
- **Synthetic templated corpus.** Identifiers such as `DL-001` favour keyword search.
- **The BM25 is unstemmed.**
- **One run, no trials.**
