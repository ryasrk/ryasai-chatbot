# Architecture and RAG evidence — 2026-10-05

Follows [the upgrade evidence of 2026-10-04](2026-10-04-upgrade-evidence.md), which rated architecture 7.5 ("complex
modules and manual ownership boundaries need further review") and RAG 8.3 ("broader independently judged quality
remains due"). This record lists what changed, what was measured, and what still limits each rating. It is an
engineering record, not a certification.

## Architecture

| Measure | Before | After | Guard |
|---|---:|---:|---|
| Static import cycles in `src/lib` | 3 | **0** | `module-budget.test.ts` (absolute) |
| `src/lib` modules over 800 lines | 9 | **0** (largest 786) | `module-budget.test.ts` (absolute) |
| Raw SQL statements without an ownership predicate | 1 (embedding `UPDATE`) | **0** | `raw-sql-ownership.test.ts` |
| Nested relation writes (`connect` / `connectOrCreate`) | 0 | 0 | `raw-sql-ownership.test.ts` |
| Coverage-gated modules | 220 | **240** | `coverage:gate` |

The cycles were broken with leaf modules (`session-errors`, `rag-scoring`, `unified-tool-core`, `ai-chat`,
`plan-model`, `real-connector-shared`) and one explicit port (`chat-completion-port`); the nine modules were split along
their existing seams with the public surface kept by re-export (ADR 0015). The ownership sweep inventories every raw
statement in `src/` and `mini-services/`; negative controls removing the predicate from the embedding write and from
the pgvector query each fail it.

Also found and fixed on the way: an API key scoped to one database could query every database through the multi-step
DAG, the agentic loops, the planner, the unified tools and `/api/v1/agent/run` (`integrationIds` was dropped at each
delegation), and `handleApiError` returned provider failures as anonymous `500 INTERNAL_ERROR` without a stack.

Verified on the final tree: `tsc` 0 · lint 0 errors · 351 files, 8,281 pass, 0 fail · coverage gate OK (240 modules,
76.81%) · e2e 19/19 · e2e:prod 19/19 (the browser suites ran on the architecture commit; later commits touch routing and
error typing, covered by the unit suite).

## RAG — live, independently judged

**Setup.** `benchmark/eval-live/`: one fictional company, 24 generated policy documents (Indonesian and English) plus a
full-length distractor book, 303 questions each tied to a verbatim quote (144 factual, 24 cross-language, 39 multi-hop,
24 colloquial, 21 distractor-book, 48 unanswerable). Every question goes through the production HTTP API of a
standalone build in a separate eval organization and database. Generator: `cbcn/deepseek-v4.1-flash`. Question
author: Kimi. Judge: `ag/gemini-3.8-flash-high` (Google), a third family. Both result sets below were judged by the
same judge with **0 failed judgements**.

**Changes measured** (all in the fixed build): reasoning-token headroom for rerank / graph extraction / synthesis
(they stopped at a 1,024 cap on 73% / 96% / 39% of calls and returned empty), section-packed chunking (a table kept its
heading; 526 → 284 corpus chunks, mean 314 → 581 characters), the pronoun-clarification length limit, and the
document-reference retrieval rule and provider-timeout typing landed after this run (see the re-run below).

| Metric | Baseline | Fixed build |
|---|---:|---:|
| Answer correctness (n=252) | 85.7% | **90.5%** |
| Correct or partial | 86.5% | **91.3%** |
| Faithfulness to cited documents | 84.1% | **86.9%** |
| Cross-language (n=24) | 75.0% | **95.8%** |
| Multi-hop (n=39) | 61.5% | **79.5%** |
| Colloquial (n=24) | 95.8% | 100.0% |
| Factual (n=144) | 96.5% | 96.5% |
| Distractor-book (n=21) | 57.1% | 52.4% |
| Refusal on unanswerable (n=48) | 91.7% | 87.5% |
| Citation hit (mechanical) | 91.3% | 91.7% |

Judge-free measures, including a second baseline run that gives the run-to-run noise:

| Measure | Baseline 1 | Baseline 2 | Fixed |
|---|---:|---:|---:|
| False "not found" on answerable questions | 9.5% | 9.6% | **5.6%** |
| Expected numbers present in the answer | 89.1% | 88.0% | **93.7%** |
| Latency p50 / p95 | 19.9 / 61.9 s | 19.4 / 62.3 s | **17.1 / 50.7 s** |

**Reading the noise.** Two judgements of identical answers moved correctness by 0.4 points; two runs of the same build
moved it 1.2 points and refusal (n=48) by 8.3 points. So the correctness, cross-language, multi-hop, false-"not found",
number-recall and latency changes are outside the noise; the refusal and distractor differences (2 and 1 questions) are
not, and are not claimed.

**Distractor re-run** (`2026-10-05-rag-live-distractor-rerun.json`, after the routing fixes): of the 13 failing
distractor questions, those that name their source now retrieve instead of chatting, but the category stays weak —
questions about a 1 MB book phrased like general knowledge are still answered from the model's memory, and three hit
the 60 s answer timeout on every run (now a typed `LLM_TIMEOUT` instead of a 500).

**Measurement defects found and fixed** (each would have overstated or hidden quality): the first judge ran out of
credits mid-run and the second was retired mid-run, silently dropping 84 and then 125 judgements — failed judgements
are now counted and a run losing more than 2% exits non-zero; the unanswerable judge could not see the documents and
scored real related facts as fabrication (refusal 70.8% → 81.3% on identical answers once it could); the harness
client could not parse SSE bodies on `stream: false`.

## What still limits the ratings

- **RAG.** Synthetic corpus and questions, one generator model, one judge per comparison. Distractor-book (~55%) is
  the weak category: general-knowledge-phrased questions about a long non-policy document. Faithfulness ~87% under a
  strict judge. No customer corpus.
- **Architecture.** `unified-tools-mcp.ts` is covered at 13.57% and not gated. The size cap and cycle rule apply to
  `src/lib` only; `src/components` (e.g. the settings view) is not under them.
