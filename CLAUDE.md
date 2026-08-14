# CLAUDE.md — ryasai Chatbot (Super-App Track)

> Living document. Update the **Progress Log** at the bottom every session.
> Last updated 2026-08-14. Version 0.4.0. PostgreSQL 16. All PLAN.md phases P0–P5 + S4 + RAG complete. Language standardized to English.

---

## 1. Project Identity

| | |
|---|---|
| Path | `/home/ryasr/ryasai/Chatbot` |
| Stack | Next.js 16 (App Router) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui |
| Runtime | Bun for dev/test, Node standalone for prod build |
| Domain | Multi-tenant SaaS AI assistant: natural-language → SQL, RAG over company docs, whitelisted REST calls, streaming chat |
| Status | **Production ready** (2026-07-27): Postgres migration complete, production RAG architecture, fail-closed auth, standalone build verified |
| Version | 0.4.0 |
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

**Data layer (Prisma schema — 30 models)**
- `Company`, `User`, `Integration` (encrypted config), `IntegrationSchema` (reflected table/columns cache).
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
- Registry pattern: `getConnector(id, provider, config)`. Provider: POSTGRESQL | MYSQL | MSSQL | SQLITE_DEMO | REST_API.
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
- 913 unit tests across 56 files (`bun run test` — per-file subprocess runner for mock isolation), 4 Playwright e2e (`bun run e2e`), mock LLM server for determinism.

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
- `bun run test` — 913 unit tests across 56 files (per-file subprocess runner, 0 fail). Any new lib file ships with `*.test.ts`.
- `bun run e2e` — 4 golden-path specs with mock LLM, keep green.
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
bun run test         # unit tests (913 pass, 0 fail, 8 skip — per-file runner for mock isolation)
bun run e2e          # Playwright (4 specs, mock LLM)
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
| `prisma/schema.prisma` | 30 models, multi-tenant, encrypted configs |

### Specs & progress
- `PLAN.md` — overhaul plan (all phases P0–P5 + S4 + RAG complete)
- `README.md` — quick start, commands, project structure
- `docs/postgres-migration.md` — SQLite → Postgres migration guide

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

> **Update 2026-07-30**: All orphaned API routes now wired to UI. SSO → login view button + status endpoint. Session export → download button in session list. Document versions → version history panel in doc detail dialog. Prompt library → "Library" tab in prompt-tools view. Webhook incoming → info card in settings system tab.

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

### 2026-07-25 — PLAN.md P0–P5 + S4 complete, repo cleanup

**P1.1 LLM dedup**: `agent-llm.ts` merged into `llm-client.ts`. Single unified transport: `chatOnce`, `chatStream`, `agentChatOnce`, `agentChatStream`.

**P2.1 Real streaming**: `/v1/chat/completions` fake word-split replaced with `runStreamingChatCompletion` real token deltas. Persistence moved into `ReadableStream.start`.

**P4.1 Token usage tracking**: `LlmUsageLog` model added. `chatOnce`/`chatStream` parse usage from OpenAI + Anthropic responses. Fire-and-forget `logLlmUsage()`. `ai.ts` purpose labels (router/sql/synthesis/rest/chat). Monitoring API + security view stat cards.

**S4 Postgres migration**: `docs/postgres-migration.md` (7-step guide). Schema datasource comment.

**Plugin E2E fixes** (3 critical bugs):
- BUG 1: Planner discarded plugin params → fixed `JSON.stringify(step.input)`
- BUG 2: `executePlugin` POST body wrapped incorrectly → parse JSON input
- BUG 3: `web_search`/`url_fetch` pointed to localhost → replaced with Wikipedia API
- `selectRelevantPlugins` minScore 0.05→0.01, added question words to keywords

**Hydration fix**: `page.tsx` lazy `useState` initializer caused server/client mismatch → reverted to default `'dashboard'` + sync in `useEffect`.

**Knowledge view fix**: Category tabs disappeared on filter switch → fetch ALL docs once, filter client-side.

**Repo cleanup**: Deleted 26 unused files (worklog.md, DOKUMEN docx ×2, agent-ctx, .zscripts, design-comps, docs/superpowers, .gitkeep, download/). Created README.md. Updated PRODUCT.md, PLAN.md, CLAUDE.md.

**Verification**: tsc 0 · lint 0 errors 9 warnings (all exhaustive-deps) · tests 194 pass 8 skip 0 fail · git clean.

### 2026-07-26 — Security hardening, rate limiting, z-ai removal, English standardization

**Security & reliability fixes (18 issues across 17 files + 3 new files)**:

