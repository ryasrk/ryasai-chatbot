# Product

## Platform

web

## Users

Enterprise administrators in Indonesian companies who manage an AI assistant deployment. They connect data sources (SQL databases, REST APIs), upload knowledge documents, configure LLM providers, generate API keys for integration, and monitor usage. Their job is to keep the assistant accurate, secure, and useful for their organization.

## Product Purpose

A multi-source AI chatbot that answers questions by routing to the right tool — SQL queries, document RAG, REST API calls, external plugins, or general chat. It exists to give internal teams a single assistant that can access structured data, company documents, and external APIs without switching tools. Success means the admin can configure it once and trust it to answer accurately with guardrails.

## Positioning

Self-hosted, single-tenant, fail-closed enterprise AI assistant. Unlike SaaS chatbots, all data stays in the admin's infrastructure. SQL guardrails, AES-256-GCM encrypted credentials, and audit logging are built in, not add-ons.

## Operating Context

- Admin logs in, runs a setup wizard (admin account → LLM config → test model → upload docs → data sources → test chat)
- Daily work: manage integrations, upload documents, configure AI, manage API keys, monitor audit logs, use agentic console
- Language: Indonesian for all UI labels and system prompts
- Deployment: single instance, dedicated admin mode

## Capabilities

- Text-to-SQL with AST guardrails (SELECT only, LIMIT 100, no DML/DDL)
- Production RAG architecture:
  - Intent analyzer with progressive slot filling (asks ONE clarifying question at a time)
  - Contextual query rewriter (follow-ups → standalone search queries)
  - Query expansion (synonym + multilingual, max 3 expansions)
  - Multi-pass retrieval with reflection (evidence sufficiency check, 2x topK second pass)
  - GraphRAG (cognee knowledge graph recall in parallel with flat retrieval)
  - Agentic confidence loop (route → execute → evaluate → repeat, max 3 iterations, heuristic pre-check for obvious cases)
  - Streaming agentic loop (same loop, streams final answer to UI)
- Hybrid RAG (lexical + semantic + FTS + external vector store)
- Semantic scoring in smart router (40% keyword + 60% embedding similarity, cached, graceful fallback to keyword-only)
- Schema description enrichment (LLM-generated per-table descriptions, used as router/intent context)
- REST API connector with whitelisted endpoints
- OpenAI-compatible and Anthropic-native LLM providers
- Real SSE token streaming (chat + external API)
- API key generation with rate limiting for external integrations
- Audit logging for all security-relevant actions
- Multi-step agentic planner with self-correction (DAG execution, parallelized per dependency level)
- 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, StackOverflow, timezone, datetime) + custom webhook tools
- Cognee memory layer (optional, disabled by default)
- Scheduled runs (cron-based automation with notification delivery)
- Execution history + export (full per-run logs with answer/error/toolRuns/latency, JSON/CSV export, 15s polling + toast notifications)
- Chat persistence across menu switches (ChatView + AgenticView always mounted, SSE continues in background)
- Notification API (webhook + email + Telegram)
- LLM token usage tracking (per-purpose monitoring)
- Smart router (self-adjusting load balancer with circuit breaker)

## Brand Commitments

- Name: ryasai
- Voice: professional, direct, no jargon — admin is a low-level engineer who wants things simple but powerful
- Language: Indonesian for all user-facing strings
- Visual: clean, compact, no wasted space — admin doesn't want to scroll for important controls

## Evidence on Hand

- Full codebase (25 Prisma models, 67 API routes, 16 views, 62+ unit tests + 4 e2e)
- CLAUDE.md with architecture audit and progress log
- README.md with quick start and commands
- PostgreSQL 16 migration complete (5 demo databases: ERP, Chinook, World, Pagila, ClickHouse)
- `scripts/long-turn-chat.ts` — 20-turn multi-database test, 100% pass rate, 102.1s on Postgres
- Production status: tsc 0 errors, lint 0 errors, tests green (run per-file due to mock.module isolation)

## Product Principles

1. **Compact over spacious** — every pixel earns its place, admins scan fast
2. **Fail-closed by default** — missing config means refuse, not guess
3. **Indonesian first** — all UI and system prompts in Bahasa Indonesia
4. **Security is visible** — guardrails, audit, encryption are shown not hidden
5. **One admin, one deployment** — no multi-role UI complexity
6. **Production RAG architecture** — intent analysis, multi-pass retrieval with reflection, and agentic confidence loops are first-class, not bolted on
