# ADR 0001: Single-Tenant Architecture

**Status:** Accepted  
**Date:** 2026-07-30

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
