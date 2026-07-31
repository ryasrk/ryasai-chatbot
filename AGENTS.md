# AGENTS.md — ryasai Chatbot

## Project

Single-tenant enterprise AI assistant. Stack: Next.js 16 + TypeScript 5 + Prisma 6 + Postgres 16 + Bun.

## Commands

- `bun run lint` — ESLint
- `bunx tsc --noEmit` — typecheck
- `bun run test` — Bun test runner
- `bun run e2e` — Playwright end-to-end
- `bun run build` — production build

## Architecture

- `src/lib/` — server-only libraries (AI, RAG, guardrails, tools).
- `src/app/api/` — 68 routes.
- `src/components/views/` — 12 views.
- `prisma/schema.prisma` — 27 models (incl. `McpServer.headersJson`, `ScheduledRun.timezone`).
- `mini-services/scheduler/` — BullMQ worker (cron-based, timezone-aware).
- `src/lib/redis.ts` — BullMQ queues: `scheduleQueue` (scheduled-runs), `jobQueue` (document-processing).
- `src/lib/mcp-client.ts` — MCP client manager (timeouts, LRU, DNS-rebinding, encrypted headers).
- `src/instrumentation.ts` — boot: env validation, job worker, OTel init, graceful shutdown wiring.

## Conventions

- English in all strings and comments.
- Server-only libs in `src/lib/` are never imported into client components.
- Every new lib file ships with a `*.test.ts`.
- Fail-closed auth: deny on error, never on absence.
- Single-tenant: no `companyId` field.

## Key Files

`ai.ts`, `tool-router.ts`, `rag.ts`, `guardrails.ts`, `intent-pipeline.ts`, `prisma/schema.prisma`