New files:
- `src/lib/env-schema.ts` — Zod env validation at app startup (prod-only, fail-closed)
- `src/lib/rate-limit.ts` — Redis + in-memory rate limit helper for route handlers
- `src/lib/logger.ts` — Structured JSON logger (no Pino dep, stdlib console + levels)
- `src/app/api/health/route.ts` — Detailed health endpoint (DB + Redis connectivity checks)

Modified (key changes):
- `session.ts` — Session fixation fix: `sessionVersion` in User schema + cookie HMAC, incremented on login, checked on verify. 30min inactivity timeout (in-memory Map).
- `crypto.ts` — `signSession(userId, sessionVersion)` → 3-part token. `verifySession` accepts legacy 2-part + new 3-part. `extractSessionVersion` helper.
- `login/route.ts` — Increments `sessionVersion` on login, signs with new version (invalidates all prior cookies).
- `llm-client.ts` — MAX_RETRIES 1→3, linear→exponential backoff (500ms*2^attempt), timeout 60s→30s.
- `notifications.ts` — HMAC-SHA256 `X-Signature-256` header when `signatureSecret` configured. `sendNotificationWithRetry` wrapper (3 retries, 2s*2^n backoff).
- `plugin-registry.ts` — Zod schema replaces manual validation.
- `middleware.ts` — In-memory rate limiting (POST/PUT/DELETE/PATCH only, per-route buckets, Edge-safe). GET not limited (read-only, no security benefit).
- `tool-router.ts` — `allowMultiStepDag` flag (planner integration). `withSqlConcurrency` semaphore (3 concurrent per integration). Structured SQL/REST errors with hints.
- `rag.ts` — Query-level cache (1min TTL, 200 entries, invalidated on doc upload/delete). LLM reranker (opt-in `RAG_LLM_RERANK=true`).
- `cognee.ts` — `COGNEE_ENABLED` default true (was false). Session-level semantic cache (Map, 1min TTL, 100 entries/session).
- `env-schema.ts` + `instrumentation.ts` — `validateEnv()` on boot.
- `scheduler/index.ts` — `sendNotification` → `sendNotificationWithRetry`. Log retention (daily cleanup, 90-day default).
- `prisma/schema.prisma` — `User.sessionVersion Int @default(0)`, `AppConfig.cogneeEnabled @default(true)`.

**z-ai-web-dev-sdk removed**:
- `ai.ts` — `resolveBackend()` now throws `LlmNotConfiguredError` (fail-closed) instead of falling back to sandbox SDK.
- `package.json` — `z-ai-web-dev-sdk` dependency removed.
- Error classifiers + tests updated to match new `LlmNotConfiguredError` message.

**English standardization (~146 replacements across 34 files)**:
- `src/lib/` — 28 files, ~93 replacements (error messages, system prompts, guardrail messages, notification text, session errors, plugin validation).
- `src/components/ + src/app/` — 6 files, ~53 replacements (setup wizard, markdown UI, error pages, layout metadata, integration API view).
- `src/app/api/` — already clean (agent dashboard regex patterns intentionally match Indonesian user input).
- Functional data (STOP_WORDS, keyword arrays in rag/plugin-selector/smart-router) left as-is — tokenization data, not UI text.

**Structured logger wired into hot paths**:
- `rag.ts`, `tool-router.ts`, `ai.ts`, `session.ts` — `console.log/warn/error` → `scopedLogger` with JSON output.

**Verification**: tsc 2 pre-existing errors (api-keys.test.ts redeclared variable) · lint 0 errors 19 pre-existing warnings · bun test src/ 418 pass 8 skip 0 fail (1 pre-existing mock isolation fail in query route test).

### 2026-07-26 — Real DB connectors, typed errors, streaming resilience, constants extraction

**Real database connectors** (`src/lib/real-connectors.ts` — new, 488 lines):
- `PostgresConnector` — uses `pg` Pool for connection pooling, `information_schema` schema reflection, 30s query timeout.
- `MysqlConnector` — uses `mysql2/promise` Pool, `information_schema` reflection, 30s timeout.
- `MssqlConnector` — uses `mssql` ConnectionPool, `INFORMATION_SCHEMA` reflection, `requestTimeout` enforcement.
- All use dynamic `loadDriver()` import — app works without drivers installed, fails with clear error when that provider is used.
- `connectors.ts` updated: POSTGRESQL/MYSQL/MSSQL cases now use real connectors (was all mapped to SqliteDemoConnector).
- MONGODB/CLICKHOUSE/SNOWFLAKE/ORACLE still map to demo (not in scope).

