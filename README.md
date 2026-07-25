# ryasai — Enterprise AI Assistant

Self-hosted, single-tenant AI assistant that answers questions by routing to the right tool: SQL queries, document RAG, REST API calls, external plugins, or general chat. Built for Indonesian enterprises that need data-grounded AI with security guardrails.

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
- **Database**: Prisma 6 + SQLite (Postgres-ready — see `docs/postgres-migration.md`)
- **Runtime**: Bun (dev/test) · Node standalone (prod build)
- **UI**: Tailwind 4 · shadcn/ui · 5 theme system
- **AI**: OpenAI-compatible + Anthropic-native LLM providers
- **Memory**: Cognee integration (optional, disabled by default)

## Features

### Core AI Pipeline
- **Smart Router**: Self-adjusting load balancer (schema + performance + latency + similarity + circuit breaker)
- **Text-to-SQL**: AST guardrails (SELECT only, LIMIT 100, no DML/DDL)
- **Hybrid RAG**: Lexical + semantic + FTS + external vector store (Qdrant/Milvus)
- **REST Connector**: Whitelisted endpoints with parameter schema
- **Streaming Chat**: Real SSE token streaming (not fake word-by-word)

### Super-App Capabilities
- **Agentic Planner**: Multi-step DAG execution with self-correction
- **Plugin Registry**: 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, StackOverflow search, timezone, datetime) + custom webhook tools
- **Cognee Memory**: Chat-turn remember/recall + knowledge graph cognify
- **Scheduler**: Cron-based automation with notification integration
- **Notification API**: Webhook + email + Telegram delivery

### Security
- AES-256-GCM encryption for all credentials
- Edge auth middleware (cookie-based session)
- SQL AST guardrails (mutation block, LIMIT cap)
- SSRF blocklist (RFC1918, link-local, CGNAT, ULA)
- API keys (hashed, prefix-based O(1) lookup, rate-limited)
- Audit logging for all security-relevant actions
- Fail-closed auth (no demo fallback by default)

### Observability
- LLM token usage tracking (per-purpose: router, sql, rag, rest, synthesis, chat)
- Tool run metrics (latency, success rate, circuit breaker)
- Monitoring dashboard (24h stats, failed requests, blocked SQL)
- Audit log (GUARDRAIL_BLOCK, SQL_EXECUTE, API_KEY_GENERATED, etc.)

## Architecture

```
User query
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Smart Router (self-adjusting)                      │
│  schema + performance + latency + similarity        │
│  → SQL | RAG | REST | CHAT | CONTEXTUAL_CHAT        │
└─────────────────────────────────────────────────────┘
   │
   ├─ Chat path (tool-router.ts)
   │   └─ Single tool: SQL / RAG / REST / CHAT
   │
   └─ Agentic path (planner.ts)
       ├─ planQuery → multi-step DAG
       ├─ executePlan → per-step tool execution
       │   ├─ Built-in tools (sql, rag, rest, chat)
       │   └─ Plugin tools (plugin:weather, plugin:web_search, ...)
       └─ synthesizeAnswer → combine step outputs
```

## Commands

```bash
bun run dev          # dev server on $PORT (3000 default)
bun run build        # standalone build → .next/standalone
bun run start        # prod standalone server
bun run test         # unit tests (194 pass, 8 skip, 0 fail)
bun run e2e          # Playwright (4 specs, mock LLM)
bun run lint         # eslint (0 errors)
bunx tsc --noEmit    # typecheck (0 errors)
bunx prisma db push  # apply schema to SQLite
bunx prisma generate # regenerate Prisma client
bash start.sh        # start Next.js + scheduler
bash reset.sh        # reset DB + re-seed
```

## Project Structure

```
src/
├── app/
│   ├── api/              # 60 API routes
│   ├── page.tsx          # Main SPA (16 views)
│   ├── layout.tsx        # Root layout (theme init)
│   ├── error.tsx         # Route-level error boundary
│   └── global-error.tsx  # Root error boundary
├── components/
│   ├── ui/               # shadcn/ui primitives
│   └── views/            # 16 feature views
├── lib/
│   ├── ai.ts             # LLM client, router, SQL gen, answer gen
│   ├── llm-client.ts     # Unified transport (OpenAI + Anthropic)
│   ├── tool-router.ts    # Single-tool execution (SQL/RAG/REST/CHAT)
│   ├── smart-router.ts   # Self-adjusting load balancer
│   ├── planner.ts        # Multi-step agentic planner
│   ├── plugin-registry.ts    # External webhook tool executor
│   ├── plugin-selector.ts    # Semantic plugin matching
│   ├── rag.ts            # Hybrid retrieval
│   ├── rag-fts.ts        # FTS5 full-text search
│   ├── guardrails.ts     # SQL AST validation
│   ├── connectors.ts     # DB connector registry
│   ├── cognee.ts         # Memory + knowledge graph
│   ├── notifications.ts  # Webhook/email/Telegram
│   └── ...
├── middleware.ts         # Edge auth
prisma/
└── schema.prisma         # 23 models
mini-services/
└── scheduler/            # Cron worker
scripts/
├── seed.ts               # Full seed (users, ERP, docs, plugins, schedules)
└── seed-plugins.ts       # Plugin-only seed (9 prebuilt)
docs/
└── postgres-migration.md # SQLite → Postgres guide
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLite path (`file:./db/custom.db`) or Postgres URL |
| `ENCRYPTION_SECRET_KEY` | Yes | 64-char random string for AES-256-GCM |
| `ADMIN_INITIAL_PASSWORD` | Yes | Initial admin password (change after first login) |
| `AUTH_DEMO_FALLBACK` | No | `false` by default (fail-closed) |
| `COGNEE_ENABLED` | No | `true` to enable memory layer |
| `PORT` | No | Dev server port (default 3000) |

## License

Proprietary. All rights reserved.
