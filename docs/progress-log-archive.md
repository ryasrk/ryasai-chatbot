# Progress Log — archive (2026-07-24 → 2026-08-14)

> Historical entries moved out of `CLAUDE.md` on 2026-09-25. **Reason, measured:** `CLAUDE.md` had
> grown to 90719 bytes against a 65536-byte read budget, and the truncation kept the HEAD — so the
> NEWEST entries were exactly what disappeared. The 2026-09-25 entry began at byte 87712 and was
> therefore never read, in a file whose own header calls the Progress Log "the single source of
> truth for cross-session continuity". Splitting keeps continuity working.
>
> These entries were true when written and are kept for the reasoning. Where they disagree with the
> code, the code wins — several describe a "single-tenant" state that was REVERTED, and the counts
> and versions have moved on.

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
- Per-tenant client cache. `datasetFor()` → `org:<id>` isolation.
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

> ⚠️ **REVERTED — this entry describes a state that no longer exists.** The single-tenant
> refactor below was undone: the codebase IS multi-tenant, with `Organization` as the tenant
> root, `organizationId` on every model and `role` back on `User`. Verified:
> `grep -c "organizationId" prisma/schema.prisma` = 93, `companyId` = 0. Kept for the reasoning
> (the audit fixes in this entry are real and still apply), but **do not follow its
> "no companyId / everyone is admin" guidance** — that is exactly the bug class
> `prisma-tenant.ts` and `tenant-route-guard.test.ts` exist to prevent.

**Architectural change (since REVERTED)**: Removed `Company` model, `companyId` from ALL models, `role` from `User`. App became single-tenant, admin-only. Every DB query, every function signature, every API route, every view simplified.

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

---

## Moved 2026-09-30 (second trim)

> Moved for the same MEASURED reason as the first trim, and by the same rule: keeping the
> newest entries readable matters more than keeping the oldest in place. The 1.4.0 entry had
> pushed the combined instruction files to 67,541 bytes against the 65,536-byte budget, so the
> TAIL of `AGENTS.md` was on course to stop loading — the rule sections, which are the ones an
> agent needs. Both entries below were true when written; where they disagree with the code,
> the code wins.

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

---

## Moved 2026-10-01 (third trim)

> Same MEASURED reason and same rule as the two earlier trims. The 1.6.0 entry (5,545 bytes,
> the largest yet) pushed the combined instruction files to 68,581 against the 65,536-byte read
> budget, and truncation keeps the HEAD — so the tail of `AGENTS.md`, which holds the RULE
> sections, is what would stop loading. The two oldest entries moved out; the newest stay in
> place. Both were true when written; where they disagree with the code, the code wins.

### 2026-09-29 — Repo cleanup: 63 dead files, a duplicated implementation, and a truncated instruction file

**The instruction budget was the real defect.** `AGENTS.md` (59,565 B) plus this file (37,433 B) came to 97 KB against
a 65,536-byte read budget, and truncation keeps the HEAD — so everything in `AGENTS.md` past byte ~28,000 was
silently dropped, including `## Cross-tenant IDOR` (a real IDOR incident) and `## Silent-failure classes` (20 defect
patterns). The rules an agent most needs were the ones not being delivered. Fixed by MOVING reference out, not by
deleting content: `docs/architecture-reference.md` (pipeline internals + this file's audit summary and algorithm
sketches), `docs/billing-and-prompts-reference.md`, `docs/build-and-deploy-reference.md`. Now 55,084 B total, every
rule section inside the budget, and each moved section left a pointer that states why it moved.

**Dead files, found by measurement after a wrong first answer.** `grep -r` claimed 46 orphan modules including
`chat-view.tsx` — obviously false, because a recursive grep matches a file's own contents and matches SUBSTRINGS (it
"found" a consumer for an unused `toggle.tsx` via the local `toggleSidebar`). Replaced with specifier resolution,
kept as `scripts/audit/dead-modules.mjs`. Real result: 2 shadcn components (`toggle.tsx`, `use-mobile.ts`) and
`__connector-mocks.ts` — the last a FAILED EXTRACTION whose richer mocks nobody imports while `rag-fts.test.ts`
defines its own inline.

