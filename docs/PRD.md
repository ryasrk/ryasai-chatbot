# Product Requirements Document — ryasai Chatbot

> Version 0.4.0 · PostgreSQL backend · Single-tenant · Fail-closed
> Last updated 2026-07-27

---

## 1. Product Overview

**ryasai Chatbot** is a self-hosted, single-tenant enterprise AI assistant that answers natural-language questions by routing them to the right tool — SQL queries, document RAG, REST API calls, external plugins, or general chat. It gives internal teams a single assistant that can access structured data, company documents, and external APIs without switching tools.

### Who it's for

Enterprise administrators who manage an AI assistant deployment. They connect data sources (SQL databases, REST APIs), upload knowledge documents, configure LLM providers, generate API keys for integration, and monitor usage. Their goal is to keep the assistant accurate, secure, and useful for their organization.

### Problem it solves

Enterprises have data siloed across databases, documents, and APIs. Employees either switch between tools to answer one question, or ask an LLM that hallucinates without access to real data. ryasai unifies access behind one assistant that grounds answers in the company's actual data, with guardrails that prevent data loss or leakage.

### Positioning

| Attribute | ryasai | SaaS chatbots |
|-----------|--------|---------------|
| Hosting | Self-hosted, single instance | Vendor cloud |
| Data residency | All data stays in admin's infrastructure | Vendor-controlled |
| Multi-tenancy | Single-tenant (one deployment, one admin) | Multi-tenant SaaS |
| Security model | Fail-closed by default — missing config means refuse, not guess | Best-effort |
| Guardrails | SQL AST, SSRF blocklist, audit logging built in | Add-ons or absent |
| Credentials | AES-256-GCM encrypted at rest | Vendor-managed |

Unlike SaaS chatbots, all data stays in the admin's infrastructure. SQL guardrails, encrypted credentials, and audit logging are built in, not add-ons. The admin configures it once and trusts it to answer accurately with guardrails.

---

## 2. Goals & Non-Goals

### Goals

- **Single assistant, multiple data sources** — route natural-language questions to SQL, RAG, REST, plugins, or chat automatically
- **Grounded answers** — every answer traces to real data (DB rows, document chunks, API responses) with citations
- **Security by default** — fail-closed auth, SQL AST guardrails, SSRF blocklist, encrypted credentials, audit logging
- **Self-hostable** — runs on a single server with PostgreSQL + Bun/Node, no external vendor dependency for data
- **Observable** — every tool run logged with latency + status, every guardrail block audited at critical severity
- **Extensible** — plugin registry for custom webhook tools, scheduler for cron automation, OpenAI-compatible external API
- **Resilient** — graceful degradation when cognee, vector store, or embedding API is unavailable

### Non-Goals

- **Multi-tenant SaaS** — deliberately single-tenant, one admin per deployment (multi-tenant is a future roadmap item)
- **Free-form tool execution** — tools are whitelisted from a registry; the LLM cannot invent endpoints or SQL tables
- **No-code admin UI for non-engineers** — the admin is a low-level engineer who wants compact, direct controls
- **Mobile app** — web-only (responsive desktop)
- **Vendor LLM hosting** — uses the admin's own OpenAI-compatible or Anthropic-native endpoint; does not resell LLM access
- **Real-time streaming push for scheduler** — current scheduler uses 15s polling (SSE push is a future roadmap item)
- **Free-form SQL** — only SELECT with LIMIT 100, no DML/DDL, enforced by AST guardrails with no bypass

---

## 3. User Personas

### 3.1 Enterprise Admin

The primary user. A low-level engineer who deploys and maintains the assistant.

| | |
|---|---|
| **Goals** | Configure data sources, upload docs, manage AI config, monitor usage, keep the assistant accurate and secure |
| **Daily flow** | Log in → manage integrations → upload documents → configure LLM/embedding → manage API keys → monitor audit logs → use agentic console |
| **First run** | Setup wizard: admin account → LLM config → test model → upload docs → data sources → test chat |
| **Pain points** | Switching between tools to answer cross-source questions; unguarded LLMs that hallucinate; opaque vendor pricing |
| **Success criteria** | Configure once, trust it to answer accurately with guardrails visible |

