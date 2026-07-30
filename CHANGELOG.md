# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
