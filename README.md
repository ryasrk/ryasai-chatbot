# ryasai — Enterprise AI Assistant

![CI](https://github.com/ryasai/Chatbot/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-Proprietary-red) ![Version](https://img.shields.io/badge/version-0.4.0-blue) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

Self-hosted, single-tenant AI assistant that answers questions by routing to the right tool: SQL queries, document RAG, REST API calls, external plugins, or general chat. Built for enterprises that need data-grounded AI with security guardrails.

## Quick Start

```bash
# Install dependencies
bun install

# Apply database schema
bunx prisma db push --accept-data-loss
bunx prisma generate

# Seed demo data (admin user, ERP tables, documents, plugins)
bun run scripts/seed.ts

# Start dev server + scheduler
bash start.sh
# or just the web app:
bun run dev
```

Default login: `admin@ryas.ai` / `admin12345`

## Stack

- **Framework**: Next.js 16 (App Router) · React 19 · TypeScript 5
- **Database**: Prisma 6 + PostgreSQL 16 (pgvector + pg_trgm extensions)
- **Runtime**: Bun (dev/test) · Node standalone (prod build)
- **UI**: Tailwind 4 · shadcn/ui · 5 theme system
- **AI**: OpenAI-compatible + Anthropic-native LLM providers (fail-closed — no sandbox fallback)
- **Memory**: Cognee integration (enabled by default, graceful degradation when unavailable)

## Features

### Core AI Pipeline
- **Intent Analyzer**: Decides whether retrieval is needed + whether clarification is needed. Uses document names, integration names, and schema table descriptions as context. Progressive slot filling (asks ONE question at a time)
- **Contextual Query Rewriter**: Rewrites follow-up questions into standalone search queries using conversation history
- **Query Expansion**: Synonym + multilingual expansion (e.g. "leave" → "vacation", "cuti", "cuti tahunan", "time off"). Max 3 expansions
- **Multi-pass Retrieval with Reflection**: `retrieveWithReflection()` — expands query, retrieves with all expansions in parallel, merges + dedupes by chunkId, evaluates evidence sufficiency via LLM, does a second pass with 2x topK if insufficient
- **GraphRAG**: Cognee `recallKnowledgeGraph` called in parallel with flat retrieval, graph context merged into results
- **Agentic Confidence Loop**: `runAgenticLoop()` — route → execute → evaluate confidence → repeat (max 3 iterations). Heuristic pre-check skips LLM confidence call for obvious cases. Cross-source fallback: when confidence evaluator suggests `nextToolHint`, inject hint into next iteration
- **Streaming Agentic Loop**: `runStreamingAgenticLoop()` — same loop but streams the final answer. Wired into UI chat via `allowMultiStepDag: true`
- **Smart Router**: Self-adjusting load balancer (schema + performance + latency + similarity + circuit breaker) with semantic scoring (40% keyword overlap + 60% embedding similarity, cached 5min/10s)
- **Text-to-SQL**: AST guardrails (SELECT only, LIMIT 100, no DML/DDL)
- **Real DB Connectors**: Postgres (pg Pool), MySQL (mysql2 Pool), MSSQL (mssql ConnectionPool) — dynamic driver loading, 30s timeout, schema reflection
- **Hybrid RAG**: Lexical + semantic + FTS + external vector store (Qdrant/Milvus) + LLM reranker (opt-in) + query cache (1min TTL)
- **Contextual Retrieval**: Optional (env `CONTEXTUAL_RETRIEVAL=true`). Prepends an LLM-generated document summary to each chunk before embedding, reducing retrieval failures by ~49%
- **REST Connector**: Whitelisted endpoints with parameter schema
- **Streaming Chat**: Real SSE token streaming with mid-stream error frames + 120s idle watchdog

### Super-App Capabilities
- **Agentic Planner**: Multi-step DAG execution with self-correction
- **Schema Description Enrichment**: LLM-generated 1-sentence description per table, stored in `IntegrationSchema.description`. Used as context in intent analyzer + router prompt. Fire-and-forget on integration create + test
- **Plugin Registry**: 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, StackOverflow search, timezone, datetime) + custom webhook tools
- **Cognee Memory**: Chat-turn remember/recall + knowledge graph cognify
- **Scheduler**: Cron-based automation with notification integration
- **Execution History + Export**: `ScheduledRunLog` model stores full execution history (answer, error, toolRuns JSON, latencyMs). `GET /api/schedules/[id]/runs` + `?format=json|csv` export. UI polling (15s) + toast notifications on new runs
- **Notification API**: Webhook + email + Telegram delivery

