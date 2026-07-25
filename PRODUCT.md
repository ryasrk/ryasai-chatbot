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
- Hybrid RAG (lexical + semantic + FTS + external vector store)
- REST API connector with whitelisted endpoints
- OpenAI-compatible and Anthropic-native LLM providers
- Real SSE token streaming (chat + external API)
- API key generation with rate limiting for external integrations
- Audit logging for all security-relevant actions
- Multi-step agentic planner with self-correction (DAG execution)
- 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, StackOverflow, timezone, datetime) + custom webhook tools
- Cognee memory layer (optional, disabled by default)
- Scheduled runs (cron-based automation with notification delivery)
- Notification API (webhook + email + Telegram)
- LLM token usage tracking (per-purpose monitoring)
- Smart router (self-adjusting load balancer with circuit breaker)

## Brand Commitments

- Name: ryasai
- Voice: professional, direct, no jargon — admin is a low-level engineer who wants things simple but powerful
- Language: Indonesian for all user-facing strings
- Visual: clean, compact, no wasted space — admin doesn't want to scroll for important controls

## Evidence on Hand

- Full codebase (23 Prisma models, 60 API routes, 16 views, 194 unit tests + 4 e2e)
- CLAUDE.md with architecture audit and progress log
- README.md with quick start and commands
- docs/postgres-migration.md for scaling
- Production status: tsc 0 errors, lint 0 errors, 194 tests green

## Product Principles

1. **Compact over spacious** — every pixel earns its place, admins scan fast
2. **Fail-closed by default** — missing config means refuse, not guess
3. **Indonesian first** — all UI and system prompts in Bahasa Indonesia
4. **Security is visible** — guardrails, audit, encryption are shown not hidden
5. **One admin, one deployment** — no multi-role UI complexity
