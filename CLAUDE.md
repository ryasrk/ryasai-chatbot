# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Last updated 2026-10-01. Version 2.1.0. PostgreSQL 16. All PLAN.md phases P0–P5 + S4 + RAG complete. Language standardized to English.
>
> **Counts and versions in this file drift.** Section 1 and 8 describe CURRENT state — run the
> command rather than trusting a number written here; section 9 (Progress Log) is HISTORICAL and
> its numbers were true when written — do not "fix" them. When you need a number, run the command. (Section 2 was three
> releases stale — it claimed 6825 tests across 265 files when this tree measures 7206 across 289 —
> which is why it moved to docs/ rather than being re-corrected in place.)

---

## 1. Project Identity

| | |
|---|---|
| Path | `/home/ryasr/ryasai/Chatbot` |
| Stack | Next.js 16 (App Router) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui |
| Runtime | Bun for dev/test, Node standalone for prod build |
| Domain | Multi-tenant AI assistant deployed **on-prem per customer**, licensed with a signed machine-bound key: natural-language → SQL, RAG over company docs, whitelisted REST calls, streaming chat |
| Status | **Release 2.1.0** (2026-10-03). Latency. Verified by execution, not assertion: `tsc` 0 · `lint` 0 · `bun run test` 323/323 files, 7983 pass, 0 fail · coverage:gate exit 0 · `e2e` and `e2e:prod` both 19 passed |
| Version | 2.1.0 |
| Language | English (standardized — all UI, errors, system prompts, comments in English) |

---

## 2. Audit Summary (moved)

The component-by-component inventory — auth and tenancy, the data layer, the AI pipeline, guardrails, connectors,
observability, the intent pipeline, the agentic loop and the scheduler — now lives in
**`docs/architecture-reference.md`**, beside the AI/RAG internals it overlaps with.

It is there rather than here for a MEASURED reason: `CLAUDE.md` plus `AGENTS.md` came to 97 KB against a 65,536-byte
instruction budget, so the tail of `AGENTS.md` was silently truncated. Both files describe the same system, so the
inventory belongs with the architecture rather than in a history log.

**Counts there are historical.** Verify with `grep -c` against the code — this section spent months claiming
"913 tests across 56 files" long after both numbers had changed.

## 3. Super-App Vision

A **super-app** = one tenant-facing app that hosts many capabilities (tools), orchestrates them agenticly, remembers everything, and lets third parties extend it. WeGo, Grab, and ChatGPT-with-plugins are the reference shapes.

### Target state

```
User query
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Orchestrator (Planner LLM)                         │
│  intent → multi-step plan [tool₁, tool₂, tool₃]     │
│  with data deps:  tool₂.input = tool₁.output        │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Tool Registry (plugin-based)                       │
│  sql · rag · rest · web-search · code-interpreter   │
│  · email · calendar · custom-tenant-tools …         │
└─────────────────────────────────────────────────────┘
   │ per-step: execute → observe → feed back
   ▼
┌─────────────────────────────────────────────────────┐
│  Memory Layer (cognee)                              │
│  session memory (fast) + knowledge graph (persistent)│
│  entities · relationships · past runs · preferences  │
└─────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  Synthesizer (Answer LLM)                           │
│  all tool outputs + memory context → NL answer       │
│  with citations + chart data + follow-up suggestions │
└─────────────────────────────────────────────────────┘
```

### Super-app principles (non-negotiable)

1. **Tenant isolation is sacred** — every tool, every memory query, every graph traversal is scoped by `organizationId` (injected by the tenant extension, not hand-written). No cross-tenant leakage ever.
2. **Fail-closed by default** — missing config, expired key, ambiguous permission → refuse, audit, explain. Never guess.
3. **Tools are whitelisted, never free-form** — the LLM proposes a tool *id* from a registry; it cannot invent endpoints or SQL tables.
4. **Every tool run is observable** — `ToolRun` row with latency, input/output summary, status. Every guardrail block → `AuditLog` critical.
5. **Memory is editable and forgettable** — GDPR/privacy: a tenant can delete their graph, a user can forget a fact. Cognee's `forget()` maps to this.
6. **Streaming end-to-end** — status updates per step, token streaming for synthesis. User never waits blind.
7. **Deterministic where it matters** — routing and SQL gen at temp=0. Creativity only in final synthesis.

