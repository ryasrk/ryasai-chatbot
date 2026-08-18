# AGENTS.md — ryasai Chatbot

## Project

Multi-tenant SaaS AI assistant (NL → SQL, RAG, REST, streaming chat) with license validation. Stack: Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui. Proprietary.

> `CLAUDE.md` is a large living log (1000+ lines) of session history — trust it for *why* decisions were made, but verify current state against the code. An earlier "single-tenant refactor" mentioned in its progress log was reverted; the codebase is multi-tenant. `docs/adr/0001-single-tenant-architecture.md` and the helm chart description are likewise stale — the code (org-scoped models, tenant extension) is the source of truth.

## ⛔ Non-negotiable invariants (read before touching these areas)

`src/lib/invariants.test.ts` statically enforces the rules below, and CI runs
it on every push. These encode real production incidents — including incidents
introduced by AI-assisted changes. **If a guard fails your change, do not
delete or weaken the guard**; read the comment block above the failing
assertion (it documents the outage) and restructure your change.

1. **One boot file**: `src/instrumentation.ts` is the ONLY instrumentation
   file, and it MUST call `startJobWorker()`. Never create a root
   `instrumentation.ts` — Next.js resolves it FIRST and silently shadows
   `src/`, which once left the BullMQ worker dead for 16+ hours while 40
   document jobs piled up unprocessed (docs uploaded but never embedded →
   "chatbot doesn't know my documents").
2. **cognee searchTypes**: only literal names from the SDK's own
   `SearchTypeString` union (`node_modules/@cognee/cognee-ts/lib/types.d.ts`).
   `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` came from *Python* cognee docs and
   were never valid in the TS SDK. When upgrading `@cognee/cognee-ts`, the
   guard re-reads the union — fix any renamed literal THERE, not by deleting
   the guard.
3. **DB drivers load through the static `DRIVER_LOADERS` map** in
   `real-connectors.ts` — `async () => import('pg')` literals, never
   `await import(variable)`. A variable specifier is invisible to Turbopack
   (breaks dev) and to output tracing (drivers silently vanish from the
   standalone Docker image → "driver not installed" in production only).
   Adding a driver = one map entry + `serverExternalPackages` +
   `outputFileTracingIncludes` in `next.config.ts` (all three, guarded).
4. **PDF/DOCX/XLSX extraction must stay lossless-or-empty**: `document-parsers.ts`
   never "falls back" to dumping printable ASCII from raw bytes — that noise
   gets chunked, embedded, and served as knowledge. Image-only PDFs return `''`
   so the doc is marked a placeholder. Behavioral tests live in
   `document-parsers.test.ts` (FlateDecode, `<hex>` strings, multi-stream
   `endstream` resumption, noise-free empty) — extend them when touching the
   parser.

**Verification ritual after touching any of the above**: `bun test src/lib/invariants.test.ts`
plus the area's own test file. For ingestion changes, upload a REAL PDF
(`test-data/coates.2025.book.1996.pdf`, 2.7MB) through `POST /api/documents`
and confirm: chunkCount > 100, embeddings written (`DocumentChunk.embeddingJson`
non-null), `Document.cognifyStatus = 'completed'`, then ask the chatbot a
question only the document can answer and check for citations.

## Commands

```bash
bun install              # deps (uses bun.lock)
bun run dev              # dev server on $PORT (default 3000), sources ./.env
bun run build            # standalone build → .next/standalone
bun run start            # prod standalone server (Bun runtime)
bun run lint             # eslint (0 errors expected; warnings are pre-existing)
bunx tsc --noEmit        # typecheck (0 errors expected)
bun run test             # unit tests — custom per-file runner (see below)
bun run test:integration # integration tests (need live Postgres / network)
bun run e2e              # Playwright (5 specs / 8 tests — Postgres e2e DB, mock LLM + mock license validator)
bun run rag-eval         # RAGAS RAG quality eval (LLM-as-judge)
bun run sql-eval         # Text-to-SQL eval — needs EVAL_ORG_ID + --integration <id>
bash start.sh            # Next.js + scheduler worker (seeds empty DB if empty)
e2e prerequisites: Postgres DB `ryasai_e2e` (created once: sudo -u postgres createdb -O ryasai ryasai_e2e && CREATE EXTENSION vector) + `bunx playwright install chromium`
bash reset.sh            # DROP SCHEMA → recreate → prisma db push → seed (empty)
bun run prepare          # install pre-commit hook (.git/hooks/pre-commit)
```

