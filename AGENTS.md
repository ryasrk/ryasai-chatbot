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
- `prisma/schema.prisma` — 26 models.
- `mini-services/scheduler/` — cron worker.

## Conventions

- English in all strings and comments.
- Server-only libs in `src/lib/` are never imported into client components.
- Every new lib file ships with a `*.test.ts`.
- Fail-closed auth: deny on error, never on absence.
- Single-tenant: no `companyId` field.

## Key Files

`ai.ts`, `tool-router.ts`, `rag.ts`, `guardrails.ts`, `intent-pipeline.ts`, `prisma/schema.prisma`