---

## 4. Cognee Integration (the memory + graph layer)

### Why cognee

- **Open-source, self-hostable** (Apache-2.0) — no vendor lock-in, tenant data stays in your infra.
- **TypeScript client exists**: `@cognee/cognee-ts` — drops into Next.js without a Python sidecar.
- **One Postgres instance for memory** — cognee 1.0 keeps vectors + sessions + metadata in Postgres (its own `cognee_db`), beside the app's data. Replaces the JSON-embedding-in-SQLite hack (G8) and the flat-chunks problem (G3) in one move. The GRAPH is the exception and stays on embedded Kuzu — upstream labels its Postgres graph adapter a demo.
- **Four operations**: `remember`, `recall`, `forget`, `improve` — matches our mental model exactly.
- **BEAM benchmark SOTA** at 100K and 10M tokens — proven for long-context agent memory.
- **MCP server** available — future-proof for tool-using agents.

### Integration shape

**Phase 1 — Parallel memory (non-destructive)**
- Add `src/lib/cognee.ts` wrapping `@cognee/cognee-ts`.
- On every chat turn: `cognee.remember({ userMessage, aiMessage, toolRuns, sessionId })` against the org dataset. **The real names are `org:<id>` and `org:<id>:kb`** (`datasetFor()` / `kbDatasetFor()` in `cognee-types.ts`), not `company:{companyId}` — an earlier revision of this section used the old naming.
- On every `routeQuery`: first call `cognee.recall(question, { session_id })` → inject top memory hits into the router prompt as "prior context".
- Keep existing RAG untouched. Measure: does recall improve follow-up questions ("what about last month?")?

**Phase 2 — Knowledge graph for documents**
- Replace/augment `DocumentChunk` flat storage with cognee `cognify` pipeline:
  - Upload doc → extract text (reuse `document-parsers.ts`) → `cognee.add()` → `cognee.cognify()`.
  - Cognee extracts entities + relationships, builds graph, stores embeddings in pgvector.
- Retrieval: `cognee.recall(question)` returns graph-grounded chunks + related entities. Falls back to existing lexical RAG if cognee unavailable.
- Per-tenant dataset isolation: `org:<id>:kb` (see above).

**Phase 3 — Agent memory across sessions**
- `improve()` after each successful tool run: store "this SQL answered this question well" as a pattern.
- On future similar questions, `recall` surfaces the prior pattern → SQL gen prompt includes "last time this worked: …".
- This closes G2 (no learning) and G10 (no self-correction).

**Phase 4 — Graph reasoning for multi-hop**
- Questions like "who approved the invoice from the vendor that also supplied last quarter's anomaly?" → cognee graph traversal finds the path.
- Planner (§5) can emit a `graph_query` tool step that calls `cognee.recall` with a structured query.

### Cognee deployment

Both composes (`docker-compose.yml`, and the one `install.sh` generates) wire cognee identically —
there is no dev/prod store split any more:

- **Relational + vector + cache: the bundled PostgreSQL**, in cognee's OWN database `cognee_db`.
  Never the app's `ryasai` database: `migrate` runs `prisma db push` on every boot, which DROPS an
  unknown table it finds EMPTY (silently), and refuses to boot at all when that table has rows.
