# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Last updated 2026-09-25. Version 1.0.0. PostgreSQL 16. All PLAN.md phases P0–P5 + S4 + RAG complete. Language standardized to English.
>
> **Counts and versions in this file drift.** Sections 1–2 and 8 describe CURRENT state and are
> corrected to 1.0.0; section 9 (Progress Log) is HISTORICAL and its numbers were true when
> written — do not "fix" them. When you need a number, run the command.

---

## 1. Project Identity

| | |
|---|---|
| Path | `/home/ryasr/ryasai/Chatbot` |
| Stack | Next.js 16 (App Router) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui |
| Runtime | Bun for dev/test, Node standalone for prod build |
| Domain | Multi-tenant AI assistant deployed **on-prem per customer**, licensed with a signed machine-bound key: natural-language → SQL, RAG over company docs, whitelisted REST calls, streaming chat |
| Status | **Release 1.0.0** (2026-09-25). Verified by execution, not assertion: `tsc` 0 · `lint` 0 · `bun run test` 265/265 files, 6825 pass, 0 fail · `bun run e2e` 16/16 (dev) and `e2e:prod` 16/16 against the standalone build |
| Version | 1.0.0 |
| Language | English (standardized — all UI, errors, system prompts, comments in English) |

---

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
- **Single-Postgres memory layer** (cognee 1.0) — graph + vectors + sessions + metadata in one Postgres. Replaces the JSON-embedding-in-SQLite hack (G8) and the flat-chunks problem (G3) in one move.
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

- **Dev**: cognee local mode (SQLite + LanceDB + Kuzu, zero services). Env: `LLM_API_KEY` reuses tenant's key.
- **Prod**: single Postgres with `pgvector` + cognee's Postgres graph backend. One container, one DB. Env:
  ```
  DB_PROVIDER=postgres
  VECTOR_DB_PROVIDER=pgvector
  GRAPH_DATABASE_PROVIDER=postgres
  CACHE_BACKEND=postgres
  ```
- **Isolation**: cognee datasets are namespaced `org:<id>`. The wrapper in `cognee-types.ts` is the only place a dataset name is built, so no call can reach a name without an org. Verified against the code, not the design sketch.

### When NOT to use cognee

- < 50 documents and no multi-hop needs → existing RAG is simpler and faster. Cognee adds a Postgres dependency.
- Small deployment with no cross-session memory need → overkill.
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
- `bun run test` — per-file subprocess runner, must report 0 fail (265 files as of 1.0.0; the runner prints the real count, so read it rather than this line). Any new lib file ships with `*.test.ts`.
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

### 2026-09-25 — Release 1.0.0: memory integration replaced, and a guard that proved nothing

**Version aligned to 1.0.0** in all six places it was stamped (package.json, .env.example,
install.sh, and the two code fallbacks + otel) — they had drifted to FOUR different numbers
(0.4.0 / 2.0.0 / 0.5.0 / 0.0.0), and the code fallbacks are what the customer's UI actually
displays (the Dockerfile declares no `ARG`, so `NEXT_PUBLIC_APP_VERSION` from `.env` never
reaches the bundle). CHANGELOG converted from a two-month-old `[Unreleased]` into `[1.0.0]`.

**Cognee: one backend, one version, one writer.** Removed `@cognee/cognee-ts` entirely and moved
memory to a pinned **cognee v1.6.0 API server**; with no `COGNEE_SERVER_URL` memory is OFF rather
than half-wired. Reason is measured, not stylistic: two lineages writing one store produced a
collection sized 1536 while the embedder returned 384, and a graph with 0 nodes after a write
that reported success. Cross-session recall now works and is measured (write ~9s warm, recall
0.21-0.35s from a different session, found by a semantic query too).

**Latency, localized honestly.** Write latency is the CUSTOMER's model, not this code: measured
on their endpoint, "Say OK" answers in 1.3s while an extraction request takes 23.7s. All four
write sites are fire-and-forget, so an answer is never blocked — the cost is memory FRESHNESS.
Two claims I made and then retracted with the refuting numbers are recorded in
`docs/cognee-http-migration.md`.

**A guard that proved nothing — the most valuable find of the session.** Following the discipline
of negative-controlling every guard: deleting the real `startJobWorker()` CALL from
`src/instrumentation.ts` left the suite at **49 pass, 0 fail**, because the assertion was
`toContain('startJobWorker')` and the name survives in the import one line above (a comment
satisfied it too). That guard exists for the repo's most expensive known outage (40 document jobs
stuck 16+ hours). It now strips comments and requires an INVOCATION. Two other guards were
audited and held (cognee searchTypes; the SQL deny-list, which was already written against a call
count).

