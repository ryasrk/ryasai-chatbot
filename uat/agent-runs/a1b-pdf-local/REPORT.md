# A1b — LOCAL PDF ingestion and retrieval (knowledge path)

Written by the coordinating agent from the run's own artifacts, because the agent process stopped before writing
its report. Every number below is quoted from a file in this directory or measured directly; nothing is inferred.

## Environment

- Org `zz-agent-knowledge` (isolated), app v2.1.0 on http://localhost:3000.
- Artifact: `test-data/coates.2025.book.1996.pdf`, 2,805,059 bytes, uploaded as `a1b-coates.pdf`.
- Ingest: upload 201 in 1,733 ms, embed 2,156 ms, `waitEmbedded` -> `1 doc(s) fully vectorised` (total 3,967 ms).
  Final counts: 500 chunks, 500 with a pgvector vector, 0 JSON-only. **The vector path is healthy** — this is the
  measured difference from the first run, where a 1536-dim fixture wrote 500 JSON values and 0 vectors.
- `contentText` = 1,136,715 characters.

## Results (from `19-final.out`, `17-q1.json`, `02-smoke.json`, `10-battery.json`)

| question | outcome | verdict |
|---|---|---|
| "Apa tujuan proyek San Andreas menurut dokumen?" | correct, 5 citations, sources named | CORRECT |
| "Berapa perkiraan populasi dunia pada 2025?" | explicitly says it did not find a clean figure, and explains the retrieved table is OCR-mangled | CORRECT (honest) |
| Q5 (San Andreas, magnitude band) | answered the available half and stated the daily count was not in the passage; 8 citations | CORRECT (honest) |

No fabricated answer was found. The "search did not find it" wording was used correctly rather than claiming the
document does not exist.

## Findings

### F1 — MEDIUM: a 1.1M-character document is capped at 500 chunks, so ~35% of it is unreachable
`08-coverage.json`, measured against the same source text:

```
sourceNormChars 938224   uncappedChunks 1067   cappedChunks 500
windowCoverage: uncappedPct 99.9   cappedPct 43.7
cappedCoversUpToNormPos 606000   cappedCoversPctOfSource 64.6   unreachableNormChars 332224
```

`RAG_MAX_CHUNKS_PER_UPLOAD = 500` (`src/lib/constants.ts:52`) is a fixed cap with no operator override. For a book
this size the tail is silently not indexed: the document reports `ready` and every chunk that exists is vectorised,
so nothing looks wrong. **Not fixed here** — raising a cap silently would change ingestion cost for every install,
and the right fix needs a decision (per-install override vs. a documented limit). Recorded, not dropped.

### F2 — LOW/INFORMATIONAL: the extraction of a real book is OCR-imperfect, and the product says so
`02-smoke.json` shows the model describing the retrieved table as "garbled, OCR-mangled ... mixes population and
energy columns". That is honest reporting of imperfect source text, not a product defect. Reading order is a known
limitation of a content-stream parser (also reported as F4 in the first run's report) and is NOT re-measured here.

### F3 — REJECTED AS A DEFECT: a one-off 71-second turn
One turn measured 71,427 ms to first token (`byPurpose.synthesis = 66,565 ms`). It was investigated and does NOT
reproduce: three subsequent runs of the same question measured **6,741 / 5,353 / 12,854 ms** first-token with 5
correct citations each, and a direct gateway probe with a 10,800-character prompt returned first token in
**1,764 / 1,605 ms**. The slow turn is transient provider/contention variance, not a code path. Reported because it
was measured, not because it is a defect.

### F4 — LOW: turn latency varies ~2.4x between identical requests
`firstTokenMs` for the same question and session shape: 6,741 / 5,353 / 12,854 ms; `intent-analysis` alone ranged
2,571-8,587 ms. The variance is in the LLM calls, not in retrieval (retrieval stages stayed within 500 ms across
runs). Relevant to the earlier latency work: median improved, but the tail is provider-bound.

## Not verified

- Reading order / word-joining quality (needs a sentence-integrity measurement like the first run's; not re-run here).
- Behaviour at a larger corpus (multiple large PDFs in one org).
- Whether `RAG_MAX_CHUNKS_PER_UPLOAD` should be configurable (a product decision, see F1).