### Security
- AES-256-GCM encryption for all credentials
- Session fixation defense (sessionVersion + HMAC, invalidated on re-login)
- 30min inactivity timeout
- Edge auth middleware (cookie-based session)
- Rate limiting (POST/PUT/DELETE/PATCH, per-route, Edge-safe in-memory)
- SQL AST guardrails (mutation block, LIMIT cap)
- SSRF blocklist (RFC1918, link-local, CGNAT, ULA)
- Plugin manifest Zod validation at registration
- Webhook HMAC-SHA256 signature verification
- API keys (hashed, prefix-based O(1) lookup, rate-limited)
- Audit logging (fail-closed on critical severity)
- Env schema validation at startup (Zod, prod-only)
- Fail-closed auth (no demo fallback by default)

### Observability
- Structured JSON logger (`src/lib/logger.ts` — scoped, leveled, no Pino dep)
- Typed error responses (`{ error: { code, message, hint? } }` — 16 error codes via `src/lib/errors.ts`)
- LLM token usage tracking (per-purpose: router, sql, rag, rest, synthesis, chat)
- Tool run metrics (latency, success rate, circuit breaker)
- RAG cache metrics (`getRagCacheStats()` — hits, misses, hit rate)
- `ScheduledRunLog` full execution history (answer, error, toolRuns, latency) + JSON/CSV export
- Monitoring dashboard (24h stats, failed requests, blocked SQL)
- Audit log (GUARDRAIL_BLOCK, SQL_EXECUTE, API_KEY_GENERATED, etc.)
- Log retention (daily cleanup, 90-day default via scheduler)
- Health endpoints: `/api/v1/health` (liveness) + `/api/health` (DB + Redis checks)

### Reliability
- LLM retry with exponential backoff (3 retries, 500ms*2^attempt)
- 30s LLM timeout, 120s stream timeout
- Per-integration SQL concurrency limiter (3 concurrent max)
- Webhook retry with exponential backoff (3 retries, 2s*2^n)
- RAG query cache (1min TTL, invalidated on document changes)
- RAG LLM reranker (opt-in via `RAG_LLM_RERANK=true`)
- Multi-tool DAG execution (opt-in via `allowMultiStepDag` flag)
- Parallelized intent pipeline (`rewriteQuery` + `recallContext` + 7 DB queries + `analyzeIntent` via `Promise.all`)
- Parallelized planner steps (`groupByLevel` + `Promise.all` within each dependency level)
- Agentic loop heuristic confidence check (skips LLM call for obvious cases)
- Semantic scoring graceful fallback (keyword-only when embedding API unavailable)

## Architecture

```mermaid
flowchart TD
    A[User query] --> B[Intent Pipeline]
    B --> B1[Query Rewriter]
    B --> B2[Contextual Recall]
    B --> B3[DB metadata queries]
    B --> B4[Intent Analyzer]
    B1 & B2 & B3 & B4 --> C[Smart Router]
    C -->|40% keyword + 60% embedding| D{Decision}
    D -->|SQL| E1[SQL Branch]
    D -->|RAG| E2[RAG Branch]
    D -->|REST| E3[REST Branch]
    D -->|CHAT| E4[Chat Branch]
    D -->|CONTEXTUAL_CHAT| E5[Contextual Chat]
    E1 & E2 & E3 & E4 & E5 --> F[Answer]
    D -->|multi-step| G[Agentic Loop]
    G --> G1[Route]
    G1 --> G2[Execute]
    G2 --> G3{Confidence high?}
    G3 -->|no, max 3| G1
    G3 -->|yes| G4[Synthesize + Stream]
    G4 --> F
```

```mermaid
sequenceDiagram
    participant U as User
    participant R as Router
    participant T as Tool
    participant L as LLM
    U->>R: Question
    R->>L: Intent analysis
    L-->>R: Needs retrieval? + clarification?
    R->>T: Route (SQL / RAG / REST / Chat)
    T->>L: Execute (gen SQL / retrieve docs / call API)
    L-->>T: Result
    T->>L: Evaluate confidence
    L-->>T: Confidence score
    alt Confidence low AND iterations < 3
        T->>R: Next tool hint
        R->>T: Route next tool
    else Confidence high
        T->>L: Synthesize final answer
        L-->>U: Streamed answer + citations
    end
```

<details>
<summary>ASCII architecture diagram (fallback)</summary>

```
User query
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Intent Pipeline (parallelized via Promise.all)     │
│  ├─ Query Rewriter (follow-up → standalone)         │
│  ├─ Contextual Recall (cognee memory)               │
│  ├─ DB metadata queries (integrations, docs, etc.)  │
│  └─ Intent Analyzer (slot filling, clarification)   │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Smart Router (self-adjusting + semantic scoring)   │
│  40% keyword overlap + 60% embedding similarity     │
│  → SQL | RAG | REST | CHAT | CONTEXTUAL_CHAT        │
└─────────────────────────────────────────────────────┘
   │
   ├─ Chat path (tool-router.ts)
   │   └─ Single tool: SQL / RAG / REST / CHAT
   │
   └─ Agentic path (runStreamingAgenticLoop)
       ├─ route → execute → evaluate confidence → repeat (max 3)
       ├─ Query Expansion (synonym + multilingual, max 3)
       ├─ Multi-pass Retrieval with Reflection
       │   └─ GraphRAG (cognee recallKnowledgeGraph, parallel)
       ├─ executePlan → parallelized per dependency level
       │   ├─ Built-in tools (sql, rag, rest, chat)
       │   └─ Plugin tools (plugin:weather, plugin:web_search, ...)
       └─ synthesizeAnswer → stream final answer
```

