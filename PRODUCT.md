# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Enterprise administrators in Indonesian companies who manage an AI assistant deployment. They connect data sources (SQL databases, REST APIs), upload knowledge documents, configure LLM providers, generate API keys for integration, and monitor usage. Their job is to keep the assistant accurate, secure, and useful for their organization.

## Product Purpose

A multi-source AI chatbot that answers questions by routing to the right tool — SQL queries, document RAG, REST API calls, or general chat. It exists to give internal teams a single assistant that can access structured data, company documents, and external APIs without switching tools. Success means the admin can configure it once and trust it to answer accurately with guardrails.

## Positioning

Self-hosted, multi-tenant, fail-closed enterprise AI assistant. Unlike SaaS chatbots, all data stays in the admin's infrastructure. SQL guardrails, AES-256-GCM encrypted credentials, and per-tenant isolation are built in, not add-ons.

## Operating Context

- Admin logs in, runs a setup wizard (admin account → LLM config → test model → upload docs → data sources → test chat)
- Daily work: manage integrations, upload documents, configure AI, manage API keys, monitor audit logs
- Language: Indonesian for all UI labels and system prompts
- Deployment: single instance per company, dedicated admin mode

## Capabilities and Constraints

- Text-to-SQL with AST guardrails (SELECT only, LIMIT 100, no DML/DDL)
- Hybrid RAG (lexical + semantic + FTS + external vector store)
- REST API connector with whitelisted endpoints
- OpenAI-compatible and Anthropic-compatible LLM providers
- API key generation with rate limiting for external integrations
- Audit logging for all security-relevant actions
- Streaming chat via Socket.io
- Multi-step agentic planner (super-app phase)
- Cognee memory layer (optional, disabled by default)
- Scheduled runs (cron-based automation)
- Plugin/tool registry (external webhook tools)

## Brand Commitments

- Name: ryasai
- Voice: professional, direct, no jargon — admin is a low-level engineer who wants things simple but powerful
- Language: Indonesian for all user-facing strings
- Visual: clean, compact, no wasted space — admin doesn't want to scroll for important controls

## Evidence on Hand

- Full codebase at /home/ryasr/ryasai/Chatbot
- CLAUDE.md with architecture audit and super-app roadmap
- Original spec: DOKUMEN SPESIFIKASI TEKNIS & PENGEMBANGAN SISTEM.docx
- Production status: 103 tests green, tsc + lint clean

## Product Principles

1. **Compact over spacious** — every pixel earns its place, admins scan fast
2. **Fail-closed by default** — missing config means refuse, not guess
3. **Indonesian first** — all UI and system prompts in Bahasa Indonesia
4. **Security is visible** — guardrails, audit, encryption are shown not hidden
5. **One admin, one deployment** — no multi-role UI complexity