### Testing quirks (important)

- `bun run test` runs `scripts/test.ts`, NOT `bun test src/`. Bun's `mock.module` leaks state across test files in a single process, so each `*.test.ts` gets its own `bun test` subprocess (8-way parallel). Do not switch to `bun test src/` — it will fail with stale-mock errors.
- Run a single test file: `bun test src/lib/guardrails.test.ts`
- Tests inject a fallback `ENCRYPTION_SECRET_KEY` if unset, so they run on a fresh checkout without `.env`.
- Integration tests (`*.integration.test.ts` + `connector-dummy.test.ts`) need a live Postgres (some require seeded demo content — run via `bun run test:integration`).
- `src/lib/cognee.e2e.test.ts` is skipped unless `RUN_COGNEE_E2E=true` (needs a live cognee backend).
- e2e mock stack: `e2e/global-setup.ts` seeds the e2e DB, starts a mock License-Validator on `:4546` (Ed25519 test keypair from `e2e-keys.ts` → `LICENSE_SIGNING_PUBLIC_KEY`) and a mock LLM on `:4545`; the app runs on `:3105` with `E2E_DATABASE_URL`. Playwright `workers: 1` (shared DB).
- `src/lib/tenant-route-guard.test.ts` statically enforces org-context entry on every route — if it fails for a new route, add `enterWithOrg((await getActiveUser()).organizationId)` (or `bypassOrg` if genuinely cross-org).
- 102 test files across `src/`. Every new lib file should ship with a `*.test.ts`.

### Pre-commit hook

`scripts/pre-commit.sh` runs `bunx tsc --noEmit --incremental` then `bun run lint -- --quiet`. It blocks on errors only (warnings pass). Installed by `bun run prepare` (also runs on `bun install` via the `prepare` script).

### CI gotchas

- CI (`ci.yml`) runs `rm -rf node_modules/.prisma && bunx prisma generate` before typecheck — a cache-restored stale Prisma client makes every Prisma type resolve to `{}` and tsc emits ~130 errors. If tsc suddenly fails en masse locally, delete `node_modules/.prisma` and regenerate.
- The e2e job pins `ENCRYPTION_SECRET_KEY` and uses a `pgvector/pgvector:pg16` service container; the app build itself is validated separately by `build-images.yml`.

## Architecture

