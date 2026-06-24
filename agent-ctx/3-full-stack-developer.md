# Task 3 — full-stack-developer — Integrations API routes

## Scope
Build all REST API routes for the Integrations feature (spec §3.1, §3.2, §5.1, §4.3, §7, §8).

## Files created
All under `/home/z/my-project/src/app/api/integrations/`:

| File | Method(s) | Purpose |
| --- | --- | --- |
| `route.ts` | GET, POST | List integrations for active company / create new (encrypt config + test + reflect schema + audit) |
| `[id]/route.ts` | GET, PATCH, DELETE | Single detail with masked config + cached schema / toggle status / drop pool + delete |
| `[id]/test/route.ts` | POST | Re-test connection, update lastTestedAt/lastTestOk |
| `[id]/schema/route.ts` | GET | Return cached reflected schema (tables + columns + rowCount) |
| `[id]/query/route.ts` | POST | Text-to-SQL: generateSql → validateAndSanitizeLlmSql → executeQuery → QueryHistory + audit |

## Behaviour notes
- All handlers are server-only route handlers (no `'use client'`).
- Use `getActiveUser()` from `@/lib/session` for company + user context.
- Company scoping: every `findFirst` filters on `{ id, companyId: user.companyId }` so cross-tenant reads/edits are impossible.
- POST create calls `connectorRegistry.getConnector()` + `testConnection()` + `fetchSchema()` and caches rows into `IntegrationSchema` via `createMany` (after a defensive `deleteMany` for idempotency on re-create flows).
- POST query pipeline:
  1. Convert cached `IntegrationSchema` rows → `ReflectedTable[]` (parse `columns` JSON).
  2. `describeSchema()` to build compact prompt.
  3. `generateSql({ question, schemaDescription, provider })`.
  4. `validateAndSanitizeLlmSql()` — on failure: `GUARDRAIL_BLOCK` audit (severity `critical`), HTTP 403, body `{ ok:false, reason, generatedSql }`.
  5. On pass: `connector.executeQuery(sanitizedSql)`, persist `QueryHistory` (success flag + rowCount + executionMs), `SQL_EXECUTE` audit (info), return `{ ok:true, sql, explanation, rows, rowCount, executionMs }`.
- Errors wrapped in try/catch with Bahasa Indonesia graceful messages per spec §8.
- DELETE calls `connectorRegistry.drop(id)` BEFORE the DB delete to release the pooled connector.

## Lint
`bun run lint` → 0 errors.

## Smoke tests (curl, dev server running on :3000)
All 8 operations pass against the seeded integration `int-erp-001`:
- GET list → 200, `tableCount:8`
- POST create (POSTGRESQL provider) → 201, schema reflected (8 tables)
- GET detail → 200, masked password `P@••••••26`, 8 tables with parsed columns
- PATCH `{status:inactive}` → 200, status updated
- DELETE → 200, `{ deleted:true }`
- POST test → 200, `{ ok:true, tablesCount:8 }`
- GET schema → 200, 8 tables
- POST query `"Tampilkan 5 produk dengan harga tertinggi"` → 200, SQL `SELECT * FROM demo_products ORDER BY unit_price DESC LIMIT 5;`, 5 rows, 1ms

## Notes for downstream agents
- The frontend Integrations page can call these routes directly with relative paths.
- For streaming chat (spec §5.2), reuse `generateSql` + `streamAnswer` from `@/lib/ai` in the socket.io mini-service.
- `QueryHistory` rows are now being written — a future Analytics dashboard can aggregate them.