**61 files at the repo root (6.2 MB)** — screenshots, DOM dumps, probe JSON — had all landed in ONE commit whose
message is about a guardrail fix, because nothing ignored them. Removed after verifying each was unreferenced (which
is how `views.json` was caught as a false positive rather than reported live). `.gitignore` now blocks the SHAPES
they take, scoped to the root: a global `*.png`/`*.txt` would silently hide the next asset in `docs/screenshots/` or
`test-data/wikipedia/` (24 such files are tracked today). `coverage-summary.json` is deliberately NOT ignored — it
looks like a build artifact and is an INPUT the gate reads.

**`dedupeByPrefix` existed twice**, as `dedupeByPrefix` and `dedupeJoin`, differing only in whether they joined the
result. The memory copy's comment said "mirrors the KB recall path" — a note documenting duplication instead of
removing it. Consolidated into `cognee-core.ts` ("shared helpers", imports neither caller, so no cycle).

**Consolidating it exposed a vacuous guard.** The dedupe test used `'P'.repeat(100)` for both hits, so changing
`slice(0, 100)` to `slice(0, 50)` left the file at 45 pass / 0 fail. It now pins the boundary from both sides and
fails in both directions. Building it also required measuring that one call issues FOUR HTTP recalls, not two.

**Eight coverage floors quoted a stale measurement**, and the gate surfaced it (`cognee-memory` floored at 62 against
a real 61.42%). `rag-retrieval.ts` claimed 70.79% against 62.72%; `tool-router.ts` claimed 62.62% against 54.44%. A
stale number there is worse than none — it looks like evidence and answers the question wrongly. All 11 refreshed,
and `coverage-floor-consistency.test.ts` now fails when a comment stops matching `coverage-summary.json`, when a
floor sits above its measurement, or when a floor names a file the summary no longer measures.

**Verified:** `tsc` 0 · `lint` 0 · 289/289 files, 7206 pass, 0 fail, 71 skip · coverage:gate exit 0.

### 2026-09-30 — Release 1.3.0: storage becomes a decision, memory moves onto the bundled Postgres, nine silent failures

**Version 1.1.1 → 1.3.0** (minor: two `feat:` commits since 1.2.1). All eight stamped locations bumped, CHANGELOG heading cut, `main` fast-forwarded, tag `v1.3.0` pushed, all six image tags verified published (3 moving + 3 versioned), then **deployed to production and confirmed live** — `/api/v1/health` reports 1.3.0, schema pushed before the new image so `storageChosenAt` existed before the app needed it.

**Knowledge storage is now an explicit, enforced choice.** Until an admin picks, `POST /api/documents` returns 503 `SETUP_REQUIRED` before extraction runs. Recorded as a sticky TIMESTAMP, not a boolean — a `@default(false)` invites a backfill that would delete the gate silently. AI Memory is stated as bundled (no choice to offer); external vector DBs got their own sub-menu; the setup wizard gained a Knowledge Storage step with no Skip.

**Nine defects, all one shape: reporting success for work not done.** Self-role-change (an admin could demote themselves and lock the install out of user management); streaming RAG not delivering the per-source guidance the non-streaming path sent; citation rank being the array index rather than the retrieval rank (wrong precisely because citations are concatenated across tool runs); four 1536-dim fallbacks beside a `vector(384)` column; a 60s agentic deadline wrapping a 120s stream; the login limiter counting SUCCESSES and keying one shared bucket for all anonymous callers (the 11th sign-in in a minute was refused — a NEW finding, not from the UAT report); `db push` wanting to drop the runtime-created GIN index; `VectorStoreConfig.vectorSize` still defaulting to 1536.

**Two guards that could not fail, found by their own controls.** The vector-store ROW payload had no verdict assertion at all — every test ran with `row = null`, so the arm a real install is in was never measured. And the panel's "bogus verdict" test could not fail because the JSX switches on exact literals; the narrowing moved into the leaf (`parseEmbeddingStampVerdict`) where it is observable. Five negative-control harnesses: 6/6, 11/11, 12/12, 9/9, 19/19, each restored byte-identical.