- `src/app/api/` — 93 REST routes (session auth via `getActiveUser()`, external API key auth via `requireExternalApiKey()`).
- `src/components/views/` — feature views registered in `src/lib/view-routing.ts` (`VIEW_KEYS`): dashboard, chat, integrations, knowledge, ai-config, prompt-tools, integration-api, security, agentic, plugins, schedules, settings. Plus sub-components (topbar, chat cards, dialogs).
- `src/lib/` — server-only libraries. Never import `db`, `crypto`, `config`, or `session` into client components (they touch secrets).
- `mini-services/scheduler/` — separate Bun process, BullMQ worker (repeatable jobs, no manual polling). Imports parent libs via relative paths. Disables cognee (file-lock conflict with dev server). Requires Redis.
- `prisma/schema.prisma` — 30 models. Every model except `Organization` and `Invitation` carries `organizationId`.
- `src/instrumentation.ts` — Next.js server boot (the ONLY instrumentation file — see invariants): env validation, BullMQ job worker (`startJobWorker()` — document embed/cognify jobs die in Redis without it), OTel init, plugin auto-heal, license revalidation, graceful shutdown. OTel init itself is in `src/lib/otel.ts` (optional, `OTEL_ENABLED=true`).
- `src/lib/db.ts` — Prisma client + tenant extension. Singleton cached on `globalThis` in non-prod.
- `src/lib/redis.ts` — two connections: `redis` for BullMQ (`maxRetriesPerRequest: null`, blocks/retries forever) and `cmd` (fails fast, used by `rateLimit()` / `checkRedisHealth()` so callers fall back to DB-based limiting). `jobQueue` = single `document-processing` queue, `type` field dispatches.
- `src/lib/scheduler-queue.ts` — `scheduleQueue` (BullMQ repeatable jobs). `syncSchedule()` bridges `ScheduledRun` DB row → BullMQ repeatable job. Removing a repeatable job requires exact `pattern` + `tz` match (BullMQ hashes the key from these; look up the stored job first or removal silently no-ops).
- MCP: `src/app/api/mcp/servers/` CRUD + `src/lib/mcp-client.ts` (stdio/SSE transports) + `src/lib/mcp-install.ts`. stdio server commands are restricted to `ALLOWED_MCP_CMDS` (`npx|bunx|uvx|node|python`) in `admin-tools.ts`; the prod Docker image ships node + uv + python3 for exactly this reason.
- `sdk/` — `@ryasai/chatbot-sdk`, a tiny standalone package (no build step, `main: index.ts`) for building webhook plugin tools. Not part of the app build.

### AI/RAG pipeline entrypoints

