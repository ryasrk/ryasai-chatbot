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
2. **cognee searchTypes**: only names that exist in the PINNED SERVER's enum.
   The authority is the cognee **v1.6.0 server's OpenAPI schema**, captured into
   `src/lib/__fixtures__/cognee-search-types.json` by
   `scripts/refresh-cognee-search-types.ts` (CI runs no cognee sidecar, so the
   snapshot is what the guard reads). `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` came
   from *Python* cognee docs and were never valid; the move to the server's enum
   immediately caught a mirrored `FEEDBACK` that does not exist server-side. Fix a
   renamed literal by refreshing the fixture and syncing `COGNEE_SEARCH_TYPES` —
   never by deleting the guard.
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
bun run e2e              # Playwright, DEV server (8 specs / 12 tests — Postgres e2e DB, mock LLM + mock license validator)
bun run build && bun run e2e:prod
                         # same specs against the PRODUCTION standalone build (see below)
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
- **Run both e2e modes before shipping.** `bun run e2e` uses `next dev`; `bun run e2e:prod`
  (`playwright.prod.config.ts`) runs the same specs against `.next/standalone/server.js`
  with `NODE_ENV=production`. Dev and the shipped artifact diverge in ways that are
  invisible in dev and fatal in production: minified client code, prerendered server
  components, real security headers, and `outputFileTracing` deciding which packages
  exist at runtime (a missing DB driver only fails here). Every blocker found in the
  2026-09 audit surfaced by changing the environment, never by re-reading code. CI runs
  both. The prod config sets `E2E_TEST_MODE=true` so the localhost mock LLM is reachable
  — `instrumentation.ts` fails closed if that marker ever appears on a deployment, and
  `invariants.test.ts` asserts no production manifest ships it.
- e2e mock stack: `e2e/global-setup.ts` seeds the e2e DB, starts a mock License-Validator on `:4546` (Ed25519 test keypair from `e2e-keys.ts` → `LICENSE_SIGNING_PUBLIC_KEY`) and a mock LLM on `:4545`; the app runs on `:3105` with `E2E_DATABASE_URL`. Playwright `workers: 1` (shared DB).
- `src/lib/tenant-route-guard.test.ts` statically enforces org-context entry on every route — if it fails for a new route, add `enterWithOrg((await getActiveUser()).organizationId)` (or `bypassOrg` if genuinely cross-org).
- 132 `*.test.ts` files across `src/` (129 run as unit tests; 3 integration files opt in via `bun run test:integration`). Every new lib file should ship with a `*.test.ts`.

### Pre-commit hook

`scripts/pre-commit.sh` runs `bunx tsc --noEmit --incremental` then `bun run lint -- --quiet`. It blocks on errors only (warnings pass). Installed by `bun run prepare` (also runs on `bun install` via the `prepare` script).

### CI gotchas

- CI (`ci.yml`) runs `rm -rf node_modules/.prisma && bunx prisma generate` before typecheck — a cache-restored stale Prisma client makes every Prisma type resolve to `{}` and tsc emits ~130 errors. If tsc suddenly fails en masse locally, delete `node_modules/.prisma` and regenerate.
- The e2e job pins `ENCRYPTION_SECRET_KEY` and uses a `pgvector/pgvector:pg16` service container; the app build itself is validated separately by `build-images.yml`.

## Architecture