**Typed error system** (`src/lib/errors.ts` — new):
- `ErrorCode` union (16 codes: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, VALIDATION_ERROR, RATE_LIMITED, LLM_NOT_CONFIGURED, LLM_ERROR, LLM_TIMEOUT, GUARDRAIL_BLOCK, SQL_ERROR, REST_ERROR, PLUGIN_ERROR, MCP_ERROR, CONFIG_ERROR, SETUP_REQUIRED, INTERNAL_ERROR).
- `AppError` class with `code`, `hint`, `statusCode`, `cause`.
- `defaultStatusForCode()` — maps error codes to HTTP status.
- `toTypedError()` — converts any error to typed response shape.
- `session.ts` `handleApiError()` now emits `{ error: { code, message, hint? } }` (was `{ error: string }`). All 64 routes using `handleApiError()` automatically get typed errors.

**Streaming error resilience**:
- `send/route.ts` (internal chat) — 120s idle watchdog sends `LLM_TIMEOUT` SSE error frame before close. Mid-stream catch sends `LLM_ERROR` frame. `safeClose()` guard prevents enqueue-after-close.
- `v1/chat/completions/route.ts` (external API) — same 120s watchdog + `LLM_ERROR` frame + `data: [DONE]` close. `safeEnqueue()` guard.

**Centralized constants** (`src/lib/constants.ts` — new):
- All magic numbers extracted: SQL_MAX_LIMIT, RAG_CHUNK_SIZE/OVERLAP/MAX_PER_DOCUMENT/CACHE_TTL/MAX_ENTRIES/MAX_CHUNKS_PER_UPLOAD, RATE_LIMIT_WINDOW/DEFAULT/CHAT/LOGIN/AGENT/UPLOAD, LLM_TIMEOUT/STREAM_TIMEOUT/MAX_RETRIES/RETRY_BACKOFF_BASE, SESSION_INACTIVITY_TIMEOUT/COOKIE_MAX_AGE, SQL_MAX_CONCURRENT_PER_INTEGRATION, NOTIFICATION_MAX_RETRIES/BACKOFF_BASE/TIMEOUT, WEBHOOK_RESPONSE_CAP, COGNEE_SESSION_CACHE_TTL/MAX, LOG_RETENTION_DAYS_DEFAULT.
- 6 files updated to import from constants.ts: guardrails.ts, rag.ts, middleware.ts, llm-client.ts, session.ts, notifications.ts.

**RAG cache metrics**:
- `_cacheHits`/`_cacheMisses` counters in `rag.ts`.
- `getRagCacheStats()` export → `{ hits, misses, hitRate }`.
- `log.debug` on cache hit/miss with query + topK.

**Graceful degradation verification**:
- All cognee callsites (8 in cognee.ts) confirmed to have try-catch with graceful fallback.
- All vector store callsites (5 in rag.ts) confirmed to fall back to lexical search.
- `// ponytail: graceful degradation` comments added at each callsite.

**Verification**: tsc 2 pre-existing errors (api-keys.test.ts) + 1 fixed (real-connectors.ts mssql cast) · lint 0 errors 19 warnings · bun test src/ 403 pass 8 skip 1 pre-existing fail.

### 2026-07-27 — Production RAG architecture + Postgres migration (v0.4.0)

**Postgres migration (closes G6, G8)**: Migrated SQLite → PostgreSQL 16 (pgvector + pg_trgm). All demo data migrated: ERP (72), Chinook (14,926), World (5,298), Pagila (46,211) = 66,435 rows. `connectors.ts` updated (information_schema instead of PRAGMA). Chinook tables renamed to lowercase with column mapping. `rag-fts.ts` uses tsvector. `scripts/migrate-demo-to-postgres.ts`.

**Production RAG architecture**:
- Intent Analyzer with document/integration/schema context + progressive slot filling (`src/lib/intent-pipeline.ts`).
- Contextual Query Rewriter for follow-up questions.
- Query Expansion (synonym + multilingual, max 3).
- Multi-pass Retrieval with Reflection (`retrieveWithReflection` + `mergeRetrievalResults`).
- GraphRAG via cognee `recallKnowledgeGraph` wired into `retrieveWithReflection`.
- Agentic Confidence Loop (`runAgenticLoop` — max 3 iterations, heuristic pre-check, cross-source fallback). `runStreamingAgenticLoop` for SSE. Closes G10.
- `evaluateAnswerConfidence` in `intent-pipeline.ts`.