- `src/lib/tool-router.ts` — dispatcher: `runNonStreamingChatCompletion`, `runStreamingChatCompletion`, agentic loops (`runAgenticLoop`, `runStreamingAgenticLoop`).
- `src/lib/tool-branches.ts` — non-streaming branch executors (SQL/RAG/REST/CHAT/Plugin).
- `src/lib/stream-preparers.ts` — streaming branch preparers.
- `src/lib/tool-utils.ts` — shared types + leaf utilities (SQL semaphore, chart/citation helpers).
- `src/lib/rag.ts` — hybrid retrieval (vector + lexical + knowledge graph, RRF fusion).
- `src/lib/vector-stores.ts` — external vector store abstraction: **Qdrant, Milvus, Pinecone, Chroma** (+ internal pgvector fallback). Per-provider auth headers matter: Pinecone uses `Api-Key`, Chroma uses `X-Chroma-Token`, Qdrant/Milvus use Bearer. Pinecone is never auto-created (control-plane op) — `ensure` describes the index and errors with guidance if missing. Chroma metadata must be null-free (upsert strips nulls). `resetEnsuredCollections()` is the test seam.
- **LLM streaming fallback** (`iterSseStream` in `llm-client-utils.ts`): a provider that ignores `stream:true` and returns a plain JSON body is handled — the body is yielded whole and the OpenAI chunk parser accepts `message.content` as well as `delta.content`. Without this the chat UI rendered a silent EMPTY answer with success citations. Keep both shapes covered (`llm-client-stream-fallback.test.ts`).
- `src/lib/source-init.ts` — LLM "first scan" on source add: documents (auto description when uploader gave none) and REST endpoints (auto description from method/path/sample). Fire-and-forget, no-op without an LLM. Table descriptions for DBs come from `schema-enrichment.ts`. All three flow into the intent router; **table descriptions also render into the Text-to-SQL prompt via `describeSchema()`'s `description` field — keep that wired** (it was silently dropped once).
- **RAG quality defaults** (all verified): rerank ON by default (`RAG_LLM_RERANK=false` to opt out), structure-aware chunking (`splitStructuralBlocks` in `rag-chunking.ts` — headings/tables become chunk boundaries), bilingual diff-query decomposition (`DIFF_PATTERNS` in `hyde.ts` — `selisih X dan Y`, `perbedaan…dengan`, `X dibanding Y`), corpus-level BM25 IDF refreshed by FTS rebuild via `ts_stat` in `rag-fts.ts`. KG entity extraction at ingest runs bounded (`mapWithConcurrency(…, 5)` in the documents POST route) — never reintroduce bare `Promise.all` over chunks.
- **RAG evaluation**: `bun run benchmark/golden-set.ts --org=<id> --out=…` generates a per-org bilingual golden set (extractive layer needs no LLM; `--llm` adds paraphrases). `bun run rag-eval --golden=<file>` runs RAGAS metrics; set `RAGAS_JUDGE_BASE_URL/_KEY/_MODEL` to a **different** model than the generator or the run is flagged self-judged. The built-in 8 questions are a smoke set only.
- `src/lib/smart-router.ts` — self-adjusting tool router (schema + performance + latency scoring, circuit breaker, LLM tiebreaker).
- `src/lib/intent-pipeline.ts` — intent analysis, query rewriting, expansion, reflection, confidence.
- `src/lib/planner.ts` — multi-step DAG planner (`planQuery`, `topoSort`, `executePlan`, `synthesizeAnswer`).
- `src/lib/guardrails.ts` — SQL validation (rejects DML/DDL, forces `LIMIT 100`, single-statement). Hand-rolled tokenizer + scanner, NOT a real SQL parser — see "LLM → Database safety" below for the full picture.
- `src/lib/connectors.ts` + `src/lib/real-connectors.ts` — DB connector registry (Postgres/MySQL/MSSQL/ClickHouse via the STATIC `DRIVER_LOADERS` map — never a variable-specifier `import()`; see invariants #3).
- `src/lib/cognee.ts` — barrel over `cognee-core.ts` (settings/client cache), `cognee-memory.ts` (chat memory), `cognee-knowledge-graph.ts` (cognify/graph recall/forget). No-op unless the per-org Settings toggle is on (`COGNEE_ENABLED=false` is only a process-wide kill switch); reuses the tenant's LLM config. Datasets are per-org (`org:<id>`, `org:<id>:kb`). Recall strategies use `SUMMARIES` → `CHUNKS` → `NATURAL_LANGUAGE` and guard missing datasets via `c.datasets.has()` (see invariants #2).

### Chat session context & memory (why the bot can feel "confused" mid-session)

- **History window**: `send/route.ts` fetches the last **10 messages** (`take: 10`); every downstream consumer truncates again — final-answer prompts `history.slice(-10)` with a 2000-char/message cap (`historyToMessages` in `ai.ts`), the LLM router `slice(-8)` at 400 chars, intent/rewrite `slice(-6)`.
- History reaches the LLM as **native alternating user/assistant turns** (`historyToMessages` — exported, tested) preceded by a short system label. Do NOT flatten history back into one system message — that change caused weak follow-up grounding. `generateSql()` still gets no history; follow-up resolution for SQL depends on `rewriteQuery`.
- **Rolling summary**: messages that fall out of the 10-message window are folded into `ChatSession.summary` (LLM-generated, merged with the previous summary) by `maybeUpdateSessionSummary` in the send route; injected into every turn as a `[Earlier in this session...]` system prefix. `summaryUpTo` tracks the fold watermark.
- **Session wrapper stripping**: the send route wraps user text with `[Session started: …] [Current time: …]`. Downstream string/semantic consumers must `stripSessionWrapper()` (tool-utils) first — recall, rewrite, and memory writes already do. The contextualized version still goes to SQL/answer prompts (temporal resolution).
- **Cognee memory writes on BOTH paths**: `rememberChatTurn` in `_runNonStreamingChatCompletion` AND in the send route (fire-and-forget). Memory is per-**org** (dataset `org:<id>`), recall `.catch(() => '')` — silent no-op when cognee is down.
- **Session titles**: `generateSessionTitle` (LLM, 3-6 words, same language, `purpose: 'title'`) on first turn; falls back to `text.slice(0, 60)`. Retitle check accepts BOTH `"New Session"` and `"Sesi Baru"` — the schema default and the API default differ.
- History timestamps include the full date (multi-day sessions).
- Error AI rows (`status: 'error'`) are excluded from the summary fold but still enter the live history window.
- **Prompts are load-bearing code**: `INTENT_SYSTEM_PROMPT` once shipped with literal `' +` / `\n' +` string-concat artifacts (from a pasted template) sent verbatim to the LLM, degrading every follow-up intent decision. Prompt-artifact guards exist in `intent-pipeline.test.ts` and `ai.test.ts` — when editing ANY LLM prompt, keep those tests green and artifact-free.

### Text-to-SQL prompt conventions

- The single SQL-generation prompt lives inline in `generateSql()` (`src/lib/ai.ts`). Rules 13–16 encode hard-won behavior — do not drop them when restructuring:
  - String search must be **case-insensitive per dialect**: PostgreSQL `ILIKE '%x%'` (or `LOWER()`), MySQL/MSSQL `LOWER(col) LIKE`, ClickHouse `positionCaseInsensitive(col, 'x') > 0`. Bare `=` or case-sensitive `LIKE` misses real user data.
  - `%`/`_` inside a search term need an explicit `ESCAPE` clause; never strip user wildcards silently.
  - `IS NULL` / `COALESCE`, never `= NULL`; LIKE on a NULL column returns NULL.
  - Substring match for "contains / menyebut / terkait / tentang"; exact case-insensitive equality for "exactly / persis".
- **SQL error-correction loop** (`SQL_REPAIR_ATTEMPTS=2` in `constants.ts`): both `runSqlBranch` (non-streaming) and `prepareSqlStream` regenerate SQL with the DB error fed back as `repairFeedback` when execution fails or the guardrail rejects. Terminal failure status is `error` (not `blocked` — that's rate-limit only). Guard tests: `tool-router.test.ts` ("persistent guardrail rejection…", "guardrail rejection recovers…").
- **Empty-result & truncation honesty**: callers pass `rowCount`/`truncated` to `generateAnswer`/`streamAnswer`; the synthesis prompt then instructs the model to state "no matching data" plainly (no invented explanations) or disclose "showing the first N rows" when `rowCount >= SQL_MAX_LIMIT`. Keep both notes in sync between `generateAnswer` and `streamAnswer`.
- `ai.test.ts` asserts on this prompt text — extend those assertions when adding rules.
- **SQL eval harness**: `bun run sql-eval --integration <id>` (`benchmark/sql-eval.ts`, needs `EVAL_ORG_ID`) measures execution accuracy + keyword presence (ILIKE/CURRENT_DATE/LIMIT) against a golden question set (`--file` for custom sets, `--out` for JSON results). Prompt changes should be measured with it, not vibes.

### Text-to-SQL prompt conventions

- The single SQL-generation prompt lives inline in `generateSql()` (`src/lib/ai.ts`). Rules 13–16 encode hard-won behavior — do not drop them when restructuring:
  - String search must be **case-insensitive per dialect**: PostgreSQL `ILIKE '%x%'` (or `LOWER()`), MySQL/MSSQL `LOWER(col) LIKE`, ClickHouse `positionCaseInsensitive(col, 'x') > 0`. Bare `=` or case-sensitive `LIKE` misses real user data.
  - `%`/`_` inside a search term need an explicit `ESCAPE` clause; never strip user wildcards silently.
  - `IS NULL` / `COALESCE`, never `= NULL`; LIKE on a NULL column returns NULL.
  - Substring match for "contains / menyebut / terkait / tentang"; exact case-insensitive equality for "exactly / persis".
- `ai.test.ts` asserts on this prompt text — extend those assertions when adding rules.

### LLM → Database safety (audit-verified)

**Enforced**: `guardrails.ts` — SELECT/WITH-only, mutation-keyword + injection-pattern rejection (string-literal-aware scan), single statement, LIMIT clamped/forced to `SQL_MAX_LIMIT=100` (`constants.ts`); re-checked at the execution boundary by `assertSelectOnly()` in `real-connectors.ts`. Driver-level timeouts (30s `QUERY_TIMEOUT_MS`) for pg/MySQL/MSSQL; per-integration semaphore `SQL_MAX_CONCURRENT=3` (`tool-utils.ts`, per-instance not distributed); verified TLS by default; `queryHistory` rows + audit trail (`GUARDRAIL_BLOCK` logged critical).

**Known gaps — do not assume these exist**:
- **No read-only enforcement at the DB layer** (no `SET TRANSACTION READ ONLY`, no read-only role). Safety is regex-only, and the "tokenizer + AST walker" in `guardrails.ts` is hand-rolled lexical scanning, not a real SQL parser.
- **LIMIT 100 is enforced textually + by prompt disclosure only** — no row cap enforced at execution time (the synthesis prompt now tells the model to disclose truncation).
- The SQL repair loop regenerates on guardrail/execution errors, but transient-network retry (streaming) still re-runs *identical* SQL.
- ClickHouse `executeQuery` has **no timeout**; the streaming SQL path skips `withToolSandbox` and the SQL rate limit (both are non-streaming-only).
- Integration selection fallback differs by path: non-streaming takes the oldest active integration; streaming uses keyword scoring over table/column names (`stream-preparers.ts`).

## Multi-Tenancy

- **Tenant root**: `Organization` model. `User.organizationId` links 1 user → 1 org. Every data model carries `organizationId`.
- **Auto-scoping**: `src/lib/prisma-tenant.ts` Prisma extension auto-injects `organizationId` via `AsyncLocalStorage` on `findFirst`/`findMany`/`count`/`aggregate`/`groupBy`/`update*`/`delete*`/`create*`. `findUnique` is NOT scoped (cuid IDs make cross-tenant access by ID infeasible).
- **Escape hatch**: `bypassOrg(fn)` for setup/SSO/signup/seed where no org context exists yet.
- **Context setup**: `getActiveUser()` (in `session.ts`) calls `enterWithOrg(orgId)` — but **`AsyncLocalStorage.enterWith()` does NOT propagate back to the caller's frame**. Every route handler MUST call `enterWithOrg(user.organizationId)` itself right after `getActiveUser()`, or all its DB queries run unscoped (cross-tenant leak). `src/lib/tenant-route-guard.test.ts` enforces this statically — keep it green when adding routes.
- **RBAC**: `admin > analyst > viewer`. `requireRole(user, 'admin')` guards admin routes.
- **Plan gating**: `starter | pro | enterprise`. `hasPlan(user.plan, 'pro')` gates premium features (`src/lib/plan-gating.ts`).
- **License validation**: external License-Validator service (`LICENSE_VALIDATOR_URL`, default `http://localhost:9000`). Ed25519 signed responses + grace period + periodic revalidation. `getActiveUser()` checks license status and throws `LicenseError` on expiry.
- **Key files**: `src/lib/prisma-tenant.ts`, `src/lib/session.ts`, `src/lib/license-client.ts`, `src/lib/plan-gating.ts`, `src/lib/api-keys.ts`.

## Conventions

- **English** in all user-facing strings (UI, errors, system prompts, comments).
- **Server-only libs** in `src/lib/` — never import `db`, `crypto`, `config`, or `session` into client components.
- **Fail-closed**: missing config/keys → throw, never fall back to insecure behavior. (`AUTH_DEMO_FALLBACK` defaults to `false`.)
- **Path alias**: `@/*` → `./src/*` (configured in `tsconfig.json`).
- **Comments explain *why*** — the codebase uses `// ponytail:` markers for hard-won context. Preserve these.
- **Typed errors**: `src/lib/errors.ts` defines `AppError` with 16 codes. `handleApiError()` in `session.ts` maps them to HTTP responses with `{ error: { code, message, hint? } }`.
- **New tools/plugins**: ship with a unit test for the executor + a guardrail test if it touches external systems.
- **Prisma schema changes**: run `bunx prisma db push` to apply, `bunx prisma generate` to regenerate the client.

## Setup

- Copy `.env.example` to `.env`. **`DATABASE_URL`** (postgresql://, Postgres 16 + pgvector) and **`ENCRYPTION_SECRET_KEY`** (64-char hex or any passphrase, derived via SHA-256) are required — the app refuses to start without the key.
- Postgres needs the `vector` extension: `CREATE EXTENSION IF NOT EXISTS vector;` (run as superuser). `reset.sh` and `start.sh` attempt this via `sudo`.
- Local dev DB bootstrap (one-time):
  ```bash
  sudo apt-get install -y postgresql-16-pgvector
  sudo -u postgres psql -c "CREATE ROLE ryasai LOGIN PASSWORD 'ryasai_dev';"
  sudo -u postgres createdb -O ryasai ryasai
  sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS vector;"
  bunx prisma db push
  ```
- `bunx prisma db push` applies the schema. `bunx prisma generate` regenerates the client (Prisma also runs this automatically after `bun install`).
- `scripts/seed.ts` seeds an **empty** database (the signup flow creates the org/admin). Demo data (Chinook, Pagila, etc.) is migrated separately via `scripts/migrate-demo-to-postgres.ts`.
- Scheduler requires Redis. Without Redis, the app degrades gracefully (synchronous processing, in-memory rate limits).

## Database integrations (Supabase/Neon/PlanetScale…)

- Managed providers hand users a **connection string** — the create-integration dialog accepts it and pre-fills the fields; the server (`parseConnectionString` in `real-connectors.ts`) re-parses authoritatively.
- Managed providers default to TLS (`sslByDefault` in `db-provider-presets.ts`). TLS verification is ON by default; `DB_SSL_REJECT_UNAUTHORIZED=0` is the dev/self-signed opt-out.
- Connection failures are **classified** (`describeConnectionError`): `auth` / `ssl` / `dns` / `timeout` / `refused` / `database_missing` / `driver_missing`. The UI shows the classified hint; never regress to the opaque "Connection failed" string.
- `POST /api/integrations/[id]/test` (the UI "Test Connection" button) re-tests on a fresh pool and refreshes the schema cache.
- Supabase specifics: the **pooler** host needs the full dotted username (`postgres.<project-ref>`) and port 6543 (transaction mode) / 5432 (session mode); direct connections use `db.<project-ref>.supabase.co:5432`. Schema reflection defaults to `public` — pass `?schema=` or a `schema` field for others.
- Schema enrichment (`SELECT DISTINCT` per text column) runs under a budget (150 queries, concurrency 6) so large managed DBs don't hang first-time reflection.

## Build & Deploy

- **Build runs under real Node** (`node:22-slim`), not Bun — Turbopack breaks under Bun's node-compat shim (jsdom `patch.json` error). Prod runtime is Bun (`oven/bun:1-slim`).
- `bun run build` produces `.next/standalone/`. The script also copies `.next/static` and `public/` into it.
- Docker images: `Dockerfile` (app) + `Dockerfile.scheduler` (scheduler). CI (`build-images.yml`) builds and pushes to GHCR on `main` push and version tags. `ci.yml` runs lint + typecheck + unit tests on every push/PR, plus the e2e suite against a pgvector service container.
- Deployment is compose-first: `docker-compose.yml` pulls prebuilt GHCR images and runs a `migrate` one-shot (scheduler image ships the Prisma CLI) before `app`/`scheduler`; plus Redis and `pgvector/pgvector:pg16`. `install.sh` is the one-liner installer (`--with-searxng` adds a private SearXNG for the web_search tool). A `helm/` chart also exists but lags the compose path.
- `next.config.ts`: `output: "standalone"`, `serverExternalPackages` for cognee/ioredis/bullmq/DB drivers/OTel SDKs, `outputFileTracingIncludes` pinning the DB driver packages into the standalone output (both are guarded — see invariants #3).
