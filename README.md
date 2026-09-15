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

**Test suite:** 6522 tests across 240 files, `bun run test`, 0 failures. Coverage is
reported two ways on purpose: **96.20% of reachable lines** and 88.09% merged across 198
gated modules (`bun scripts/coverage-gate.ts`). Branch coverage is **not measurable** in
this toolchain — Bun emits `BRF: 0` — and that limitation is recorded rather than papered
over. One caveat worth stating: a `bun run test` run flaked once in
`src/lib/llm-config.test.ts`, which passed 5/5 in isolation immediately afterwards and on
both re-runs of the full suite. Cause unknown.

## Key Updates (v0.4.1)

**Document ingestion & data sources reliability pass (2026-08):**

- **PDF extraction rewritten** — content streams are now located and zlib-inflated (`FlateDecode`), covering the three text-show encodings (`(literal) Tj`, `[(array)] TJ`, `<hex> Tj`) with correct `endstream` resumption. A 2.7 MB book that previously yielded **329 chars of binary noise** now yields **1.1M chars of real text**. Image-only PDFs return empty (placeholder) instead of embedding garbage. Never had a real PDF worked before this — the old regex matched only uncompressed operators.
- **Background pipeline fixed** — a duplicated root `instrumentation.ts` shadowed the real one, so the BullMQ worker never started: every document-embed/document-cognify job sat in Redis unprocessed (documents uploaded "successfully" but were never embedded → chatbot knew nothing). The boot file now lives only in `src/instrumentation.ts`, guarded by a static invariant test.
- **DB driver loading fixed** — `await import(variable)` is untraceable by Turbopack and by standalone output tracing (drivers vanished from the Docker image). Drivers now load through a static `DRIVER_LOADERS` map, are declared in `serverExternalPackages`, and are pinned in `outputFileTracingIncludes`. Data-source connections (Postgres/MySQL/MSSQL/ClickHouse) work in dev **and** in the standalone build.
- **Cognee recall fixed** — `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` were never valid SearchTypes in `@cognee/cognee-ts` (every recall logged validation errors). Replaced with `SUMMARIES` → `CHUNKS` → `NATURAL_LANGUAGE`. (The `datasets.has()` guard added at the same time was later found to be **harmful** — see the memory-integrity pass below.)

**Cognee memory integrity pass (2026-09) — proof that memory actually works:**

- **`datasets.has()` is unreliable in `@cognee/cognee-ts` 0.1.3, and trusting it silently disabled memory.** Measured against a real store: `has('org:<id>')` returned `false` for a dataset that `datasets.list()` listed **and** whose stored fact a raw `search()` returned. Because recall treated `false` as authoritative and returned `''` before searching, memory was written, stored, and retrievable — and the chatbot never saw it. No error, no log, just a bot that claimed it had never been told. `has()` is now advisory (warns, then searches anyway) in both chat memory and knowledge-graph recall.
- **Cross-session recall is verified end-to-end through the real chat pipeline.** A fact stated in session A is answered correctly by a **brand-new** session B with no chat history (`ELANG-6621`) — which is what distinguishes real memory from the 10-message history window.
- **A corrupt local store no longer means permanent amnesia.** A torn `graph.wal` (left behind when a Bun 1.3.14 crash aborted the native binding mid-write) made *every* subsequent init fail with `std::bad_alloc`, forever, for that org. Init now detects store corruption, **quarantines** the damaged store (renames it to `<org>.corrupt-<timestamp>` — never deletes, it may be the tenant's only copy) and rebuilds once. Verified against the real corrupt WAL.
- **Every cognee SDK call is bounded.** There was no `AbortSignal`, no `Promise.race`, no deadline anywhere in the layer, so a native call that never settles hung the caller forever — and `rememberChatTurn` is awaited *after* the answer is computed, so a hang stalled the user's response. `withDeadline` now bounds warm/ownerId/remember/search. The default is **240s, calibrated by measurement**: one ordinary `remember()` took **192s** because it runs cognee's cognify pipeline (its own LLM calls). A first attempt at 20s aborted real writes mid-flight, and the still-running pipeline made the *next* write fail with "cognify for dataset is already running" — a timeout that produced a permanent-looking breakage.
- **`NATURAL_LANGUAGE` fails on the local kuzu backend** (2 of 2 attempts): the SDK accepts the name but emits Cypher the backend rejects on every retry. Kept rather than deleted (it is a valid `SearchType`, other backends may support it, and each strategy is isolated so the cost is one wasted LLM call, never a lost answer), and documented with the measurement.
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
- Agentic Loop (route → execute → evaluate → repeat)
- Smart Router (semantic + performance scoring)
- Text-to-SQL (AST guardrails)
- Real DB Connectors (Postgres, MySQL, MSSQL)
- REST Connector (whitelisted endpoints)
- MCP Client (external servers with hardening)

### Super-App
- Agentic Planner (multi-step DAG)
- Schema Enrichment (LLM descriptions)
- Plugin Registry (9 prebuilt + custom webhooks)
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
| `LICENSE_VALIDATOR_URL` | Recommended | License server; **defaults to `http://localhost:9000`** — unset means every license activation fails with an opaque `fetch failed` in local dev. Use `https://license.ryasai.my.id` unless running a local validator |
| `COGNEE_ENABLED` | No | kill switch — leave unset, Settings > AI Memory decides; `false` forces off |
| `RAG_LLM_RERANK` | No | true (optional) |
| `CONTEXTUAL_RETRIEVAL` | No | true (optional, -49% failures) |
| `LOG_LEVEL` | No | debug/info/warn/error |
| `PORT` | No | 3000 (default) |

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
- ✅ 6522 unit tests across 240 files (`bun run test`), incl. static invariant guards (see Development)
- ✅ PDF/DOCX/XLSX extraction verified against real files (FlateDecode streams, hex strings)
- ✅ Data-source drivers verified in dev AND standalone build (static loader map + tracing)
- ✅ Error handling + graceful fallbacks
- ✅ 99.38% accuracy on the 800-question cross-source benchmark (4 databases/APIs, 0 empty
  answers, 0 throttled requests) — see **Measured Results**; 99.75% variance-corrected
- ✅ Verifiable evidence for every benchmark figure (raw answers committed, re-scorable)
- ⏳ Load testing recommended
- ⏳ Monitoring + alerting setup

## License

Proprietary. All rights reserved.