</details>

## Commands

```bash
bun run dev          # dev server on $PORT (3000 default)
bun run build        # standalone build → .next/standalone
bun run start        # prod standalone server
bun run test         # unit tests (62+ pass individually — mock.module isolation issue across files, run per-file)
bun run e2e          # Playwright (4 specs, mock LLM)
bun run lint         # eslint (0 errors)
bunx tsc --noEmit    # typecheck (0 errors)
bunx prisma db push  # apply schema to Postgres
bunx prisma generate # regenerate Prisma client
bash start.sh        # start Next.js + scheduler
bash reset.sh        # reset DB + re-seed
bun run scripts/long-turn-chat.ts  # 20-turn multi-database chat test
```

## Project Structure

```
src/
├── app/
│   ├── api/              # 62 API routes
│   ├── page.tsx          # Main SPA (12 views, ChatView+AgenticView always mounted)
│   ├── layout.tsx        # Root layout (theme init)
│   ├── error.tsx         # Route-level error boundary
│   └── global-error.tsx  # Root error boundary
├── components/
│   ├── ui/               # shadcn/ui primitives
│   └── views/            # 12 feature views
├── lib/
│   ├── ai.ts             # LLM client, router, SQL gen, answer gen, streaming, schema enrichment
│   ├── intent-pipeline.ts # Intent analyzer + query rewriter + query expansion
│   ├── llm-client.ts     # Unified transport (OpenAI + Anthropic)
│   ├── tool-router.ts    # Dispatcher + agentic loop (split: tool-branches, stream-preparers, tool-utils)
│   ├── smart-router.ts   # Self-adjusting load balancer + semantic scoring
│   ├── planner.ts        # Multi-step agentic planner (parallelized executePlan)
│   ├── schema-enrichment.ts # LLM-generated table descriptions for IntegrationSchema
│   ├── plugin-registry.ts    # External webhook tool executor
│   ├── plugin-selector.ts    # Semantic plugin matching
│   ├── rag.ts            # Hybrid retrieval + retrieveWithReflection
│   ├── rag-fts.ts        # FTS5 (SQLite) / tsvector (Postgres) full-text search
│   ├── guardrails.ts     # SQL AST validation
│   ├── connectors.ts     # DB connector registry (Postgres/MySQL/MSSQL + demo)
│   ├── real-connectors.ts # Real DB connectors (pg/mysql2/mssql drivers)
│   ├── cognee.ts         # Memory + knowledge graph (recallKnowledgeGraph)
│   ├── errors.ts         # Typed error system (16 codes, AppError class)
│   ├── constants.ts      # Centralized magic numbers
│   ├── notifications.ts  # Webhook/email/Telegram
│   └── ...
├── middleware.ts         # Edge auth
prisma/
└── schema.prisma         # 25 models (incl. ScheduledRunLog)
mini-services/
└── scheduler/            # Cron worker (creates ScheduledRunLog per execution)
scripts/
├── seed.ts               # Full seed (users, ERP, docs, plugins, schedules)
├── seed-plugins.ts       # Plugin-only seed (9 prebuilt)
├── migrate-demo-to-postgres.ts # SQLite → Postgres data migration (66,435 rows)
└── long-turn-chat.ts     # 20-turn multi-database conversation test
docs/
└── postgres-migration.md # Postgres migration reference (complete)
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres URL (e.g. `postgresql://ryasai:ryasai_dev@localhost:5432/ryasai`) |
| `ENCRYPTION_SECRET_KEY` | Yes | 64-char random string for AES-256-GCM |
| `ADMIN_INITIAL_PASSWORD` | Yes | Initial admin password (change after first login) |
| `AUTH_DEMO_FALLBACK` | No | `false` by default (fail-closed) |
| `COGNEE_ENABLED` | No | `true` by default (graceful degradation when cognee unavailable) |
| `RAG_LLM_RERANK` | No | `true` to enable LLM reranker for RAG results |
| `CONTEXTUAL_RETRIEVAL` | No | `true` to prepend LLM-generated document context to chunks before embedding (-49% retrieval failures) |
| `LOG_LEVEL` | No | `debug`/`info`/`warn`/`error` (default `info`) |
| `LOG_RETENTION_DAYS` | No | Log retention period (default 90) |
| `PORT` | No | Dev server port (default 3000) |

## License

Proprietary. All rights reserved.
