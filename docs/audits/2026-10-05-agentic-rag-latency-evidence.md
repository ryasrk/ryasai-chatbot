# Agentic, RAG, architecture and latency — evidence, 2026-10-05 (b)

Follows [the architecture and RAG evidence of the same day](2026-10-05-architecture-rag-evidence.md). Every number below
comes from a run whose output is named; nothing is estimated. Setup as before: eval organisation in its own database,
standalone build on port 3107, generator `cbcn/deepseek-v4.1-flash`, independent judge `ag/gemini-3.8-flash-high`
(0 failed judgements in every run below). Engineering record, not a certification.

## Agentic — `benchmark/eval-live/run-agentic.ts` (new)

110 compound questions built deterministically from the verified RAG and SQL sets, so each part has a known answer;
judged per part; LLM calls and tokens attributed per question from `LlmUsageLog`.

| Measure | Baseline (after the API fix) | Final build |
|---|---:|---:|
| Parts correct (170 parts) | 90.0% [85–94] | **96.5% [93–98]** |
| All parts correct (80 questions) | 78.8% [69–86] | **92.5% [85–97]** |
| three-part, all correct (n=10) | 50.0% | 90.0% |
| doc + doc, all correct (n=15) | 66.7% | 100.0% |
| Silent drops (part neither answered nor reported) | 0 | 0 |
| Scope leaks, Chinook-only key (n=10) | 0 | 0 |
| LLM calls / tokens, doc + db question | 12.0 / 27,418 | **7.3 / 14,916** |
| p50 / p95, doc + db | 19.8 / 34.3 s | 17.9 / 49.5 s |

Before the baseline, the smoke run showed that **no compound question was ever planned over the API** (history held the
question itself, so every turn entered the agentic loop, whose rounds had no plan permission). Causes fixed, each with a
test that fails without it: history read before the question is stored (2 routes); `agenticRound`; the plan's tool is
final (`plannedTool`, scoped); a pipeline step budget instead of the 30 s per-tool sandbox (10 of the baseline's 18 failed
parts were steps killed at 30 s). ADR 0016.

## RAG — `run-rag.ts`, 303 questions, same judge as the last recorded run

| Metric | 2026-10-05 fixed build | Final build |
|---|---:|---:|
| Answer correctness (n=254) | 90.5% | 91.7% [87.7–94.5] |
| Distractor-book correct (n=24) | 11 | 15 |
| Multi-hop correct (n=39) | 31 | 33 |
| Citation hit | 91.7% | 93.3% |
| **Faithfulness** | **86.9%** | **80.3% [75.0–84.7]** |
| Refusal on unanswerable (n=48, ±8 pt run noise) | 87.5% | 83.3% |
| Latency p50 / p95 | 17.1 / 50.7 s | 21.4 / 71.7 s |

Chunk-level retrieval (`retrieval-recall.ts`, new): all multi-hop evidence in the answer context **59.0% → 69.2%** (n=39;
quotes 73.1% → 82.1%); factual unchanged at 92.4%. From: per-hop decomposition and rerank, coverage-preserving merge,
a sufficiency judge that reads 8,000 characters instead of 2,000. ADR 0017. The documents-before-general-knowledge probe
(`kb-probe.ts`) explains most of the distractor gain.

**The faithfulness drop is real and partly caused by this work.** Document-only questions that ran a database or REST
step rose from 1 to 13 of 255; only 3 of those 13 answers were faithful, and they were 9 s slower. The PR #46 selector
wording ("call one tool per part") makes the model hedge across sources, and the plan now executes what it used to drop.
Without those 13, faithfulness also fell (86.2% → 83.1%), with process narrative ("the knowledge graph records…", "the
step-3 lookup…") leaking into synthesised answers. **Not fixed in this round** — it is the first open item.

## Latency — first token, streaming path (`latency-eval.ts --questions eval-live/latency-questions.json`)

48 questions on the eval corpus, correctness checked. A and A2 are the same build 25 minutes apart: provider drift alone
moved the factual median by 2.2 s.

| First token, median / p95 | A | A2 | B: fast model for rerank/reflection/decompose | C: no LLM rerank |
|---|---:|---:|---:|---:|
| Document, factual (30) | 10.1 / 23.6 s | 7.9 / 33.8 s | 8.8 / 18.6 s | 4.4 / 35.7 s |
| Multi-hop (6) | 28.4 / 58.7 s | 18.4 / 72.5 s | 15.6 / 40.9 s | 12.6 / 30.6 s |
| Database (10) | 7.6 / 9.1 s | 7.6 / 9.3 s | 8.9 / 10.3 s | 7.9 / 9.3 s |
| Greeting (2) | 3.3 s | 3.3 s | 3.5 s | 3.2 s |
| Correct | 45/48 | 45/48 | 45/48 | 44/48 |

Where the time goes (factual, A): rerank median 6.0 s (1,578 output tokens per call on the agentic run — a reasoning
model ranking 12 chunks), then reflection 2.0 s, then 2.3 s of answer-model thinking before its first token; intent and the
selector (2.0 s each) run alongside retrieval. p95 tails are calls that hit the 30 s provider timeout. The model
decomposer also fired on 4 of 30 single-fact questions (3.8 s each).

Fixed in code: the API transport called the selector twice per turn, once serially before the pipeline (2.1 s p50;
`fe3dec7`). Not changed, needs a decision: the reranker (`RERANKER_URL` cross-encoder is supported but not bundled), a
fast non-reasoning model for structured roles (`LlmConfig` purposes `query`/`keyword`), and the memory recall on the
critical path (`COGNEE_RECALL_TIMEOUT_MS`, 8 s; memory is off in the eval organisation, so unmeasured here).

## Architecture

Size and cycle rules now cover all of `src` (0 cycles; four files over 800 lines split along their seams; a cron-editing
bug that rewrote 7 of 10 quick presets as daily found and fixed on the way). One guard path for the three MCP surfaces
(`unified-tools-mcp.ts` 13.57% → 88.55%, now gated). Shared limits and the provider list have one definition. Coverage
gate 246 modules. ADRs 0016–0017.

## Ratings (from 7.0 / 8.5 / 8.0)

| Domain | Rating | Why not higher |
|---|---:|---|
| Agentic | **8.0** | Large measured gain, but synthetic corpus, one generator and one judge, n=80 compound questions; p95 got worse; the selector over-calls sources on document questions |
| RAG | **8.3** | Correctness flat within noise, multi-hop retrieval up; faithfulness regressed 6.6 points and latency rose — a regression this work contributed to. No customer corpus |
| Architecture | **8.5** | Rules now repo-wide and decisions recorded; but the two chat transports diverged again in this session (found by measurement, not by a test), and several guards still read source text |
| Latency (new) | **5.5** | 8–10 s to first token on a document question, 16–28 s multi-hop, 3.3 s for a greeting; p95 20–35 s |

None of the three is at 9. What would move them, in order: (1) gate extra tool calls on document questions and keep
process narrative out of synthesis, then re-measure faithfulness; (2) a cross-encoder or fast-model rerank, measured for
both first-token time and correctness; (3) a real customer corpus and a second judge family.