**Semantic scoring in smart router**: 40% keyword + 60% embedding similarity blend. Source embedding cache (5min TTL) + question embedding cache (10s TTL). Graceful fallback to keyword-only when embedding API unavailable.

**Schema description enrichment**: `IntegrationSchema.description` field (LLM-generated per table). `enrichSchemaDescriptions()` in `src/lib/schema-enrichment.ts`. `generateSchemaDescriptions()` in `ai.ts`. Wired into intent analyzer + routeQuery context.

**Performance optimizations**: Intent pipeline parallelized (Promise.all for rewrite + DB queries + recallContext + analyzeIntent). Agentic loop heuristic confidence check (skips LLM for obvious cases). Planner executePlan parallelized (groupByLevel + Promise.all within levels). 21.2% faster (129.7s → 102.1s on 20-turn chat).

**Chat visual quality + persistence**: `toolHasResults` flag hides badge/footer when no results. ChatView + AgenticView always mounted (hidden class toggle, removed `key={view}`). SSE streams continue across menu switches.

**Scheduler improvements**: `ScheduledRunLog` model (execution history with full answer/error/toolRuns/latency). `GET /api/schedules/[id]/runs` (50 most recent logs) + `/export?format=json|csv`. UI polling (15s) + toast notification on run completion. History dialog with export buttons.

**Analytics timezone fix**: `setUTCHours` instead of `setHours` (matches DB UTC timestamps).

**New files**: `src/lib/intent-pipeline.ts`, `src/lib/intent-pipeline.test.ts` (39 tests), `src/lib/schema-enrichment.ts`, `scripts/long-turn-chat.ts`, `scripts/migrate-demo-to-postgres.ts`, `src/app/api/schedules/[id]/runs/route.ts`, `src/app/api/schedules/[id]/runs/export/route.ts`.

