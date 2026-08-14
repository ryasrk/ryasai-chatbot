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

## Key Updates (v0.4.0)

**Multi-Tenant Architecture:**
- Org isolation via AsyncLocalStorage + Prisma extension
- Every query auto-filtered by organizationId
- getActiveUser() required on all routes
- Role-based access (admin, analyst, viewer)

**RAG Improvements:**
- Fixed critical bug: retrieval was either/or, now both + KG run together
- BM25 + RRF fusion: consensus ranking, no hand-tuned weights
- Eval framework: recall@k, precision@k, MRR, grounded rate
- Golden test set: 25 real-world questions ready

See ARCHITECTURE.md and MULTI-TENANT-GUIDE.md for details.

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
bun run test             # 1392+ unit tests
bun run e2e              # Playwright
bun run lint             # eslint
bunx tsc --noEmit        # typecheck
bash start.sh            # Next.js + scheduler
bash reset.sh            # reset DB + reseed
```

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
| `COGNEE_ENABLED` | No | true (default) |
| `RAG_LLM_RERANK` | No | true (optional) |
| `CONTEXTUAL_RETRIEVAL` | No | true (optional, -49% failures) |
| `LOG_LEVEL` | No | debug/info/warn/error |
| `PORT` | No | 3000 (default) |

See `.env.example` for auth (OIDC, SAML), observability, and advanced options.

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Full system design, RAG pipeline, multi-tenant isolation, performance
- **[MULTI-TENANT-GUIDE.md](./MULTI-TENANT-GUIDE.md)** — Org scoping guide, code examples, pitfalls
- **[docs/postgres-migration.md](./docs/postgres-migration.md)** — Postgres setup

## Production Readiness

- ✅ Multi-tenant isolation (AsyncLocalStorage + Prisma)
- ✅ Authentication + RBAC (admin, analyst, viewer)
- ✅ BM25 + RRF (fixed: was never hybrid)
- ✅ Eval framework with golden test set
- ✅ 1392+ unit tests
- ✅ Error handling + graceful fallbacks
- ⏳ Load testing recommended
- ⏳ Monitoring + alerting setup

## License

Proprietary. All rights reserved.
