# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-07-31

### Security
- **CRITICAL: Middleware unblocks external API endpoints** — `/api/v1/chat/completions`, `/api/v1/agent/run`, `/api/webhooks/incoming` added to `PUBLIC_API_PATHS` (were blocked by cookie gate, making Bearer auth endpoints completely non-functional)
- **CRITICAL: REST executor SSRF protection at execution time** — `isBlockedHost` + `isBlockedHostAsync` (DNS-rebinding) check before every outbound REST fetch (`tool-branches.ts`)
- **CRITICAL: Plugin executor SSRF re-check at execution time** — `isBlockedHostAsync` added to `executePlugin` (was registration-time only)
- **CRITICAL: SQL injection in KG relation insert** — replaced raw `VALUES` string interpolation with parameterized per-relation `$executeRaw` (`knowledge-graph.ts`)
- **CRITICAL: pgvector HNSW index** — `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on `DocumentChunk.embedding` (every vector search was a full table scan)
- **HIGH: DNS-rebinding protection** — `isBlockedHostAsync()` via `dns.lookup(all: true)`, blocks if any resolved IP is private; added `metadata.google.internal`, `metadata.aws.internal`, `metadata.azure.com` to string blocklist
- **HIGH: CORS origin via env var** — `CHAT_API_CORS_ORIGIN` env var replaces hardcoded `*` on external chat API
- **HIGH: MCP confirmation gate** — agentic npx install requires `\b(confirm|yes|proceed)\b` in user message before spawning child process
- MCP: `AbortSignal.timeout()` on all SDK calls (connect 15s, listTools 10s, callTool 30s) — configurable via env vars
- MCP: `disconnectAllMcp` wired into graceful shutdown (was dead code — stdio children orphaned on SIGTERM)
- MCP: Env var wipe-on-edit bug fixed — dialog omits `envVars` key when blank on edit; PATCH only updates when key present AND non-empty
- MCP: `MCP_ERROR` thrown as `AppError` on test failure (was dead error code)
- MCP: `headersJson` field (AES-256-GCM encrypted) for SSE/HTTP auth headers
- MCP: `transport.onclose` handler set before `connect()` for proactive failure detection
- MCP: Test connections NOT cached (closed after listTools — was leaking stdio children)
- MCP: LRU cap on connection cache (default 20, `MCP_MAX_CONNECTIONS`)
- MCP: Single-flight dedup on tools-cache cold miss
- MCP: Non-text content blocks JSON-serialized (was silently dropped)
- MCP: Silent catch blocks now `console.warn`

### Fixed
- **CRITICAL: `_lastUsage` race condition** — replaced module-level singleton with `AsyncLocalStorage` + `withUsageTracking()` wrapper (concurrent requests were clobbering each other's token usage)
- **CRITICAL: Scheduler `throw e` bypassed all failure recording** — moved notification, `lastRunAt`, `ScheduledRunLog`, and `auditLog` BEFORE the throw (failed runs left zero trace)
- **CRITICAL: Scheduler `worker.close()` never called on SIGTERM** — hoisted worker to module scope, `shutdown()` now calls `await _worker.close()` before `connection.quit()` (in-flight jobs were killed mid-execution)
- **CRITICAL: OTel `initOtel()` never called** — wired into `instrumentation.ts` `register()` (SDK was pure scaffolding)
- **CRITICAL: Citation trails dropped in streaming path** — `StreamingCompletionResult` now has `citationTrail` field; `prepareRagStream` and all agentic streaming return paths propagate it
- **HIGH: `recallContext` unguarded** — cognee outage broke all chat; now `.catch(() => '')`
- **HIGH: Document worker never closed on shutdown** — `docWorker.close()` added to `cleanupFns`
- **HIGH: `jobQueue` had no `defaultJobOptions`** — added `attempts: 3, backoff: exponential 5s, removeOnComplete: 100, removeOnFail: 500` (jobs got zero retries, never auto-removed from Redis)
- **HIGH: Document worker `lockDuration` too short** — 30s default expired mid-embedding causing double processing; set to 300s + `stalledInterval: 30s`
- **HIGH: `chatStream` bypassed `fetchWithRetry`** — streaming LLM calls got zero retries on transient 5xx; now uses `fetchWithRetry`
- **HIGH: No aggregate timeout on agentic loop** — added `AGENTIC_DEADLINE_MS` (90s default) deadline check at each iteration
- **HIGH: Circuit breaker livelock** — added half-open recovery: after 5min cooldown (`CIRCUIT_BREAKER_COOLDOWN_MS`), tool gets 50% score for probe attempt; `PerfMetrics` gets `lastFailureAt` field
- Silent SSE chunk catches now log warnings instead of silently dropping

### Added
- Scheduler timezone support — `ScheduledRun.timezone` field + `tz` option in BullMQ repeat (`syncSchedule` accepts `timezone`)
- `withUsageTracking()` export from `llm-client.ts` — wraps async fn in isolated AsyncLocalStorage context
- `isBlockedHostAsync()` export from `llm-config.ts` — DNS-rebinding SSRF check via `dns.lookup`
- MCP env vars: `MCP_MAX_CONNECTIONS`, `MCP_CONNECT_TIMEOUT_MS`, `MCP_LIST_TOOLS_TIMEOUT_MS`, `MCP_CALL_TOOL_TIMEOUT_MS`
- `McpServer.headersJson` Prisma field (AES-256-GCM encrypted HTTP headers for SSE/HTTP transports)
- `CHAT_API_CORS_ORIGIN` env var for external API CORS
- `AGENTIC_DEADLINE_MS` env var for agentic loop wall-clock timeout
- `CIRCUIT_BREAKER_COOLDOWN_MS` env var for circuit breaker half-open recovery cooldown

### Changed
- `instrumentation.ts` — now calls `initOtel()`, captures `docWorker` return for graceful shutdown, includes `disconnectAllMcp` in cleanup
- `tool-router.ts` — `runNonStreamingChatCompletion` and `runStreamingChatCompletion` wrapped in `withUsageTracking()` for per-request usage isolation
- `StreamingCompletionResult` interface — added `usage` and `citationTrail` fields
- `PerfMetrics` interface — added `lastFailureAt` field
- MCP quick-connect transport detection: `/mcp` → http (was misclassifying as sse)
- `prisma db push --accept-data-loss` may drop the `tsv` column — re-create via `ALTER TABLE "DocumentChunk" ADD COLUMN tsv tsvector; CREATE INDEX "DocumentChunk_tsv_idx" ON "DocumentChunk" USING gin(tsv);`

## [0.4.0] - 2026-07-30

### Removed
- Dead/redundant shelfware: `rbac.ts`, `schedule-events.ts`, `redis-rate-limit.ts`, `rate-limit.ts`, `ollama-provider.ts`, `health-checks.ts` (+ tests). RBAC unwirable without touching 75 routes (single-tenant YAGNI). Ollama provider redundant — `embeddings.ts` already supports OLLAMA via DB config. Health checks redundant — `/api/health` + `/api/v1/health` routes already implement liveness+readiness inline. Rate limit libs unused — middleware has its own inline limiter. Schedule events emitter had no SSE consumer — UI polls every 15s.

### Added
- Contextual Retrieval (Anthropic technique): LLM-generated document summaries prepended to chunks before embedding (`CONTEXTUAL_RETRIEVAL` env var)
- LLM reranker scoring: 0-10 scoring approach replacing index-ranking, with score < 3 filtering
- Langfuse trace → score linkage: `traceLlmCall` returns traceId, `postLangfuseScore` links RAGAS metrics to traces
- OpenTelemetry instrumentation: `src/lib/otel.ts` with `getTracer()` and `withSpan()` helpers, lazy SDK init via `OTEL_ENABLED`
- Property-based tests for SQL guardrails using fast-check (8 properties)
- Graceful shutdown module: `src/lib/graceful-shutdown.ts` with SIGTERM/SIGINT handlers and cleanup timeout
- Scheduler failure notifications: failed scheduled runs now send webhook/Telegram notifications with error details
- Metadata support in LLM traces: `traceLlmCall` accepts `metadata` field, forwarded to Langfuse/Helicone
- CI: Semgrep static analysis job in GitHub Actions
- Helm chart with blue-green (Argo Rollouts) and canary (Flagger + Istio) deployment support
- Disaster recovery: automated backup, restore, and backup validation scripts
- OpenAPI specification (57KB) for external API integration
- SDK package for programmatic access
- Vision/multimodal LLM support (VLM)
- Responses API + structured output
- MCP client + native function calling + prompt caching
- OpenAI-compatible multi-agent API
- Real database connectors (Postgres, MySQL, MSSQL, ClickHouse)
- RAG benchmark suite (540 questions across 5 databases)
- Cron-based scheduler with notification channels (webhook, Telegram)
- SSRF blocklist for outbound webhook/plugin/MCP calls
- Audit logging with fail-closed behavior
- Log retention with automated cleanup

### Changed
- Reranker prompt: index-ranking → 0-10 scoring with parseRerankerScores
- Instrumentation hook: delegated OTel SDK init to `src/lib/otel.ts`
- Scheduler notification logic: sends on both success and failure (was success-only)
- CI workflow: added Semgrep scan job

### Fixed
- Dynamic integration detection: no hardcoded database names
- Routing context awareness + integration detection
- 5 critical chat flow bugs: chatbot queries actual data sources
- MCP filesystem default path + test error messages
- Seed-plugins double-run
- Streaming resilience for SSE token delivery
- Typed error responses for UI

### Security
- SQL guardrails: AST anti-injection, mutation blocking, LIMIT 100 cap, statement chaining prevention
- AES-256-GCM encryption for notification configs and credentials
- HMAC-SHA256 webhook signatures (X-Signature-256)
- Fail-closed auth: deny on error, never on absence (`AUTH_DEMO_FALLBACK=false` default)
- Environment schema validation at startup with Zod
- Security hardening: removed z-ai fallback, standardized English

## [0.3.0] - 2026-07-27

### Added
- Agentic MCP installer: fetch GitHub README, parse install instructions, set credentials via chat
- Maturity roadmap P0-P3: CI, security docs, file splits, Helm, VLM, SDK
- Enhanced scheduler with time picker, dashboard notifications, output view
- Plugin/MCP merge with toggle popup
- Auto-install MCP from URL in agentic chat + Quick Add by URL in Tools

### Changed
- Removed Browse MCP tab, consolidated into agentic view
- Dashboard redesign with security tests and auto re-cognify

### Fixed
- Mobile/portrait resolution Sheet trigger for agentic view
- MCP regex matching
- .env admin email configuration

## [0.2.0] - 2026-07-25

### Added
- Wave 2: Chat plugin wiring, Redis broker, seed fix
- Wave 1: Critical UI fixes, dashboard redesign, security tests, dedup
- Phase 5: OpenAPI spec, deployment guide, LICENSE, log retention, audit fail-closed
- Phase 4: OpenAI Multi-agent API + Programmatic Tool Calling
- Phase 3: Docker, observability, Postgres code adaptation
- Phase 2: Vision/multimodal, Responses API, structured output
- Phase 1: MCP client, native function calling, prompt caching

## [0.1.0] - 2026-06-24

### Added
- Initial project setup: Next.js 16, TypeScript 5, Prisma 6, Bun
- Core AI assistant with intent → router → tool pipeline
- RAG (hybrid: lexical + semantic + FTS + vector store)
- SQL guardrails and connector
- Chat session management
- Document upload and processing