### 3.2 Internal User

An employee who asks questions via the chat UI and gets answers grounded in company data.

| | |
|---|---|
| **Goals** | Get accurate answers to business questions without learning SQL or knowing which system holds the data |
| **Flow** | Open chat → type question → see streaming answer with citations + data source badge → ask follow-ups |
| **Pain points** | Don't know which database has the data; can't write SQL; LLMs that guess instead of checking real data |
| **Success criteria** | Asks "compare last month's sales with the SOP for returns" and gets a grounded answer citing both DB and document sources |

### 3.3 API Consumer

A developer or system that integrates programmatically via the OpenAI-compatible API.

| | |
|---|---|
| **Goals** | Embed the assistant into other applications, scripts, or pipelines using a standard API |
| **Flow** | Generate API key in UI → call `/v1/chat/completions` or `/v1/agent/run` → receive streaming or JSON response |
| **Pain points** | Vendor lock-in to non-standard APIs; rate limits that break batch jobs; opaque error responses |
| **Success criteria** | Drops in as an OpenAI-compatible endpoint, gets typed errors with hints, respects rate limits |

---

## 4. Functional Requirements

### 4.1 Chat & Routing

| Requirement | Description |
|-------------|-------------|
| Natural-language routing | Question → automatic routing to SQL / RAG / REST / CHAT / CONTEXTUAL_CHAT via smart router |
| Intent analysis | Determine whether retrieval is needed and whether clarification is needed; progressive slot filling (one question at a time) |
| Contextual query rewriting | Rewrites follow-up questions into standalone search queries using conversation history |
| Query expansion | Synonym + multilingual expansion (e.g. "leave" → "vacation", "cuti", "cuti tahunan", "time off"); max 3 expansions |
| Streaming responses | Real SSE token streaming with mid-stream error frames + 120s idle watchdog |
| Chat persistence across menu switches | ChatView + AgenticView always mounted with `hidden` class toggle; no remount/re-fetch on menu switch |

### 4.2 RAG (Retrieval-Augmented Generation)

| Requirement | Description |
|-------------|-------------|
| Hybrid retrieval | Lexical (keyword overlap + phrase hits) + semantic (cosine on embeddings) + FTS (BM25-style) + external vector store (Qdrant/Milvus) |
| Multi-pass retrieval with reflection | `retrieveWithReflection()` — expands query, retrieves all expansions in parallel, merges + dedupes, LLM evaluates evidence sufficiency, retries with 2x topK if insufficient |
| GraphRAG | Cognee `recallKnowledgeGraph` called in parallel with flat retrieval; graph context merged into results |
| Query-level cache | In-memory, 1min TTL, 200 entries; invalidated on document upload/delete; metrics exposed via `getRagCacheStats()` |
| LLM reranker | Opt-in (`RAG_LLM_RERANK=true`); retrieves 3x candidates, LLM ranks by relevance |
| Document chunking | Double-newline split + hard ceiling (1400 chars, 180 overlap); per-document cap (`maxPerDocument=2`) for diversity |
| Graceful degradation | Vector store down → lexical fallback; embedding API down → keyword-only; cognee down → flat RAG |

### 4.3 SQL Query

| Requirement | Description |
|-------------|-------------|
| Text-to-SQL | LLM generates SQL with schema description context, JSON output, temp=0 (deterministic) |
| AST guardrails | SELECT only, LIMIT 100 cap, no DML/DDL, no transaction control, no system procs, no comments, no statement chaining; `GUARDRAIL_BLOCK` audit at critical severity |
| Real DB connectors | Postgres (pg Pool), MySQL (mysql2 Pool), MSSQL (mssql ConnectionPool) — dynamic driver loading, 30s timeout |
| Schema reflection + caching | `IntegrationSchema` stores reflected table/column metadata; avoids re-reflection per query |
| Schema description enrichment | LLM-generated per-table description for richer SQL generation context |
| Per-integration concurrency limiter | 3 concurrent SQL executions max per integration (semaphore) |