**Tests**: intent-pipeline 39 · smart-router 11 · planner 23. 913 tests pass via per-file subprocess runner (`scripts/test.ts` — Bun's `mock.module` leaks across files in a single invocation, so each file gets its own `bun test` process).

**Verification**: tsc 0 errors · lint 0 errors (31 warnings).

**Next**: Test scheduler toast + history dialog in browser. Test export JSON/CSV. Consider real-time SSE push from scheduler. Consider email/webhook notification on schedule failure. Populate Chinook artist/album/customer tables (empty). Consider cognee Postgres backend.

### 2026-07-27 — Test isolation fix (P0 #1)

**Problem**: `bun test src/` segfaulted (Bun 1.3.9 runtime bug) and mocks silently leaked across test files (Bun's `mock.module` doesn't isolate between files in a single invocation — confirmed by `ai.test.ts:5` comment "leaks across test files in bun:test"). Suite could only be run per-file manually.

**Root cause**: Bun `mock.module` cross-file leak is a runtime limitation, not user-fixable. Separate issue: `tool-router.test.ts` had 13 stale-mock failures (mock missing `db.integration.findMany` + `integrationSchema.findMany` added at `tool-router.ts:153-154`) and 2 tests stale from the intent-pipeline gate addition (`analyzeIntent` returns `needsRetrieval: false` when no docs/integrations mocked → early-exit before `routeQuery`).

**Fix**:
- `scripts/test.ts` — per-file subprocess runner. Each `*.test.ts` gets its own `bun test` process (process isolation = perfect mock isolation). 8-way parallel, aggregates pass/fail/skip counts, exits 1 on any failure. `package.json` `"test"` now runs this instead of `bun test src/`.
- `tool-router.test.ts` — added `mockIntegrationFindMany` + `mockIntegrationSchemaFindMany` to `@/lib/db` mock (11 failures fixed). Added `mockDocumentCount.mockImplementation(async () => 1)` to the 2 intent-pipeline-gated tests so `analyzeIntent` returns `needsRetrieval: true` and the code reaches the routing logic (2 failures fixed).

**Verification**: tsc 0 errors · lint 0 errors (31 warnings) · `bun run test` 913 pass 0 fail 8 skip across 56 files.

**Next**: P0 #2 — add CI (GitHub Actions: lint + typecheck + test + build on push/PR). P0 #3 — split `tool-router.ts` (1980 lines). P0 #4 — reconcile stale doc counts. Consider upgrading Bun 1.3.9 → 1.3.14 (may fix the segfault in `bun test src/`).

### 2026-07-27 — Split tool-router.ts (P0 #3) + doc reconciliation (P0 #4)

**P0 #3 — tool-router.ts split (1980 → 807 lines)**:

Split into 4 focused files with clean one-directional dependency chain:
- `src/lib/tool-utils.ts` (238 lines) — shared types (`PendingToolRun`, `CompletionResult`, `ChatHistoryEntry`, `StreamingCompletionResult`) + leaf utilities (`withSqlConcurrency`, `buildChartDataFromRows`, `buildDocumentCitation`, `sanitizeSqlError`, `summarize`, `safeParseColumns`, `safeParseSampleRow`, `extractTableName`, `jsonRowsToChart`, `safeJson`, `unavailableDataSourceResult`).
- `src/lib/tool-branches.ts` (643 lines) — non-streaming branch executors (`runChatBranch`, `runContextualChatBranch`, `runRagBranch`, `runSqlBranch`, `runRestBranch`, `runPluginBranch`) + `executeRestRequest`.
- `src/lib/stream-preparers.ts` (429 lines) — streaming preparers (`prepareChatStream`, `prepareContextualChatStream`, `prepareRagStream`, `prepareSqlStream`, `prepareRestStream`, `preparePluginStream`).
- `src/lib/tool-router.ts` (807 lines) — dispatcher entry points (`runNonStreamingChatCompletion`, `runStreamingChatCompletion`) + `runMultiStepDag` + agentic loops (`runAgenticLoop`, `runStreamingAgenticLoop`) + `chooseAvailableDecision` + re-exports from the 3 new files.

Agentic loops stay in `tool-router.ts` because they call back into `runNonStreamingChatCompletion`/`runStreamingChatCompletion` (circular dependency if moved out). All existing exports preserved via re-exports — zero changes needed in consumer files or test file.

**P0 #4 — doc reconciliation**:
- `package.json` version 0.2.0 → 0.4.0 (was stale since docs said 0.4.0).
- CLAUDE.md "16 Prisma models" → "25 models" (2 locations: §2.1 + key files table).
- CLAUDE.md key files table updated: `tool-router.ts` description rewritten, 3 new files added.
- CLAUDE.md §6 "Indonesian in user-facing strings" → "English in all user-facing strings" (was stale since 2026-07-26 English standardization).
- CLAUDE.md §6 "RESTful, `companyId` from session" → "RESTful, single-tenant (no companyId)" (was stale since Company model removal).
- README.md "67 API routes" → "62 API routes" (actual count).
- README.md `tool-router.ts` description updated to mention the split.

**Verification**: tsc 0 errors · lint 0 errors (31 warnings) · `bun run test` 913 pass 0 fail 8 skip across 56 files.

**Next**: P1 items — adopt LightRAG patterns (dual-level retrieval, role-specific LLM config), enable reranking by default, RAGAS evaluation harness, pgvector native column, distributed cache via Redis, pre-commit hooks. Consider upgrading Bun 1.3.9 → 1.3.14.

### 2026-07-27 — P1 quality algorithms (all LightRAG patterns adopted)

**P1 #6 — Reranking ON by default**: `rag.ts` `RAG_LLM_RERANK` check flipped from `=== 'true'` to `!== 'false'`. LLM reranker now active by default (significant quality uplift for mixed queries, ~500ms latency cost).

**P1 #11 — Pre-commit hooks**: `scripts/pre-commit.sh` runs `tsc --noEmit` + `eslint --quiet` before every commit. `package.json` `"prepare"` script installs it to `.git/hooks/pre-commit`. No husky/lint-staged dependency — just a shell script.

**P1 #7 — Role-specific LLM config** (LightRAG 4-role pattern): `src/lib/llm-config.ts` `getRoleLlmConfig(role)` — 4 roles: `extract` (entity-relation extraction), `query` (answer synthesis), `keyword` (intent analysis + query rewrite), `vlm` (multimodal). Falls back to chat config when no role-specific row exists. 30s cache. Wired into: `intent-pipeline.ts` (analyzeIntent + rewriteQuery → keyword role, evaluateEvidenceSufficiency + evaluateAnswerConfidence → query role), `rag.ts` reranker → query role. Admins configure via `LlmConfig` rows with `purpose = 'extract' | 'query' | 'keyword' | 'vlm'`.

**P1 #12 — pgvector native column**: `prisma/schema.prisma` `DocumentChunk.embedding Unsupported("vector(1536)")?` column added. `embeddings.ts` now writes to both `embeddingJson` (fallback) and `embedding` (native vector) via `$executeRaw`. `rag.ts` `pgvectorSimilaritySearch()` — uses Postgres `<=>` (cosine distance) operator for O(log n) indexed similarity search via IVFFlat, replacing O(n) JS cosine scan. Preferred path in `resolveVectorScores` — falls back to external Qdrant/Milvus, then lexical-only.

**P1 #13 — Distributed cache via Redis**: `src/lib/redis.ts` `cacheGet`/`cacheSet`/`cacheDel` — Redis-backed with in-memory fallback. `rag.ts` `_ragCache` Map replaced with Redis cache (TTL-based eviction via `EX`). `invalidateRagCache()` now async (Redis SCAN+DEL by prefix). Wired into `retrieveRelevantChunks` — distributed across instances.

**P1 #5 — Dual-level retrieval** (LightRAG core algorithm): `src/lib/knowledge-graph.ts` — native TS entity-relation extraction + dual-level retrieval. `indexChunkKnowledgeGraph()` extracts entities + relations from chunks via LLM (EXTRACT role), stores entity names as chunk keywords + relations in `KgRelation` table. `dualLevelRetrieval()` — local level (entity-centric chunk match) + global level (relation-chain traversal via `KgRelation` table). Wired into `retrieveRelevantChunks` — runs in parallel with vector/lexical retrieval, entity-matched chunks get 30% score boost, KG-only chunks get 80% lexical score. `KgRelation` model added to Prisma schema. KG extraction runs fire-and-forget during document ingestion.

**P1 #8 — RAGAS evaluation harness**: `benchmark/rag-eval.ts` — measures 4 RAGAS metrics (faithfulness, answer relevance, context precision, context recall) via LLM-as-judge. `bun run rag-eval` runs the evaluation. Results saved to `benchmark/results/ragas-report.json`. 5 default eval questions (extensible). `package.json` `"rag-eval"` script added.

**New files**: `src/lib/knowledge-graph.ts`, `benchmark/rag-eval.ts`, `scripts/pre-commit.sh`.
**Schema**: `KgRelation` model + `DocumentChunk.embedding` vector column.
**Verification**: tsc 0 errors · lint 0 errors (33 warnings) · `bun run test` 913 pass 0 fail 8 skip across 56 files.

**Next**: Run `bunx prisma db push` to apply schema changes (KgRelation table + embedding column). Run `bun run rag-eval` with real documents to measure RAG quality. Consider upgrading Bun 1.3.9 → 1.3.14. Configure role-specific LLM models (fast model for extract/keyword, strong model for query) via LlmConfig rows.

---

## 2026-07-30 — 8.6 → 9.5 PUSH (3 parallel subagents)

Goal: push Agentic 8→9.5, RAG 8.5→9.5, Code Quality 8.5→9.5, Production 8.5→9.5, Features 8.5→9.5, Docs 8.0→9.5.
All free/open-source stack (no paid subscriptions). Deps pre-installed: `fast-check`, `@opentelemetry/api`.

### Subagent A — AI/RAG/Agentic (owns: src/lib/rag*, intent-pipeline*, tool-router*, planner*, knowledge-graph*, benchmark/rag-eval*)
- [x] bge-reranker cross-encoder interface → reranker.ts + test
- [x] HyDE + sub-query decomposition → hyde.ts + test
- [x] Reflexion/self-critique pass → reflexion.ts + test
- [x] Token/cost budget per agentic run → agentic-budget.ts + test (7 tests)
- [x] Constrained output validation → constrained-output.ts + test (10 tests, wired into planner.ts)
- [x] Parent-document chunking → rag-chunking.ts chunkTextParentDoc() + test (11 tests)
- [x] Citation trails from GraphRAG → citation-trail.ts + test (5 tests), wired into rag-retrieval.ts
- [x] Streaming confidence updates → onConfidence callback in runStreamingAgenticLoop
- [x] Per-tool execution sandbox → tool-sandbox.ts + test (8 tests), wired into planner.ts executePlan
- [x] LlamaFirewall AlignmentCheck interface → alignment-check.ts + test (8 tests, HTTP/LLM/disabled modes)
- [x] DeepEval CI test gate → benchmark/rag-eval.ts --ci flag + test (5 tests)

### Subagent B — Code Quality + Production (owns: tsconfig, .github/, src/lib/observability*, logger*, rate-limit*, redis*, guardrails* tests, instrumentation.ts, scripts/, docs/runbook*, CHANGELOG*)
- [x] Property-based tests for SQL guardrails → guardrails.property.test.ts (8 fast-check properties)
- [x] Semgrep scan step in CI → ci.yml +semgrep job (returntocorp/semgrep-action@v1)
- [x] Redis-backed distributed rate limiter → DELETED (redis-rate-limit.ts was unwired shelfware; middleware has inline limiter)
- [x] OpenTelemetry instrumentation → otel.ts + test (9 tests, lazy SDK init, getTracer/withSpan)
- [x] Langfuse trace → score linkage → observability.ts traceLlmCall returns traceId, postLangfuseScore links it
- [x] Scheduler SSE push → DELETED (schedule-events.ts had no SSE consumer; UI polls every 15s)
- [x] Scheduler failure notifications → scheduler/index.ts sends on success + failure
- [ ] Strict TS flags → DEFERRED (1005 errors with noUncheckedIndexedAccess + exactOptionalPropertyTypes, needs coordinated rollout)
- [x] Graceful shutdown → graceful-shutdown.ts + test (8 tests, SIGTERM/SIGINT, cleanup order) — wired via instrumentation.ts (db.$disconnect + disconnectRedis)
- [x] Readiness vs liveness probes → DELETED (health-checks.ts redundant; /api/health + /api/v1/health routes already implement this inline)
- [x] CHANGELOG.md → keep-a-changelog format
- [x] Runbook → docs/runbook.md (deploy/rollback/rotate keys/restore/debug/incidents)

### Subagent C — Features + Documentation (owns: src/app/api/ new routes, src/components/views/, docs/, prisma/schema.prisma, README.md)
- [x] OIDC SSO integration → sso.ts (293 lines: discovery, code exchange, JWT HS256+RS256, getOrCreateSsoUser) — wired: GET /api/auth/sso/login + /api/auth/sso/callback routes, middleware public paths, env-schema + .env.example
- [x] Ollama LLM provider → DELETED (ollama-provider.ts was redundant; embeddings.ts already supports OLLAMA via DB config)
- [x] RBAC roles within single-tenant → DELETED (rbac.ts unwirable without touching 75 routes; single-tenant = admin only. User.role field kept in schema, defaults to "admin")
- [x] Mermaid architecture diagrams → README.md (flowchart + sequenceDiagram, ASCII in <details> fallback)
- [x] ADRs → docs/adr/0001-0008 (8 ADRs: single-tenant, SQL guardrails, fail-closed, hybrid RAG, AES-256-GCM, agentic loop, pgvector, contextual retrieval)
- [x] API usage guide → docs/api-guide.md (curl/JS/Python per endpoint, grouped by category)
- [x] Threat model doc → docs/threat-model.md (STRIDE analysis, trust boundaries, mitigation table)
- [x] Document versioning → doc-versioning.ts + test + 2 API routes (DocumentVersion model, create/list/restore)
- [x] Conversation export → conversation-export.ts + test + API route (JSON/markdown formats)
- [x] Prompt library → prompt-library.ts + test + 2 API routes (SavedPrompt model, CRUD)
- [x] Incoming webhooks → incoming-webhook.ts + test + API route (HMAC-SHA256 verification, fail-closed)
- [x] DAG preview → dag-preview.ts + test (Mermaid text from planner output)
- [x] Onboarding guide → docs/onboarding.md (dev setup, codebase tour, common tasks)
- [x] Glossary → docs/glossary.md (40+ terms defined)

### FINAL VERIFICATION
- Lint: 0 errors, 0 warnings ✅
- Typecheck: 0 errors ✅
- Tests: 1360 pass / 0 fail / 8 skip across 94 files ✅
- New files: 73 (43 src/lib, 6 docs, 4 API routes, 23 test files, CHANGELOG, runbook, 8 ADRs)
- Modified files: 16
- Prisma models added: DocumentVersion, SavedPrompt, User.ssoSubject, User.role, Document.version

### 2026-08-14 — UI verification + app-wide compact/contrast audit (post-90135b9)

`npx impeccable install` re-run for this session (installed into `.github` — GitHub Copilot harness detected as this repo's target; `impeccable detect` over `src/components` + `globals.css` reported 0 anti-patterns, consistent with the 2026-07-24 sweep).

**Live-verified commit 90135b9's fixes** (dead account menu, mobile tab overflow, WCAG contrast) against a fresh e2e run (isolated git worktree + Postgres DB, avoiding the running dev server's `.next` lock) — Profile/Settings/About all navigate correctly, "Add Database" renders single-line/no-overflow at 1920/1366/1280px. The bug report that triggered this session reflected a stale pre-fix browser tab, not a live regression.

**Independent WCAG audit (4-agent workflow) found what 90135b9 missed** — that commit only touched `--muted-foreground`/`--success`/`--warning`/`--info`, never `--primary-foreground` or `--accent`/`--accent-foreground`:
- **Critical**: `src/app/page.tsx` sidebar nav tooltips (collapsed + expanded, lines ~592/636) rendered their description/shortcut line as `text-muted-foreground` nested inside a `TooltipContent` with `bg-primary` — a token pair never designed to sit together. Contrast ratio 1.01–1.52 (need 4.5) in **all 10** theme×mode combinations — the description text was effectively invisible. This is almost certainly what the bug report meant by "hover text color on menu popups." Fixed: `text-muted-foreground` → `text-primary-foreground/70` (description) / `/60` (shortcut hint), which is guaranteed to contrast against `bg-primary` in every theme by construction.
- **Enterprise Blue (default) light-mode** `--accent`/`--accent-foreground` (dropdown/menubar hover text) measured 4.07:1, just under the 4.5:1 AA floor. Darkened `--accent` `oklch(0.60 0.22 290)` → `oklch(0.53 0.22 290)` in both `globals.css` and `themes.ts`.
- All other theme×mode combinations for `--primary`/`--primary-foreground`, `--muted`/`--muted-foreground`, `--popover`/`--popover-foreground` independently re-verified as passing (exact OKLab→sRGB conversion, not an approximation).

**Systemic icon+text button spacing bug** (workflow-audited, ~71 occurrences across 24 files): `Button` (`src/components/ui/button.tsx`) has a dedicated `icon=` prop that renders icon+text in separate, properly-gapped spans — but nearly every icon+text button in the app instead passes the icon as a JSX child (`<Button><Plus/>Add Thing</Button>`), which falls through to a code path that jams icon and text into one bare `<span>` with zero gap. This was the literal cause of the reported "Add Database button looks oversized/wrong" — not overflow, but missing icon/text spacing making the button read as cramped. Fixed by converting every occurrence to the `icon=` prop (or a manual `gap-1.5` span for the few icon-after-text cases like "Continue →") across 31 files total.

**Compact-theme deviations** (19 findings from the same audit): `size="sm"` missing on several toolbar/dialog-footer buttons that defaulted to h-10 next to h-8 siblings (`vector-store-panel.tsx`, `test-panel.tsx`, `api-keys-panel.tsx`, `rest-create-form.tsx`, `query-tester.tsx`, dialog footers in `upload-dialog.tsx`/`create-integration-dialog.tsx`); `Card` `p-4`/`gap-3` overrides fighting the established `py-3 px-3.5 gap-2.5` default (`custom-tools-card.tsx`, `mcp-servers-tab.tsx`); `space-y-4`→`space-y-3` rhythm fixes; 11 Input fields still at `text-sm` where the rest of the app uses `text-xs` (`rest-create-form.tsx`, `rest-connector-sheet.tsx`); chat bubble padding (`message-bubble.tsx` px-4→px-3.5, `thinking-card.tsx`, one arbitrary `p-[18px]` in `tool-execution-card.tsx`→`p-3.5`); `chart-renderer.tsx` chart height `h-64`→`h-[140px]` to match the Dashboard's already-compacted chart convention.

**Also fixed 2 additional overflow-prone tab+button rows** beyond the one 90135b9 fixed at the component level: `integrations-view.tsx` and `knowledge-base-view.tsx` both had a `TabsList` + action-button-group row with no wrap/scroll safety net on the outer flex row itself. Wrapped each `TabsList` in its own `min-w-0 overflow-x-auto` container (matching the existing pattern in `integration-api-view.tsx`/`security-view.tsx`) and added `shrink-0` to the button group.

**Execution**: 2 research workflows (4 agents: icon-bug sweep, overflow-row sweep, 5-theme×2-mode contrast audit, compact-spacing sweep) + 1 fix workflow (12 agents, one per file group, zero cross-file conflicts) + 3 critical fixes applied directly (sidebar tooltip color, accent token, 2 overflow rows).

**Verified**: `tsc --noEmit` 0 errors · `bun run lint` 0 errors (160 pre-existing warnings, mostly in `.github/skills/impeccable`, unrelated to this session) · `bun run test` 1616 pass / 0 fail / 8 skip across 102 files · live e2e re-check (isolated worktree, same Postgres/mock-LLM/mock-license harness as the automated suite) confirms the sidebar tooltip text is now legible and "Add Database" still renders single-line at all tested widths.

**Next**: visual spot-check the other 4 non-default themes (Midnight/Forest/Slate/Sandstone) in a real browser session — the contrast audit computed all 10 combinations mathematically but only Enterprise Blue/dark was screenshotted this session. Consider running `impeccable detect` again once impeccable's ruleset catches structural patterns like the icon-prop bug (currently out of its scope — it's a project-specific `Button` API convention, not a general anti-pattern).