- `src/app/api/` — 99 REST routes (session auth via `getActiveUser()`, external API key auth via `requireExternalApiKey()`).
- `src/components/views/` — feature views registered in `src/lib/view-routing.ts` (`VIEW_KEYS`): dashboard, chat, integrations, knowledge, ai-config, prompt-tools, integration-api, security, agentic, plugins, schedules, settings. Plus sub-components (topbar, chat cards, dialogs).
- `src/lib/` — server-only libraries. Never import `db`, `crypto`, `config`, or `session` into client components (they touch secrets).
- `mini-services/scheduler/` — separate Bun process, BullMQ worker (repeatable jobs, no manual polling). Imports parent libs via relative paths. Disables cognee (file-lock conflict with dev server). Requires Redis.
- `prisma/schema.prisma` — 31 models. Every model except `Organization` and `Invitation` carries `organizationId`.
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
- `src/lib/guardrails.ts` — SQL validation (rejects DML/DDL, rejects side-effecting functions via `detectDangerousFunctions`, forces `LIMIT 100`, single-statement). Hand-rolled tokenizer + scanner, NOT a real SQL parser — see "LLM → Database safety" below for the full picture, including which layer actually blocks what.
- `src/lib/connectors.ts` + `src/lib/real-connectors.ts` — DB connector registry (Postgres/MySQL/MSSQL/ClickHouse via the STATIC `DRIVER_LOADERS` map — never a variable-specifier `import()`; see invariants #3).
- `src/lib/cognee.ts` — barrel over `cognee-core.ts` (settings/backend selection/client cache), `cognee-memory.ts` (chat memory), `cognee-knowledge-graph.ts` (cognify/graph recall/forget), `cognee-http.ts` (transport to a cognee API server). No-op unless the per-org Settings toggle is on (`COGNEE_ENABLED=false` is only a process-wide kill switch); reuses the tenant's LLM config. Datasets are per-org (`org:<id>`, `org:<id>:kb`).

  **ONE backend, one version, one writer.** `COGNEE_SERVER_URL` set → HTTP to a cognee **v1.6.0** server (the `cognee` sidecar in `docker-compose.yml`; the SHIPPED default for compose installs). Unset → **memory is OFF**; there is no in-process fallback, because the `@cognee/cognee-ts` bindings were REMOVED from this project (2026-09-24). `getCogneeBackend()` / `getCogneeServerOptions()` in `cognee-core.ts` are the single decision point, so a write and its matching read can never use different transports.

  **Do not add the bindings back alongside the server.** Two cognee lineages writing one store is a corruption mechanism, and this deployment already paid for it: a LanceDB collection sized 1536 while the configured embedder returned 384, and a graph holding 0 nodes after a write that reported success. Recorded with measurements in `docs/cognee-http-migration.md`; the earlier 0.2.0 evaluation is in `scripts/cognee-upgrade-check.md`.

  **Server-side flags matter more than the client config.** `AUTO_FEEDBACK=false`, `IMPROVE_AUTO_ENABLED=false`, `USAGE_LOGGING=false` are set in compose and `install.sh` and are LOAD-BEARING: with them at their defaults one search measured **24-95s** (retrieval itself was 49ms — the cost was `SessionTurnAnalysis` calling the LLM and retrying on a schema-validation error). With them off: write 9s, search 0.21s. Re-enabling any of them means re-measuring, not assuming. The URL is read from the **environment only, never the per-org `AppConfig` row** — a per-org server address would let one org point memory at another org's server, which is exactly the cross-tenant leak this module already had to fix once.

  **Why the server is the default (measured):** a server write took 19.9s and the matching recall returned the stored token in 4.3s, and cross-session recall through `rememberChatTurn` → `recallContext` gave `FOUND=true`. Full contract in `docs/cognee-http-migration.md` (multipart `remember`; the embedding-dimension trap; `HYBRID_COMPLETION` returns ONE synthesized answer, so recall requests `CHUNKS`/`SUMMARIES` explicitly).

  **Recall strategies** are `SUMMARIES` → `CHUNKS`, then a third gated on the graph backend (`NATURAL_LANGUAGE` on postgres, `CHUNKS_LEXICAL` on kuzu). That gate lived in the removed in-process client; on the v1.6.0 server both are valid, and `docs/cognee-http-migration.md` records which ones were actually measured returning separate hits. `GRAPH_COMPLETION` is NOT an alternative: measured failing after 193341 ms. `datasets.has()` is **advisory only** — it reports a present dataset as missing, so a `false` must never suppress recall (see invariants #2).

  **The bindings themselves are gone**, so `@cognee/cognee-ts` is no longer a dependency and the old "do not bump it" fence is moot. It still applies to anyone PROPOSING to bring the bindings back: read `scripts/cognee-upgrade-check.md` first (0.2.0 makes `remember()` a false success AND leaves a persistent "dataset completed" mark that keeps breaking writes even after downgrading), then prove a WRITE-then-RECALL against a fresh store.

  **`dbProvider`/`dbUrl` on the org row are INERT.** They used to select the in-process store (kuzu+lancedb vs pgvector); storage now belongs to the server and is set by compose. The fields are still readable and echoed to the UI, and changing them changes nothing — see the note in `cognee-core.ts` so the next reader does not spend an afternoon proving it.

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

**Enforced**: `guardrails.ts` — SELECT/WITH-only, mutation-keyword + injection-pattern rejection (string-literal-aware scan), **side-effecting-function denial** (`detectDangerousFunctions`: `pg_read_file`, `dblink`, `set_config`, `load_file`, `file()`, `url()`, `openrowset`, …), single statement, LIMIT clamped/forced to `SQL_MAX_LIMIT=100` (`constants.ts`); re-checked at the execution boundary by `assertSelectOnly()` + `assertNoDangerousFunctions()` in `real-connectors.ts` (shared function list — do NOT create a second copy, that divergence is what made the boundary weaker than the guard). **DB-layer read-only**: Postgres `SET TRANSACTION READ ONLY` + `SET LOCAL statement_timeout`, MySQL `SET TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`, ClickHouse `readonly=1` + `request_timeout`, MSSQL `readOnlyIntent` (see gap below). Driver-level timeouts (30s `QUERY_TIMEOUT_MS`) for pg/MySQL/MSSQL/ClickHouse; per-integration semaphore `SQL_MAX_CONCURRENT=3` (`tool-utils.ts`, per-instance not distributed); verified TLS by default; `queryHistory` rows + audit trail (`GUARDRAIL_BLOCK` logged critical).

**Known gaps — do not assume these exist**:
- **`SET TRANSACTION READ ONLY` does NOT cover read-type side effects.** Measured on Postgres 16 with scanners bypassed: it blocks INSERT/UPDATE/DELETE/TRUNCATE/DDL, but `pg_read_file()`, `set_config()` and `pg_sleep()` still run (they are reads). Those three are handled by the function deny-list + `statement_timeout`, not by read-only mode. Do not describe read-only mode as "blocks everything".
- **MSSQL has no per-transaction read-only mode.** `readOnlyIntent` only routes to a read replica when the server has an Availability Group; otherwise a read-write login still permits write side effects. A real fix needs an operator-granted read-only role (a customer-side DB setup step). The function deny-list covers `xp_cmdshell`/`OPENROWSET`/`BULK INSERT`/`OPENDATASOURCE`.
- The "tokenizer + AST walker" in `guardrails.ts` is hand-rolled lexical scanning, not a real SQL parser. The deny-list is the load-bearing part for functions; the DB read-only mode is the load-bearing part for mutation.
- **LIMIT 100 is enforced textually + by prompt disclosure only** — no row cap enforced at execution time (the synthesis prompt now tells the model to disclose truncation).
- The SQL repair loop regenerates on guardrail/execution errors, but transient-network retry (streaming) still re-runs *identical* SQL.
- The streaming SQL path skips `withToolSandbox` and the SQL rate limit (both are non-streaming-only).
- Integration selection fallback differs by path: non-streaming takes the oldest active integration; streaming uses keyword scoring over table/column names (`stream-preparers.ts`).

### Answer confidence & evidence sufficiency (2026-09 trial)

INCIDENT (user-reported): *"the LLM sometimes says it doesn't know even though the
answer IS in the knowledge base, and it answers once you name the source."*

Traced with `trial/06-verify-fix.ts` against a seeded live Postgres. Two defects
compounded, and neither was in the model:

1. **Placeholder chunks were fed to the answer prompt as evidence.** A document
   whose extraction produced nothing is stored as `[Empty document: x.pdf]` so
   retrieval can still match the filename (`emptyDocumentContent`). That marker is
   not evidence, but it reached `retrieveWithReflection`'s evidence string.
2. **Sufficiency was decided by evidence LENGTH.** `evidence.trim().length < 50`
   returned `insufficient` with no LLM call. A 46-char placeholder tripped it
   (false "no evidence"), and so did a genuinely complete short answer —
   *"Tarif lembur hari kerja 1,5x upah per jam."* (41 chars) is a full answer and
   was declared insufficient.

The chain that produced the symptom: placeholder-as-evidence → length shortcut →
`sufficient: false` → retrieval advanced to a **second pass** → `retrievalPasses >= 2`
→ `tool-branches.ts` injected *"If the evidence doesn't contain the answer, say
so"* → the model correctly obeyed an instruction to disclaim. Naming the source
changed the ranking, so the note vanished — exactly the reported asymmetry.

Fixes: `isPlaceholderChunk()` / `emptyDocumentContent()` in `rag-chunking.ts` as the
single source for the marker (it was an inline literal in the upload route with no
shared detector); placeholders filtered out of the evidence string; the length
short-circuit replaced by a content-only floor (`< 8 alphanumeric chars`).
`evaluateAnswerConfidence` had the **same length bug plus an ordering bug** — its
guards sat below the `if (!cfg) return { confident: true }` early-return, so on a
deployment with no LLM they were unreachable and empty/placeholder evidence was
reported confident. Not reproduced by accident: that function had **no tests at
all**, which is why both defects survived.

**Do not reintroduce length as a proxy for sufficiency or confidence.** A short
chunk is not a bad chunk. `invariants.test.ts` covers the filter, forbids any
`evidence.length < N` short-circuit (scanning code with comments stripped —
the fix's own comment quotes the old expression), and asserts the placeholder
check precedes the LLM gate.

**Honest scope of the trial.** Retrieval recall was measured and is NOT the
problem: across 5 queries (3 vague, 2 source-named) the needle chunk surfaced
every time, at rank 2–3. The environment has only a **mock LLM**, so answer
quality, faithfulness and RAGAS numbers are NOT measurable here — `trial/README.md`
records that and the harness emits no quality scores. What was verified live:
tenant isolation (cross-org retrieval leak: none), on-topic > off-topic scoring,
guardrail 6/6 (DROP, `pg_read_file`, `pg_sleep`, comment-hidden mutation all
blocked; a string-literal decoy correctly allowed), DB-layer read-only rejecting
`DELETE`, schema reflection (31 tables with FK relations feeding `describeSchema`).
`trial/` is ad-hoc and not part of CI.

## Cross-tenant IDOR: `findUnique` on a client-supplied id (2026-09 audit)

`findUnique` is NOT org-scoped (the tenant extension cannot add `organizationId`
to a unique `where`). The long-standing rationale in `prisma-tenant.ts` was
*"IDs are cuid() random — cross-tenant access by ID is infeasible"*. **That
rationale is false and has been removed**: `api/mcp/servers/route.ts` returns
`id: true` to the browser, so a legitimate org-A user holds their own server ids
in plain sight and those same ids resolve in org B's context.

Two routes were exploitable, and BOTH called `getActiveUser()` + `enterWithOrg()`
— so `tenant-route-guard.test.ts` passed them. The goroutine was correct; the
query simply ignored the context it established.

| route | hole |
|---|---|
| `api/mcp/servers/[id]` GET/PATCH/DELETE | read/modify/delete another org's MCP server by id |
| `chat/sessions/[id]/send` | `body.promptId` read another org's `SavedPrompt` and injected its text into this org's system prompt |

**Rule**: loading a row by a CLIENT-SUPPLIED identifier must use `findFirst` (or
`findFirstOrThrow`), never `findUnique`. Use `findUnique` only for (a) pre-auth
lookups where no org exists yet (login/signup/invite/setup) and (b) re-reading a
row the same handler just created. `invariants.test.ts` carries an explicit
allowlist of files permitted to contain `findUnique` and fails on any new one —
if your route legitimately needs it, add it there **with the reason**.

## Alignment gate: two fail-opens (2026-09 audit)

`checkAlignment` is an advisory guardrail (it annotates an answer, it does not
block the request). Two defects made it weaker than it read:

1. **`ALIGNMENT_CHECK` enum mismatch.** `env-schema.ts` declares
   `z.enum(['http','llm','disabled'])`, but all four call sites tested
   `=== 'true'`. Setting the SCHEMA-VALID value `ALIGNMENT_CHECK=llm` — the
   documented way to enable the LLM judge — silently DISABLED the guardrail.
   Now read through the single predicate `isAlignmentCheckEnabled()`
   (`alignment-check.ts`); `invariants.test.ts` fails on any reintroduced
   `process.env.ALIGNMENT_CHECK === 'true'`.
2. **Non-streaming bypass.** `runStreamingAgenticLoop` checked alignment *inside*
   its substantial-evidence branch, but `runAgenticLoop` `return`ed from that same
   branch ~10 lines BEFORE its own check. The identical question was guarded over
   SSE and unguarded over HTTP, while `docs/threat-model.md` claimed both were
   covered. Both loops now call one shared `alignmentNoteFor()` helper — a second
   inline copy is exactly how they diverged.

The judge fails **open** on error (a judging outage must not silence every reply)
but logs a warning and reports `reason: 'alignment check skipped (judge
unavailable)'` — deliberately not "failed", because `aligned: true` next to
"failed" reads as "checked and fine", the opposite of what happened.

## Multi-Tenancy

- **Tenant root**: `Organization` model. `User.organizationId` links 1 user → 1 org. Every data model carries `organizationId`.
- **Auto-scoping**: `src/lib/prisma-tenant.ts` Prisma extension auto-injects `organizationId` via `AsyncLocalStorage` on `findFirst`/`findMany`/`count`/`aggregate`/`groupBy`/`update*`/`delete*`/`create*`. **`findUnique` is NOT scoped** — see "Cross-tenant IDOR" above: an earlier note here claimed cuid ids made cross-tenant access infeasible, which was wrong (ids are returned to clients) and two routes were exploitable. Use `findFirst` for any client-supplied id.
- **Escape hatch**: `bypassOrg(fn)` for setup/SSO/signup/seed where no org context exists yet.
- **Context setup**: `getActiveUser()` (in `session.ts`) calls `enterWithOrg(orgId)` — but **`AsyncLocalStorage.enterWith()` does NOT propagate back to the caller's frame**. Every route handler MUST call `enterWithOrg(user.organizationId)` itself right after `getActiveUser()`, or all its DB queries run unscoped (cross-tenant leak). `src/lib/tenant-route-guard.test.ts` enforces this statically — keep it green when adding routes.
- **RBAC**: `admin > analyst > viewer`. `requireRole(user, 'admin')` guards admin routes.
- **Plan gating**: `starter | pro | enterprise`. `hasPlan(user.plan, 'pro')` gates premium features (`src/lib/plan-gating.ts`).
- **License validation**: external License-Validator service (`LICENSE_VALIDATOR_URL`, default `http://localhost:9000`). Ed25519 signed responses + grace period + periodic revalidation. `getActiveUser()` checks license status and throws `LicenseError` on expiry.
- **License enforcement covers background work too**: `getLockdownReason` (`license-client.ts`) is the single predicate for "is this org locked down"; the HTTP path reaches it via `getActiveUser()`, and the **scheduler worker calls it directly in `processJob`** before doing any work. INCIDENT (2026-09): the worker had no gate, so a locked-down org's scheduled runs kept calling the LLM and touching the DB unattended. A locked org's job is **skipped** (not retried — a bad license is permanent, and retrying burns all 3 attempts per tick), recorded as `ScheduledRunLog.status='skipped'` + a `warning` audit row, and rendered as a "Skipped" badge in the schedules view. `unreachable`-within-grace still runs. **Any new process that executes work for an org must consult `getLockdownReason`** — never re-implement the status→lockdown mapping (`invariants.test.ts` enforces both).
- **Key files**: `src/lib/prisma-tenant.ts`, `src/lib/session.ts`, `src/lib/license-client.ts`, `src/lib/plan-gating.ts`, `src/lib/api-keys.ts`.

## Deployment model: on-prem, single install, licensed via OUR validator

**ryasai is deployed ON-PREM per customer.** One install = one deployment, and the
customer runs it on their own hardware. There is no multi-tenant SaaS control
plane: the `Organization` row is that install's own tenant root, and the app
reaches OUT to **OUR** License Validator (`~/ryasai/ryasai-LicenseValidator`,
a separate repo/service we operate) to validate its license key + machine id.

The direction matters and is easy to invert: the app is the CLIENT. It POSTs to
`/api/v1/license/validate` with `{license_key, machine_id, product}` and gets back
an Ed25519-signed verdict. Our validator is the authority; a self-hosted install
cannot mint its own license.

**Consequences — several earlier notes in this file were written as if this were a
multi-tenant SaaS and are WRONG for this business:**

- **There is no usage metering, no token budget, and no cost tracking to sell.**
  Billing is the signed LICENSE (a flat per-install entitlement). We do not charge
  per token, per seat, or per query, and we could not if we wanted to: the install
  is on the customer's premises with the customer's LLM key. Repeatedly, agents —
  and I — have "found" a missing cost/quota/budget feature here. **It is not
  missing; it is deliberately absent.** Verify the business model before proposing
  metering work.
- The token budget (`llm-budget.ts`, `assertWithinBudget` in the chat send route)
  is **dormant**: it exists as an optional operator safety valve against a runaway
  agent loop, is OFF unless `LLM_DAILY_TOKEN_BUDGET` is set, and is not a billing
  mechanism. Do not build on it.
- **Plan tiers / quotas (`starter|pro|enterprise`, `checkQuota`) are dormant
  licensing-era leftovers**, not a revenue path. The shipped commercial model is
  `licensePlan = 'flat'` — one entitlement, all features. Per-org quota checks
  still exist and are enforced where wired; they are simply never the thing that
  separates a paying customer from a non-paying one (the LICENSE is).
- **Multi-tenancy IS still load-bearing even here** — do not "simplify" it away.
  A single install can host several `Organization` rows (signup creates one), and
  more importantly the org scoping is what keeps data separated within the
  install and what every security guard in this file depends on. The past
  "single-tenant refactor" that removed `organizationId` was REVERTED for good
  reason; re-read the Cross-tenant IDOR section before touching it.

## Bring-your-own-key: the customer pays their provider, not us

**ryasai ships no LLM and no embedding model.** Every org supplies its own chat
endpoint, API key, and embedding endpoint in Settings > AI Configuration
(`LlmConfig`: `baseUrl`/`encryptedApiKey`/`model` + the `embedding*` quartet).
There is no platform key and no platform fallback anywhere in the transport —
verified: `llm-client.ts` sends only `cfg.apiKey`, which comes from the org's own
row via `getLlmRuntimeConfig()` (`findFirst` → org-scoped by the tenant
extension). An org with no config resolves `null` and the call fails closed.

Verified live (`trial/21-byok-isolation.ts`): two configured orgs each resolve
their OWN model + key with no cross-org bleed, and an unconfigured org gets
`null` rather than someone else's credentials.

**What this means for the money model — do not get this backwards:**

- **There is no per-org LLM COGS.** Token spend lands on the customer's provider
  invoice. `LlmUsageLog` tracks tokens for monitoring and for the customer's own
  runaway-loop protection — NOT for our margin. Do not build billing on it, and
  do not assume a cost column is missing-but-needed; our costs are hosting,
  Postgres, Redis and bandwidth, which are roughly flat per tenant.
- **The token budget is a dormant operator safety valve, not a product feature.**
  `LLM_DAILY_TOKEN_BUDGET` is env-configured (one process-wide number, OFF by
  default) and exists only to stop a runaway agent loop. It is not a billing
  mechanism and there is no per-org budget UI to build — see "Deployment model"
  above: the entitlement is the signed license, not a usage meter.
- The schema line calling `LlmUsageLog` "cost tracking" was **removed** — it
  described a billing model we are not in and would mislead the next reader into
  building usage-based charging on top of the customer's own key.

**BYOK failure handling is a first-class UX problem.** Because the credential is
the customer's, a 401/402/404 is never an operator misconfiguration — it is
their action item. Previously EVERY provider failure collapsed into one status
and told the user *"AI provider is not configured. Open Settings…"*, which is
actively misleading when the URL and model are already correct and only the key
is dead, credit ran out, or the model was renamed. `classifyProviderFailure()`
(`llm-client-utils.ts`) now separates `auth` / `quota` / `model_missing` /
`model_unsupported` / `unreachable` / `unknown`, and `LlmProviderError` carries
that classification on the error so callers can show a precise fix. The raw
provider body is NEVER sent to a client (it can echo the key prefix) — it stays
in server-side logs; only the category + hint cross the wire.
`toTypedError` maps it to 502 (upstream), not 500 (our fault).

## Billing: the signed license IS the revenue model (not subscriptions or metering)

> Keep this section for the QRIS purchase-flow mechanics, but do not read it as a
> metering roadmap — see "Deployment model" above. The entitlement is a signed,
> machine-bound license issued by OUR validator; there is no per-token or per-seat
> charge to reconcile, and the customer's install runs with the customer's own LLM key.

Billing via QRIS is IMPLEMENTED (spec: `docs/superpowers/specs/2026-08-26-qris-billing-design.md`):
Midtrans Snap checkout, flat `'flat'` plan (all features), packs 1/3/6/12 months
(`src/lib/pricing.ts`), register-free → locked-until-paid (`licenseStatus 'unpaid'`),
webhook-driven license issuance via the License-Validator's
`POST /internal/licenses/generate` (X-Internal-Secret auth, in `~/ryasai/ryasai-LicenseValidator`,
separate repo). Key pieces: `src/lib/midtrans.ts`, `src/lib/license-issue.ts`,
`src/app/api/billing/*`, buy-license dialog, `license-expiry-reminder` scheduler job.
New env: `MIDTRANS_SERVER_KEY`, `NEXT_PUBLIC_MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION`,
`NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION`, `LICENSE_INTERNAL_SECRET`.

Still open before charging real customers:

- **Plan quotas are now ENFORCED** (2026-09 audit): `checkQuota()` / `quotaFor()` /
  `quotaExceededMessage()` in `plan-gating.ts` gate every resource-creation path —
  `maxIntegrations` in `POST /api/integrations` (checked BEFORE the connection test, so a
  refused create costs no round-trip to the customer DB and does not surface as
  "Connection failed"), `maxDocuments` in `POST /api/documents` (before extraction/
  embedding, so no embedding call is wasted), and `maxUsers` in `accept-invite` plus BOTH
  SSO provisioning paths (`sso.ts`, `sso-saml.ts`). Signup/register are deliberately NOT
  gated — they create a fresh org whose first user is always within quota; gating them
  would lock a new customer out of their own account. Refusals are HTTP 402 with
  `code: 'QUOTA_EXCEEDED'`. An unknown/null plan resolves to `starter`, the MOST
  restrictive tier, so a typo'd plan cannot unlock the largest quotas. `invariants.test.ts`
  pins the wiring by asserting on the actual `checkQuota(...)` invocation rather than on a
  nearby string, and forbids a hardcoded `{ allowed: true }`; both guards were
  negative-controlled (a disabled `if (false)` with the QUOTA_EXCEEDED string still present
  initially slipped past a weaker version of the guard).
  **Known limit — do not overstate**: this is a check, not a lock. Two concurrent creates
  can both read `current = limit - 1` and overshoot by one. Acceptable for a commercial
  boundary; if a quota ever gates something expensive or security-relevant it must be
  re-implemented as an atomic check-and-insert.
- **SSO provisions into an explicitly-resolved org, never a hardcoded one**:
  `resolveSsoOrganizationId()` (`sso.ts`) uses `SSO_ORGANIZATION_ID` when set, otherwise
  accepts the single-org case, and **throws** when several orgs exist. INCIDENT (2026-09):
  both SSO providers wrote the literal `'org-default'`, a leftover from the reverted
  single-tenant refactor. `User.organizationId` is a foreign key, so on a real multi-tenant
  DB that insert threw an FK violation — first-time SSO login was simply broken, and no test
  caught it because the `db` mock accepted any value. Guessing a tenant instead would be
  strictly worse than the FK error (cross-tenant attribution), hence fail-closed.
- **License-Validator deployment story** is undocumented (issue/revoke/machine-slot ops live in that other repo).
- No trial path — deliberate choice (locked until paid); revisit if conversion suffers.
- `LLM_DAILY_TOKEN_BUDGET` is opt-in (default off) and dormant. It is a runaway-loop safety valve, NOT the revenue mechanism and NOT a per-org ceiling anyone asked for (see "Deployment model" above).
- Quality evals (`rag-eval`/`sql-eval`) run only via the manual/scheduled `eval.yml` workflow — no hard CI gate on answer quality.

## Editable context prompts (spec: `docs/superpowers/specs/2026-08-26-editable-context-prompts-design.md`)

Admins can attach free-text prompts that shape LLM answers per source:
- `Document.contextPrompt` → injected into RAG answer synthesis (only when that doc's chunks are retrieved). Editor: Knowledge view → document "Details" dialog.
- `Integration.contextPrompt` → injected into SQL synthesis (both the SQL-generation step and the final answer prose). Editor: Data Sources view → integration "Schema" sheet.
- Org-wide `ragContextPrompt` (in `AppConfig.promptSettings` JSON) → every RAG answer. Editor: Prompt & Tools view.
- Org-wide `systemPrompt` (existing, same JSON) → chat + agentic. The Prompt & Tools editor now has char counters, a default-template button, and injection explainers.
- Per-table `IntegrationSchema.description` is admin-editable and `manualDescription`-locked: `enrichSchemaDescriptions` skips locked rows, and schema `?refresh=1` carries locked descriptions + flags across re-reflection (older code wiped them on every refresh).

Injection helper: `buildSourceGuidance()` (`src/lib/source-guidance.ts`) — budget-capped (2000 chars), preserves retrieval order, truncates with an ellipsis marker, notes omitted prompts. RAG branch prepends the block to the evidence `context` (not as a system message); SQL branch appends `Context guidance:` to the effective prefix for both `generateSql` and `generateAnswer`. Empty prompts are no-ops. All writes are admin-only + audit-logged.

Post-audit hardening now in place: billing webhook uses a conditional settlement claim
(race-safe) + hourly `order-reconcile` sweep for settled-but-unissued orders +
gross_amount validation; env validation is fatal for missing DATABASE_URL/
ENCRYPTION_SECRET_KEY and prints a consolidated degradation warning block otherwise;
install.sh requires an operator-supplied LICENSE_SIGNING_PUBLIC_KEY; web-fetch follows
redirects manually with per-hop SSRF checks; chat send has org rate limit
(`CHAT_RATE_LIMIT_PER_MIN`) + optional spend budget; `/api/metrics` is token/admin-gated;
document jobs have retry (`POST /api/documents/[id]/reprocess` + UI button); purchase
flow is e2e-tested via mock Midtrans (:4547, `MIDTRANS_BASE_URL` test seam).

**Remove before shipping a customer image — VERIFY, do not assume:**
- Demo data paths (`scripts/migrate-demo-to-postgres.ts` demo DBs, `connectors.ts` demo tables,
  `test-data/` PDFs). **Checked against the actual build:** `.dockerignore` excludes
  `test-data/`, and `.next/standalone/` ships only `node_modules`, `public` and `server.js` —
  so neither the PDF fixtures nor `scripts/` reach the customer image today. The last
  remaining reference was a COMMENT in `prisma/schema.prisma` listing `SQLITE_DEMO` among the
  allowed providers. Checked before acting on it: `SQLITE_DEMO` appears NOWHERE in `src/` — the
  demo connector was already removed, and the UI offers only POSTGRESQL / MYSQL / MSSQL — so the
  comment was the last trace of a capability that no longer exists. Removed. The checklist item
  is therefore CLOSED, not carried forward.
- `helm/` chart lags docker-compose — `helm/README.md` carries a NOT-PRODUCTION-READY
  banner and a divergence table; don't point customers at it until reconciled (compose +
  `install.sh` are the supported path).

Resolved by the 2026-09 audit (kept here so they are not re-introduced):
- Dev artifacts `dev.log` / `README.md.bak` / `tsconfig.tsbuildinfo` deleted (all were
  gitignored but dirtied every `git status`).
- Stale docs corrected: `docs/adr/0001` is now marked SUPERSEDED in place (body preserved
  for the reasoning); PRODUCT.md/PRD/threat-model/helm claim multi-tenant + English and
  the re-derived counts (31 models, 99 routes, 12 views).
- Benchmark run artifacts are gitignored (`benchmark/results/*.json`, keeping the
  curated `ground-truth-failures.json`) so they stop polluting the working tree.

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

**HOW THE DISPLAYED VERSION REACHES THE IMAGE — checked, because the obvious path is dead.**
`src/lib/public-config.ts` exposes `appVersion` from `NEXT_PUBLIC_APP_VERSION`, and `install.sh`
writes that variable into the customer's `.env`. That `.env` line does **not** set it for the
browser: `NEXT_PUBLIC_*` is normally substituted by the bundler at BUILD time, and the Dockerfile
declares no `ARG`/`ENV` for it, so no substitution happens. Inspected in the built output:

    server chunk : appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0"
    client chunk : M.default.env.NEXT_PUBLIC_APP_VERSION || "1.0.0"

so what a customer actually sees is the **hardcoded fallback**. That is why the fallback is kept
equal to the released version (1.0.0) and is called out above as needing to move with any future
release — it is the real display value, not a placeholder. If a deployment ever needs to override
the version at build time, add `ARG NEXT_PUBLIC_APP_VERSION` to the builder stage and pass it from
compose `build.args`; until then the fallback IS the mechanism.

**KNOWN FORWARD-COMPAT WARNING, not a defect.** `bun run build` prints:

    ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

`src/middleware.ts` is still supported and still runs (it carries the rate limiting and has its
own test file), so this is a migration to schedule rather than a bug to fix — but it is recorded
here because it appears on every build and an unexplained warning trains people to ignore build
output. Migrating means renaming the file and re-checking the `matcher` config against Next's
current `proxy.ts` semantics; do it deliberately, not as a drive-by during unrelated work.

- **Build runs under real Node** (`node:22-slim`), not Bun — Turbopack breaks under Bun's node-compat shim (jsdom `patch.json` error). Prod runtime is Bun (`oven/bun:1-slim`).
- `bun run build` produces `.next/standalone/`. The script also copies `.next/static` and `public/` into it.
- Docker images: `Dockerfile` (app) + `Dockerfile.scheduler` (scheduler). CI (`build-images.yml`) builds and pushes to GHCR on `main` push and version tags. `ci.yml` runs lint + typecheck + unit tests on every push/PR, plus the e2e suite against a pgvector service container.
- Deployment is compose-first: `docker-compose.yml` pulls prebuilt GHCR images and runs a `migrate` one-shot (scheduler image ships the Prisma CLI) before `app`/`scheduler`; plus Redis and `pgvector/pgvector:pg16`. `install.sh` is the one-liner installer (`--with-searxng` adds a private SearXNG for the web_search tool). A `helm/` chart also exists but lags the compose path.
- `next.config.ts`: `output: "standalone"`, `serverExternalPackages` for cognee/ioredis/bullmq/DB drivers/OTel SDKs, `outputFileTracingIncludes` pinning the DB driver packages into the standalone output (both are guarded — see invariants #3).
