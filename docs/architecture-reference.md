# Architecture reference — AI/RAG internals

Moved out of `AGENTS.md` on 2026-09-29, and the reason is measured rather than tidiness.

`AGENTS.md` had grown to 59,565 bytes against an instruction budget of 65,536 — and `CLAUDE.md` (37,433 bytes,
session history) is read FIRST, so only the first ~28,103 bytes of `AGENTS.md` ever reached an agent. Everything
below byte 28,103 was silently dropped, which included **`## Cross-tenant IDOR`** (a real IDOR incident) and
**`## Silent-failure classes`** (20 defect patterns). Those are rules; this section is reference. The rules stayed in
`AGENTS.md` and this moved here, where it is read when the area is being worked on.

Load it when: changing retrieval, prompts, SQL generation, guardrails, session memory, or answer-confidence logic.

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

### LLM → Database safety (audit-verified)

**Enforced**: `guardrails.ts` — SELECT/WITH-only, mutation-keyword + injection-pattern rejection (string-literal-aware scan), **side-effecting-function denial** (`detectDangerousFunctions`: `pg_read_file`, `dblink`, `set_config`, `load_file`, `file()`, `url()`, `openrowset`, …), single statement, LIMIT clamped/forced to `SQL_MAX_LIMIT=100` (`constants.ts`); re-checked at the execution boundary by `assertSelectOnly()` + `assertNoDangerousFunctions()` in `real-connectors.ts` (shared function list — do NOT create a second copy, that divergence is what made the boundary weaker than the guard). **DB-layer read-only**: Postgres `SET TRANSACTION READ ONLY` + `SET LOCAL statement_timeout`, MySQL `SET TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`, ClickHouse `readonly=1` + `request_timeout`, MSSQL `readOnlyIntent` (see gap below). Driver-level timeouts (30s `QUERY_TIMEOUT_MS`) for pg/MySQL/MSSQL/ClickHouse; per-integration semaphore `SQL_MAX_CONCURRENT=3` (`tool-utils.ts`, per-instance not distributed); verified TLS by default; `queryHistory` rows + audit trail (`GUARDRAIL_BLOCK` logged critical).

**Known gaps — do not assume these exist**:
- **`SET TRANSACTION READ ONLY` does NOT cover read-type side effects.** Measured on Postgres 16 with scanners bypassed: it blocks INSERT/UPDATE/DELETE/TRUNCATE/DDL, but `pg_read_file()`, `set_config()` and `pg_sleep()` still run (they are reads). Those three are handled by the function deny-list + `statement_timeout`, not by read-only mode. Do not describe read-only mode as "blocks everything".
- **MSSQL has no per-transaction read-only mode.** `readOnlyIntent` only routes to a read replica when the server has an Availability Group; otherwise a read-write login still permits write side effects. A real fix needs an operator-granted read-only role (a customer-side DB setup step). The function deny-list covers `xp_cmdshell`/`OPENROWSET`/`BULK INSERT`/`OPENDATASOURCE`.
- `guardrails.ts` itself is a lexical scan. Since 2026-10-04 it is followed by a REAL parse (`sql-ast-guard.ts`, `node-sql-parser`) for PostgreSQL, MySQL/MariaDB and MSSQL: exactly one SELECT, no `SELECT … INTO`, functions checked as AST nodes against the shared `sql-function-denylist.ts`, system catalogs denied (including unprefixed `pg_*`), and the base tables/columns available for per-role policy. Fail-closed: an unparseable query is rejected into the repair loop (measured: 137/138 distinct real queries and 480/480 gold queries still pass). The AST runs only when `{ provider }` is passed; every production caller passes it (`invariants.test.ts`). ClickHouse stays lexical + `readonly=1`. The parse caught two measured lexical bypasses: a quoted function name (`"pg_read_file"(…)`, now also unquoted by the lexical scan) and a catalog in a quoted comma-join. The validated text is what runs — the tree is never re-serialised.
- **LIMIT 100 is enforced textually + by prompt disclosure only** — no row cap enforced at execution time (the synthesis prompt now tells the model to disclose truncation).
- The SQL repair loop regenerates on guardrail/execution errors; the one transient-network retry (ECONNRESET/ETIMEDOUT/EPIPE) re-runs *identical* SQL.