**Also fixed:** the chat UI could drop an in-flight answer and then drop it silently (both fixed);
e2e now clears the BullMQ queue as well as Postgres (orphaned jobs were leaving a document
without a vector and failing a citation assertion); `adoptStuckJobs` renamed — it never adopted
anything.

**Verified by execution, not assertion:** `tsc` 0 · `lint` 0 · `bun run test` 265/265 files,
6825 pass, 0 fail, 71 skip · `bun run e2e` 16/16 (dev) · `bun run e2e:prod` 16/16 against the
standalone build, which reports version 1.0.0 and ships no `@cognee`.

**Known and documented, not hidden:** the provider occasionally returns an empty body for an
extraction call (rare, not reproducible on demand; retries recover it — 184 of 297 first-attempt
validation failures eventually succeeded). The exact trigger is outside this codebase.

### 2026-09-26 — Real-LLM probing: 12 silent-failure classes, and a prompt that was never delivered

Work this session was driven by one method: run the PRODUCTION pipeline against the customer's real
provider and real business data, then chase down anything that looked wrong. Twelve defects shared
one shape — the code reported success for work it had not done, or dropped data on the way out.
They are catalogued with measurements in `AGENTS.md` ("Silent-failure classes found by probing").

**The two most consequential were both about DELIVERY, not logic:**

- A routing bug sent document questions to SQL. The `datetime` plugin declares the bare keyword
  "tahun", so 5 of 6 database questions containing a time word were promoted OFF the route the
  classifier had chosen — and the WRONG answer scored HIGHER ("Tampilkan pesanan per jam." 0.415 vs
  "Hitung 15% dari 2 juta." 0.383), so no threshold could separate them. A question answerable only
  from a document had been returning "the data does not contain that". Fixed with a subject-match
  gate; the same question now returns the planted token `ZQX-4471` with its citation.
- The intent system prompt was 2872 characters and the Text-to-SQL rules 3033, against a provider
  ceiling of ~2000 for a SYSTEM message. Measured: 1800 chars reports `prompt_tokens` 411, 2100+
  reports 44 (the user message alone), 3/3 reproducible. Both prompts were therefore discarded on
  EVERY request. User messages have no such ceiling. This also explains an earlier round where a
  prompt rewrite changed behaviour by exactly 0/4 — there was nothing to ignore.

**A ambiguous question was answered with a confident guess.** "Berapa banyak itu?" (a pronoun with
no antecedent, which the prompt has always listed as needing clarification) produced
"Jumlahnya 2.405 (total stok)" — picked from one of three connected databases. A downstream guard
suppressed clarification whenever the question contained "berapa", which is exactly what the
ambiguous shapes contain. The rule moved into CODE, because two prompt rewrites changed it by 0/4.

**Also fixed:** `extractError` dropped the actionable `hint` on 48 callers; `fetchProviderModels`
never read the response body so BYOK failures could not be classified; a transport failure surfaced
to the customer as Bun's raw "Unable to connect" with an empty hint; `resetCognee` reported a
successful wipe when the forget had failed; `GET /api/documents/[id]` selected `cognifyStatus` and
never mapped it.

**This file was silently truncating itself.** Measured: `CLAUDE.md` was 90719 bytes against a
65536-byte read budget, and truncation keeps the HEAD — so the 2026-09-25 entry (starting at byte
87712) was never read, in a file whose own header calls the Progress Log "the single source of truth
for cross-session continuity". Entries through 2026-08-14 moved to `docs/progress-log-archive.md`;
`CLAUDE.md` is now 33584 bytes and the newest entry starts at byte 30577. `AGENTS.md` had the same
problem at 66057 and a duplicated section; both fixed.

**Verified by execution:** `tsc` 0 · `lint` 0 · `bun run test` 267/267 files, 6858 pass, 0 fail,
71 skip · benchmark 167 · invariants 49 · e2e dev 16/16 and e2e:prod 16/16. Every fix carries a
negative-controlled guard: plant the violation, confirm the guard FAILS, restore, confirm it passes.
One guard written this session survived its control and was rewritten — a test that cannot fail is
worse than no test, because it reports safety.

**Still open, recorded rather than hidden:** memory-write latency is the customer's model (a 23.7s
extraction call vs 1.3s for "Say OK"), all write sites are fire-and-forget so answers are never
blocked; memory FRAMING shows no measurable effect (14/15 vs 14/15, unproven); the provider
occasionally returns an empty body and retries recover it.
