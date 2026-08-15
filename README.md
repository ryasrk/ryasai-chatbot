# ryasai — Enterprise AI Assistant

![CI](https://github.com/ryasai/Chatbot/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-Proprietary-red) ![Version](https://img.shields.io/badge/version-0.4.0-blue) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

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

## Key Updates (v0.4.1)

**Document ingestion & data sources reliability pass (2026-08):**

- **PDF extraction rewritten** — content streams are now located and zlib-inflated (`FlateDecode`), covering the three text-show encodings (`(literal) Tj`, `[(array)] TJ`, `<hex> Tj`) with correct `endstream` resumption. A 2.7 MB book that previously yielded **329 chars of binary noise** now yields **1.1M chars of real text**. Image-only PDFs return empty (placeholder) instead of embedding garbage. Never had a real PDF worked before this — the old regex matched only uncompressed operators.
- **Background pipeline fixed** — a duplicated root `instrumentation.ts` shadowed the real one, so the BullMQ worker never started: every document-embed/document-cognify job sat in Redis unprocessed (documents uploaded "successfully" but were never embedded → chatbot knew nothing). The boot file now lives only in `src/instrumentation.ts`, guarded by a static invariant test.
- **DB driver loading fixed** — `await import(variable)` is untraceable by Turbopack and by standalone output tracing (drivers vanished from the Docker image). Drivers now load through a static `DRIVER_LOADERS` map, are declared in `serverExternalPackages`, and are pinned in `outputFileTracingIncludes`. Data-source connections (Postgres/MySQL/MSSQL/ClickHouse) work in dev **and** in the standalone build.
- **Cognee recall fixed** — `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` were never valid SearchTypes in `@cognee/cognee-ts` (every recall logged validation errors). Replaced with `SUMMARIES` → `CHUNKS` → `NATURAL_LANGUAGE`, plus a `datasets.has()` guard so a not-yet-cognified org returns empty instead of throwing `dataset not found`.
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
```

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
├── app/api/              # 62 API routes
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
└── schema.prisma         # 30 models
docs/
├── ARCHITECTURE.md       # Full system design
└── MULTI-TENANT-GUIDE.md # Org scoping guide
```

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

## Production Readiness

- ✅ Multi-tenant isolation (AsyncLocalStorage + Prisma)
- ✅ Authentication + RBAC (admin, analyst, viewer)
- ✅ BM25 + RRF hybrid retrieval (+ KG leg)
- ✅ Eval framework with golden test set
- ✅ 1600+ unit tests, incl. static invariant guards (see Development)
- ✅ PDF/DOCX/XLSX extraction verified against real files (FlateDecode streams, hex strings)
- ✅ Data-source drivers verified in dev AND standalone build (static loader map + tracing)
- ✅ Error handling + graceful fallbacks
- ⏳ Load testing recommended
- ⏳ Monitoring + alerting setup

## License

Proprietary. All rights reserved.