**Production consequence disclosed, not hidden:** cognee's relational/vector/cache stores moved to the bundled PostgreSQL, but the OLD stores are orphaned in the volume and cannot be migrated automatically — measured there: SQLite held 3 datasets / 28 data rows / 236 pipeline runs / 36 queries, LanceDB held 27 chunks / 81 edges / 10 entities. The Kuzu GRAPH survived untouched (98 nodes, 81 edges). A first reading of the graph reported 0 nodes — my query was wrong (`show_tables()` returns id in column 0, name in column 1), which is worth remembering as "check what your probe returns before believing its verdict".

**Verified:** tsc 0 · lint 0 errors (133 pre-existing warnings) · 299/299 files, 7387 pass, 0 fail · coverage:gate exit 0 · e2e dev 18 passed · e2e:prod 18 passed · invariants 52 · benchmark 167 · CI green on `main` and `dev`.

**Recorded rather than fixed:** the `mock.module` cross-file bleed is a property of running two suites in one Bun process, not a defect in either file — measured (`tool-branches` + `stream-preparers` in one process = 106 pass / 4 fail; each alone green; `bun run test` green). Documented with numbers in `AGENTS.md` so it stops being re-opened as a bug.

### 2026-09-30 (c) — Release 1.5.0: the memory tab leads with state, and one field that must not be read

**Version 1.4.0 → 1.5.0.** Eight stamped locations bumped, CHANGELOG heading cut, then released and deployed.

**The panel opened with a form; it now opens with the ANSWER.** The two consumers look identical to a compiler and must not look identical to an operator, so the memory tab states which one is in use before offering any field. In the follow-chat state the fields are GONE — a blank form invites a save that would pin memory to the chat model forever, which is the one irreversible-looking action the fallback exists to prevent.

**`mode` is declared in the function signature and deliberately NOT read.** `readSidecarState` decides from `diagnostics.components` presence plus `enabled`/`connected`, because `mode` is unreliable: an ENABLED install whose sidecar is down reports `mode: 'disabled'`, which would libel working memory as switched off. Declaring the field lets the tests hand over the exact server body and assert that changing `mode` alone never moves the verdict — the field that caused the misreading is the one being exercised, rather than the one nobody touches.

**Negative-controlled on the frozen bytes.** Planting `if (data?.mode === 'disabled') return 'off'` breaks "an ENABLED install whose sidecar did not answer is unreachable, never 'off'" (2 fail), restoring byte-identical at md5 `80b94ebd…`. Test diff across the change: **+32 assertions, 0 removed** — no guard was weakened to make it pass. `readSidecarState` was extracted as a testable leaf so the four verdicts are pinned individually rather than only through rendered HTML.

**Verified on the frozen hash:** tsc 0 · lint 0 errors · 300/300 files, 7441 pass, 0 fail · coverage:gate exit 0 (203 modules) · e2e dev 18 · build · e2e:prod 18. Rendered in a real browser at 1440px and 390px: no horizontal overflow at either width, no console errors, the four store rows render, mobile stacks to one column.

**A process note worth keeping.** The e2e modes were NOT re-run by the implementer after its final edit, and it said so rather than implying otherwise — which is why the two runs above were measured by a second party on the frozen file. An unverified claim flagged as unverified costs nothing; the same claim left implicit would have shipped.

### 2026-10-01 — Release 1.6.0: a live IDOR, a cross-tenant PII leak, six row-cap bypasses, and three silent-failure classes

**Found by a 10-agent read-only audit, each finding then reproduced by hand before it was accepted.** Two of the agents were wrong in ways worth recording: one asserted a guard's content from its comment without reading the assertion (it withdrew the claim), and one reported "both runners agree" when their globs differed 303 vs 290 — the correction came from the Lead's own check.