**One SQL pipeline for both transports (2026-10-04).** `src/lib/pipelines/sql-pipeline.ts` (`runSqlPipeline`) owns integration selection, the SQL rate limit, `contextPrompt`/`businessContext`/`textColumns`, the repair loop, the guardrail, `withToolSandbox` + `withSqlConcurrency`, and every `queryHistory` / audit row. `runSqlBranch` (`tool-branches.ts`) and `prepareSqlStream` (`stream-preparers.ts`) only shape the output. Before this, the streaming path — the one the web chat uses — wrote no SQL audit rows or queryHistory and skipped the rate limit, the sandbox and the integration `contextPrompt`. `pipelines/transport-parity.test.ts` drives one scripted turn through both transports and requires identical side effects; put new SQL behaviour in the pipeline, never in an adapter.

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



---

# Moved from `CLAUDE.md` — audit summary and algorithm sketches

These two sections were moved here on 2026-09-29 because `CLAUDE.md` (36 KB) plus `AGENTS.md` (30 KB) exceeded the
65,536-byte instruction budget, so the tail of the second file was truncated — including security rules. Both
sections describe the SAME subject as this file (what exists, how the pipeline decides), so they belong beside it
rather than in a second document that is read on a different occasion.

`CLAUDE.md` keeps its identity, vision, roadmap, quick reference and progress log. **Counts in the audit summary
below are historical** — that file's own header warns about this, and `grep -c` on the code is the source of truth.

## 2. Audit Summary (current state)

### 2.1 What exists and works

**Auth & tenancy**
- Scrypt password hashing (`src/lib/passwords.ts`), signed httpOnly session cookie (`src/lib/session.ts`), `AUTH_DEMO_FALLBACK=false` fail-closed mode.
- Multi-tenant: `Organization` → `User` (RBAC: admin/analyst/viewer) → all resources scoped by `organizationId` via Prisma extension.
- Login/logout routes, `/api/me` identity, setup wizard gate (`AppConfig.setupCompleted`).

**Multi-tenant architecture**
- `Organization` is the tenant root; `User.organizationId` links 1 user → 1 org. Every data model carries `organizationId`.
- Prisma tenant extension (`src/lib/prisma-tenant.ts`) auto-injects `organizationId` via AsyncLocalStorage. Use `bypassOrg()` for setup/SSO queries.
- License validation: `LICENSE_VALIDATOR_URL` env. Signup validates license before org creation (`src/lib/license-client.ts`).
- RBAC: `admin > analyst > viewer`. `requireRole(user, 'admin')` guards admin routes.
- Plan gating: `starter | pro | enterprise`. `hasPlan(user.plan, 'pro')` gates premium features (`src/lib/plan-gating.ts`).
- SSO/SAML: enterprise-tier feature, integrates with organization identity providers.
- Session: `getActiveUser()` calls `enterWithOrg()` to set context, checks license status.

**Data layer (Prisma schema — 31 models; verify with `grep -c "^model " prisma/schema.prisma`)**
- `Organization` (tenant root), `User` (RBAC `admin|analyst|viewer`), `Integration` (encrypted config), `IntegrationSchema` (reflected table/columns cache).
  **There is no `Company` model** — an earlier revision listed one. Verified: `grep -c "^model Company " prisma/schema.prisma` = 0, `companyId` = 0, `organizationId` = 93.
- `LlmConfig` + `VectorStoreConfig` (per-tenant LLM + vector store, AES-256-GCM encrypted keys).
- `Document` → `DocumentChunk` (content, keywords, embeddingJson, embeddingModel).
- `RestApiConnector` → `RestApiEndpoint` (whitelisted method+path+paramSchema).
- `ChatSession` → `ChatMessage` (citations, chartData, status).
- `ToolRun`, `RestApiRequestLog`, `ApiRequestLog`, `ApiKey`, `AuditLog`, `QueryHistory`, `SmartMapping`, `AppConfig`.

