# AGENTS.md — ryasai Chatbot

## Project

Multi-tenant SaaS AI assistant with license validation. Stack: Next.js 16 + TypeScript 5 + Prisma 6 + Postgres 16 + Bun.

## Commands

- `bun run lint` — ESLint
- `bunx tsc --noEmit` — typecheck
- `bun run test` — Bun test runner
- `bun run e2e` — Playwright end-to-end
- `bun run build` — production build

## Architecture

- `src/lib/` — server-only libraries (AI, RAG, guardrails, tools).
- `src/app/api/` — ~95 routes.
- `src/components/views/` — 12 views.
- `prisma/schema.prisma` — 30 models (incl. `Organization`, `Invitation`, `McpServer.headersJson`, `ScheduledRun.timezone`).
- `mini-services/scheduler/` — BullMQ worker (cron-based, timezone-aware).
- `src/lib/redis.ts` — BullMQ queues: `scheduleQueue` (scheduled-runs), `jobQueue` (document-processing).
- `src/lib/mcp-client.ts` — MCP client manager (timeouts, LRU, DNS-rebinding, encrypted headers).
- `src/instrumentation.ts` — boot: env validation, job worker, OTel init, graceful shutdown wiring.

## Conventions

- English in all strings and comments.
- Server-only libs in `src/lib/` are never imported into client components.
- Every new lib file ships with a `*.test.ts`.
- Fail-closed auth: deny on error, never on absence.
- Multi-tenant: every data model has `organizationId`. Prisma tenant extension auto-injects via AsyncLocalStorage. Use `bypassOrg()` for setup/SSO queries.

## Multi-Tenancy

- **Tenant root**: `Organization` model. `User.organizationId` links 1 user → 1 org.
- **License validation**: `LICENSE_VALIDATOR_URL` env. Signup validates license before creating org. `src/lib/license-client.ts`.
- **RBAC**: `admin > analyst > viewer`. `requireRole(user, 'admin')` guards admin routes.
- **Plan gating**: `starter | pro | enterprise`. `hasPlan(user.plan, 'pro')` gates premium features.
- **Session**: `getActiveUser()` sets org context via `enterWithOrg()`, checks license status.
- **Key files**: `src/lib/prisma-tenant.ts`, `src/lib/license-client.ts`, `src/lib/plan-gating.ts`.

## Key Files

`ai.ts`, `tool-router.ts`, `rag.ts`, `guardrails.ts`, `intent-pipeline.ts`, `prisma-tenant.ts`, `license-client.ts`, `plan-gating.ts`, `prisma/schema.prisma`
