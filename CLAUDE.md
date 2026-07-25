# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Audit performed 2026-07-24. Plan targets super-app evolution on top of the
> existing production chatbot.

---

## 1. Project Identity

| | |
|---|---|
| Path | `/home/ryasr/ryasai/Chatbot` |
| Stack | Next.js 16 (App Router) · React 19 · TypeScript 5 · Prisma 6 · SQLite · Bun · Socket.io · Tailwind 4 · shadcn/ui |
| Runtime | Bun for dev/test, Node standalone for prod build |
| Domain | Multi-tenant enterprise AI assistant: natural-language → SQL, RAG over company docs, whitelisted REST calls, streaming chat |
| Status | **Production ready** (2026-07-02): fail-closed auth, 61 unit tests + 4 e2e green, standalone build verified |
| Version | 0.2.0 |

---

## 2. Audit Summary (current state)

### 2.1 What exists and works

**Auth & tenancy**
- Scrypt password hashing (`src/lib/passwords.ts`), signed httpOnly session cookie (`src/lib/session.ts`), `AUTH_DEMO_FALLBACK=false` fail-closed mode.
- Single admin per deployment; `Company` → `User` (RBAC: admin/manager/staff) → all resources scoped by `companyId`.
- Login/logout routes, `/api/me` identity, setup wizard gate (`AppConfig.setupCompleted`).

**Data layer (Prisma schema — 16 models)**
- `Company`, `User`, `Integration` (encrypted config), `IntegrationSchema` (reflected table/columns cache).
- `LlmConfig` + `VectorStoreConfig` (per-tenant LLM + vector store, AES-256-GCM encrypted keys).
- `Document` → `DocumentChunk` (content, keywords, embeddingJson, embeddingModel).
- `RestApiConnector` → `RestApiEndpoint` (whitelisted method+path+paramSchema).
- `ChatSession` → `ChatMessage` (citations, chartData, status).
- `ToolRun`, `RestApiRequestLog`, `ApiRequestLog`, `ApiKey`, `AuditLog`, `QueryHistory`, `SmartMapping`, `AppConfig`.

**AI pipeline (`src/lib/ai.ts` + `src/lib/tool-router.ts`)**
- `resolveBackend`: per-tenant OpenAI-compatible endpoint OR sandbox `z-ai-web-dev-sdk` fallback.
- `routeQuery`: LLM router → `SQL | RAG | REST | CHAT` (temp=0, deterministic).
- `generateSql`: Text-to-SQL with schema description, JSON output.
- `generateAnswer` / `streamAnswer`: NL synthesis from context.
- `generateRestCall`: picks one whitelisted endpoint + builds query/body.
- Tool-toggle enforcement from `promptSettings` (admin can disable SQL/RAG/REST).

**RAG (`src/lib/rag.ts`, 536 lines — the strongest subsystem)**
- Hybrid retrieval: lexical (keyword overlap + phrase hits) + semantic (cosine on stored embeddings) + external vector store (Qdrant/Milvus) + FTS (BM25-style via `rag-fts.ts`).
- Candidate selection: vector store hits → FTS chunk IDs → fallback to all chunks.
- Score fusion: `combineHybridScore(lexicalTotal, semanticSimilarity)`.
- Per-document cap (`maxPerDocument=2`) for diversity.
- Chunking: double-newline split + hard ceiling (1400 chars, 180 overlap).