### 4.4 Agentic Loop

| Requirement | Description |
|-------------|-------------|
| Confidence-based tool loop | `runAgenticLoop()` — route → execute → evaluate confidence → repeat (max 3 iterations) |
| Heuristic pre-check | Skips LLM confidence call for obvious cases (saves an LLM call) |
| Cross-source fallback | When confidence evaluator suggests `nextToolHint`, inject hint into next iteration |
| Streaming agentic loop | `runStreamingAgenticLoop()` — same loop but streams the final answer; wired into UI chat via `allowMultiStepDag: true` |
| Multi-step planner | `planQuery()` → multi-step JSON plan → `executePlan()` DAG runner (topological sort, Kahn's algorithm) → `synthesizeAnswer()` |
| Self-correction | On step error, LLM reformulates the question and retries once; falls back to error if retry fails |
| Plan validation | Every tool.id ∈ registry; no circular deps; max 6 steps (configurable) |

### 4.5 Smart Router

| Requirement | Description |
|-------------|-------------|
| Semantic scoring | 40% keyword overlap + 60% embedding similarity (cached 5min / 10s) |
| Performance scoring | Success rate from last 50 ToolRuns per type (24h window); self-adjusting — reads fresh history each call |
| Schema scoring (0.35 weight) | Keyword overlap between question and actual DB table/column names, REST endpoint paths, document names/categories |
| Latency scoring (0.15 weight) | `1 - min(avgLatency/5000, 1)` — faster tools score higher |
| Circuit breaker | If last 10 runs have >70% failure rate, tool score → 0; auto-recovers when failure rate drops |
| LLM tiebreaker | When top 2 scores are within 0.1, falls back to LLM router call to break the tie (saves an LLM call when heuristic is confident) |
| Integration selection | `pickBestIntegration()` — scores each integration by schema keyword match instead of "first by createdAt" |
| Routing scores visibility | `GET /api/routing/scores` — exposes current tool scores, performance metrics, circuit breaker status |

### 4.6 REST API

| Requirement | Description |
|-------------|-------------|
| Whitelisted endpoints | Only `RestApiEndpoint` rows with `isEnabled=true` are callable; LLM cannot invent paths |
| Parameter schema | Each endpoint has a parameter schema; LLM builds query/body from the schema |
| External API (OpenAI-compatible) | `/v1/chat/completions` — streaming + non-streaming, API-key auth, rate limits |
| API key auth | Hashed (`keyHash`), prefix-based O(1) lookup, rate-limited (per-minute + daily), revocable, audit-logged |
| Documentation snippets | curl / JS / Python examples in UI |
| Test panel | Request builder (method, URL, headers, params, body) + response viewer (status, latency, headers, pretty JSON) in UI |

### 4.7 Plugins

| Requirement | Description |
|-------------|-------------|
| Prebuilt plugins | 9: weather, Wikipedia, translate, calculator, news, StackOverflow, timezone, datetime, web search |
| Custom webhook tools | Zod-validated manifest; AES-256-GCM encrypted credentials; webhook executor with timeout + output cap |
| Semantic plugin selection | `selectRelevantPlugins()` — semantic relevance matching (minScore 0.01) |
| SSRF guard | `isBlockedHost()` blocks RFC1918, link-local, CGNAT, ULA on webhook URLs |
| HMAC signature | Webhook HMAC-SHA256 `X-Signature-256` header when `signatureSecret` configured |
| Plugin management UI | Table with tool ID, description, status, endpoint, method; create/edit dialog with manifest JSON; enable/disable toggle |

### 4.8 Scheduler

| Requirement | Description |
|-------------|-------------|
| Cron-based scheduled runs | 5-field cron parser (wildcard/ranges/lists/steps); independent Bun worker process polls every 60s |
| Execution history | `ScheduledRunLog` — full answer, error, tool runs JSON, latency, executedAt; cascade delete on ScheduledRun |
| History export | JSON (full data) + CSV (answer truncated to 500 chars) with `Content-Disposition: attachment` header |
| Real-time notification | 15s polling + toast (success/error) when a run completes; compares `lastRunAt` timestamps |
| Notification delivery | Webhook + email + Telegram; retry with exponential backoff (3 retries, 2s*2^n) |
| Atomic claim | Optimistic lock prevents double-execution on poll overlap; 60s execution timeout; parallel execution |

### 4.9 Memory (Cognee)

| Requirement | Description |
|-------------|-------------|
| Chat-turn remember/recall | `rememberChatTurn` (fire-and-forget) + `recallContext` (injected into router/SQL/answer prompts) |
| Knowledge graph cognify | Document upload → extract text → `cognee.add()` → `cognee.cognify()` (entities + relationships + pgvector embeddings) |
| Session-level semantic cache | Map per session, 1min TTL, 100 entries/session |
| Graceful degradation | All 8 cognee callsites wrapped in try-catch; cognee down → flat RAG, no crash |
| GDPR forget | `forgetAll()` / `forgetKnowledgeGraph()` for privacy deletion |
| Configurable | `COGNEE_ENABLED` env flag (default true); reuses tenant LLM config — no separate cognee env vars |

### 4.10 Security

| Requirement | Description |
|-------------|-------------|
| AES-256-GCM encryption | All integration configs, LLM keys, vector store keys, plugin credentials encrypted at rest; never log decrypted values |
| Session fixation defense | `sessionVersion` in User + cookie HMAC; incremented on login (invalidates all prior cookies); 30min inactivity timeout |
| SQL AST guardrails | Every LLM-generated SQL passes `validateAndSanitizeLlmSql` before execution; no exceptions, no bypass flag |
| SSRF blocklist | RFC1918, link-local (169.254.x.x), CGNAT, ULA blocked on webhook + REST test endpoints |
| Rate limiting | Edge middleware (POST/PUT/DELETE/PATCH only, per-route buckets, Edge-safe in-memory); API keys (per-minute + daily) |
| Audit logging | All security-relevant actions logged; fail-closed on critical severity; `GUARDRAIL_BLOCK` at critical |
| Fail-closed auth | `AUTH_DEMO_FALLBACK=false` by default; missing LLM key → `LlmNotConfiguredError`, never fallback to unbounded behavior |
| Env schema validation | Zod validation at app startup (prod-only, fail-closed) |
| API keys | Hashed, prefix-based O(1) lookup, rate-limited, revocable, audit-logged |
| Session cookies | `httpOnly`, `sameSite=lax`, `secure` in prod, signed |

### 4.11 Observability

| Requirement | Description |
|-------------|-------------|
| Structured JSON logger | Scoped + leveled, stdlib console (no Pino dep); wired into hot paths (rag, tool-router, ai, session) |
| Typed error responses | `{ error: { code, message, hint? } }` — 16 error codes via `AppError` class + `defaultStatusForCode()` |
| LLM token usage tracking | Per-purpose (router, sql, rag, rest, synthesis, chat); `LlmUsageLog` model; monitoring API + stat cards |
| Tool run metrics | Per tool: type/status/latency/input+output summary; circuit breaker reads last 50 runs |
| RAG cache metrics | `getRagCacheStats()` — hits, misses, hit rate |
| Monitoring dashboard | 24h stats, failed requests, blocked SQL, tool execution tracing |
| Log retention | Daily cleanup via scheduler, 90-day default (`LOG_RETENTION_DAYS`) |
| Health endpoints | `/api/v1/health` (liveness) + `/api/health` (DB + Redis connectivity checks) |

---

## 5. Non-Functional Requirements

### Performance

| Metric | Target | Current |
|--------|--------|---------|
| Avg response time per chat turn | < 8s | 5.1s (21% faster after optimizations) |
| Chat pass rate (20-turn multi-DB test) | — | 100% (18/20 success, 0 errors, 2 clarifications) |
| RAG query cache | 1min TTL | 200 entries, invalidated on doc changes |

### Reliability

| Requirement | Implementation |
|-------------|----------------|
| LLM retry | 3 retries, exponential backoff (500ms * 2^attempt) |
| LLM timeout | 30s (non-stream), 120s (stream idle watchdog) |
| Webhook retry | 3 retries, 2s * 2^n backoff |
| SQL concurrency | 3 concurrent max per integration (semaphore) |
| Graceful degradation | Cognee down → flat RAG; vector store down → lexical; embedding API down → keyword-only; no integrations → CHAT; no documents → CHAT |

### Security

- Fail-closed by default (no demo fallback)
- Encrypted at rest (AES-256-GCM)
- SQL AST guardrails (no bypass)
- SSRF blocklist (RFC1918, link-local, CGNAT, ULA)
- Rate limiting (Edge middleware + API keys)
- Audit logging (fail-closed on critical)

### Scalability

- PostgreSQL 16 + pgvector 0.6 + pg_trgm extensions
- Single-tenant (multi-tenant is a future roadmap item)
- Dynamic driver loading (app works without pg/mysql2/mssql installed; fails with clear error when that provider is used)

### Availability

| Dependency down | Fallback |
|-----------------|----------|
| Cognee | Flat RAG (no graph context) |
| Vector store (Qdrant/Milvus) | Lexical + FTS retrieval |
| Embedding API | Keyword-only scoring |
| LLM provider | `LlmNotConfiguredError` (fail-closed) |
| No integrations configured | CHAT branch |
| No documents uploaded | CHAT branch |

---

## 6. Technical Architecture

### Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19 · TypeScript 5 · Tailwind 4 · shadcn/ui · 5 theme system |
| Database | Prisma 6 + PostgreSQL 16 (pgvector + pg_trgm) |
| Runtime | Bun (dev/test) · Node standalone (prod build) |
| AI | OpenAI-compatible + Anthropic-native LLM providers (fail-closed) |
| Memory | Cognee (enabled by default, graceful degradation) |
| Background jobs | Mini-service scheduler (independent Bun process) |

### Architecture Diagram

```
                         ┌──────────────────────────┐
                         │  Admin / Internal User   │
                         │  (Web UI — 12 views)     │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │  Next.js Edge Middleware │
                         │  (auth + rate limiting)  │
                         └────────────┬─────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
   ┌──────────▼──────────┐ ┌──────────▼──────────┐ ┌──────────▼──────────┐
   │  Internal API       │ │  External API       │ │  Scheduler Worker   │
   │  (session auth)     │ │  (API key auth)     │ │  (cron, 60s poll)   │
   │  /api/chat (SSE)    │ │  /v1/chat/completions│ │  mini-services/     │
   │  /api/agent/*       │ │  /v1/agent/run      │ │  scheduler           │
   │  /api/schedules     │ │  /v1/health         │ │                     │
   └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
              │                       │                       │
              └───────────────────────┼───────────────────────┘
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           │                          │                          │
┌──────────▼──────────┐  ┌────────────▼───────────┐  ┌──────────▼──────────┐
│  Smart Router       │  │  Agentic Planner       │  │  Cognee Memory      │
│  (schema + perf +   │  │  (planQuery → DAG →    │  │  (remember/recall/  │
│  latency + circuit) │  │  executePlan → synth)  │  │  cognify/forget)    │
└──────────┬──────────┘  └────────────┬───────────┘  └─────────────────────┘
           │                          │
           └──────────────┬───────────┘
                          │
            ┌─────────────▼──────────────┐
            │  Tool Registry             │
            │  sql · rag · rest · chat   │
            │  plugin:* (9 prebuilt +    │
            │  custom webhooks)          │
            └─────────────┬──────────────┘
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
┌──▼──────────┐  ┌────────▼────────┐  ┌──────────▼──────────┐
│  RAG        │  │  SQL Connectors │  │  REST Connector     │
│  (hybrid:   │  │  (Postgres/     │  │  (whitelisted       │
│  lexical +  │  │  MySQL/MSSQL)   │  │  endpoints)         │
│  semantic + │  │  + AST guard    │  │                     │
│  FTS +      │  │  (SELECT only)  │  │                     │
│  vector)    │  │                 │  │                     │
└─────────────┘  └─────────────────┘  └─────────────────────┘
                          │
            ┌─────────────▼──────────────┐
            │  PostgreSQL 16             │
            │  (pgvector + pg_trgm)      │
            │  25 Prisma models          │
            └────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Intent pipeline before retrieval | Determine whether retrieval is needed + whether clarification is needed *before* spending an LLM call on retrieval |
| Agentic loop with heuristic pre-check | Skip the LLM confidence call for obvious cases — saves latency + tokens on clear-cut queries |
| Semantic + keyword blend in smart router | 40% keyword / 60% embedding similarity — keyword catches exact-match DB table names, embedding catches paraphrased intent |
| Fail-closed auth (no demo fallback) | Missing config means refuse, not guess — security over convenience |
| Whitelisted tools (never free-form) | The LLM proposes a tool *id* from a registry; it cannot invent endpoints or SQL tables |
| Streaming end-to-end | Status updates per step + token streaming for synthesis — user never waits blind |
| Deterministic where it matters | Routing and SQL gen at temp=0; creativity only in final synthesis |
| Cognee as outer ring (not replacement) | Graph retrieval runs in parallel with flat RAG; falls back to flat if cognee down — no single point of failure |
| Single-tenant (no companyId) | Simplified every query, function, route; multi-tenant is a future migration, not a premature abstraction |

---

## 7. Data Model Summary

25 Prisma models, PostgreSQL backend (pgvector + pg_trgm extensions).

| Model | Role |
|-------|------|
| `User` | Admin account (scrypt hash, sessionVersion for fixation defense) |
| `AppConfig` | Singleton config (setupCompleted, cogneeEnabled) |
| `Integration` | Data source connection (encrypted config, provider: POSTGRESQL/MYSQL/MSSQL) |
| `IntegrationSchema` | Reflected table/column metadata cache |
| `LlmConfig` | LLM provider config (encrypted key, OpenAI-compatible / Anthropic-native) |
| `VectorStoreConfig` | External vector store config (Qdrant/Milvus, encrypted key) |
| `Document` | Uploaded knowledge document (name, category, status) |
| `DocumentChunk` | Chunked content (content, keywords, embeddingJson, embeddingModel) |
| `ChatSession` | Chat conversation container |
| `ChatMessage` | Individual message (role, content, citations, chartData, toolType, toolHasResults) |
| `ToolRun` | Per-tool execution record (type, status, latency, input/output summary) |
| `RestApiConnector` | REST API connection container |
| `RestApiEndpoint` | Whitelisted endpoint (method, path, paramSchema, isEnabled) |
| `RestApiRequestLog` | REST call audit log |
| `ApiKey` | External API key (hashed, prefix-based lookup, rate limits) |
| `ApiRequestLog` | External API request log |
| `AuditLog` | Security event log (GUARDRAIL_BLOCK, SQL_EXECUTE, API_KEY_GENERATED, etc.) |
| `QueryHistory` | Past queries for similarity boosting in smart router |
| `SmartMapping` | Source → entity field maps for routing hints |
| `Plugin` | Custom webhook tool (manifest, encrypted credentials, isEnabled) |
| `McpServer` | MCP server config (future tool-using agent support) |
| `ScheduledRun` | Cron-based scheduled run (cronExpr, prompt, isActive, nextRunAt) |
| `ScheduledRunLog` | Execution history (status, answer, error, toolRunsJson, latencyMs, executedAt) |
| `NotificationConfig` | Notification delivery config (webhook + email + Telegram) |
| `AgentRun` | Agentic planner run record (plan, status, output) |
| `LlmUsageLog` | LLM token usage per purpose (router/sql/rag/rest/synthesis/chat) |

---

## 8. API Surface

### Internal API (session auth)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/chat/sessions` | Create chat session |
| GET | `/api/chat/sessions` | List sessions |
| POST | `/api/chat/send` | Send message (SSE streaming) |
| GET | `/api/integrations` | List data sources |
| POST | `/api/integrations` | Create integration |
| GET | `/api/integrations/[id]/schema` | Get reflected schema |
| POST | `/api/documents` | Upload document (triggers chunking + cognee cognify) |
| GET | `/api/documents` | List documents |
| GET | `/api/schedules` | List scheduled runs |
| POST | `/api/schedules` | Create scheduled run |
| GET | `/api/schedules/[id]/runs` | Execution history (last 50) |
| GET | `/api/schedules/[id]/runs/export` | Export history (JSON / CSV) |
| GET | `/api/tools` | List plugins |
| POST | `/api/tools` | Create plugin |
| GET | `/api/agent/dashboard` | Agentic console (SSE streaming) |
| GET | `/api/agent/dashboard/tools` | List agent tools (28 across 6 categories) |
| GET | `/api/routing/scores` | Smart router visibility (scores, circuit breaker) |
| GET | `/api/monitoring` | 24h monitoring stats |
| GET | `/api/audit` | Audit log |
| POST | `/api/auth/login` | Login (increments sessionVersion) |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/setup/admin` | Setup wizard — create admin |
| POST | `/api/llm-config` | Configure LLM provider |
| GET | `/api/settings/api-keys` | List API keys |

### External API (API key auth)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/chat/completions` | OpenAI-compatible chat (streaming + non-streaming) |
| POST | `/api/v1/agent/run` | Agentic multi-step run (plan → execute → synthesize) |
| GET | `/api/v1/health` | Liveness check |

### Health

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Detailed health (DB + Redis connectivity checks) |
| GET | `/api/v1/health` | Liveness (external API) |

---

## 9. Future Roadmap

| Item | Description |
|------|-------------|
| Multi-tenant support | Reintroduce `companyId` scoping for multi-tenant SaaS deployments |
| Real-time SSE push for scheduler | Replace 15s polling with persistent SSE connection from scheduler to UI |
| Email/webhook notification on schedule failure | Current notification config only sends on success; add failure delivery |
| Cognee production deployment | Single Postgres with pgvector + cognee Postgres graph backend (one container, one DB) |
| Streaming agentic loop for external API | `/v1/agent/run` currently non-streaming; add SSE streaming variant |
| More database connectors | MongoDB, Snowflake, Oracle (currently map to demo connector) |
| MCP server integration | Leverage `McpServer` model for tool-using agent support |
| Visual dashboard for routing scores | Surface smart router scores + circuit breaker status in UI (currently API-only) |
| ToolRun recording in scheduler | Scheduler currently creates ToolRun rows; verify all execution paths record metrics |

---

## 10. Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Chat pass rate (20-turn multi-database test) | 100% | 100% (18/20 success, 0 errors, 2 clarifications) |
| Avg response time per turn | < 8s | 5.1s |
| Test coverage | Growing | 73+ unit tests (8 skip on cognee-unavailable, 0 fail) |
| `tsc --noEmit` | 0 errors | 0 errors |
| `bun run lint` | 0 errors | 0 errors |
| Demo data migrated to Postgres | — | 66,435 rows (ERP 72, Chinook 14,926, World 5,298, Pagila 46,211) |
| Prisma models | — | 25 |
| API routes | — | 65 internal + external |
| UI views | — | 12 |
| Prebuilt plugins | — | 9 |
