# ADR 0014: Per-Role Data Access Inside an Organization

**Status:** Accepted
**Date:** 2026-10-04

## Context

Tenant isolation (ADR 0009) answers "which organization". Inside one, every user could query every reflected table
and retrieve every document: a `viewer` could ask for the salary column, read it from the integration's sample row,
or retrieve an HR document. API keys already had a scope (integration and document ids); interactive roles had none.

## Decision

- **SQL.** `Integration.accessMode` is `open` (default — unchanged behaviour on upgrade) or `restricted`. In
  restricted mode `analyst` and `viewer` may query only the tables (and optionally columns) in `DataAccessPolicy`;
  an ungranted table is denied. `admin` is never restricted. Enforced twice in `sql-pipeline.ts`: the schema the
  generator sees is filtered (tables, columns and sample-row values), and `sql-ast-guard.ts` rejects any table or
  column outside the grant — including in `WHERE`, aggregates, CTE bodies and subqueries, because filtering on a
  column leaks it. `SELECT *` on a column-restricted table is rejected with a repair hint. A denial is audited as
  `ACCESS_DENIED` (critical).
- **Documents.** `Document.allowedRoles` (default: every role). The router narrows the existing `documentIds` scope at
  its two public entry points, so RAG, the SQL→documents fallback, speculative retrieval, the agentic loop and the
  graph recall all receive the narrowed scope through the parameter they already honour. The document list, detail,
  chunk viewer and search routes apply the same filter; a hidden document is reported as not found.
- **Role source.** Read from the user row (`access-scope.ts`), not threaded through every route. API-key and scheduled
  turns run as the org admin and stay bounded by the key's own scope. An unknown user resolves to `viewer`.
- **Admin surface.** `GET/PUT /api/integrations/[id]/access-policy` (admin-only, validated against the reflected
  schema, audited as `ACCESS_POLICY_UPDATE`); `PATCH /api/documents/[id] { allowedRoles }` (admin always kept).

## Consequences

- Integration detail and schema endpoints filter what a restricted non-admin sees, and omit the generated domain
  profile (it names tables and may quote sample values).
- The generated business context still reaches SQL generation for restricted roles; any table it names is denied by
  the AST guard, at the cost of a repair attempt.
- Chat memory (cognee session memory) is not role-filtered; it holds what was said in a session, not documents.
- The empty-scope convention is preserved: "nothing visible" is a sentinel id, never `[]` (which means unrestricted).
