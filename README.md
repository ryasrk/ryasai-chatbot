# ryasai — Enterprise AI Assistant

![CI](https://github.com/ryasai/Chatbot/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-Proprietary-red) ![Version](https://img.shields.io/badge/version-0.4.1-blue) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

**Multi-tenant SaaS** AI assistant that answers questions by routing to the right tool: SQL queries, document RAG, REST API calls, external plugins, or general chat. Built for enterprises that need data-grounded AI with security guardrails and organizational isolation.

- **Multi-tenant:** Each organization is completely isolated. Documents, queries, and results are per-org. Org context enforced via AsyncLocalStorage + Prisma extension.
- **Advanced RAG:** Hybrid retrieval (vector + lexical + knowledge graph) with RRF rank fusion. BM25 with corpus-level IDF. Structure-aware chunking (headings + tables stay whole). Evaluation framework with a per-org golden-set generator and independent-judge support.
- **Production-grade security:** AES-256-GCM encryption, session fixation defense, SSRF protection, audit logging, role-based access control.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system design. See [MULTI-TENANT-GUIDE.md](./MULTI-TENANT-GUIDE.md) for org isolation details.

## Quick Start

```bash
# Install dependencies
bun install

# Apply database schema
bunx prisma db push --accept-data-loss
bunx prisma generate

# Seed demo data
bun run scripts/seed.ts

# Start dev server
bash start.sh
```

Default: `admin@ryas.ai` / `admin12345`

## Measured Results

Numbers below come from runs recorded in the repository, so they can be re-derived
rather than taken on trust. Source files are linked next to each figure.

**Cross-source benchmark — 800 questions, model `cbcn/deepseek-v4.1-flash`**
(`trial/cross/`, raw answers in `trial/cross/report.json`):

| Family | Accuracy | p50 | TTFT p50 | Tokens/task |
|---|---|---|---|---|
| Sales database | 99% (198/200) | 6192 ms | 84 ms | 38.66 |
| HR database | 99% (198/200) | 6210 ms | 84 ms | 48.57 |
| REST APIs | **100%** (200/200) | 6806 ms | 85 ms | 234.00 |
| Cross-source | 99.5% (199/200) | 6357 ms | 83 ms | 84.50 |
| **Total** | **99.38% (795/800)** | 6363 ms | 84 ms | 101.51 |

- **Token speed:** p50 **7.29 tokens/sec**; 81,109 completion tokens over 799 sampled turns.
- **Accuracy per source:** SQL 99.23% (516/520) · REST 99.64% (279/280).
- **Zero HTTP 429s, zero empty answers.** A throttled or empty run is aborted and reports
  `accuracy: null` rather than a low score, so a rate-limiter artifact can never be
  published as an accuracy figure.

800 questions across 4 families (200 each), split across 4 concurrent runners — one per
family — with the parent doing the single merge. Every answer is a number and the wrong
source returns a *different* number, so a misrouted question fails visibly instead of
looking plausible. A single database could not detect a wrong source at all.

**This benchmark does NOT exercise memory — read the caveat before quoting it.** The run
used `SIMPLE_PIPELINE=1`, which **bypasses cognee entirely**. It is therefore a measure of
routing + SQL/REST execution, not of the memory layer, and it says nothing about
cross-session recall. Memory is verified separately and end-to-end (see the cognee
integrity pass above): a fact stated in one session is answered by a brand-new session with
no history. Do not cite the 99.38% as evidence that memory works.

### Cognee Knowledge Graph Retrieval Benchmark — 1,000 Questions, 1,200 Documents
(`benchmark/`, full report at `benchmark/results/cognee-1000-report.md`, raw data in `benchmark/results/cognee-1000-results.json`):

Measured end-to-end against a 1,200-document enterprise procurement corpus (900 hot + 300 filler, 1,237 typed relations, 766 entities) and 1,000 ground-truth relation-derived questions across easy, medium, hard, and complex tiers, using `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` embeddings (dim 1536):

| Tier | Questions (n) | Recall@5 | Recall@10 | Recall@10 (Partial) | Answer@1 | MRR | Distractor Rejection |
|---|---|---|---|---|---|---|---|
| **Easy** (1-hop) | 150 | 0.1600 | **0.2733** (27.3%) | 0.2733 | 0.0533 | 0.1065 | **1.0000** (100%) |
| **Medium** (2-hop) | 350 | 0.0000 | **0.0000** | 0.2657 (26.6%) | 0.0000 | 0.0000 | **1.0000** (100%) |
| **Hard** (3-hop) | 300 | 0.0000 | **0.0000** | 0.0456 (4.6%) | 0.0000 | 0.0000 | **0.9933** (99.3%) |
| **Complex** (Supersession) | 200 | 0.2850 | **0.3100** (31.0%) | 0.4850 (48.5%) | 0.1550 | 0.2096 | **1.0000** (100%) |
| **ALL (Overall)** | **1000** | **0.0810** | **0.1030** (10.3%) | **0.2447** (24.5%) | **0.0390** | **0.0579** | **0.9965** (99.7%) |

- **Ingestion throughput:** 1,200 documents in 1,245.9s (~20.7 min, 1,038.3 ms/doc average), 29,400 items processed, 0 batch errors. Ingestion utilizes segmented recycling every 300 docs to prevent Uvicorn/asyncio thread-pool exhaustion.
- **Retrieval latency:** p50 **3,426 ms**, p90 **4,117 ms**, p99 **4,871 ms** (topK=10, concurrency 6).
- **Control block (all 7 gates PASSED):**
  - `corpus-size`: **PASS** — empirical `return_everything` recall@10 = 0.0030, answer@1 = 0.0010 (closes the "return everything" shortcut arithmetically).
  - `hits-ratio`: **PASS** — 10.0 / 1200 = 0.00833 < 0.01.
  - `topk-honoured`: **PASS** — server returned exactly 10 chunks per query.
  - `oracle`: **PASS** — ground-truth and grading logic confirmed 1.0000.
  - `ingest-landed`: **PASS** — 48 batches successful, independent probe verified (`FOUND doc-0001 in 5 chunks`).
  - `aborted`: **PASS** — 0 questions experienced 429 streaks or errors.
  - `doc-resolution`: **PASS** — 10,000 / 10,000 returned chunks resolved to corpus document text.
- **Scope & Interpretation:** A hit means joined evidence was *findable*, not final answer prose quality. Multi-hop full set recovery remains difficult within a flat top-10 window without directed graph traversal, but partial evidence coverage reaches 26.57% for medium and 48.50% for complex supersession queries. See `benchmark/results/cognee-1000-report.md`.

**Read this honestly.** A single pass cannot separate a defect from sampling variance.
Of the 5 failures here, **3 answered correctly 5 times out of 5** when re-asked, giving a
variance-corrected **99.75% (798/800)**. The 2 that stayed wrong (`S019` answering 0,
`S031` refusing) share one cause: the SQL branch occasionally picks 0 or declines instead
of naming the source. Both are answered correctly by the REST branch in most runs, which
is why the measured figure remains 99.38%.

**"Routing agreement" (SQL 65.58%) is deliberately NOT an accuracy measure.** Of the 600
questions whose source is SQL, **258 were served over REST instead — and 256 of those were
still correct**. Reaching the same rows another way is flexibility, not an error, and
scoring it as a miss would punish the system for something the user cannot observe. Only
the answer is scored.

**Two defects found and fixed while producing this benchmark**, both of which had made the
product refuse questions it can answer:

- `Ada berapa order yang dibatalkan?` refused **on every attempt** while the same question
  phrased `pesanan` answered correctly. Two causes: the domain-context scan stopped at the
  first blank line, and the Sales keyword list is wrapped across two lines, so `order` was
  never read (17 terms yielded, `order` missing); and `order` sat in the generic
  schema-token list as the SQL keyword `ORDER BY`. Fixed — a term the domain context
  declares explicitly now outranks that list, while genuine noise (`id`, `status`,
  `created`) is still filtered.
- **Token usage was never reported on the streaming path.** Three layers stacked: the
  stream is a generator and can only yield strings, so the parsed counts were discarded;
  object spread *evaluates* getters, snapshotting `usage` before the stream ran; and
  `streamAnswer` (SQL/RAG/REST) never forwarded it at all. The gateway was never at fault.
  These are the first token figures that come from real usage rather than an estimate.

**Head-to-head: full pipeline vs the small pipeline** (`SIMPLE_PIPELINE=1`, 100 questions):
**accuracy is a TIE.** Only 3 of 100 questions differed and the direction was mixed —
McNemar registers 0 wins for either side. The small pipeline is materially faster
(p50 4728 ms vs 6302 ms, TTFT p50 3554 ms vs 4789 ms), but on that evidence the default
stays as it is. An earlier 1-point gap was reported as a finding; it is sampling noise and
is not claimed here.

**Test suite:** 6,760 tests across 249 files (`bun scripts/test.ts`), 0 failures, 100% pass rate. 48 static invariant guards (`bun test src/lib/invariants.test.ts`). Coverage is
reported two ways on purpose: **96.20% of reachable lines** and 88.09% merged across 198
gated modules (`bun scripts/coverage-gate.ts`). Branch coverage is **not measurable** in
this toolchain — Bun emits `BRF: 0` — and that limitation is recorded rather than papered
over. One caveat worth stating: a `bun run test` run flaked once in
`src/lib/llm-config.test.ts`, which passed 5/5 in isolation immediately afterwards and on
both re-runs of the full suite. Cause unknown.

## Key Updates (v0.4.1)

**Cognee dependency review (2026-09):**

- **`@cognee/cognee-ts@0.2.0` was evaluated and REJECTED.** It does not merely fail — it corrupts. `remember()` returns `{"status":"PipelineRunCompleted"}` in ~25 ms and writes **nothing** to the graph (only `add_pipeline` runs; the data lands with `pipeline_status: None`). Memory is lost while the API reports success, which is worse than the known `has()` bug that at least returned a wrong boolean. It then marks the dataset completed, and that mark **persists in `cognee.db`** — so downgrading to 0.1.3 does not recover: cognify logs `dataset already completed; short-circuiting` and refuses new data until the store is deleted. MEASURED: the same store after revert wrote in 416 ms with no recall; a fresh store wrote in 15142 ms and recalled correctly. It also fixes neither problem that motivated the look (`has()` still reports a present dataset as missing; `NATURAL_LANGUAGE` still fails on kuzu). The one real gain was `HYBRID_COMPLETION` (OK, 1303 ms, 4542 chars — ~2.6× richer than `CHUNKS`), which is worthless while writes do not land. See `scripts/cognee-upgrade-check.md` for the evidence and the recommended probe. The Python repo's v1.5.x line is a **separate release track** from the Rust/TS bindings we ship — separate enough that the fix was to move to it: memory now runs against a cognee v1.5.4 API server by default (`COGNEE_SERVER_URL`), with the TS binding retained only as the fallback. See `docs/cognee-http-migration.md`.

**Context-safety pass (2026-09):**

- **The RAG cache can no longer be shared across orgs.** The key was `rag:${orgId ?? 'global'}:…`, so a caller with NO org context shared one entry with every other context-less caller. That is reachable — MEASURED, `getOrgContext()` returns `undefined` on the far side of `bypassOrg()` — so a bypassed path could read and write an entry another org's request had populated. No context now returns a null key and the cache is skipped: the cost is a retrieval, not a disclosure.
- **`web-fetch` bounds the download and omits an absent title.** `await res.text()` drained the whole body before `.slice(0, 10_000)` clamped the return value, so the cap bounded only what we handed back — a large page was fully transferred into memory against a caller-chosen URL. The body now reads through a bounded reader that **cancels** past the budget (MEASURED: 10 of 40 chunks pulled, stream cancelled). Separately, `title` was emitted as a present key holding `undefined` while the type declares `title?: string` — an optional key that is always present is not optional, so `'title' in result` lied. It is omitted when there is none.
- **FTS ranking is deterministic.** `ORDER BY rank ASC` had no tie-break, and equal `ts_rank` values are common, so the same query could return ties in a different order run to run and the fused result would drift. Both arms now tie-break on the chunk id.

**Document ingestion & data sources reliability pass (2026-08):**

- **PDF extraction rewritten** — content streams are now located and zlib-inflated (`FlateDecode`), covering the three text-show encodings (`(literal) Tj`, `[(array)] TJ`, `<hex> Tj`) with correct `endstream` resumption. A 2.7 MB book that previously yielded **329 chars of binary noise** now yields **1.1M chars of real text**. Image-only PDFs return empty (placeholder) instead of embedding garbage. Never had a real PDF worked before this — the old regex matched only uncompressed operators.
- **Background pipeline fixed** — a duplicated root `instrumentation.ts` shadowed the real one, so the BullMQ worker never started: every document-embed/document-cognify job sat in Redis unprocessed (documents uploaded "successfully" but were never embedded → chatbot knew nothing). The boot file now lives only in `src/instrumentation.ts`, guarded by a static invariant test.
- **DB driver loading fixed** — `await import(variable)` is untraceable by Turbopack and by standalone output tracing (drivers vanished from the Docker image). Drivers now load through a static `DRIVER_LOADERS` map, are declared in `serverExternalPackages`, and are pinned in `outputFileTracingIncludes`. Data-source connections (Postgres/MySQL/MSSQL/ClickHouse) work in dev **and** in the standalone build.
- **Cognee recall fixed** — `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` were never valid SearchTypes in `@cognee/cognee-ts` (every recall logged validation errors). Replaced with `SUMMARIES` → `CHUNKS` → `NATURAL_LANGUAGE` (the third is now backend-gated — see the context-safety pass below). (The `datasets.has()` guard added at the same time was later found to be **harmful** — see the memory-integrity pass below.)

**Cognee memory integrity pass (2026-09) — proof that memory actually works:**

- **`datasets.has()` is unreliable in `@cognee/cognee-ts` 0.1.3, and trusting it silently disabled memory.** Measured against a real store: `has('org:<id>')` returned `false` for a dataset that `datasets.list()` listed **and** whose stored fact a raw `search()` returned. Because recall treated `false` as authoritative and returned `''` before searching, memory was written, stored, and retrievable — and the chatbot never saw it. No error, no log, just a bot that claimed it had never been told. `has()` is now advisory (warns, then searches anyway) in both chat memory and knowledge-graph recall.
- **Cross-session recall is verified end-to-end through the real chat pipeline.** A fact stated in session A is answered correctly by a **brand-new** session B with no chat history (`ELANG-6621`) — which is what distinguishes real memory from the 10-message history window.
- **A corrupt local store no longer means permanent amnesia.** A torn `graph.wal` (left behind when a Bun 1.3.14 crash aborted the native binding mid-write) made *every* subsequent init fail with `std::bad_alloc`, forever, for that org. Init now detects store corruption, **quarantines** the damaged store (renames it to `<org>.corrupt-<timestamp>` — never deletes, it may be the tenant's only copy) and rebuilds once. Verified against the real corrupt WAL.
- **Every cognee SDK call is bounded.** There was no `AbortSignal`, no `Promise.race`, no deadline anywhere in the layer, so a native call that never settles hung the caller forever — and `rememberChatTurn` is awaited *after* the answer is computed, so a hang stalled the user's response. `withDeadline` now bounds warm/ownerId/remember/search. The default is **240s, calibrated by measurement**: one ordinary `remember()` took **192s** because it runs cognee's cognify pipeline (its own LLM calls). A first attempt at 20s aborted real writes mid-flight, and the still-running pipeline made the *next* write fail with "cognify for dataset is already running" — a timeout that produced a permanent-looking breakage.
- **`NATURAL_LANGUAGE` fails on the local kuzu backend** (2 of 2 attempts): the SDK accepts the name but emits Cypher the backend rejects on every retry. Kept rather than deleted (it is a valid `SearchType`, other backends may support it, and each strategy is isolated so the cost is one wasted LLM call, never a lost answer), and documented with the measurement.
- **Memory is bounded and the doomed strategy is gone.** `NATURAL_LANGUAGE` cannot run on the local kuzu graph backend — MEASURED, every attempt fails with "generated Cypher that this graph backend rejected" (6039ms plus its own LLM call, both wasted per turn). It was attempted anyway, on TWO legs per turn, and the knowledge-graph leg swallowed the failure in a bare `catch {}` so no log ever showed it. It is now gated on the graph backend (which the client already knows: `kuzu` vs `postgres`) and replaced on kuzu by `CHUNKS_LEXICAL`, MEASURED working there at 41ms. `GRAPH_COMPLETION` was measured as an alternative and is **worse** — it failed after **193341ms** — so it is not used. Injected memory is also capped now (`MEMORY_CONTEXT_MAX_CHARS`, matching `buildSourceGuidance`'s 2000): it was the only unbounded context-injection path, merged with an unbounded join and interpolated into as many as six prompts per turn.
- **Regression-proofed** — `cognee-degradation.test.ts` (30 tests: every failure mode degrades to a working chat), `cognee-recovery.test.ts` (21: quarantine, the one-retry guard, deadline), plus a live suite (`cognee-live.test.ts`, opt-in via `RUN_COGNEE_LIVE=true`). Writing these tests caught two real defects in the recovery code itself — an infinite quarantine loop, and a rebuild that silently never ran.
- **Regression-proofed** — `src/lib/invariants.test.ts` statically enforces all of the above (single instrumentation file that starts the worker; searchType literals validated against the installed SDK's own type union; static driver loader map + external + tracing config; no binary-noise PDF fallback). CI fails if any invariant is broken — including by AI-assisted changes.

**Earlier (v0.4.0):**

- Multi-tenant architecture (org isolation via AsyncLocalStorage + Prisma extension, auto-filtered queries, RBAC)
- RAG: retrieval runs vector + lexical + KG together (was either/or), BM25 + RRF fusion, eval framework with golden test set

## Stack

- **Framework**: Next.js 16 (Turbopack) · React 19 · TypeScript 5
- **Database**: Prisma 6 + PostgreSQL 16 (pgvector + pg_trgm)
- **Runtime**: Bun · Node.js
- **UI**: Tailwind 4 · shadcn/ui
- **AI**: OpenAI-compatible + Anthropic providers
- **Memory**: Cognee (optional, graceful degradation)

## Features

### Multi-Tenant
- Org-scoped data (every table has organizationId)
- Automatic query filtering via Prisma extension
- Auth enforcement on all routes
- Role-based access control

### Hybrid Retrieval
- **Vector leg**: pgvector HNSW, cosine similarity
- **Lexical leg**: BM25 (k1=1.2, b=0.75), IDF weighting, TF saturation
- **KG leg**: Entity + relation retrieval
- **Fusion**: RRF (consensus ranking, k=60)
- **Eval**: Golden test set, recall/precision/MRR metrics

### AI Pipeline
- Intent Analyzer (retrieval need + clarification)
- Contextual Query Rewriter (follow-up → standalone)
- Query Expansion (synonym + multilingual)
- Multi-pass Retrieval with Reflection
- GraphRAG (Cognee extraction in parallel)
- **ReAct Agent Orchestrator** (dynamic Reason→Act→Observe loop, parallel tool calls, per-round adaptation)
- **Unified Tool Interface** (SQL/RAG/REST/Web/Plugin/MCP/Admin behind one strict-JSON-Schema contract)
- **Tool Circuit Breaker** (closed → open → half-open, prevents cascading failures)
- Smart Router (semantic + performance scoring)
- Text-to-SQL (AST guardrails)
- Real DB Connectors (Postgres, MySQL, MSSQL)
- REST Connector (whitelisted endpoints)
- MCP Client (external servers, **lossless JSON Schema passthrough**)

### Super-App
- ReAct Agent Orchestrator (dynamic multi-tool reasoning loop)
- Unified Tool Registry (one contract across every tool family)
- Tool Circuit Breaker (health-aware tool routing)
- Schema Enrichment (LLM descriptions)
- Plugin Registry (9 prebuilt + custom webhooks)
- MCP Client (lossless JSON Schema passthrough, circuit-broken)
- Cognee Memory (chat recall + KG)
- Scheduler (cron automation)
- Execution History (full audit trail)
- Notifications (webhook + email + Telegram)

### Security
- AES-256-GCM credentials encryption
- Session fixation defense
- 30min inactivity timeout
- Edge auth middleware
- Rate limiting per route
- SQL AST guardrails
- SSRF blocklist + DNS-rebinding protection
- Webhook HMAC-SHA256 verification
- API key hashing + rate limiting
- Audit logging
- Env schema validation (Zod)
- Fail-closed auth
- Multi-tenant isolation (org scoping)

### Observability
- Structured JSON logging
- Typed errors (16 codes)
- LLM token usage tracking
- Tool metrics (latency, success, circuit breaker)
- RAG cache stats
- Execution history + export (JSON/CSV)
- Monitoring dashboard
- Audit log
- Log retention (90-day default)
- Health endpoints

### Reliability
- LLM retry (3x exponential backoff)
- Timeouts: 30s LLM, 120s stream, 90s agentic
- SQL concurrency limiter (3 max per integration)
- Webhook retry (3x exponential backoff)
- RAG cache (1min TTL)
- RAG LLM reranker (optional)
- pgvector HNSW (sub-millisecond)
- Multi-tool DAG (optional)

## Agentic Architecture

The agent surface runs a **dynamic ReAct loop**, not a pre-committed plan. Each
round the model reasons, calls one or more tools through native function calling,
observes the real results, and decides the next action from them — so a tool that
returns nothing can be adapted around instead of failing a plan fixed before any
data arrived.

| Module | Role |
|---|---|
| `src/lib/unified-tools.ts` | One `UnifiedTool` contract (id, strict JSON Schema, executor) across SQL, RAG, REST, web_search, web_fetch, chat, admin, plugin, and MCP tools. Encodes ids into LLM-legal function names and back. |
| `src/lib/tool-circuit-breaker.ts` | Closed → open → half-open state machine per tool. Trips after 3 consecutive failures, re-probes after a cooldown, and prevents one dead tool from consuming the whole turn's budget. |
| `src/lib/agent-orchestrator.ts` | The ReAct engine. Parallel tool execution per round, bounded rounds, observation feedback, and human-in-the-loop confirmation gates. |

**MCP tools keep their own JSON Schema.** A server's `inputSchema` is passed to the
model verbatim rather than flattened into a prose description, so boolean, array,
and nested-object parameters survive the round trip instead of being re-guessed.
Verified against a real MCP server: the schema the model receives is byte-identical
to the one the server advertises.

**Step inputs are coerced by declared type, never by guesswork.** The planner
normalises step inputs to strings, so they must be converted back before a typed
tool is called. Conversion reads the tool's own JSON Schema and converts only on a
type match, because parsing every value blindly corrupts any string that merely
looks like JSON — a legitimate `path: "12345"` would otherwise arrive as the
number `12345`.

**The legacy static planner** (`src/lib/planner.ts`) still backs the in-chat
multi-step DAG path; both it and the orchestrator share the circuit breaker and the
same tool catalogue. A drift check in `trial/70-agentic-e2e.ts` fails if the two
catalogues ever disagree, so a tool cannot silently exist on one surface only.

### MCP client capabilities

We declare only what we actually implement, because declaring a capability we
cannot serve makes a server wait on a request that never answers:

| Capability | Declared | What it does here |
|---|---|---|
| `roots` | yes | Answers `roots/list` with the directories this install grants, and emits `roots/list_changed`. The grant is an explicit opt-in via `MCP_ROOTS` (colon-separated, PATH convention); with nothing set we report **zero** roots rather than guessing at the host filesystem. |
| `tools` · `resources` · `prompts` | server-side | Handled, including all four `*_list_changed`/`updated` notifications, and resource **subscriptions** (`resources/subscribe`) so a conforming server actually sends us content changes instead of keeping them for subscribers only. |
| `sampling` · `elicitation` | **no** | Deliberately absent — there is no handler for either, so declaring them would strand a server on a request we never answer. |

### Plugin execution and packaging

A plugin runs either as a webhook or as a local **MCP server** (`executorType:
mcp-stdio`). The command is checked against the same allowlist the MCP installer
uses, and the process runs under Linux namespaces — network, pid, mount and user
— so it has **no route off the box** and cannot see other processes. Verified: a
baseline process reaches the network while a sandboxed one fails with
`ENETUNREACH`.

Two limits are stated rather than glossed: this is **not** a filesystem sandbox
(the mount namespace is not populated with a read-only root, so the process still
reads what the app user can), and it caps no CPU or memory. It is containment
against a careless plugin, not a boundary against a kernel-level adversary. The
level degrades explicitly and says so in the log; an operator can pin it with
`MCP_PLUGIN_ISOLATION`.

Plugins travel as **portable packages** (`GET /api/tools/[id]/package`) and are
installed in two steps: `POST /api/tools/install` validates and *describes* what
would happen — which endpoint, which process, which credential — and writes
nothing, so the operator approves something they have actually seen.
Credentials are stripped on export and refused on import.

### Agentic test coverage

The agent surface is covered at three levels, because a unit test with a mocked
provider cannot show that the transport and the tool round-trip actually cooperate:

| Level | Where | What it proves |
|---|---|---|
| Unit | `agent-orchestrator.test.ts`, `unified-tools.test.ts`, `tool-circuit-breaker.test.ts`, `llm-client.test.ts`, `plugin-sandbox.test.ts`, `plugin-package.test.ts`, `mcp-client-transport.test.ts` | Round limits, parallel execution with partial failure, circuit-breaker trips, tool-name legality, the outgoing `tool_calls` wire shape, sandbox argv composition, the package lifecycle with four attack cases, and that an unknown tool name fails instead of returning empty success. |
| Browser, mocked provider | `e2e/07-agentic.spec.ts` | SSE framing over real HTTP, the frame-ordering contract, and a complete tool-calling turn. The mock LLM rejects a malformed `tool_call`, so a wire-shape regression fails the suite. |
| Live harness | `trial/70-agentic-e2e.ts` (11 sections), `trial/95-mcp-live.ts` | A real provider and real MCP servers: tool discovery, lossless schema passthrough, catalogue parity, runtime tool changes, resource/prompt surfaces, resource content updates, the roots round trip, subscriptions against a subscribers-only server, and sandboxed plugin execution. Not in CI (requires a provider). |

## Production Hardware Specifications

Target deployment is an on-premise Linux box (Ubuntu 22.04/24.04 LTS, Debian 12, `x86_64` or `arm64`) running Docker Engine + Compose plugin.

| Tier | Target Workload | CPU | Physical RAM | Storage (SSD/NVMe) |
|---|---|---|---|---|
| **Minimum** | Small team (1–5 concurrent users), <5k documents, Native Hybrid RAG | **1 vCPU** | **2 GB** *(or 1 GB + 2 GB swap)* | **20 GB** |
| **Recommended Production** | 10–50 concurrent users, tens of thousands of documents, Knowledge Graph (Cognee) active | **2 vCPU** | **4 GB** | **40 – 50 GB** |
| **Enterprise / High-Scale** | High concurrency, hundreds of thousands of documents, intensive Text-to-SQL | **4 vCPU** | **8 GB** | **80 – 100 GB** |

### Per-Container Resource Consumption

| Container | Idle RAM | Peak / Active RAM | CPU & Storage Profile |
|---|---|---|---|
| **`app`** (Next.js / Bun) | ~150 MB | 250 – 400 MB | Low CPU (<2%), brief spikes during token streaming |
| **`scheduler`** (BullMQ) | ~100 MB | 150 – 250 MB | CPU active during PDF/DOCX chunking and embedding |
| **`db`** (PostgreSQL 16 + pgvector) | ~150 MB | 300 – 600 MB | `shared_buffers` capped at 64MB; pgvector HNSW fast on 1-2 cores |
| **`redis`** (Redis 7 Alpine) | ~30 MB | Capped at 64 MB | `--maxmemory 64mb --maxmemory-policy volatile-lru` |
| **`cognee`** (Knowledge Graph sidecar) | ~300 MB | 650 – 850 MB | Active during entity/relationship extraction and graph search |
| **Total System (All-in)** | **~750 MB** | **~1.5 – 2.2 GB** | Highly stable on a 2GB – 4GB VPS |

## Production Deployment & Security Architecture

### One-Command Installer (`install.sh`)
```bash
# Standard installation (exposes unique default port 38180)
curl -sSL https://ryasai.my.id/install.sh | bash

# Custom host port
curl -sSL https://ryasai.my.id/install.sh | bash -s -- --port 38180

# With private SearXNG search engine
curl -sSL https://ryasai.my.id/install.sh | bash -s -- --with-searxng
```

### Security & Anti-Tampering Guarantees
- **Source Code Anti-Theft Protection:** The customer VPS **never clones the git repository** and never builds from source. The installer pulls official prebuilt container images (`ghcr.io/ryasrk/ryasai-chatbot:app`, `scheduler`). `/opt/ryasai-chatbot` on the client VPS contains **only** `.env` and `docker-compose.prod.yml` — zero TypeScript code, zero prompt files, and zero test suites.
- **Port Collision Avoidance:** Uses unique port **`38180`** by default (`127.0.0.1:38180:3000`, localhost-only), avoiding common port conflicts (80, 443, 3000, 8080, 5432, 6379). The installer automatically detects if `38180` is in use and auto-selects the next available port.
- **Hardcoded Central License Authority:** In production, license validation is strictly locked to `https://license.ryasai.my.id`. Any attempt to redirect `LICENSE_VALIDATOR_URL` in `.env` is ignored by the production binary. Every validation response requires an authentic Ed25519 digital signature verified against `LICENSE_SIGNING_PUBLIC_KEY`.

## Development

```bash
bun install              # deps
bun run dev              # dev server (port 3000)
bun run build            # standalone build
bun run start            # prod server
bun run test             # unit tests (per-file runner, see AGENTS.md)
bun run e2e              # Playwright
bun run lint             # eslint
bunx tsc --noEmit        # typecheck
bash start.sh            # Next.js + scheduler
bash reset.sh            # reset DB + reseed
bun scripts/coverage-gate.ts   # per-module coverage floors
```

### Benchmarks

```bash
# 800-question cross-source benchmark (4 families, 200 each).
# Launch the four concurrently -- one runner per family -- then merge once.
bun trial/cross/run.ts --family SQL_SALES --json trial/cross/results-SQL_SALES.json
bun trial/cross/consolidate.ts --json trial/cross/report.json
bun trial/cross/repeat.ts --family SQL_SALES --trials 3   # variance vs real defects
bun trial/cross/rescore.ts       # re-score SAVED answers after a judge change
```

Only the answer is scored; see **Measured Results** above for why routing agreement is
not an accuracy measure.

Two notes that each cost a full run:

- There are **two independent chat rate limiters.** `CHAT_RATE_LIMIT_PER_MIN` is
  per-organization and lives inside the route handler; `RATE_LIMIT_CHAT_PER_MIN` is
  per-IP and lives in the **middleware**, so it runs first and the request never reaches
  the handler (default 30/min). A batch is stopped by the second, so raising only the
  first changes nothing. Both must be raised for a long run.
- The runner paces questions (`CROSS_PACE_MS`) and **aborts after 5 consecutive HTTP
  429s**. A throttled run produces empty answers, which score as failures — one run had
  196 of 200 questions refused and would have been published as an accuracy figure
  measuring the rate limiter. Never report a run that aborted.

Launch long runs from a detached shell: a run started inside a short-lived shell dies
with it and yields a truncated result file that looks like a low score.

### Guard rails for agents & humans

`src/lib/invariants.test.ts` (part of `bun run test` and CI) encodes the
load-bearing invariants of this repo as **static source scans**. Each assertion
documents the production incident it prevents:

| Invariant | Incident it prevents |
|---|---|
| Exactly one `src/instrumentation.ts`, and it calls `startJobWorker()` | A duplicate root `instrumentation.ts` shadowed the real one → BullMQ worker never started → documents never embedded/cognified (chatbot "knew nothing", `dataset not found` spam) |
| Every cognee `searchType` literal is re-validated against the installed SDK's `SearchTypeString` union | `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` came from Python docs; the TS SDK rejects them — every recall strategy errored per chat turn |
| DB drivers load via the static `DRIVER_LOADERS` map (literal specifiers only), stay in `serverExternalPackages`, and are pinned in `outputFileTracingIncludes` | `await import(variable)` is untraceable → Turbopack dev broke AND standalone Docker images shipped without `pg`/`mysql2`/`mssql` → "driver not installed" |
| PDF extractor has no printable-ASCII dump fallback | The old fallback embedded binary noise as "knowledge", poisoning retrieval |

If a change trips one of these guards: **do not delete the guard.** Read the
assertion's comment block — it explains the outage the guard encodes — and
restructure the change to preserve the invariant.

## Project Structure

```
src/
├── app/api/              # 99 API routes
├── app/page.tsx          # Main SPA (12 views)
├── components/
│   ├── ui/               # shadcn/ui
│   └── views/            # Feature views
├── lib/
│   ├── rag-ranking.ts    # BM25 + RRF
│   ├── rag-eval.ts       # Eval framework
│   ├── prisma-tenant.ts  # Multi-tenant extension
│   ├── session.ts        # Auth + org context
│   ├── cognee.ts         # Knowledge graph
│   └── ... (60+ files)
├── middleware.ts         # Edge auth
prisma/
└── schema.prisma         # 31 models
docs/
├── ARCHITECTURE.md       # Full system design
└── MULTI-TENANT-GUIDE.md # Org scoping guide
trial/
├── cross/                # 800-question cross-source benchmark + raw answers
└── live/                 # live-provider accuracy / token measurements
uat/
└── fixtures/             # 3 database dumps + 3 REST services + 9 documents (+3 legacy)
```

`trial/` and `uat/` are ad-hoc measurement harnesses, not part of CI. Their run artifacts
are committed on purpose: they are the evidence behind every number in **Measured
Results**, and committed answers can be re-scored without re-asking hundreds of questions.

## Configuration

Copy `.env.example` to `.env`:

| Var | Required | Description |
|-----|----------|-------------|
| `DATABASE_URL` | Yes | Postgres |
| `ENCRYPTION_SECRET_KEY` | Yes | 64-char (AES-256-GCM) |
| `ADMIN_INITIAL_PASSWORD` | Yes | Initial password |
| `LICENSE_VALIDATOR_URL` | Fixed | Central license server: in production, locked to `https://license.ryasai.my.id` (anti-tampering). Dev/test defaults to `http://localhost:9000` |
| `COGNEE_ENABLED` | No | kill switch — leave unset, Settings > AI Memory decides; `false` forces off |
| `COGNEE_SERVER_URL` | No | set (`http://cognee:8000`) in compose installs → memory runs over HTTP against the `cognee` sidecar (cognee 1.5.4). Unset → in-process `@cognee/cognee-ts` SDK. Read from the environment only, never per-org |
| `COGNEE_SERVER_API_KEY` | No | bearer token for the sidecar, if you put an auth proxy in front of it |
| `RAG_LLM_RERANK` | No | true (optional) |
| `CONTEXTUAL_RETRIEVAL` | No | true (optional, -49% failures) |
| `LOG_LEVEL` | No | debug/info/warn/error |
| `APP_PORT` | No | 38180 (unique host port, configurable via `--port` or `APP_PORT`) |
| `PORT` | No | 3000 (internal container port) |

**Document knowledge end-to-end** (upload → usable in chat) needs three things:
1. LLM + embedding provider configured (Settings → AI Config) — embeddings are no-op without a key, silently
2. The BullMQ worker running (automatic: `src/instrumentation.ts` starts it; watch for `[worker] Adopting N queued document job(s)` on boot)
3. Redis up (jobs fall back to synchronous processing without it)

**Data source connections** need the driver packages installed (`pg`, `mysql2`, `mssql`, `@clickhouse/client` — already in `package.json`). If a connection ever reports `driver not installed`, check `src/lib/invariants.test.ts` guard #3 before anything else.

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Full system design, RAG pipeline, multi-tenant isolation, performance
- **[MULTI-TENANT-GUIDE.md](./MULTI-TENANT-GUIDE.md)** — Org scoping guide, code examples, pitfalls
- **[docs/postgres-migration.md](./docs/postgres-migration.md)** — Postgres setup
- **[trial/cross/README.md](./trial/cross/README.md)** — How the 800-question benchmark is built and how to read it

## Production Readiness

- ✅ Multi-tenant isolation (AsyncLocalStorage + Prisma)
- ✅ Authentication + RBAC (admin, analyst, viewer)
- ✅ BM25 + RRF hybrid retrieval (+ KG leg)
- ✅ Eval framework with golden test set
- ✅ 6,760 unit tests across 249 files (`bun scripts/test.ts`), 0 failures, 100% pass rate
- ✅ 48 static invariant guards (`bun test src/lib/invariants.test.ts`)
- ✅ PDF/DOCX/XLSX extraction verified against real files (FlateDecode streams, hex strings)
- ✅ Data-source drivers verified in dev AND standalone build (static loader map + tracing)
- ✅ Error handling + graceful fallbacks
- ✅ 99.38% accuracy on the 800-question cross-source benchmark (4 databases/APIs, 0 empty
  answers, 0 throttled requests) — see **Measured Results**; 99.75% variance-corrected.
- ✅ Large-scale Cognee 1,000-question retrieval benchmark across 1,200 documents, 7/7 control block gates PASSED (`benchmark/results/cognee-1000-report.md`)
- ✅ Cross-session memory verified end-to-end separately (a fact from one session answered by
  a brand-new session with no history) — see the cognee integrity pass
- ✅ Verifiable evidence for every benchmark figure (raw answers committed, re-scorable)
- ✅ Deployment security: prebuilt containers only (zero source code on host), unique port 38180 collision avoidance, hardcoded central license validator
- ⏳ Load testing recommended
- ⏳ Monitoring + alerting setup

## License

Proprietary. All rights reserved.
