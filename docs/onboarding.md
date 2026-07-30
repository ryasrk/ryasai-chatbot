# Onboarding Guide

Goal: get a new developer productive in under 1 hour.

## Project Overview

ryasai is a self-hosted, single-tenant enterprise AI assistant. It routes natural-language questions to the right tool — SQL queries, document RAG, REST API calls, external plugins, or general chat — with security guardrails (AST-level SQL validation, AES-256-GCM credential encryption, fail-closed auth). Stack: Next.js 16 + TypeScript 5 + Prisma 6 + Postgres 16 + Bun.

## Dev Setup

```bash
git clone <repo> && cd Chatbot
bun install
cp .env.example .env          # fill in DATABASE_URL, ENCRYPTION_SECRET_KEY, ADMIN_INITIAL_PASSWORD
bunx prisma db push            # apply schema to Postgres
bunx prisma generate           # generate Prisma client
bun run scripts/seed.ts        # seed: admin user, ERP tables, documents, 9 plugins
bash start.sh                  # start Next.js + scheduler (or: bun run dev)
```

Default login: `admin@ryas.ai` / `admin12345`

## Codebase Tour

| Directory | What's here |
|-----------|-------------|
| `src/lib/` | Server-only libraries — the entire AI pipeline, security, RAG, tools |
| `src/app/api/` | 69 API routes (App Router) |
| `src/app/page.tsx` | Main SPA — 12 views, ChatView + AgenticView always mounted |
| `src/components/views/` | 12 feature views (Chat, RAG, Integrations, Scheduler, etc.) |
| `src/components/ui/` | shadcn/ui primitives |
| `prisma/schema.prisma` | 28 models — the entire data layer |
| `mini-services/scheduler/` | Cron worker (separate process) |
| `scripts/` | Seed, migration, and test scripts |

### Key Files (start here)

| File | What it does |
|------|--------------|
| `src/lib/ai.ts` | LLM client, router, SQL generation, answer synthesis, streaming |
| `src/lib/tool-router.ts` | Main dispatcher — routes to SQL/RAG/REST/Chat branches, runs agentic loop |
| `src/lib/intent-pipeline.ts` | Intent analyzer + query rewriter + query expansion |
| `src/lib/rag.ts` | Hybrid retrieval (lexical + semantic + FTS + GraphRAG) |
| `src/lib/guardrails.ts` | SQL AST validation (mutation block, LIMIT cap) |
| `src/lib/smart-router.ts` | Self-adjusting load balancer + semantic scoring |
| `src/lib/planner.ts` | Multi-step agentic planner (DAG, parallelized execution) |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for credentials |
| `src/lib/session.ts` | Fail-closed auth, session version, audit logging |
| `prisma/schema.prisma` | All 28 data models |

## Architecture

See the [Mermaid architecture diagrams in the README](../README.md#architecture) and the [ADRs](./adr/) for design decisions.

Request flow: User query → Intent Pipeline (parallel) → Smart Router → Tool branch (SQL/RAG/REST/Chat) or Agentic Loop (max 3 iterations) → Answer + citations.

## Testing

```bash
bun run test          # full suite (per-file subprocess runner, 8 concurrent)
bun test src/lib/guardrails.test.ts   # single file
bun run lint          # ESLint (must be 0 errors)
bunx tsc --noEmit     # typecheck (must be 0 errors)
bun run e2e           # Playwright (4 specs, mock LLM)
```

The test runner (`scripts/test.ts`) runs each test file in a separate Bun process for mock isolation (`mock.module` doesn't isolate across files in a single process). Concurrency is 8 by default (`CONCURRENCY=16 bun run test` to increase).

### Mock Patterns

Tests mock modules **before** importing the code under test:

```ts
import { mock, test, expect } from 'bun:test'

// Mock the DB before importing anything that uses it
mock.module('@/lib/db', () => ({
  db: {
    user: { findFirst: mock(async () => ({ id: 'u1' })) },
  },
}))

import { myFunction } from './my-module'

test('works with mocked db', async () => {
  expect(await myFunction()).toBe('u1')
})
```

For fetch mocks: assign to `global.fetch` and restore in `afterEach`:

```ts
const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

test('calls external API', async () => {
  const f = mock(async () => ({ ok: true, json: async () => ({ data: 1 }) }) as Response)
  global.fetch = f as unknown as typeof fetch
  // ...
})
```

## Common Tasks

### Add an API route

Create `src/app/api/<resource>/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export async function GET() {
  try {
    const user = await getActiveUser()  // fail-closed auth
    const items = await db.someModel.findMany()
    return NextResponse.json({ ok: true, items })
  } catch (e) {
    return handleApiError(e, 'Failed to load items.')
  }
}
```

For dynamic routes, use `interface RouteContext { params: Promise<{ id: string }> }` and `await ctx.params` (Next.js 16 async params).

### Add a tool

Register in `src/lib/tool-registry.ts` (or `plugin-registry.ts` for external webhook tools). Each tool has an executor function that receives `{ question, userId, integrationId }` and returns `{ answer, citations, toolRuns }`.

### Add a plugin

Follow the pattern in `scripts/seed-plugins.ts`. Plugins are webhook tools with a manifest (Zod-validated at registration). Create via `POST /api/tools` or seed script.

## ADRs

Architecture decisions are documented in [`docs/adr/`](./adr/). Read these to understand *why* the code is structured the way it is — especially:

- [ADR 0001: Single-tenant](./adr/0001-single-tenant-architecture.md) — no `companyId`
- [ADR 0002: SQL AST guardrails](./adr/0002-sql-ast-guardrails.md) — why regex isn't enough
- [ADR 0003: Fail-closed auth](./adr/0003-fail-closed-auth.md) — why onboarding is harder
- [ADR 0006: Agentic loop](./adr/0006-agentic-confidence-loop.md) — why max 3 iterations

## Glossary

See [`docs/glossary.md`](./glossary.md) for term definitions (RAG, GraphRAG, Agentic loop, AST guardrails, etc.).