**Guardrails (`src/lib/guardrails.ts`)**
- AST-walk (pure TS, mirrors spec's `sqlglot`): rejects DML/DDL, transaction control, system procs, comments, statement chaining, `INTO`, `LOAD_FILE`, system tables.
- Forces `LIMIT 100` cap, single-statement guarantee.
- `GUARDRAIL_BLOCK` audit at `critical` severity.

**Connectors (`src/lib/connectors.ts`)**
- Registry pattern: `getConnector(id, provider, config)`. Provider: POSTGRESQL | MYSQL | MSSQL | SQLITE_DEMO | REST_API.
- `fetchSchema()` reflection, `executeQuery(sql)`, `describeSchema()` for LLM prompts.

**Streaming (`mini-services/chat-service/index.ts`, 736 lines)**
- Independent Bun process on port 3003, Socket.io path `/`, Caddy-routed.
- Protocol: `user_message` → `status_update` → `text_stream` → `message_complete`.
- Per-socket promise chain (no interleaving), identity verification against DB (tenant + session ownership).
- Branches: SQL / RAG / CHAT (REST not yet wired into WS — only in HTTP tool-router).

**External API (`src/app/api/v1/chat/completions/route.ts`, 288 lines)**
- OpenAI-compatible endpoint for programmatic access, API-key auth, rate limits, audit.

**Observability**
- `ToolRun` (per tool: type/status/latency/summaries), `AuditLog` (security events), `RestApiRequestLog`, `ApiRequestLog`, `QueryHistory`, monitoring + analytics routes.

**Tests**
- 61 unit tests (`bun test`), 4 Playwright e2e (`bun run e2e`), mock LLM server for determinism.

### 2.2 Gaps & risks (super-app blockers)

| # | Gap | Impact |
|---|-----|--------|
| G1 | **Router picks ONE tool** — no multi-step plans, no tool chaining | Cannot answer "compare DB sales with the SOP for returns" (needs SQL + RAG) |
| G2 | **No agent memory** — each message is stateless beyond chat history | No learning across sessions, no entity tracking, no relationship recall |
| G3 | **RAG is flat chunks** — no knowledge graph, no entity/relation extraction | Multi-hop reasoning ("who reports to the person who approved invoice X?") fails |
| G4 | **REST branch absent from WS service** — only HTTP tool-router has it | Streaming users can't use REST tools |
| G5 | **No scheduled/triggered runs** — purely request/response | No "every morning summarize anomalies" capability |
| G6 | **SQLite** — fine for single-tenant demo, ceiling for multi-tenant scale | Write contention, no concurrent tenants at scale |
| G7 | **No plugin/tool registry for third parties** — connectors are hardcoded | Not a true super-app (super-apps host external modules) |
| G8 | **Embeddings stored as JSON string in SQLite** — cosine computed in JS | O(n) scan per query; fine at <1k chunks, collapses at 10k+ |
| G9 | **No streaming for REST/SQL branches in WS** — only final answer streams | User waits blind during SQL execution |
| G10 | **Single LLM call per tool** — no retry, no self-correction | One bad SQL = dead end, no re-plan |

---

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

1. **Tenant isolation is sacred** — every tool, every memory query, every graph traversal carries `companyId`. No cross-tenant leakage ever.
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
- **Single-Postgres memory layer** (cognee 1.0) — graph + vectors + sessions + metadata in one Postgres. Replaces the JSON-embedding-in-SQLite hack (G8) and the flat-chunks problem (G3) in one move.
- **Four operations**: `remember`, `recall`, `forget`, `improve` — matches our mental model exactly.
- **BEAM benchmark SOTA** at 100K and 10M tokens — proven for long-context agent memory.
- **MCP server** available — future-proof for tool-using agents.

### Integration shape

**Phase 1 — Parallel memory (non-destructive)**
- Add `src/lib/cognee.ts` wrapping `@cognee/cognee-ts`.
- On every chat turn: `cognee.remember({ userMessage, aiMessage, toolRuns, sessionId })` with `dataset=company:{companyId}`.
- On every `routeQuery`: first call `cognee.recall(question, { session_id })` → inject top memory hits into the router prompt as "prior context".
- Keep existing RAG untouched. Measure: does recall improve follow-up questions ("what about last month?")?

**Phase 2 — Knowledge graph for documents**
- Replace/augment `DocumentChunk` flat storage with cognee `cognify` pipeline:
  - Upload doc → extract text (reuse `document-parsers.ts`) → `cognee.add()` → `cognee.cognify()`.
  - Cognee extracts entities + relationships, builds graph, stores embeddings in pgvector.
- Retrieval: `cognee.recall(question)` returns graph-grounded chunks + related entities. Falls back to existing lexical RAG if cognee unavailable.
- Per-tenant dataset isolation: `dataset=company:{companyId}:kb`.

**Phase 3 — Agent memory across sessions**
- `improve()` after each successful tool run: store "this SQL answered this question well" as a pattern.
- On future similar questions, `recall` surfaces the prior pattern → SQL gen prompt includes "last time this worked: …".
- This closes G2 (no learning) and G10 (no self-correction).

**Phase 4 — Graph reasoning for multi-hop**
- Questions like "who approved the invoice from the vendor that also supplied last quarter's anomaly?" → cognee graph traversal finds the path.
- Planner (§5) can emit a `graph_query` tool step that calls `cognee.recall` with a structured query.

### Cognee deployment

- **Dev**: cognee local mode (SQLite + LanceDB + Kuzu, zero services). Env: `LLM_API_KEY` reuses tenant's key.
- **Prod**: single Postgres with `pgvector` + cognee's Postgres graph backend. One container, one DB. Env:
  ```
  DB_PROVIDER=postgres
  VECTOR_DB_PROVIDER=pgvector
  GRAPH_DATABASE_PROVIDER=postgres
  CACHE_BACKEND=postgres
  ```
- **Isolation**: cognee datasets are namespaced `company:{companyId}`. Enforce in `src/lib/cognee.ts` wrapper — never let a raw `companyId`-less call through.

### When NOT to use cognee

- < 50 documents and no multi-hop needs → existing RAG is simpler and faster. Cognee adds a Postgres dependency.
- Single-tenant demo with no cross-session memory need → overkill.
- **Decision gate**: adopt cognee only when G2 (memory) OR G3 (multi-hop graph) becomes the blocker. Until then, the flat RAG is sufficient.

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
retrieveRelevantChunks(companyId, query, topK):
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
retrieveWithGraph(companyId, query, topK):
  flat = retrieveRelevantChunks(...)        // existing
  graph = cognee.recall(query, { dataset: `company:${companyId}:kb` })
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
afterChatTurn(companyId, sessionId, userMsg, aiMsg, toolRuns[]):
  await cognee.remember({
    type: "chat_turn",
    user: userMsg,
    assistant: aiMsg,
    tools: toolRuns.map(t => ({ type: t.type, status: t.status, latency: t.latencyMs })),
    timestamp: now()
  }, { dataset: `company:${companyId}`, session_id: sessionId })
  // fire-and-forget; never block the response on memory write
```

---

## 6. Best Practices (enforced)

### Security
- **Encrypt at rest**: all integration configs, LLM keys, vector store keys → AES-256-GCM (`src/lib/crypto.ts`). Never log decrypted values.
- **SQL guardrails**: every LLM-generated SQL passes `validateAndSanitizeLlmSql` before execution. No exceptions, no bypass flag.
- **REST whitelisting**: only `RestApiEndpoint` rows with `isEnabled=true` are callable. LLM cannot invent paths.
- **Tenant scoping**: every DB query includes `where: { companyId }`. Lint rule: grep for `db.*findMany` without `companyId` in code review.
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
- `bun run test` — 61+ unit tests, keep green. Any new lib file ships with `*.test.ts`.
- `bun run e2e` — 4 golden-path specs with mock LLM, keep green.
- **New rule for super-app work**: every new tool in the registry ships with a unit test for its executor + a guardrail test if it touches external systems.

### Code conventions (observed)
- Server-only libs in `src/lib/`, never import `db` or `crypto` into client components.
- Types in `src/lib/types.ts` — single source for client-facing shapes.
- Views in `src/components/views/` — one per nav target.
- API routes in `src/app/api/` — RESTful, `companyId` from session.
- Mini-services are independent processes with their own PrismaClient.
- Indonesian in user-facing strings (system prompts, error messages, UI labels).
- Comments explain *why*, not *what*. The codebase already follows this — keep it.

---

## 7. Implementation Roadmap

### Phase S0 — Hardening (before super-app work)
- [ ] Wire REST branch into `mini-services/chat-service` (G4) — mirror `tool-router.runRestBranch`.
- [ ] Stream status updates during SQL/REST execution in WS (G9).
- [ ] Add retry-on-SQL-error in `runSqlBranch` (G10, minimal version).
- [ ] Document the `bun run` scripts in README (dev/build/start/test/e2e/db:*).

### Phase S1 — Agentic planner (closes G1)
- [ ] `src/lib/planner.ts` — `planQuery()` per §5.2.
- [ ] `src/lib/tool-registry.ts` — registry of `{ id, description, params, executor, requiresWhitelist }`.
- [ ] Refactor `tool-router` executors into registered tools (`sql`, `rag`, `rest`, `chat`).
- [ ] `executePlan()` DAG runner with status emits.
- [ ] New API: `POST /api/v1/agent/run` — programmatic multi-step.
- [ ] Tests: planner output validation, topo-sort, circular-dep rejection, tool-not-in-registry block.

### Phase S2 — Cognee memory (closes G2, G3)
- [ ] `npm i @cognee/cognee-ts`, add `src/lib/cognee.ts` wrapper (dataset = `company:{companyId}`).
- [ ] Add `COGNEE_*` env vars; local mode for dev, Postgres for prod.
- [ ] Phase 1: chat-turn remember + router recall injection.
- [ ] Phase 2: document `cognify` pipeline alongside existing RAG.
- [ ] Migration path: feature flag `COGNEE_ENABLED` per tenant; off → existing RAG only.
- [ ] Tests: mock cognee client, verify dataset isolation, verify recall injection.

### Phase S3 — Plugin/tool extensibility (closes G7)
- [ ] Tool manifest schema (JSON): `{ id, version, description, params, executor: "inline" | "url", auth }`.
- [ ] Admin UI to enable/disable tools per tenant.
- [ ] External tool executor: HTTP webhook with signed payload.
- [ ] Sandboxing: external tools run with timeout + output size cap + audit.

### Phase S4 — Scale (closes G6, G8)
- [ ] Migrate Prisma datasource SQLite → Postgres (single DB for app + cognee).
- [ ] Move `DocumentChunk.embeddingJson` → pgvector column.
- [ ] Benchmark: 10k chunks, 10 concurrent tenants. Target p95 retrieval < 200ms.

### Phase S5 — Automation (closes G5)
- [ ] `ScheduledRun` model: cron + prompt + tool plan.
- [ ] Worker process (reuse mini-services pattern) that picks up due runs.
- [ ] Deliver results via email / webhook / in-app notification.

---

## 8. Quick Reference

### Commands
```bash
bun run dev          # dev server on $PORT (3000 default), logs to dev.log
bun run build        # standalone build → .next/standalone
bun run start        # prod standalone server
bun run test         # unit tests (src/ + scripts/)
bun run e2e          # Playwright (mock LLM, fresh e2e.db)
bun run lint         # eslint
bunx tsc --noEmit    # typecheck
bun run db:push      # apply schema to SQLite
bun run db:generate  # regenerate Prisma client
```

### Key files
| File | Role |
|------|------|
| `src/lib/ai.ts` | LLM client, router, SQL gen, answer gen, streaming |
| `src/lib/tool-router.ts` | Single-tool execution branches (SQL/RAG/REST/CHAT) |
| `src/lib/rag.ts` | Hybrid retrieval, chunking, keyword extraction |
| `src/lib/rag-fts.ts` | BM25-style FTS chunk ID search |
| `src/lib/guardrails.ts` | SQL AST validation + mutation block + LIMIT cap |
| `src/lib/connectors.ts` | DB connector registry + schema reflection |
| `src/lib/rest-api-connectors.ts` | REST endpoint matching + auth headers |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt, session signing |
| `src/lib/embeddings.ts` | Embedding API client + cosine + hybrid fusion |
| `src/lib/vector-stores.ts` | Qdrant/Milvus/INTERNAL vector store abstraction |
| `src/lib/smart-mapping.ts` | Source→entity field maps for routing hints |
| `src/lib/prompt-settings.ts` | Per-tenant system prompt + tool toggles |
| `mini-services/chat-service/index.ts` | Socket.io streaming chat process |
| `src/app/api/v1/chat/completions/route.ts` | OpenAI-compatible external API |
| `prisma/schema.prisma` | 16 models, multi-tenant, encrypted configs |

### Specs & progress (existing)
- `docs/superpowers/specs/2026-06-25-chatbot-production-core-design.md` — product scope (authoritative)
- `docs/superpowers/specs/2026-06-26-hybrid-rag-quality-design.md` — RAG design
- `docs/superpowers/specs/2026-07-02-production-final-phase-design.md` — auth/wizard/e2e
- `docs/superpowers/specs/2026-07-02-license-validation-design.md` — licensing
- `docs/superpowers/plans/` + `docs/superpowers/progress/` — execution ledgers
- `worklog.md` — 84k-line chronological dev log

### Reference repos
- **cognee** — https://github.com/topoteretes/cognee (TS client: `@cognee/cognee-ts`, docs: https://docs.cognee.ai)
- **Spec doc** — `DOKUMEN SPESIFIKASI TEKNIS & PENGEMBANGAN SISTEM.docx` (original product spec, Indonesian)

---

## 9. Progress Log

> Append a new dated entry per session. Keep it short: what was done, what's next.
> This is the single source of truth for cross-session continuity.

### 2026-07-24 — Initial audit + super-app plan
- Audited full codebase: 16 Prisma models, 41 API routes, hybrid RAG (536 lines), guardrails, streaming WS service, 61 unit + 4 e2e tests green.
- Researched cognee (29.2k stars, Apache-2.0, TS client, single-Postgres memory layer, BEAM SOTA). Confirmed fit for G2 (memory) + G3 (graph).
- Wrote this CLAUDE.md: audit, super-app vision, cognee 4-phase integration, 5 algorithms, best practices, S0–S5 roadmap.
- Identified 10 gaps (G1–G10) blocking super-app evolution.
- **Next**: S0 hardening — wire REST into WS service (G4), stream SQL/REST status (G9), SQL retry (G10). Then S1 planner.

### 2026-07-24 — S0–S5 implemented (5 subagents, all green)

**Prisma schema** — 3 new models: `Plugin`, `ScheduledRun`, `AgentRun`. db:push applied.

**S0 — WS chat-service hardening (G4, G9, G10)** — `mini-services/chat-service/index.ts` 736→1028 lines:
- Added `runRestBranch` mirroring tool-router's REST execution (endpoint selection, auth headers, fetch, audit, streaming).
- Wired REST into `handleMessage` routing (counts REST endpoints, passes `hasRestApis`, dispatches).
- Added status emits: `executing_sql` before SQL execute, `rest_calling` before REST fetch.
- Added 1 retry on SQL execute error (covers transient blips, not bad SQL).

**S1 — Agentic planner (G1)** — 4 new files:
- `src/lib/tool-registry.ts` (76 lines) — built-in tools (sql/rag/rest/chat) + loads enabled plugins from DB.
- `src/lib/planner.ts` (339 lines) — `planQuery` (LLM → multi-step JSON plan), `topoSort` (Kahn's algorithm), `executePlan` (DAG runner, each step reuses existing tool-router), `synthesizeAnswer` (combines step outputs). Max 6 steps, validates tools + cycles.
- `src/app/api/v1/agent/run/route.ts` (147 lines) — POST endpoint, API-key auth, creates `AgentRun` row, plans → executes → synthesizes → returns.
- `src/lib/planner.test.ts` (90 lines, 10 tests) — topoSort (linear/circular/no-deps/dangling), parsePlanResponse (valid/malformed/code-fenced), validatePlan (unknown tool/empty).

**S2 — Cognee memory (G2, G3)** — `src/lib/cognee.ts` (132 lines) + `src/lib/cognee.test.ts` (76 lines, 8 tests):
- NO-OP when `COGNEE_ENABLED=false` (default). Dynamic import of `@cognee/cognee-ts` (not installed — fails gracefully).
- **Reuses tenant LLM config** (`getLlmRuntimeConfig`) — cognee gets the same baseUrl/apiKey/model the chatbot uses. No separate cognee env vars.
- Per-tenant client cache keyed by companyId. `datasetFor(companyId)` → `company:{companyId}` isolation.
- Exports: `rememberChatTurn` (fire-and-forget), `recallContext` (prompt-ready string), `forgetCompany` (GDPR), `cogneeHealth`.

**S3 — Plugin registry (G7)** — 4 new files:
- `src/lib/plugin-registry.ts` (183 lines) — `PluginManifest` type, `parsePluginManifest`, `normalizeManifest` (validates URL/method/auth), `executePlugin` (webhook fetch with auth headers + timeout), `encryptPluginCredentials`/`decryptPluginCredentials` (AES-256-GCM), `listEnabledPlugins`.
- `src/app/api/tools/route.ts` (133 lines) — GET (list) + POST (create, admin-only, toolId unique per tenant).
- `src/app/api/tools/[id]/route.ts` (113 lines) — GET/PATCH/DELETE for single plugin.
- `src/lib/plugin-registry.test.ts` (110 lines, 10 tests) — manifest parse/normalize/mask, executePlugin (success/network-error/invalid-manifest with mocked fetch).

**S5 — Scheduled runs (G5)** — 5 new files:
- `src/lib/cron.ts` (113 lines) — minimal 5-field cron parser (wildcard/ranges/lists/steps), `nextRun` (minute-by-minute scan, max 1 year). No library.
- `mini-services/scheduler/index.ts` (178 lines) — independent Bun process, polls every 60s, executes due `ScheduledRun` rows via `runNonStreamingChatCompletion`, updates `nextRunAt`.
- `src/app/api/schedules/route.ts` (75 lines) + `src/app/api/schedules/[id]/route.ts` (154 lines) — CRUD with cron validation, admin-only mutations.
- `src/lib/cron.test.ts` (80 lines, 14 tests) — parseCron match/no-match, nextRun calculations, invalid expressions.

**Verification**: `tsc` 0 errors · `lint` 0 errors · `bun run test` 103 pass 0 fail (61 original + 42 new).

**Next**: Wire `rememberChatTurn` + `recallContext` into chat-service (S2 Phase 1 integration). Wire planner into WS service for streaming multi-step. UI views for plugins/schedules/agent. Install `@cognee/cognee-ts` when ready to test against real cognee.

### 2026-07-24 — UI/UX overhaul (Impeccable + GRIDLIGHT theme)

**Impeccable installed** — `npx impeccable install --providers=opencode --scope=project`. PRODUCT.md created. Critique system active.

**Setup wizard**:
- Added "← Kembali" button (ArrowLeft icon, variant="outline") on steps 1–5.
- AdminStep: shows credentials (email + password with copy buttons) after creation, before continuing.
- API: `POST /api/auth/change-password` — verify old, hash new, audit log. UI: "Ganti Sandi" card in Settings > Profil.

**Provider simplification** — LLM dropdown: OpenAI-Compatible + Anthropic-Compatible only (removed OpenAI/Groq/OpenRouter/Anthropic/Ollama). Backend validates provider set. Embedding: same 2 options.

**Settings cleanup**:
- Removed: Company ID display, Tech Stack card, Mode Dedicated Single Admin alert.
- Removed: API Keys tab from Settings (moved to dedicated Integration API menu).
- Security tab: compact 4-button grid → modal popup with description + code snippet.

**Integration API menu** (new dedicated view — `integration-api-view.tsx`):
- Tab 1: API Keys — generate with name + rate limit (req/min) + daily limit (req/day). Table with status/revoke. AlertDialog confirm on revoke. Curl example.
- Tab 2: Request Logs — all request logs (endpoint, status, latency, error). Per-key logs via Activity button.
- API routes: `GET /api/settings/api-keys/[id]/logs`, `GET /api/settings/api-keys/logs`.

**Layout compaction** (all views):
- Topbar: h-14 → h-12, logo h-8 → h-6.
- Sidebar: w-64 → w-52, nav items single-line (removed desc text), icon h-5 → h-4.
- ViewHeader: removed icon box, inline icon + title, text-lg → text-base.
- Card: rounded-lg → rounded-none (sharp corners), py-4 gap-4 → py-3 px-3.5 gap-2.5.
- MetricCards: removed h-10 w-10 icon boxes, bare h-4 w-4 tinted icons, text-2xl → text-lg.
- Charts: h-[190px] → h-[140px], bar chart h-[110px] → h-[80px], pie h-[220px] → h-[140px].
- SummaryList: py-2.5 → py-1.5, text-sm → text-xs.
- All `space-y-5` → `space-y-3`, `gap-4` → `gap-3` or `gap-2.5`.

**Font hierarchy** — 3 tiers:
- Titles: `text-sm` (14px) — CardTitle, DialogTitle.
- Body: `text-xs` (12px) — descriptions, errors, table content (was text-sm).
- Meta: `text-[11px]` / `text-[10px]` — badges, timestamps, micro-labels.
- Removed: `text-[9px]`, `text-2xl` in stat cards, `text-base` in CardTitle.

**GRIDLIGHT theme** (warm earthy palette):
- Colors: primary `#3F8A5C` (green), accent `#D69A3B` (amber), neutral `#211D16` (brown), background `#f5f0e1` (cream), card `#efe8da` (grey-cream), border `#d4cbb8`.
- Dark mode: bg `#1a1510`, card `#2a2218`, sidebar `#241d12`.
- Fonts: + Playfair Display for h1/h2/h3 headings (via next/font).
- Radius: 0px on cards (sharp), 3px on controls.

**5 theme system** (`src/lib/themes.ts`):
- Gridlight (green/amber), Midnight (blue/cyan), Forest (emerald/lime), Slate (steel/violet), Sandstone (terracotta/gold).
- Each theme: light + dark mode (composed independently, not inverted).
- Theme switcher in Settings > Tema tab. Swatch preview cards.
- `localStorage` persistence. Anti-FOUC inline script in `<head>`.
- `applyTheme()` + `setTheme()` + `THEME_INIT_SCRIPT` exports.

**Background**: soft gradient only — 3 radial gradients (primary 10%, accent 8%, chart-3 5%) drifting 30s. `prefers-reduced-motion` off. No pattern.

**Tab compression** (anti-scroll):
- Integrations: Database · REST API tabs.
- Knowledge: Dokumen · Vector Store · Smart Mapping tabs. Removed RAG Search Tester + RAG Evaluation (dev tools, not production).
- AI Config: LLM · Embedding tabs.
- Prompt Tools: Prompt & Tools · Guardrails tabs.
- Security: already had 4 tabs (Audit Log, Eksekusi Tool, Request Gagal, SQL Diblokir).
- Integration API: API Keys · Request Logs tabs (panels stay mounted, no skeleton flash on switch).

**View persistence** — all 9 views stay mounted (`hidden` class toggles). No re-fetch/skeleton flash on menu switch. 150ms `view-fade` animation on switch.

**Skeleton flash eliminated** — all 6 views that used `Skeleton` replaced with centered `Loader2` spinner. Dashboard, AI Config, Prompt Tools, Integration API, Security, Settings.

**Animations** (CSS-only, per Impeccable motion thesis):
- `view-fade-in`: 200ms `cubic-bezier(0.16,1,0.3,1)` — menu/tab switch.
- `content-fade-in`: 200ms — auto on `[data-slot="tabs-content"]`.
- `scale-in`: 200ms — auto on `[data-slot="dialog-content"]` + `[data-slot="alert-dialog-content"]`.
- Button/link transitions: 150ms ease-out.
- `gradient-drift`: 30s — background ambient.
- `typing-dot`: chat typing indicator (replaced animate-bounce).

**Bug fixes**:
- Chat session panel: removed "0" badge from collapse button. Session count hidden when collapsed.
- Accordion: `type="multiple"` → `type="single" collapsible` (only 1 table open at a time). Trigger py-4 → py-2.
- Schema viewer: wrapped in `rounded-md border bg-muted/20` container, compact table rows.

**Critique score**: 28/40 (70%) → 38/40 (95%) after fixes.

**Verification**: `tsc` 0 · `lint` 0 · `bun run test` 103 pass · `impeccable detect` 0 anti-patterns.

**Next**: Wire cognee rememberChatTurn/recallContext into chat-service. Wire planner into WS. UI for plugins/schedules/agent-run. Re-seed demo tables.

### 2026-07-24 — Dashboard improvements & Agentic Dashboard (4 parallel subagents + coordinator)

**Task 1 — Nav rename**: Dashboard summary list titles "Integrasi per Provider" → "Data Sources", "Dokumen per Kategori" → "Knowledge". Sidebar labels already correct from prior session.

**Task 2 — Data Sources schema redesign** (subagent): `integrations-view.tsx` SchemaViewerContent completely redesigned. Accordion switched `type="single"` → `type="multiple"` controlled state for expand/collapse all. Toolbar: search table, search column, collapse all, expand all, download schema JSON. Per-table: copy table name, copy CREATE TABLE schema. Expanded view: columns (name/type/nullable/PK/description), sample data, metadata. Sticky header, improved spacing, smaller badges.

**Task 3 — Anthropic API documentation** (subagent): `ai-configuration-view.tsx` (438→759 lines). New "Anthropic" tab (3rd, Code icon) with sticky anchor nav + 7 sections: Endpoint, Autentikasi, Format Request, Format Response, Streaming, Tool Use, Error. `react-syntax-highlighter` Prism + vscDarkPlus style. Module-scope helpers: MethodBadge, CodeBlock, DocTable, DocSection. All strings Bahasa Indonesia.

**Task 4 — Integration API Test tab** (subagent): `integration-api-view.tsx` restructured to 4 shadcn Tabs (Dokumentasi, Test, API Keys, Request Logs) with forceMount keep-mounted pattern. New `DocumentationPanel` (base URL, auth, endpoints table, curl, rate limiting). New `TestPanel` with Request Builder (method, URL, headers, params, body, bearer token), Execute button, Response viewer (status badge, latency, collapsible headers, pretty JSON, copy, download). New `KeyValueEditor` reusable component. New server proxy `src/app/api/integration-api/test/route.ts` (session auth, 30s timeout, validates URL).

**Task 5 — Monitoring layout fix**: `security-view.tsx` — moved SQL AST Guardrails Alert + GuardrailTester out of audit tab to below `</Tabs>`. New order: Metrics → Tabs (Audit/Tracing/Failed/Blocked) → SQL AST Guardrails → GuardrailTester. Added `min-h-[600px]` to Tabs for stable container height (no jump on tab switch).

**Task 6 — Security Company Scope removed**: `settings-view.tsx` SECURITY_ITEMS — removed "Scope Perusahaan" entry (deprecated). Now 3 items: AES-256-GCM, SQL AST Guardrails, Audit Logging.

**Task 7 — Agentic Dashboard** (new menu + view + backend):
- `src/components/views/agentic-view.tsx` (~320 lines) — AI operations console. Chat panel (left, flex-1) with user/agent messages, tool execution cards (collapsible, status badges: running/success/failed), thinking indicator. Right sidebar (w-72, lg only) with 5 sections: Active Tools (by category, 28 tools), Running Tasks, Recent Executions, Agent Status, Memory. SSE parsing via fetch + ReadableStream. Empty state with example chips. Uses `typing-dot` animation from globals.css.
- `src/app/api/agent/dashboard/route.ts` — SSE endpoint (session auth, NOT external API key). Streams: thinking, plan, tool_start, tool_end, answer, done, error. Reuses planQuery + topoSort + runNonStreamingChatCompletion + synthesizeAnswer from existing planner infrastructure. Audits AGENT_DASHBOARD.
- `src/app/api/agent/dashboard/tools/route.ts` — GET tools list (session auth). 28 tools across 6 categories (database, knowledge, api, monitoring, security, provider).
- `src/lib/view-routing.ts` — added 'agentic' to VIEW_KEYS (10 views total).
- `src/app/page.tsx` — added Bot icon import, AgenticView import, nav entry (between Monitoring and Settings), renderView case.

**Verification**: `tsc` 0 · `lint` 0 · `bun run test` 103 pass 0 fail.

**Next**: Visual review in browser. Wire actual admin tool executors (connect database, generate API key, reindex knowledge) into the SSE route — currently uses existing chat planner. Pre-fill Test tab from Documentation endpoints. Expand/collapse all in schema viewer visual test.

### 2026-07-24 — Cognee bridge + remaining gaps implemented

**Cognee bridge LLM→RAG/DB/API** (previous session):
- `ai.ts`: `memoryContext?: string` added to `routeQuery`, `generateSql`, `generateAnswer`, `generateRestCall`, `generateChat` — injected as system/user message.
- `tool-router.ts`: `recallContext()` before routing → passed to all branches (SQL/RAG/REST/CHAT). `rememberChatTurn()` after completion.
- `planner.ts`: `recallContext()` before `planQuery`.
- Agent routes: `rememberChatTurn()` after synthesize (both `/api/v1/agent/run` and `/api/agent/dashboard`).

**This session — all remaining gaps implemented**:

**G7 — Plugin executor in planner**: `planner.ts` `executePlan` — replaced stub with `executePlugin` call. Looks up `Plugin` row from DB by toolId, calls `plugin-registry.executePlugin()`, handles success/error.

**G10 — Self-correction loop**: `planner.ts` `executePlan` — on step error, calls `selfCorrect()` which asks LLM to reformulate the question, then retries `runNonStreamingChatCompletion` once. Falls back to error if retry also fails.

**Anthropic native API**: `ai.ts` — `anthropicChatOnce()` + `anthropicChatStream()` implement native Anthropic Messages API (`/v1/messages`, `x-api-key` header, `anthropic-version: 2023-06-01`, system as top-level field, content blocks response). `chatOnce`/`chatStream` branch on `backend.cfg.provider === 'ANTHROPIC_COMPATIBLE'`. Streaming parses SSE `content_block_delta` events.

**Embedding provider fix**: `llm-config/route.ts` — removed hardcode `embeddingProvider = 'OPENAI_COMPATIBLE'`. Now validates and uses the actual `body.embeddingProvider` value from the request.

**G4 — Cognee to WS streaming**: `ai.ts` — `streamAnswer`/`streamChat` now accept `memoryContext?: string`, injected as system message. `mini-services/chat-service/index.ts` — imports `recallContext` + `rememberChatTurn`. `handleMessage` wraps `emitComplete` to fire-and-forget `rememberChatTurn`. `recallContext` called at each streaming site (SQL/RAG/REST/CHAT branches) + before `routeQuery`. Memory context flows end-to-end through WS streaming.

**G3 — Cognee cognify pipeline** (subagent): `cognee.ts` — added `kbDatasetFor()`, `cognifyDocument()`, `recallKnowledgeGraph()`, `forgetKnowledgeGraph()`. KB dataset = `company:{companyId}:kb` (separate from chat memory). Wired into `src/app/api/documents/route.ts` POST as fire-and-forget after chunk save. +7 tests (110 total).

**UI Plugin management** (subagent): `src/components/views/plugins-view.tsx` (~340 lines). Table with tool ID, description, status, endpoint, method. Create/edit dialog with manifest JSON. Enable/disable toggle. Delete AlertDialog.

**UI Scheduled Runs** (subagent): `src/components/views/schedules-view.tsx` (~290 lines). Table with name, cron, prompt, next/last run, status. Create/edit dialog with cron examples. Toggle + delete. Uses actual backend fields: `cronExpr`, `isActive`, `lastResult`.

**Admin tool executors**: `src/app/api/agent/dashboard/route.ts` — `executeAdminAction()` detects 7 admin intents via pattern matching and executes directly: generate API key (creates ApiKey row + audit), show monitoring metrics, show audit logs, list integrations, reindex knowledge status, list plugins, list schedules. Falls through to planner for non-admin queries.

**Nav wiring**: `view-routing.ts` — added 'plugins', 'schedules' (12 views total). `page.tsx` — Puzzle + Clock icons, PluginsView + SchedulesView imports, nav entries, renderView cases.

**Postgres migration (G8/S4)**: NOT implemented — requires running Postgres instance + schema migration + data port. Skipped as it's an infrastructure change, not a code-only task.

**Verification**: `tsc` 0 · `lint` 0 · `bun run test` 110 pass 0 fail.

**Next**: Install `@cognee/cognee-ts` and test cognify against real cognee instance. Wire `recallKnowledgeGraph` into RAG retrieval as graph-grounded outer ring. Wire `forgetKnowledgeGraph` into document delete + company GDPR delete. Visual review in browser (plugin/schedule views, admin tool executors, Anthropic native API with real key). Postgres migration when ready.

### 2026-07-24 — Smart Router: self-adjusting load balancer

**Problem**: `routeQuery` was a single LLM call with no schema awareness, no performance history, no circuit breaker. SQL integration selection was "first by createdAt". WS service had disparities (no smartMappingHints, no promptSettings, no ToolRun creation, wrong document count filter).

**Solution**: `src/lib/smart-router.ts` (~320 lines) — hybrid scoring router that replaces `routeQuery`:

1. **Schema scoring** (0.35 weight): keyword overlap between question and actual DB table/column names (from `IntegrationSchema`), REST endpoint paths/descriptions (from `RestApiEndpoint`), document names/categories (from `Document`). The router now "knows" what's in each source.

2. **Performance scoring** (0.25 weight): success rate from last 50 ToolRuns per type (24h window). Self-adjusting: reads fresh history each call.

3. **Latency scoring** (0.15 weight): `1 - min(avgLatency/5000, 1)`. Faster tools score higher.

4. **Similarity boost** (0.15 weight): scans last 200 successful ToolRuns, tokenizes `inputSummary`, computes overlap with current question. If a similar question was successfully answered by SQL before, SQL gets a boost. This is the learning dimension.

5. **Circuit breaker** (auto-disable): if last 10 runs have >70% failure rate, tool score → 0. Auto-recovers when failure rate drops.

6. **LLM tiebreaker**: when top 2 scores are within 0.1, falls back to `routeQuery` LLM call to break the tie. Saves an LLM call when the heuristic is confident.

7. **Integration selection**: `pickBestIntegration()` — when SQL is chosen, scores each integration by keyword match against its schema. Picks the best-matching one instead of "first by createdAt".

**Files created/modified**:
- `src/lib/smart-router.ts` (~320 lines) — `smartRoute()`, `pickBestIntegration()`, `getRoutingScores()`, `tokenize()`, `keywordOverlap()`, schema/endpoint/document/performance/similarity loaders.
- `src/lib/smart-router.test.ts` — 11 tests (tokenize, keywordOverlap).
- `src/lib/tool-router.ts` — replaced `routeQuery` import with `smartRoute`, uses `routed.integrationId` for SQL branch.
- `mini-services/chat-service/index.ts` — replaced `routeQuery` with `smartRoute`, fixed 4 WS disparities: added `smartMappingHints` (via `loadSmartMappingHintsWs`), added `promptSettings` tool toggles, fixed document count filter (`status:'ready', isEnabled:true`), uses `routed.integrationId` for SQL.
- `src/app/api/routing/scores/route.ts` — `GET /api/routing/scores` — visibility endpoint showing current tool scores, performance metrics, circuit breaker status, and keyword indices.

**Self-adjustment flow**:
```
Query → tokenize → load schema/endpoint/doc metadata + ToolRun history + similarity
     → score each tool (schema + perf + latency + similarity + availability)
     → circuit breaker check (auto-disable failing tools)
     → if scores close → LLM tiebreaker
     → if SQL → pickBestIntegration by schema match
     → execute → ToolRun recorded → next query reads fresh history → scores adjust
```

**Verification**: `tsc` 0 · `lint` 0 · `bun run test` 121 pass 0 fail (110→121, +11).

**Next**: Create ToolRun rows in WS chat-service (currently only HTTP paths record them — WS streaming is a blind spot for performance data). Visual dashboard for routing scores in the Agentic view or Monitoring tab.

### 2026-07-24 — Single-tenant admin-only refactor + full audit fixes

**Architectural change**: Removed `Company` model, `companyId` from ALL models, `role` from `User`. App is now single-tenant, admin-only. Every DB query, every function signature, every API route, every view simplified.

**Schema changes** (prisma/schema.prisma — 521→380 lines):
- Removed `Company` model entirely
- Removed `companyId` from: Integration, LlmConfig, Document, VectorStoreConfig, SmartMapping, ChatSession, RestApiConnector, RestApiRequestLog, ToolRun, ApiKey, ApiRequestLog, AuditLog, Plugin, ScheduledRun, AgentRun
- Removed `role` from `User` (was `admin | manager | staff`)
- `LlmConfig`, `VectorStoreConfig`, `AppConfig` — changed from `findUnique({ where: { companyId } })` to `findFirst()` (singleton)
- `db:push --force-reset` applied (fresh DB)

**Core libs updated** (16 files):
- `session.ts`: `ActiveUser` = `{ userId, name, email }` (no companyId/role). `writeAudit` no companyId. `getActiveUser` queries without companyId/role.
- `llm-config.ts`: `getLlmRuntimeConfig()` no args (findFirst). `getPublicLlmConfig()` no args.
- `ai.ts`: All functions (resolveBackend, routeQuery, generateSql, generateAnswer, generateChat, generateRestCall, streamAnswer, streamChat) — no companyId. `streamAnswer` source widened to `'SQL'|'RAG'|'REST_API'`.
- `tool-router.ts`: `runNonStreamingChatCompletion` no companyId. All branches no companyId. `loadSmartMappingHints()` no args.
- `smart-router.ts`: All functions no companyId. All DB queries no companyId filter.
- `planner.ts`: `planQuery`, `executePlan`, `synthesizeAnswer`, `selfCorrect` — no companyId.
- `cognee.ts`: Single client (no Map). `datasetFor()`→`'default'`. `forgetCompany`→`forgetAll`. All functions no companyId.
- `api-keys.ts`: `requireExternalApiKey` returns `{ apiKeyId }` (no companyId). **Prefix-based key lookup** (O(1) not O(n)). **Rate limit enforcement** (per-minute + daily).
- `prompt-settings.ts`: `getPromptSettings(db)` no companyId (findFirst).
- `plugin-registry.ts`: `executePlugin`/`listEnabledPlugins` no companyId. **SSRF guard** added (isBlockedHost).
- `tool-registry.ts`: `getAvailableTools()` no companyId.
- `rag.ts`: All retrieval functions no companyId. **`take: 500`** on loadAllCandidateChunks.
- `embeddings.ts`, `vector-stores.ts`, `rag-fts.ts`: No companyId.
- `types.ts`: `ActiveUser` = `{ userId, name, email }`. Removed `Role` type.

**3 HIGH lib bugs fixed**:
1. `planner.ts`: `executePlan` now checks `completion.toolRuns.some(tr => tr.status === 'error' || 'blocked')` → sets `ok: false`. Blocked SQL/failed execution no longer synthesized as valid data.
2. `plugin-registry.ts`: `normalizeManifest` calls `isBlockedHost(url.hostname)` → blocks `169.254.x.x`/`0.0.0.0` webhook endpoints (SSRF).
3. `rag.ts`: `loadAllCandidateChunks` adds `take: 500` → prevents unbounded O(n) memory.

**API routes updated** (all files in src/app/api/):
- All `companyId` removed from `where` clauses and `data` creates
- All `role !== 'admin'` checks removed (everyone is admin)
- `writeAudit` calls: no companyId
- `requireExternalApiKey` returns `{ apiKeyId }` only
- `integration-api/test/route.ts`: SSRF guard added (isBlockedHost)
- `llm-config/route.ts`: findFirst + update/create pattern (no upsert with companyId)
- `setup/admin/route.ts`: No Company creation, User created directly

**Mini-services updated**:
- `chat-service/index.ts`: No companyId in payload, queries, or function calls. `streamAnswer` source cast removed (type widened). ToolRun creation via `persistToolRun`. Rate limiting (2s per socket). Double-emission guard. Payload max 8000 chars.
- `scheduler/index.ts`: No companyId. Atomic claim (optimistic lock). Poll overlap guard. 60s execution timeout. ToolRun creation. Admin user lookup (no role filter). Parallel execution. Audit with success/failure.

**Frontend views updated** (13 files):
- All `companyId` removed from API calls
- All `isAdmin`/`role` checks removed (admin UI always visible)
- `setup-view.tsx`: `data?.data?.models` fix, `finish()` checks `res.ok`
- `knowledge-base-view.tsx` + `prompt-tools-view.tsx`: `loadError` state prevents config loss on silent load failure
- `agentic-view.tsx`: Stale running cards marked failed on done/error. Tools fetch error state.
- `schedules-view.tsx`: `isActive` included in create body
- `prompt-tools-view.tsx`: `<a href>` → button with `navigate-view` custom event
- `page.tsx`: `navigate-view` event listener

**v1 API fixes**:
- `v1/chat/completions/route.ts`: Word-by-word streaming (splits answer into SSE chunks with 10ms delay)
- `v1/agent/run/route.ts`: Error recovery scoped to single run (not all runs)

**Verification**: `tsc` 0 · `lint` 0 · `bun run test` 121 pass 0 fail · seed script runs clean.

**Next**: Install `@cognee/cognee-ts` and test cognify. Wire `recallKnowledgeGraph` into RAG retrieval. Visual review all views in browser. Postgres migration when ready.
