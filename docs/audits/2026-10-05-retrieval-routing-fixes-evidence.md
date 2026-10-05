# Retrieval and routing fixes — evidence, 2026-10-05 (c)

Follows [the agentic, RAG and latency evidence of the same day](2026-10-05-agentic-rag-latency-evidence.md), whose
numbers were measured BEFORE the twelve latency commits that ended at `ed6a471`. This round re-measures that build,
then three fixes. Setup as before: eval organisation in `ryasai_eval`, standalone build on port 3107, generator
`cbcn/deepseek-v4.1-flash`, independent judge `ag/gemini-3.8-flash-high`, **0 failed judgements and 0 errors in every
run below**. Engineering record, not a certification.

## The build as committed (`ed6a471`) — open item 1 is closed

The previous audit's first open item was a faithfulness regression (86.9% → 80.3%). Re-measured on the full 303
questions ([`2026-10-05-c-rag-baseline.json`](2026-10-05-c-rag-baseline.json)):

| Metric | Audit build (13:48) | `ed6a471` |
|---|---:|---:|
| Answer correctness (n=255) | 91.7% | 91.0% [86.8–93.9] |
| **Faithfulness** | **80.3%** | **85.9% [81.1–89.6]** |
| Refusal on unanswerable (n=48) | 83.3% | 100.0% |
| Latency p50 / p95 (full eval) | 21.4 / 71.7 s | **5.7 / 22.1 s** |

First token, streaming path ([`2026-10-05-c-ttft.json`](2026-10-05-c-ttft.json), `before`), against run A of the
previous audit:

| Median / p95 | Audit run A | `ed6a471` |
|---|---:|---:|
| Document, factual (30) | 10.2 / 23.6 s | **4.2 / 7.4 s** |
| Multi-hop (6) | 28.9 / 58.7 s | **12.3 / 21.2 s** |
| Database (10) | 7.6 / 9.1 s | 7.9 / 9.5 s |
| Correct | 45/48 | 45/48 |

## Three causes found in the remaining wrong answers, and fixed

**1. Words a PDF extraction glued together were unsearchable.** The book in the corpus reads "CleanAirActAmendments",
"olderAmericans", "inAustralia", "HarvardÕs" (MacRoman ’). The 'simple' tsvector indexes each as one token. The evidence
of 7 of the 9 wrong distractor-book answers in the audit run sat in such a span. `glued-words.ts` emits the split form
of seamed tokens; it is ADDED to `tsv` and to the in-process BM25/overlap tokens, never written into the chunk, so
stored text and citations are unchanged. Migration `20261005000002_glued_words_tsv` re-indexes existing chunks with the
same expression (pinned byte for byte by `rag-fts-postgres.test.ts`; the SQL and TS twins are compared on a real
Postgres by `glued-words-sql.test.ts`).

