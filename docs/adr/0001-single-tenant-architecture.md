# ADR 0001: Single-Tenant Architecture

> ## ⚠️ SUPERSEDED — DO NOT FOLLOW THE DECISION BELOW
>
> **Status:** ~~Accepted~~ **Superseded** (2026-07-31)
> **Original Date:** 2026-07-30
> **Superseded by:** the multi-tenant architecture spec — `docs/superpowers/specs/2026-07-31-multi-tenant-design.md`
>
> **What changed and when.** This ADR was accepted one day before the product changed direction. On 2026-07-31 the project upgraded from single-tenant to multi-tenant SaaS: an `Organization` tenant root was added and every data model gained an `organizationId`, scoped automatically by a Prisma client extension + `AsyncLocalStorage` (`src/lib/prisma-tenant.ts`). The "no `companyId` field on any model" and "queries are unscoped" statements below are therefore **false for the current code**.
>
> **Why this file is kept, not deleted.** It preserves the reasoning behind the original decision (regulated-industry data isolation, the row-level-isolation costs that were weighed). That history is why the current design deliberately isolates at the *row* level via an auto-injecting extension rather than relying on every developer remembering a filter — and why `tenant-route-guard.test.ts` statically enforces org-context entry on every route.
>
> **Current source of truth:** the code (`prisma/schema.prisma`, `src/lib/prisma-tenant.ts`) and `AGENTS.md` → "Multi-Tenancy". Multi-tenancy is **shipped**, not future work.

**Status (archived):** Accepted at the time
**Date (archived):** 2026-07-30

## Context

Enterprise customers in regulated industries (finance, government) require dedicated deployments with full data isolation. Multi-tenant SaaS introduces cross-tenant data leakage risk, noisy-neighbor performance issues, and complex query scoping (every query needs a `companyId` filter). The product is positioned as a self-hosted enterprise assistant, not a shared SaaS.

## Decision

Deploy as single-tenant. No `companyId` field on any model. Each customer gets a dedicated instance with isolated database, Redis, and LLM API keys. Queries are unscoped — all data in the instance belongs to one tenant.

## Consequences

- **Positive:** Simpler queries (no tenant filter on every Prisma call), zero cross-tenant leakage risk, dedicated resource performance, easier compliance posture.
- **Negative:** Limits market to enterprises willing to self-host. No multi-tenant SaaS revenue model. Each deployment needs its own infrastructure cost.

## Alternatives

- **Multi-tenant with row-level isolation:** Rejected — adds `companyId` to 26 models, every query needs scoping, Postgres RLS adds complexity, one bug = data leak.
- **Multi-tenant with schema-per-tenant:** Rejected — schema migration overhead across N schemas, connection pool pressure.