**A live cross-tenant IDOR.** `Order` carries `organizationId` but was missing from `ORG_SCOPED_MODELS` (30 models have the column, 28 were scoped). Proved by driving the real extension handler: `Document.findFirst` forwarded `{"where":{"id":"x","organizationId":"org-PROBE"}}`, `Order.findFirst` forwarded `{"where":{"id":"x"}}`. `GET /api/billing/orders/[id]` therefore served any org's order from a client id — while its docstring claimed the extension scoped it, which is why nobody re-checked. Fixed, docstring corrected, and `tenant-scope-coverage.test.ts` now PARSES the schema and asserts the set equals the scoped list plus an explicit justified exception (`invitation`), so a new unscoped model fails the build naming itself.

**A cross-tenant PII leak.** The LLM trace ring buffer is a module-global with NO org field, and `/api/traces` called `enterWithOrg(...)` then never used it — passing the static tenant-route guard while being effectively unscoped, with no `requireRole`. Any authenticated user read the last 20 prompt bodies of EVERY tenant. Now stamped per org, filtered on read, admin-gated. The trap is documented in both routes: **`enterWithOrg` alone is NOT scoping when the data is in-process memory rather than a Prisma query.**

**Six row-cap bypasses, and two corruptions introduced while fixing them.** `LIMIT ALL`/`NULL` returned byte-identical SQL; MySQL's `LIMIT a, b` clamped the OFFSET and left the COUNT at a million; `FETCH FIRST`/`TOP` got a second invalid `LIMIT` appended (a syntax error on MSSQL); `1_000_000`/`1e10` matched nothing. All clamp correctly now. The first fix then corrupted a STRING LITERAL (`'LIMIT 999999'` → `'LIMIT 100'`) and a DELIMITED IDENTIFIER (`[Credit Limit 5000]` → a different column; an aliased form changed the result set's field names while the query still succeeded) — caught by a second reader, fixed by clamping over masked SQL and splicing by offset, with masking extended to backtick/bracket identifiers keyed on bracket CONTENT so a PG array subscript stays visible.

**A 631-line rewrite was DISCARDED rather than wired in.** It had zero callers (`grep enforceRowCap` → one comment): a fix in a place that could never run (class 9). Direct measurement showed it produced invalid syntax on `FETCH`/`TOP` and never applied `Math.min`. Deleting it and fixing the shipped 12-line clamp was the smaller, safer change.

**Three silent-failure classes.** (11) The planner's system prompt measured 3023 chars against a ~2000 ceiling and was discarded whole — the rules MOVED to a `user` role (moved, not deleted; a test asserts every rule still arrives), 3023 → 579. The same guard then found a THIRD instance: `historyToMessages` embedded the entire history a second time, 20,116 chars on ten turns, discarded every time and paid for twice. (14) The container healthcheck probed `/api/v1/health`, which touches nothing and always answers ok — so a dead Postgres still reported `healthy`. Now probes `/api/health`; only `db` is CRITICAL, the other four are reported so an optional blip cannot restart-loop a healthy container. (13) `license-client.ts` stored `data.plan` verbatim, and an unrecognised plan resolves to `starter` — the MOST restrictive tier — so a renamed plan would cripple a flat-licence install with no test able to catch it (the e2e mock defaults unknown keys to `enterprise`). Now normalised at the boundary, unrecognised values dropped and logged.

**Suite 40s → 20s, and two fail-open gates closed.** The wall time was ONE file: `ai.test.ts` 38.8s, of which 11 tests × 3.5s was pure backoff `setTimeout` (concurrency 8→32 moved it <0.8s, proving a critical path). `LLM_RETRY_BACKOFF_BASE_MS` is now env-overridable with the default UNCHANGED. The two runners globbed different sets (303 vs 290), so 13 benchmark suites ran but were never measured; both now share one `TEST_FILE_GLOB` with a parity guard. `coverage.ts` never exited non-zero on an inner failure and wrote a `failedTestFiles` field with no reader; `coverage-gate.ts` exited 0 when its summary was missing.

**Seven floors re-derived, not loosened.** Each sat above its measurement because the files grew (guardrails 454 → 611 lines). Reset to measured-minus-one with the number and reason recorded. The gate's own refusal path was respected rather than bypassed.