**AI pipeline (`src/lib/ai.ts` + `src/lib/tool-router.ts`)**
- `resolveBackend`: configured OpenAI/Anthropic-compatible endpoint. Fail-closed: throws `LlmNotConfiguredError` when no LLM configured (z-ai-web-dev-sdk removed).
- `routeQuery`: LLM router → `SQL | RAG | REST | CHAT` (temp=0, deterministic).
- `generateSql`: Text-to-SQL with schema description, JSON output.
- `generateAnswer` / `streamAnswer`: NL synthesis from context.
- `generateRestCall`: picks one whitelisted endpoint + builds query/body.
- Tool-toggle enforcement from `promptSettings` (admin can disable SQL/RAG/REST).
- `allowMultiStepDag` flag: when true, calls planner → executePlan → synthesizeAnswer for multi-tool queries.

**RAG (`src/lib/rag.ts`, 675 lines — the strongest subsystem)**
- Hybrid retrieval: lexical (keyword overlap + phrase hits) + semantic (cosine on stored embeddings) + external vector store (Qdrant/Milvus) + FTS (BM25-style via `rag-fts.ts`).
- Candidate selection: vector store hits → FTS chunk IDs → fallback to all chunks.
- Score fusion: `combineHybridScore(lexicalTotal, semanticSimilarity)`.
- Per-document cap (`maxPerDocument=2`) for diversity.
- Chunking: double-newline split + hard ceiling (1400 chars, 180 overlap).
- Query-level cache (in-memory, 1min TTL, 200 entries) — invalidated on document upload/delete.
- LLM reranker (opt-in `RAG_LLM_RERANK=true`): retrieves 3x candidates, LLM ranks by relevance.