**2. The SQL branch's second chance for the documents existed on the streaming transport only.** All four wrong
factual answers on `/api/v1` were document-table questions routed to the database ("In the Maximum Storage Limits
table, which facility code…"): "no matching data", a guessed count, and a UNION the guard blocked three times. The
decision now lives in `sql-pipeline.ts` (`documentsShouldAnswerInstead`) and both transports call it; a query that
failed every attempt is a miss too. The ready-document count runs first, so an organisation without documents never
pays for the relevance judge's model call (the old order called the model first). A failure of the check keeps the
database answer. `transport-parity.test.ts` drives both cases through both transports.

**3. The Postgres full-text leg returned nothing.** `searchFtsChunkIds` used `plainto_tsquery`, which ANDs every word;
the SQLite path ORs. [`fts-recall.ts`](../../benchmark/eval-live/fts-recall.ts) on 255 answerable questions
([output](2026-10-05-c-fts-recall.txt)):

| Query | Zero rows | Evidence in top 64 | ms / query |
|---|---:|---:|---:|
| every word (`plainto_tsquery`, before) | 253 | 2 | 0.4 |
| **any word, `ts_rank` (shipped)** | 0 | **218** | 2.3 |
| any word, `ts_rank_cd` | 0 | 216 | 5.0 |

Terms are cut to letters and digits before the `|` join, so `to_tsquery` sees no operator but the one placed there
(`rag-fts-live.test.ts` parses hostile input on a real Postgres); capped at 32 terms.

## What each fix did, measured

Full eval, 303 questions ([R1](2026-10-05-c-rag-glued-sqlfallback.json), [R2](2026-10-05-c-rag-fts-or.json)). R1 and R2
ran at `--concurrency 16` (new flag), so their latency is not comparable with the baseline's; correctness is unaffected
by it.

| Metric | `ed6a471` | R1: glued words + SQL second chance | R2: + any-word FTS |
|---|---:|---:|---:|
| Answer correctness | 91.0% | **95.3%** [92.0–97.3] | 94.5% [91.0–96.7] |
| Faithfulness | 85.9% | 88.6% | **90.2%** [85.9–93.3] |
| Citation hit | 96.1% | 97.3% | 97.3% |
| Refusal (n=48) | 100.0% | 97.9% | 95.8% |
| factual (n=144) | 97.2% | 99.3% | 100.0% |
| cross-language (n=24) | 83.3% | 87.5% | 87.5% |
| multi-hop (n=39) | 74.4% | 87.2% | 82.1% |
| distractor-book (n=24) | 79.2% | 87.5% | 83.3% |

What is attributable, question by question:
- **SQL second chance:** q095, q116, q134 changed from `SQL` to `RAG` (or `SQL`+`RAG`) and became correct. q058 stayed
  on SQL in R1 (the judge accepted rows that did not answer) and was answered from the documents in R2.
- **Glued words:** chunk-level evidence for the distractor book 79.2% → 83.3% (q229 —
  [before](2026-10-05-c-recall-book-before.json), [after](2026-10-05-c-recall-book-glued.json)); q229, q231, q232
  became correct in R1.
- **Any-word FTS: no measurable gain while embeddings work.** Chunk-level recall with and without it is identical on
  four categories and one multi-hop question lower (64.1% → 61.5%; [AND](2026-10-05-c-recall-fts-and.json),
  [OR](2026-10-05-c-recall-fts-or.json)), because the vector leg fills the candidate pool. Its value is the degraded
  path the design promises ("embedding API down → lexical fallback"). With the embedding host blocked
  ([AND](2026-10-05-c-recall-novector-fts-and.json), [OR](2026-10-05-c-recall-novector-fts-or.json)): factual 90.3% →
  93.8%, colloquial 79.2% → 91.7%, cross-language 75.0% → 79.2%, distractor 70.8% → 75.0%, multi-hop 53.8% → 53.8%.
- **Not attributed:** the multi-hop swing (74.4 → 87.2 → 82.1) and the refusal moves are in documents none of the fixes
  touch; they are run-to-run variance (the previous audit recorded ±8 points on refusal).

First token (`after` = R1 build, `or` = R2 build), streaming, serial: document 4.2 / 7.2 s and 4.0 / 10.6 s, multi-hop
11.5 / 19.5 s and 12.0 / 69.1 s (one question, n=6), database 8.0 / 12.8 s and 8.3 / 14.9 s. Medians did not move; the
p95 of n=6 and n=10 is one question each.

## A measurement defect, recorded

The first R2 run reported factual 95.8% (five false "not found"). It was contaminated by this session: a chunk-recall run
with the embedding host blocked shared the server's Redis database and wrote lexical-only retrievals under the same
cache keys (`ragCacheKey` has no segment for whether the vector leg ran) while the server answered the same questions.
Re-run with `rag:*` flushed and nothing else running: factual 100.0%, all five correct. The contaminated run is not used
above. Two consequences: in-process harnesses must not share the server's Redis database during an eval, and in the
product a retrieval computed during an embedding outage is cached for `RAG_CACHE_TTL_MS` (60 s) after recovery — small,
not fixed here.

## Still open

- **q241 and q223 are flaky** between runs: the probe sends them to retrieval, the sufficiency judge rejects evidence
  that is in context, and the turn falls back to a chat that fetches the web.
- Multi-hop is the noisiest category (n=39, three runs today: 74.4 / 87.2 / 82.1%). Watch it on the next run of the
  any-word FTS before treating it as neutral.
- No customer corpus; one generator, one judge.