- **Graph: embedded Kuzu**, unchanged. Upstream labels its Postgres graph adapter a demo ("not
  production-ready"), so the `cogneedata` volume is still required.
- **`cognee-db-init`** (one-shot) creates `cognee_db` before cognee starts; cognee declares
  `depends_on: {cognee-db-init: {condition: service_completed_successfully}}`, because a missing
  database makes cognee exit(1) — under `restart: unless-stopped` that reads as a crash loop.
- **No `CACHE_DB_URL`.** With `CACHE_BACKEND=postgres` and the URL unset the cache reuses the
  relational database; a separate cache database aborts alembic `c3d5e7f9a1b2` and the sidecar
  never becomes healthy.
- Env names are cognee's, UNPREFIXED (`DB_*`, `VECTOR_DB_*`, `CACHE_BACKEND`, `GRAPH_DATABASE_*`);
  the `COGNEE_*` names belong to this app's `.env` and are not read by the sidecar. `LLM_*` /
  `EMBEDDING_*` deliberately live in `.env.cognee`, NOT in `environment:` (which always overrides).
- Guarded by `src/lib/cognee-store-wiring.test.ts`, which reads BOTH composes: every one of these
  reverts SILENTLY in production — cognee boots fine on the wrong store, it just writes where
  nobody looks.
- **Isolation**: cognee datasets are namespaced `org:<id>`. The wrapper in `cognee-types.ts` is the only place a dataset name is built, so no call can reach a name without an org. Verified against the code, not the design sketch.

### When NOT to use cognee

- < 50 documents and no multi-hop needs → existing RAG is simpler and faster. Cognee adds a Postgres dependency.
- Small deployment with no cross-session memory need → overkill.
- **Decision gate**: adopt cognee only when G2 (memory) OR G3 (multi-hop graph) becomes the blocker. Until then, the flat RAG is sufficient.

---

## 5. Algorithms (moved)

The routing, planning, hybrid-retrieval, guardrail, memory-write and agentic-loop sketches are in
**`docs/architecture-reference.md`**.

They describe the pipeline, so they sit with the pipeline. The sketches are DESIGN INTENT: where the shipped code
differs, the code wins — check the module before quoting a formula from here.

## 6. Best Practices (enforced)

### Security
- **Encrypt at rest**: all integration configs, LLM keys, vector store keys → AES-256-GCM (`src/lib/crypto.ts`). Never log decrypted values.
- **SQL guardrails**: every LLM-generated SQL passes `validateAndSanitizeLlmSql` before execution. No exceptions, no bypass flag.
- **REST whitelisting**: only `RestApiEndpoint` rows with `isEnabled=true` are callable. LLM cannot invent paths.
- **Tenant scoping**: the Prisma extension in `prisma-tenant.ts` injects `organizationId` from AsyncLocalStorage — it is NOT written into each `where` by hand, and there is no `companyId`. Two rules that ARE load-bearing: (a) every route must call `enterWithOrg(...)` itself (`enterWith` does not propagate to the caller's frame), enforced by `tenant-route-guard.test.ts`; (b) loading a row by a CLIENT-SUPPLIED id must use `findFirst`, never `findUnique`, because the extension cannot scope a unique `where`.
- **API keys**: hashed (`keyHash`), prefix-only stored, rate-limited, revocable, audit-logged.
- **Session cookies**: `httpOnly`, `sameSite=lax`, `secure` in prod, signed.

### Reliability
- **Fail-closed**: missing LLM key → 401/500 with message, never fallback to unbounded behavior.
- **Timeouts**: every external call uses `AbortSignal.timeout()` (60s LLM, 30s REST, 120s stream).
- **Idempotent writes**: `persistAiMessage` catches duplicate session errors gracefully.
- **Graceful degradation**: no integrations → CHAT; no documents → CHAT; vector store down → lexical fallback; embedding API down → lexical fallback.

### Performance
- **Schema reflection cache**: `IntegrationSchema` avoids re-reflection per query.
- **Candidate narrowing**: FTS/vector hits → load only those chunks, not all.
- **Per-document diversity cap**: `maxPerDocument=2` prevents one doc dominating.
- **Streaming**: status updates per phase, tokens for synthesis. User sees progress.

### Testing
- `bunx tsc --noEmit` — zero errors.
- `bun run lint` — zero errors.
- `bun run test` — per-file subprocess runner, must report 0 fail (the runner prints the real count; READ THAT, not a number written here — this line said 265 for three releases after it changed). Any new lib file ships with `*.test.ts`.
- `bun run e2e` — 16 golden-path specs with mock LLM, keep green. Also run `bun run e2e:prod` before shipping; dev and the standalone build diverge.
- **New rule for super-app work**: every new tool in the registry ships with a unit test for its executor + a guardrail test if it touches external systems.

### Code conventions (observed)
- Server-only libs in `src/lib/`, never import `db` or `crypto` into client components.
- Types in `src/lib/types.ts` — single source for client-facing shapes.
- Views in `src/components/views/` — one per nav target.
- API routes in `src/app/api/` — RESTful, multi-tenant (organizationId via Prisma extension).
- Mini-services are independent processes with their own PrismaClient.
- English in all user-facing strings (system prompts, error messages, UI labels).
- Comments explain *why*, not *what*. The codebase already follows this — keep it.

---

## 7. Implementation Roadmap

### Phase S0 — Hardening ✅
- [x] WS service deleted (P1.5) — streaming now via SSE in tool-router
- [x] Stream status updates during SQL/REST execution
- [x] Add retry-on-SQL-error in planner self-correction (G10)
- [x] Documented in README.md

### Phase S1 — Agentic planner ✅ (closes G1)
- [x] `src/lib/planner.ts` — `planQuery()`, `executePlan()`, `synthesizeAnswer()`
- [x] `src/lib/tool-registry.ts` — built-in + plugin tools
- [x] `executePlan()` DAG runner with status emits + self-correction
- [x] API: `POST /api/v1/agent/run` + `POST /api/agent/dashboard` (SSE)
- [x] Tests: planner.test.ts (topoSort, parse, validate)

### Phase S2 — Cognee memory ✅ (closes G2, G3)
- [x] `src/lib/cognee.ts` wrapper (recall, remember, cognify, forget)
- [x] `COGNEE_ENABLED` env flag, local mode (SQLite+Kuzu+LanceDB)
- [x] Chat-turn remember + router recall injection
- [x] Document cognify pipeline
- [x] Tests: cognee.test.ts (8 tests, skip when cognee unavailable)

### Phase S3 — Plugin extensibility ✅ (closes G7)
- [x] `src/lib/plugin-registry.ts` — manifest, executePlugin, SSRF guard
- [x] 9 prebuilt plugins (weather, Wikipedia, translate, calculator, news, etc.)
- [x] `src/lib/plugin-selector.ts` — semantic relevance matching
- [x] External webhook executor with timeout + output cap
- [x] Tests: plugin-registry.test.ts, plugin-selector.test.ts

### Phase S4 — Scale (closes G6, G8) ✅
- [x] `docs/postgres-migration.md` — 7-step migration guide
- [x] Schema Postgres-compatible (String for JSON, no SQLite-specific types)
- [x] Code adaptation (connectors.ts PRAGMA→information_schema, rag-fts.ts FTS5→tsvector)
- [x] Postgres 16 + pgvector + pg_trgm deployed, all demo data migrated (66,435 rows: ERP 72, Chinook 14,926, World 5,298, Pagila 46,211)

### Phase S5 — Automation ✅ (closes G5)
- [x] `ScheduledRun` model + `mini-services/scheduler/` worker
- [x] Notification API (webhook + email + Telegram)
- [x] Scheduler delivers results via notification config

---

## 8. Quick Reference

### Commands
```bash
bun run dev          # dev server on $PORT (3000 default)
bun run build        # standalone build → .next/standalone
bun run start        # prod standalone server
bun run test         # unit tests (per-file runner for mock isolation — read the count it prints)
bun run e2e          # Playwright (16 specs, mock LLM + mock license validator)
bun run lint         # eslint (0 errors)
bunx tsc --noEmit    # typecheck (0 errors)
bunx prisma db push  # apply schema to PostgreSQL
bunx prisma generate # regenerate Prisma client
bash start.sh        # start Next.js + scheduler
bash reset.sh        # reset DB + re-seed
```

### Key files
| File | Role |
|------|------|
| `src/lib/ai.ts` | LLM client, router, SQL gen, answer gen, streaming |
| `src/lib/tool-router.ts` | Dispatcher + agentic confidence loop + streaming dispatcher |
| `src/lib/tool-branches.ts` | Non-streaming branch executors (SQL/RAG/REST/CHAT/Plugin) |
| `src/lib/stream-preparers.ts` | Streaming branch preparers (prepare*Stream) |
| `src/lib/tool-utils.ts` | Shared types + leaf utilities (chart/citation/SQL semaphore) |
| `src/lib/rag.ts` | Hybrid retrieval, chunking, keyword extraction |
| `src/lib/rag-fts.ts` | BM25-style FTS chunk ID search |
| `src/lib/guardrails.ts` | SQL AST validation + mutation block + LIMIT cap |
| `src/lib/connectors.ts` | DB connector registry + schema reflection |
| `src/lib/rest-api-connectors.ts` | REST endpoint matching + auth headers |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt, session signing |
| `src/lib/embeddings.ts` | Embedding API client + cosine + hybrid fusion |
| `src/lib/vector-stores.ts` | Qdrant/Milvus/INTERNAL vector store abstraction |
| `src/lib/smart-mapping.ts` | Source→entity field maps for routing hints |
| `src/lib/intent-pipeline.ts` | Intent analysis, query rewriting, expansion, reflection, confidence |
| `src/lib/schema-enrichment.ts` | LLM-generated per-table schema descriptions |
| `src/lib/prompt-settings.ts` | Per-tenant system prompt + tool toggles |
| `mini-services/scheduler/index.ts` | Cron-based scheduled run worker |
| `src/app/api/v1/chat/completions/route.ts` | OpenAI-compatible external API |
| `prisma/schema.prisma` | 31 models, multi-tenant, encrypted configs |

### Specs & progress
- `PLAN.md` — overhaul plan (all phases P0–P5 + S4 + RAG complete)
- `README.md` — quick start, commands, project structure
- `docs/postgres-migration.md` — SQLite → Postgres migration guide

---

## 9. Progress Log

> Append a new dated entry per session. Keep it short: what was done, what's next.
> This is the single source of truth for cross-session continuity.

### Ringkasan historis (2026-07-24 → 2026-08-14)

Entri lengkap periode itu dipindahkan ke `docs/progress-log-archive.md` pada 2026-09-25 — lihat
alasan terukurnya di kepala berkas itu. Ringkasnya: audit awal + rencana super-app (G1–G10) → S0–S5
implementasi (planner, cognee, plugin, scheduler, Postgres) → perombakan UI/UX + tema → Smart Router
→ perombakan single-tenant yang **kemudian DIBATALKAN** (multi-tenant tetap dipakai) → konektor DB
nyata + typed errors → arsitektur RAG produksi + migrasi Postgres → perbaikan isolasi tes →
pemecahan `tool-router.ts` → algoritma kualitas P1 (pola LightRAG) → verifikasi UI + audit kontras.

### 2026-09-30 (b) — Release 1.4.0: AI Memory gets its own extraction model, and the sub-menu names its consumer

**Version 1.3.0 → 1.4.0** (minor: a new user-facing capability, no breaking change). Eight stamped locations bumped, CHANGELOG heading cut, `main` fast-forwarded, tag `v1.4.0` pushed, all six image tags verified published, then **deployed and confirmed live** — `/api/v1/health` reports 1.4.0, all six services healthy, and the served `install.sh` updated to 1.4.0 (sha256 identical to the tested copy).

**The sub-menu now says which consumer it configures.** `Chat Configuration` / `AI Memory Configuration` / `Embedding`, replacing "LLM / Embedding / AI Memory" — where two of the three fed DIFFERENT consumers with different credentials and neither name said which.

**Memory can have its own model**, stored as an `LlmConfig` row with `purpose: 'memory'` (the table's unique key is `(organizationId, purpose)`, so no schema change). Extraction is high-volume and structure-bound where a fast model is the better trade, and the previous mechanism was a hard COPY of the chat row. **The fallback is the load-bearing part**: unset means FOLLOW CHAT, so every upgrading install keeps working — verified on production, where no `memory` row exists and the boot log reads `Memory provider shared with cognee: Shared openai/cbcn/deepseek-v4-flash`.

**Storage facts come from the sidecar**, measured live: `relational_db=postgres, vector_db=pgvector, graph_db=kuzu, file_storage=local`. `getCogneeGraphProvider()` was deliberately NOT used as the source — it derives the graph backend from a field its own comment calls INERT, so it is right only by coincidence.

**Two limits found by probing the sidecar, reported instead of worked around:** `save_llm_config` stores provider/model/api_key and has NO endpoint field (four spellings posted, all stored `''`), so the endpoint is saved app-side and surfaced as the exact `OPENAI_API_BASE=` line; and the settings API exposes no embedding parameters, so the Embedding tab REPORTS the memory embedder rather than offering a field that could not take effect.

**Negative-controlled 21/21, and the control changed the code twice** — the recurring value of running it: (1) the test guarding ENCRYPTION of a billable credential asserted only that the mocked encryptor had been CALLED, so a route calling it and storing plaintext passed; it now reads the stored payload and decrypts it back, with the UPDATE arm covered separately (the harness proved those are separate write sites by only breaking one). (2) The rename guard asserted the new label but not the absence of the old, so reverting to `LLM` stayed green.

**Verified:** tsc 0 · lint 0 errors · 300/300 files, 7431 pass, 0 fail · coverage:gate exit 0 (203 gated modules; new route floored at 98 against a measured 99.37%) · e2e dev 18 · e2e:prod 18.

### 2026-09-30 (c) — Release 1.5.0 *(moved to the archive: the memory panel leads with state)*

**Version 1.4.0 → 1.5.0.** The AI Memory tab states which consumer is in use before offering any field; in the
follow-chat state the fields are gone, because a blank form invites pinning memory to the chat model forever.
`mode` is declared and deliberately NOT read (an enabled install with a down sidecar reports `mode: 'disabled'`).
Negative-controlled on the frozen bytes: planting the `mode` read breaks 2 tests at md5 `80b94ebd…`.

### 2026-10-01 — Release 1.6.0 *(moved to the archive: one IDOR, one PII leak, six row-cap bypasses)*

**Release 1.6.0.** A live cross-tenant IDOR (`Order` was missing from `ORG_SCOPED_MODELS`, so
`GET /api/billing/orders/[id]` served any org's order), a cross-tenant PII leak in the process-global trace ring
buffer (`enterWithOrg` is NOT scoping for in-process memory), six row-cap bypasses including two corruptions
introduced while fixing them, and three silent-failure classes. Full detail: `docs/progress-log-archive.md`.

### 2026-10-01 (b) — v1.7.0–v1.7.2 *(moved to the archive: faster answers, a security pass, two corrections)*

First token 9.3 s → 7.6 s (p95 43.3 s → 11.3 s once timeouts stopped being retried), `bun audit` 130 → 0, and
`restoreDocVersion` stopped orphaning `KgRelation` rows. Two audit findings were corrected as wrong (the HNSW index
exists; three "missing indexes" had no query). Full detail: `docs/progress-log-archive.md`.

### 2026-10-04 — unreleased: one pipeline per tool, a parsed SQL guard, per-role data access

Driven by a repo audit (architecture 7.5, Text-to-SQL security 7.5, RAG 8.0). Unreleased on `dev`; version unchanged.

- **The two chat transports had drifted on SQL.** `prepareSqlStream` — the web chat — wrote no `GUARDRAIL_BLOCK` /
  `SQL_EXECUTE` audit and no `queryHistory`, and skipped the SQL rate limit, `withToolSandbox`, the integration
  `contextPrompt` and `textColumns`. `pipelines/sql-pipeline.ts` and `pipelines/rag-pipeline.ts` now own the logic;
  `transport-parity.test.ts` drives one turn through both transports and requires identical side effects.
- **Parsed SQL guard** (`sql-ast-guard.ts`, `node-sql-parser`, ADR 0013), fail-closed, after the lexical scan.
  Measured first: 137/138 distinct real queries and 480/480 gold queries pass. It caught two lexical bypasses —
  `"pg_read_file"(…)` (quoted name; the scan now unquotes too) and a catalog in a quoted comma-join.
- **Per-role access** (ADR 0014): `Integration.accessMode` + `DataAccessPolicy` (tables/columns for analyst/viewer),
  `Document.allowedRoles`. Enforced in the generator's schema view, the AST guard, the router's document scope and the
  document/integration read routes. Migration `20261004000002_data_access_policy`.
- **Static security corpus** (`bun run sql-security-eval`, in CI): 381 attacks 0 bypasses, 66 controls 0 blocked.
  Negative control: the lexical scan alone lets 76 through (20 catalog, 56 policy).
- **Authorization defects found on the way**: document version create/restore and schema `?refresh=1` were open to
  every role (now admin); integration detail/schema served every sample row to every role (now filtered).
- MSSQL runs each query in an always-rolled-back transaction; MySQL bounds execution server-side
  (`max_execution_time` / MariaDB `max_statement_time`); "Test connection" reports a login that can write.
- `module-budget.test.ts` ratchets 3 import cycles and 9 modules over 800 lines.
- **Corrected audit claim:** the retrieval fallback `loadAllCandidateChunks` is bounded (≤3 documents) and only runs
  when FTS and vectors both return nothing — not a full scan.

Not done. Needs a live LLM to measure: fencing schema/sample data in the SQL prompt, and the larger RAG/SQL evals with
an independent judge. Not started: the 1M-chunk retrieval load test, numeric-grounding checks, the real-PDF e2e, and
splitting `real-connectors.ts`.

Verified: tsc 0 · lint 0 errors · 348 files, 8,243 pass, 0 fail · coverage:gate OK (220 modules, 76.83%) · build ·
e2e 19 · e2e:prod 19 · `sql-security-eval` 381/381 blocked, 66/66 allowed.

### 2026-10-03 (b) — v2.1.0: retrieval stops waiting for the routing verdict

**Median first token 7.8 s -> 5.5 s on document questions (-31%); full eval 63/63, the best recorded.**
The 8 s decomposed into four stages, two of which (retrieval+rerank 2.2 s, reflection 1.7 s) waited for a routing
verdict they never read. `speculative-retrieval.ts` starts retrieval alongside intent analysis on both transports and
cancels it when the turn routes away; `retrieveWithReflection` and `retrieveRelevantChunks` take an AbortSignal and
check it BEFORE each model call (reflection, rerank, second pass).

**The cancellation depth was the whole fix, and the first version got it wrong.** Checking only between stages left an
unused rerank running (3.1-3.6 s), and the compound/DAG path measured 22.5 s -> **46.7 s** — slower with speculation
ON. After threading the signal into the retrieval: 43.2 s -> 23.0 s on that path, SQL turns level (9.248 -> 9.245 s),
and the compound question went 5/8 -> **8/8** correct. Scope safety is asserted, not assumed: a speculative result is
reused only for the exact request (question, topK, document set) and a cancelled one is never reused.
`SPECULATIVE_RETRIEVAL=false` restores the serial order.

Also: two floors the PR #45 merge left behind (`mcp-client` 51 vs 84.50% measured, `plugin-registry` 65 vs 77.08% —
the PR's tests were committed without the floors they earn, caught by `coverage-floor-consistency.test.ts`), and
`intent-pipeline` 64 -> 63 (denominator grew 574 -> 609, hits 373 -> 388).

Verified: tsc 0 · lint 0 · 323 files, 7,983 pass, 0 fail · coverage gate OK (209 modules) · build · e2e 19 ·
e2e:prod 19 · eval 63/63. One negative control FAILED to fail (inner-retrieval signal threading had no test) and one
wiring guard was missing entirely (non-streaming transport) — both found by running the controls, both now covered.

### 2026-10-03 — v2.0.0: security architecture

Six parallel streams, integration-reviewed before landing (the review caught three real defects in the first pass —
all fixed with the measurement recorded): memory-queue shedding at 1,000 pending; Redis-shared rate limiting on the
LLM routes (middleware moved to `runtime='nodejs'` — the Edge build stubbed `node:net`, so the counter silently never
reached Redis while shipping ~700 KB of dead ioredis); a tamper-evident audit hash chain with a verify script whose
exit codes are the contract; opt-in RLS via `scripts/enable-rls.ts` (its first version crashed on real Postgres —
`IN (${array})` binds as one parameter and `information_schema.tables` has no `table_owner`; both fixed and the test
now models the real catalog); per-org daily token/request budgets that make NO db call when unset; and a consolidated
tool-policy layer (ALLOW/DENY with reasons, compatibility-checked against `applyToolGating` across 32 cases, router
adoption deliberately deferred). Also: SECURITY.md de-staled, four ADRs (0009-0012), digest pinning in install.sh,
native fs walk replacing `execSync('du -sb')`, PR #45 merged with its dropped `allowIds` scoping restored.

An e2e failure that looked like a product defect was traced to a zombie standalone server on port 3000 stealing
BullMQ jobs with the wrong DATABASE_URL — reproduced (embed 0/1 with the zombie, 1/1 after killing it), then both
suites green: **e2e 19 and e2e:prod 19**. Eval 61/63; both misses are `majemuk-dok-db`, at 60% across 45 historical
samples. tsc 0 · lint 0 · 322 files, 7,938 pass, 0 fail · coverage gate OK (208 modules) · build.

### 2026-10-01 (c) — v1.7.8: routing accuracy — role-aware sources, a second chance after an empty database, both halves of a compound question

**The routing error class was narrow.** Over 526 document questions in an eval, 5.7% reached the database, and they
concentrated on two phrasings whose WORDS look like a data query while the answer is a policy figure. Three fixes, each
negative-controlled at N=20–40 per arm:

- **A database that cannot answer defers to the documents** (`sql-answerability.ts`, new). The verdict is read from the
  ROWS — empty, all-NULL, or the generator's improvised "tidak tersedia" row — never from the answer's wording, which
  is a documented failure class here. Needs documents present, is skipped when the user PINNED the database, and is a
  SECOND ATTEMPT: rows that answer are kept, and if the documents find nothing the database answer stands.
  49/60 → 56/60 on the affected questions; 24/24 genuine database questions unaffected.
- **Tool descriptions state the ROLE.** `sql` answers what the records SAY, `rag` what the rules DEFINE. Reverting the
  wording dropped the right choice 20/20 → 13/20; with it 240/240 at N=40. In the tool schemas, not the rule list,
  because the rule list already costs ~37pp per rule.
- **Every tool call is resolved, not just `result[0]`.** MEASURED: the model asked for BOTH sources on 5 of 16 tries of
  a two-part question. The pre-existing trigger could never fire — it reads a marker from the model's TEXT and a
  tool-calling reply has none (0 of 40). 4/12 → 11/12 on the old compound question; 6/12 on a new one.

**Two of my own hypotheses were wrong**, recorded rather than dropped: the NULL rerank scores were not "unranked" (the
reranker endorses ~2.24 of ~12; the rest are REJECTED — see 1.7.7), and the local reranker is not blind (only
production carries the 377-char prefix). **One guard was vacuous**: deleting the line returning `extraTools` left every
test green, because the selector guards asserted source TEXT and the router test mocks the selector; behaviour is now
driven through the real module.

**Verified:** tsc 0 · lint 0 · 315 files, 7712 pass, 0 fail · coverage:gate OK (204 modules) · build · e2e 19 ·
e2e:prod 19. Full eval: **62/63** (was 53/54 before this work).