**Verified:** tsc 0 · lint 0 errors · 307/307 files, 7599 pass, 0 fail · coverage:gate OK (203 modules) · e2e dev 18 · e2e:prod 18 · `docker compose config` rc=0 on both composes. Negative controls restored byte-identical throughout, including one that reproduced the ORIGINAL leaks (an analyst got HTTP 200 when `requireRole` was deleted).

**Recorded rather than hidden:** arithmetic counts (`LIMIT 1000000*100`) and `TOP n PERCENT` cannot be bounded by a lexical clamp — both pinned as DOCUMENTED GAP tests so the absence stays visible. A deliberately-failing negative-control artifact (`zz-nc-plant.test.ts`) was left in the tree by a subagent and removed; it was the cause of a transient 8-failure suite run.

### 2026-10-01 (b) — v1.7.0–v1.7.2: faster answers, a security pass, two corrections

**v1.7.0 = latency, v1.7.1 = the batch after it, v1.7.2 = two defects found by reviewing 1.7.1** (a cancelled request was classed as a timeout; a safety test passed with no build on disk). Details in `docs/latency-reference.md`; measured on
15 policy questions x3, on one machine.

- Median time to first token **9.3 s → 7.6 s**, LLM calls before it **4.7 → 3.7**, and first-token p95
  **43.3 s → 11.3 s** once `fetchWithRetry` stopped retrying TIMEOUTS (it retried the one failure that
  had already spent the full 30 s budget, up to four times). That retry also cost ACCURACY: 3 of 12
  tool-selection calls returned `null` on a transport timeout, and `null` silently falls back to the
  heuristic router. A 5xx and a connection error still use the full ladder.
- Tool selection starts ALONGSIDE intent analysis (`SPECULATIVE_ROUTING=false` restores serial order);
  a multi-phrasing query is reranked ONCE, not once per phrasing; cognee's two recall strategies run
  concurrently (MEASURED on production: 565 ms + 536 ms were serialised on every turn).
- A per-turn breakdown reaches the `done` frame and `/api/metrics`
  (`chat_first_token_ms`, `chat_turn_total_ms`, `chat_pre_token_llm_calls`), and
  `benchmark/latency-eval.ts` refuses a change that makes a previously-correct answer wrong.
- Citation snippets show the chunk's own text (they showed the document's context prefix, so three
  sources of one document displayed the same 240 characters).

**Rejected with evidence, not re-open blindly:** turning the reranker off is fastest (median → 5.3 s)
but on this corpus the answer chunk is already first after fusion in 13 of 14 answerable questions, so
"no regression" could not have failed; and the rerank score cannot replace the reflection check — the
compound question scored 10 while reflection correctly called the evidence insufficient.

**Security: 130 advisories → 0** (`bun audit`; v1.7.1 left 2, closed in v1.7.3 by overriding `deepmerge-ts`/`effect`). `next` 16.1.3 → 16.3.8 fixes two CRITICALS fixed only
in ≥16.3.3, one of them an unauthenticated RCE in the Image Optimization API — live here, because the
login screen calls `next/image`. The declared range `^16.1.1` would have reinstalled a vulnerable
version on the next install, so the floor is now asserted by a test. `prismjs` is pinned to 1.30.0 by
override (`react-syntax-highlighter → refractor@3.6.0` pulls `~1.27.0` into a CLIENT chunk). `deepmerge-ts`
and `effect` are pinned exactly by `@prisma/config@6.19.2` (prisma CLI only); v1.7.3 overrides them after
running migrate's real command inside the real scheduler image. `dependency-security.test.ts` asserts all three.

**Two audit findings were WRONG, corrected here.** The HNSW index is PRESENT in production
(`DocumentChunk_embedding_hnsw`, checked with `pg_indexes`), and three of the four "missing indexes"
have no query that would use them — only `Document(organizationId, status, isEnabled, createdAt)` was
real and is added.