**Guardrails (`src/lib/guardrails.ts`)**
- AST-walk (pure TS, mirrors spec's `sqlglot`): rejects DML/DDL, transaction control, system procs, comments, statement chaining, `INTO`, `LOAD_FILE`, system tables.
- Forces `LIMIT 100` cap, single-statement guarantee.
- `GUARDRAIL_BLOCK` audit at `critical` severity.

**Connectors (`src/lib/connectors.ts`)**
- Registry pattern: `getConnector(id, provider, config)`. Provider: POSTGRESQL | MYSQL | MSSQL | CLICKHOUSE | REST_API. **There is no `SQLITE_DEMO`** — it was removed; the UI offers only POSTGRESQL/MYSQL/MSSQL. Drivers load through the static `DRIVER_LOADERS` map in `real-connectors.ts` (invariant #3 in AGENTS.md), never a variable-specifier `import()`.
- `fetchSchema()` reflection, `executeQuery(sql)`, `describeSchema()` for LLM prompts.

**Streaming** — Real SSE token streaming via `runStreamingChatCompletion` in `tool-router.ts`. Old Socket.io WS service deleted (P1.5).

**External API (`src/app/api/v1/chat/completions/route.ts`, 288 lines)**
- OpenAI-compatible endpoint for programmatic access, API-key auth, rate limits, audit.

**Observability**
- `ToolRun` (per tool: type/status/latency/summaries), `AuditLog` (security events), `RestApiRequestLog`, `ApiRequestLog`, `QueryHistory`, monitoring + analytics routes.

**Intent Pipeline (`src/lib/intent-pipeline.ts`)**
- Intent Analyzer with document/integration/schema context + progressive slot filling.
- Contextual Query Rewriter for follow-up questions.
- Query Expansion (synonym + multilingual, max 3 expansions).
- Multi-pass Retrieval with Reflection (`retrieveWithReflection` + `mergeRetrievalResults`).
- GraphRAG via cognee `recallKnowledgeGraph` (wired into `retrieveWithReflection`).
- `evaluateAnswerConfidence` — heuristic + LLM confidence scoring.

**Schema Enrichment (`src/lib/schema-enrichment.ts`)**
- `enrichSchemaDescriptions()` — LLM-generated per-table descriptions stored in `IntegrationSchema.description`.
- `generateSchemaDescriptions()` in `ai.ts`. Wired into intent analyzer + `routeQuery` context for better SQL generation.

**Agentic Confidence Loop**
- `runAgenticLoop` — max 3 iterations, heuristic pre-check (skips LLM for obvious cases), cross-source fallback.
- `runStreamingAgenticLoop` — streaming variant for SSE. Closes G10 (single LLM call, no self-correction).

**Execution History (Scheduler)**
- `ScheduledRunLog` model — full execution history (status, answer, error, toolRuns JSON, latency, executedAt).
- `GET /api/schedules/[id]/runs` — last 50 execution logs.
- `GET /api/schedules/[id]/runs/export?format=json|csv` — export with Content-Disposition attachment header.
- UI polling (15s) + toast notification on run completion. History dialog with export buttons.

**Tests**
- 6825 unit tests across 265 files (`bun run test` — per-file subprocess runner for mock isolation), 16 Playwright e2e (`bun run e2e`), mock LLM server for determinism. **Do not trust a count you did not just run** — earlier revisions of this file said "913 across 56" long after both numbers had changed.

### 2.2 Gaps & risks (super-app blockers)

| # | Gap | Impact |
|---|-----|--------|
| G1 | **Router picks ONE tool** — no multi-step plans, no tool chaining | Cannot answer "compare DB sales with the SOP for returns" (needs SQL + RAG) |
| G2 | **No agent memory** — each message is stateless beyond chat history | No learning across sessions, no entity tracking, no relationship recall |
| G3 | **RAG is flat chunks** — no knowledge graph, no entity/relation extraction | Multi-hop reasoning ("who reports to the person who approved invoice X?") fails |
| G4 | **REST branch absent from WS service** — only HTTP tool-router has it | Streaming users can't use REST tools |
| G5 | **No scheduled/triggered runs** — purely request/response | No "every morning summarize anomalies" capability |
| G6 | ~~**SQLite**~~ — **RESOLVED 2026-07-27**: migrated to PostgreSQL 16 (pgvector + pg_trgm), 66,435 demo rows migrated | — |
| G7 | **No plugin/tool registry for third parties** — connectors are hardcoded | Not a true super-app (super-apps host external modules) |
| G8 | ~~**Embeddings stored as JSON string in SQLite**~~ — **RESOLVED 2026-07-27**: pgvector native vector storage + semantic scoring (40% keyword + 60% embedding blend) | — |
| G9 | **No streaming for REST/SQL branches in WS** — only final answer streams | User waits blind during SQL execution |
| G10 | ~~**Single LLM call per tool**~~ — **RESOLVED 2026-07-27**: agentic confidence loop (max 3 iterations, heuristic pre-check, cross-source fallback) | — |

---


## 5. Algorithms

### 5.1 Routing (current — single-tool)

```
routeQuery(question, hasIntegrations, hasDocuments, hasRestApis, smartMappingHints):
  prompt = ROUTER_SYSTEM + question + context flags + smart mapping hints
  decision = LLM(prompt, temp=0) → "SQL" | "RAG" | "REST" | "CHAT"
  if decision needs unavailable source → fallback CHAT
  if promptSettings disables decision → fallback CHAT
  return decision
```

**Limitation**: one tool per turn. Keep for fast-path single-intent queries.

### 5.2 Planning (super-app — multi-tool)

```
planQuery(question, availableTools[], memoryContext):
  prompt = PLANNER_SYSTEM
         + "Available tools: " + tools.map(t => `${t.id}: ${t.description} (${t.params})`)
         + "Prior memory: " + memoryContext
         + "Question: " + question
         + "Output JSON: { steps: [{ tool, input, dependsOn }, ...], needsSynthesis: bool }"
  plan = LLM(prompt, temp=0) → parsed JSON
  validate plan:
    - every tool.id ∈ registry
    - no circular deps
    - max 6 steps (configurable)
  return plan
```

**Execution** (DAG, topological order):
```
executePlan(plan, ctx):
  results = {}
  for step in topoSort(plan.steps):
    input = resolveInputs(step.input, results)  // substitute ${step.dependsOn.output}
    if step.tool in [SQL, REST] and not whitelisted → block + audit
    result = runTool(step.tool, input, ctx)
    results[step.id] = result
    emit status_update(step.tool, "done")
  return results
```

**Self-correction loop** (closes G10):
```
if result.error and retries < 2:
  corrected = LLM("This failed: {error}. Original input: {input}. Fix it.", temp=0)
  retry runTool(corrected)
```

### 5.3 Hybrid retrieval (current — keep, wrap cognee as outer ring)

```
retrieveRelevantChunks(query, topK):
  queryTokens = tokenize(query)
  queryEmbedding = embed(query) if embeddingConfigured
  vectorHits = vectorStore.search(queryEmbedding) if vectorStoreConfigured
  candidates = vectorHits ? loadChunks(vectorHits.ids) : loadFtsChunks(queryTokens)
  for chunk in candidates:
    lexical = scoreChunk(queryTokens, chunk)         // content + keyword + phrase
    semantic = cosine(queryEmbedding, chunk.embedding) or vectorHits[chunk.id]
    total = combineHybridScore(lexical, semantic)
  return selectTopWithDiversity(scored, topK, maxPerDocument=2)
```

**Cognee outer ring** (Phase 2+):
```
retrieveWithGraph(query, topK):
  flat = retrieveRelevantChunks(...)        // existing
  graph = cognee.recall(query, { dataset: kbDatasetFor() })  // org:<id>:kb
  // graph returns entities + relationship-aware chunks
  return mergeDedupe(flat, graph, preferGraphForMultiHop(query))
```

### 5.4 Guardrail pipeline (unchanged — already strong)

```
validateAndSanitizeLlmSql(sql):
  1. dangerous pattern scan (comments, xp_, sp_, ;, load_file, system tables)
  2. tokenize; leading keyword must be SELECT | WITH
  3. walk tokens, reject any MUTATION_KEYWORD outside string literals
  4. reject INTO, multiple statements
  5. clamp LIMIT to 100, append if missing
  return { ok, sanitized } or { ok: false, reason, detectedNodes }
```

### 5.5 Memory write-back (new — cognee Phase 1)

```
afterChatTurn(sessionId, userMsg, aiMsg, toolRuns[]):
  await cognee.remember({
    type: "chat_turn",
    user: userMsg,
    assistant: aiMsg,
    tools: toolRuns.map(t => ({ type: t.type, status: t.status, latency: t.latencyMs })),
    timestamp: now()
  }, { dataset: datasetFor(), session_id: sessionId })  // org:<id>
  // fire-and-forget; never block the response on memory write
```

### 5.6 Intent Pipeline (production RAG)

```
analyzeAndRewrite(question, sessionHistory, context):
  parallel:
    - rewriteQuery(question, sessionHistory)   // contextual follow-up resolution
    - loadSchemaContext()                       // IntegrationSchema + documents
    - recallContext(question)                   // cognee memory
  intent = analyzeIntent(question, rewritten, context)  // progressive slot filling
  expansions = expandQuery(rewritten, max=3)    // synonym + multilingual
  return { intent, rewritten, expansions, memoryContext }
```

```
retrieveWithReflection(question, expansions, topK):
  passes = []
  for q in [question, ...expansions]:
    hits = retrieveRelevantChunks(q, topK)
    passes.push({ query: q, hits })
  graph = cognee.recallKnowledgeGraph(question)   // GraphRAG outer ring
  merged = mergeRetrievalResults(passes, graph)    // dedupe + rerank
  if merged.confidence < threshold and passes.length < maxPasses:
    refined = refineQuery(question, merged.gaps)  // reflection
    merged = retrieveWithReflection(refined, [], topK)
  return merged
```

### 5.7 Agentic Confidence Loop (closes G10)

```
runAgenticLoop(question, context, maxIter=3):
  for i in 1..maxIter:
    if i == 1 and heuristicConfident(question, context):
      result = runDirect(question, context)       // skip LLM for obvious cases
    else:
      result = runTool(question, context)
    confidence = evaluateAnswerConfidence(question, result)
    if confidence >= threshold:
      return result
    // cross-source fallback: try next source if current one failed
    context = adaptContext(context, result.gaps)
  return bestResult  // highest confidence across iterations
```

`runStreamingAgenticLoop` — same logic, emits SSE events (`thinking`, `tool_start`, `tool_end`, `answer`) per iteration.

---