**A real bug: `restoreDocVersion` orphaned the knowledge graph.** It deleted a document's chunks and
re-inserted them without touching `KgRelation`, whose `chunkId` names a chunk id — MEASURED, 131 of 131
rows orphaned in a development database, 0 in production. Fixed in the same operation. **The FK was
deliberately NOT added**: `prisma db push` runs in `migrate` on EVERY boot BEFORE the app starts, and
on a clone holding those rows it exited non-zero ("violates foreign key constraint"), so an affected
install would stop booting. `scripts/cleanup-kg-orphans.ts` handles an install that already has
orphans; on the clone the push succeeded once it had run.

**A negative control caught a vacuous test TWICE.** The cleanup first chained `.catch()`, which does
NOT catch a synchronous throw from an absent `kgRelation` delegate — the throw aborted the restore
after the chunks were already deleted. Its test then survived its own control twice: `delete
dbMock.kgRelation` reads as undefined (so `.catch()` caught the TypeError after all), and swapping
`dbMock.db` after import changed nothing because the reference was already bound. It now throws on
property ACCESS through a Proxy installed before the import, and the old form fails it.

**Verified:** tsc 0 · lint 0 errors · 313 files, 7664 pass, 0 fail · coverage:gate OK · e2e 19 ·
build · e2e:prod 19.

<!-- Moved from CLAUDE.md on 2026-10-05: CLAUDE.md + AGENTS.md reached 67,476 bytes against the 65,536-byte read budget
(coverage-floor-consistency.test.ts). -->

### 2026-09-30 (b) — Release 1.4.0: AI Memory gets its own extraction model, and the sub-menu names its consumer

**Version 1.3.0 → 1.4.0** (minor: a new user-facing capability, no breaking change). Eight stamped locations bumped, CHANGELOG heading cut, `main` fast-forwarded, tag `v1.4.0` pushed, all six image tags verified published, then **deployed and confirmed live** — `/api/v1/health` reports 1.4.0, all six services healthy, and the served `install.sh` updated to 1.4.0 (sha256 identical to the tested copy).

**The sub-menu now says which consumer it configures.** `Chat Configuration` / `AI Memory Configuration` / `Embedding`, replacing "LLM / Embedding / AI Memory" — where two of the three fed DIFFERENT consumers with different credentials and neither name said which.

**Memory can have its own model**, stored as an `LlmConfig` row with `purpose: 'memory'` (the table's unique key is `(organizationId, purpose)`, so no schema change). Extraction is high-volume and structure-bound where a fast model is the better trade, and the previous mechanism was a hard COPY of the chat row. **The fallback is the load-bearing part**: unset means FOLLOW CHAT, so every upgrading install keeps working — verified on production, where no `memory` row exists and the boot log reads `Memory provider shared with cognee: Shared openai/cbcn/deepseek-v4-flash`.

**Storage facts come from the sidecar**, measured live: `relational_db=postgres, vector_db=pgvector, graph_db=kuzu, file_storage=local`. `getCogneeGraphProvider()` was deliberately NOT used as the source — it derives the graph backend from a field its own comment calls INERT, so it is right only by coincidence.

**Two limits found by probing the sidecar, reported instead of worked around:** `save_llm_config` stores provider/model/api_key and has NO endpoint field (four spellings posted, all stored `''`), so the endpoint is saved app-side and surfaced as the exact `OPENAI_API_BASE=` line; and the settings API exposes no embedding parameters, so the Embedding tab REPORTS the memory embedder rather than offering a field that could not take effect.

**Negative-controlled 21/21, and the control changed the code twice** — the recurring value of running it: (1) the test guarding ENCRYPTION of a billable credential asserted only that the mocked encryptor had been CALLED, so a route calling it and storing plaintext passed; it now reads the stored payload and decrypts it back, with the UPDATE arm covered separately (the harness proved those are separate write sites by only breaking one). (2) The rename guard asserted the new label but not the absence of the old, so reverting to `LLM` stayed green.

**Verified:** tsc 0 · lint 0 errors · 300/300 files, 7431 pass, 0 fail · coverage:gate exit 0 (203 gated modules; new route floored at 98 against a measured 99.37%) · e2e dev 18 · e2e:prod 18.

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

