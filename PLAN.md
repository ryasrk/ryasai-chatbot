# ryasai Chatbot — Comprehensive Overhaul Plan

> Created 2026-07-25. Based on 5-area audit (chat menu, API integration, provider format, DB relations, arch flow) + 6 business goals.

---

## Business Goals → Feature Mapping

| # | Goal | Current State | Target State |
|---|------|---------------|--------------|
| 1 | Sell the program | Has security holes (secrets in git, no middleware, unauth SSRF), dead code, inconsistent UI | Production-ready, secure, polished, consistent UI/UX |
| 2 | Multi-dimensional Chat (DB+Knowledge+REST) | Chat is non-streaming HTTP, routes to SQL/RAG/REST/CHAT but no visible progress, WS service orphaned | Chat streams tokens + shows per-tool execution status (SQL/RAG/REST) in real-time |
| 3 | Plug-and-play external API | `/api/v1/chat/completions` exists but fake-streams (4-char chunks), no CORS docs | Real SSE streaming, CORS config, API docs page, ready to embed |
| 4 | Agentic for config/monitoring | Regex admin actions + pure LLM fallback, no plugins, no confirmation gates | Agentic uses planner+plugins, confirmation on destructive actions, monitoring dashboard |
| 5 | Scheduler + notifications | Scheduler runs cron prompts, no notification delivery | Notification API (webhook + email + Telegram), scheduler sends results to notifications |
| 6 | External plugin support | GET plugins broken (no query params), plugin UI is basic table | Fixed GET execution, plugin marketplace UI (browse+add+test), user-friendly manifest editor |

---

## Phase P0 — Security Foundation (CRITICAL, pre-sell)

### P0.1 Edge auth middleware (Major)
- Create `src/middleware.ts` — allowlist: `/api/auth/login`, `/api/setup/*`, `/api`, `/api/v1/health`. All other `/api/*` require session cookie. Non-API paths pass through (SPA handles its own gate).
- Files: NEW `src/middleware.ts`

### P0.2 Fix unauthenticated SSRF (Major)
- Add `getActiveUser()` to `/api/fetch-url` route.
- Files: `src/app/api/fetch-url/route.ts`

### P0.3 Fix AUTH_DEMO_FALLBACK default (Minor)
- Default to `false` everywhere, require explicit `AUTH_DEMO_FALLBACK=true` to enable.
- Files: `src/lib/config.ts`

### P0.4 Harden SSRF blocklist (Major)
- Block: `127.0.0.1`, `localhost`, `::1`, `0.0.0.0`, `169.254.*` (link-local), RFC1918 (`10.*`, `172.16-31.*`, `192.168.*`), IPv6 ULA (`fd00::/8`), CGNAT (`100.64.*`).
- Apply to: plugin endpoints (already calls it), REST connector baseUrl (currently missing), LLM baseUrl, embedding baseUrl, fetch-url, integration-api/test.
- Files: `src/lib/llm-config.ts`, `src/app/api/data-sources/rest-connectors/route.ts`, `src/app/api/data-sources/rest-connectors/[id]/route.ts`

### P0.5 Error boundaries (Minor)
- Create `src/app/error.tsx` (route-level) + `src/app/global-error.tsx` (root-level).
- Files: NEW `src/app/error.tsx`, NEW `src/app/global-error.tsx`

### P0.6 DB schema fixes (Major)
- `Plugin.toolId` → add `@unique` constraint.
- `AgentRun` → add relations to User + ChatSession (onDelete: SetNull), add indexes on `userId`, `sessionId`.
- `AuditLog` → add index on `createdAt`, `action`.
- `ChatMessage` → add index on `userId`, `integrationId`.
- `LlmConfig` → add `@unique` on `purpose`.
- Files: `prisma/schema.prisma`

### P0.7 Git secrets cleanup (Major)
- Add `db/custom.db`, `db/*.db`, `db/*.db-journal` to `.gitignore`.
- `git rm --cached .env db/custom.db` (untrack without deleting local).
- Document: rotate encryption key + all stored credentials after this.
- Files: `.gitignore`

### P0.8 Dead code removal (Minor)
- Remove `examples/` directory (orphaned reference WS code).
- Remove stale `prisma/*.sql` files (reference deleted Company model).
- Remove `next-auth` from package.json (unused dependency).
- Remove `src/components/chat-socket-provider.tsx`, `src/hooks/use-chat-socket.ts` (orphaned WS client code).
- Files: `package.json`, removed files

---

## Phase P1 — Core LLM + Chat Fixes (HIGH, makes product work)

### P1.1 Deduplicate LLM clients (Major)
- Merge `src/lib/ai.ts` + `src/lib/agent-llm.ts` → unified `src/lib/llm-client.ts`.
- Export: `chatOnce(messages, opts)`, `chatStream(messages, opts)`, `agentChatOnce`, `agentChatStream`.
- Fix Anthropic system-message bug: concatenate ALL system messages into `system` field, not just first.
- Fix `max_tokens` inconsistency: use shared constant.
- Fix error handling: always read response body on error.
- Add LLM retry (1 retry with 1s backoff on 5xx/network errors).
- Update all importers.
- Files: `src/lib/ai.ts` (refactor), `src/lib/agent-llm.ts` (delete), NEW `src/lib/llm-client.ts`, all importers

### P1.2 Chat SSE streaming (Major) — Goal #2
- Rewrite `send/route.ts` to return SSE stream (like agentic dashboard).
- Stream: `thinking` → `tool_start` (with tool type: SQL/RAG/REST/CHAT) → `text_stream` (tokens) → `tool_end` → `answer` → `done`.
- Use `chatStream` from unified LLM client for token streaming.
- Emit status updates during SQL execution, RAG retrieval, REST calls.
- Files: `src/app/api/chat/sessions/[id]/send/route.ts`, `src/components/views/chat-view.tsx`, `src/store/useChatStore.ts`

### P1.3 Fix GET plugin execution (Major) — Goal #6
- `executePlugin`: for GET requests, parse `paramDescription` as query params, append to endpoint URL.
- Support: `key=value` format in paramDescription, or JSON schema format.
- Pass `input` as the value for the first param, or parse as JSON if structured.
- Files: `src/lib/plugin-registry.ts`

### P1.4 Fix session cross-contamination (Minor)
- `GET /api/chat/sessions`: filter `title NOT startsWith '[Agent]'`.
- `GET /api/chat/sessions/[id]`: filter `sender IN ['user','ai']` (exclude 'agent').
- Files: `src/app/api/chat/sessions/route.ts`, `src/app/api/chat/sessions/[id]/route.ts`

### P1.5 Remove orphaned WS infrastructure (Minor)
- Delete `mini-services/chat-service/` directory (1182 lines, completely disconnected).
- Remove `socket.io` + `socket.io-client` from package.json.
- Update `start.sh` to not start chat-service.
- Keep `mini-services/scheduler/` (it's used).
- Files: `mini-services/chat-service/` (delete), `package.json`, `start.sh`

---

## Phase P2 — Feature Implementation (HIGH, business goals)

### P2.1 Real external API streaming (Major) — Goal #3
- `/api/v1/chat/completions`: when `stream: true`, proxy real LLM token streaming via `chatStream`.
- Add CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, `Access-Control-Allow-Methods`) for browser embedding.
- Handle OPTIONS preflight.
- Files: `src/app/api/v1/chat/completions/route.ts`

### P2.2 Notification API (Major) — Goal #5
- New Prisma model `NotificationConfig`: `{ id, name, type (webhook|email|telegram), config (encrypted), isActive, createdAt }`.
- New `src/lib/notifications.ts`: `sendNotification(config, message)` — webhook (HTTP POST), email (SMTP), Telegram (Bot API).
- New API routes: `GET/POST /api/notifications`, `GET/PATCH/DELETE /api/notifications/[id]`, `POST /api/notifications/test`.
- Files: `prisma/schema.prisma`, NEW `src/lib/notifications.ts`, NEW `src/app/api/notifications/route.ts`, NEW `src/app/api/notifications/[id]/route.ts`, NEW `src/app/api/notifications/test/route.ts`

### P2.3 Scheduler + notification integration (Major) — Goal #5
- `ScheduledRun` model: add `notificationConfigId` field.
- `scheduler/index.ts`: after `runNonStreamingChatCompletion`, if `notificationConfigId` set, call `sendNotification`.
- Scheduler UI: add notification config dropdown.
- Files: `prisma/schema.prisma`, `mini-services/scheduler/index.ts`, `src/components/views/schedules-view.tsx`, `src/app/api/schedules/route.ts`

### P2.4 Agentic improvements (Major) — Goal #4
- Make agentic dashboard use `planQuery` + `executePlan` (not just regex + raw LLM).
- Add confirmation gate for destructive admin actions (require "konfirmasi: yes" in message).
- Fix tool cards: push new `ToolCard` on `tool_start` event (not just update existing).
- Add monitoring summary: agentic can query ToolRun stats, AuditLog, ApiRequestLog.
- Files: `src/app/api/agent/dashboard/route.ts`, `src/components/views/agentic-view.tsx`

### P2.5 Plugin marketplace UI (Major) — Goal #6
- Redesign `plugins-view.tsx`: card grid (not table), category filter sidebar, search bar.
- Add "Add Custom Plugin" wizard: endpoint URL, method, auth type, credentials, test button.
- Add "Test Plugin" button per plugin card.
- Show plugin execution history (last 5 runs).
- Files: `src/components/views/plugins-view.tsx`

---

## Phase P3 — UI/UX Standardization (MEDIUM, polish for selling)

### P3.1 Color psychology system (Major)
Based on research:
- **Blue (#2563EB)**: Trust, professionalism, security — primary brand color (Mehta & Zhu 2009: blue enhances creative performance; Bellizzi & Hite 1992: reduces perceived risk)
- **Purple (#7C3AED)**: Intelligence, creativity, AI — agentic/AI accent (associated with innovation and luxury)
- **Green (#16A34A)**: Success, growth — success states (universal "go" signal)
- **Red (#DC2626)**: Danger, urgency — destructive actions (Elliott & Maier 2014: avoidance/negative)
- **Amber (#D97706)**: Warning, caution — pending/warning states
- **Slate (#64748B)**: Neutral, low cognitive load — backgrounds, secondary text (Pelet & Papadopoulou 2012: reduces cognitive load)
- **Indigo (#4F46E5)**: Bridge between blue primary and purple AI — secondary accent

Standardize default theme to "Enterprise Blue" (blue primary + purple AI accent + slate neutrals). Keep theme switcher but make all themes follow same semantic token structure.

Files: `src/app/globals.css`, `src/lib/themes.ts`, `tailwind.config.ts`

### P3.2 Multi-dimensional Chat UI (Major) — Goal #2
- Chat view: show tool execution pipeline (SQL/RAG/REST) with status badges during streaming.
- Show which data source was queried (integration name, document name, REST endpoint).
- Citations panel: collapsible, shows source chunks for RAG, SQL query for SQL, endpoint for REST.
- Chart rendering: keep existing, standardize colors with theme.
- Files: `src/components/views/chat-view.tsx`

### P3.3 View standardization (Minor)
- All views: consistent header pattern (title + description + action button).
- All views: consistent loading state (centered spinner, not skeleton).
- All views: consistent empty state (icon + message + CTA).
- All views: consistent error state (alert + retry button).
- All tables: consistent column alignment, row density, pagination.
- All forms: consistent label/input/submit pattern.
- Files: all `src/components/views/*.tsx`

### P3.4 API documentation page (Minor) — Goal #3
- New view or tab in Integration API: embeddable API docs.
- Show: base URL, auth method, endpoints, request/response examples, curl snippets, JS/Python snippets.
- Copy-to-clipboard for all code blocks.
- Files: `src/components/views/integration-api-view.tsx`

---

## Phase P4 — Code Quality (MEDIUM)

### P4.1 LLM token usage tracking (Minor)
- Parse `usage` from provider response, persist to `ToolRun` or new `LlmUsageLog` model.
- Show in monitoring dashboard.
- Files: `src/lib/llm-client.ts`, `prisma/schema.prisma` (optional new model)

### P4.2 Log retention (Minor)
- Add cleanup cron to scheduler: delete `AuditLog`, `ApiRequestLog`, `RestApiRequestLog`, `ToolRun`, `QueryHistory` older than 90 days.
- Configurable via env `LOG_RETENTION_DAYS`.
- Files: `mini-services/scheduler/index.ts`

### P4.3 ESLint re-enablement (Minor)
- Re-enable high-signal rules: `no-unused-vars`, `no-unreachable`, `react-hooks/exhaustive-deps`.
- Keep `no-explicit-any` off for now (too many instances).
- Files: `eslint.config.mjs`

### P4.4 writeAudit fail-closed for critical (Minor)
- `writeAudit`: for `severity: 'critical'`, throw on DB write failure (don't swallow).
- For `info`/`warning`: keep current swallow + console.error behavior.
- Files: `src/lib/session.ts`

---

## Phase P5 — Tests (HIGH, user explicitly requested)

### P5.1 Unit tests for core libs
- `src/lib/llm-client.test.ts` — chatOnce, chatStream, Anthropic vs OpenAI branching, retry logic, system message concatenation.
- `src/lib/plugin-registry.test.ts` — already exists, add GET query param tests.
- `src/lib/plugin-selector.test.ts` — already exists.
- `src/lib/planner.test.ts` — already exists, add plugin execution tests.
- `src/lib/notifications.test.ts` — webhook, email, Telegram (mocked).
- `src/lib/ssrf.test.ts` — isBlockedHost with all private/loopback ranges.
- `src/lib/middleware.test.ts` — route allowlist, cookie check, redirect behavior.

### P5.2 Integration tests for API routes
- `src/app/api/chat/sessions/[id]/send/route.test.ts` — SSE streaming, tool execution, error handling.
- `src/app/api/v1/chat/completions/route.test.ts` — real streaming, API key auth, rate limiting, CORS.
- `src/app/api/notifications/route.test.ts` — CRUD, test endpoint.
- `src/app/api/fetch-url/route.test.ts` — auth required, SSRF blocked.
- `src/app/api/tools/route.test.ts` — plugin CRUD, toolId uniqueness.

### P5.3 E2E tests (Playwright)
- Chat flow: login → create session → send message → see streaming response + tool status.
- Plugin flow: add plugin → test → enable → use in chat.
- Scheduler flow: create schedule → add notification → trigger manually → verify notification.
- External API: create API key → call /v1/chat/completions with stream → verify SSE.

---

## File Conflict Matrix

| Task | Files touched | Conflicts with |
|------|--------------|----------------|
| P0.1 | NEW src/middleware.ts | none |
| P0.2 | src/app/api/fetch-url/route.ts | none |
| P0.3 | src/lib/config.ts | none |
| P0.4 | src/lib/llm-config.ts, rest-connectors routes | none |
| P0.5 | NEW src/app/error.tsx, global-error.tsx | none |
| P0.6 | prisma/schema.prisma | P2.2, P2.3 (schema) — do P0.6 first |
| P0.7 | .gitignore | none |
| P0.8 | package.json, removed files | P1.5 (package.json) — combine or sequence |
| P1.1 | src/lib/ai.ts, agent-llm.ts, NEW llm-client.ts | P1.2, P2.1 (import from LLM client) — do P1.1 first |
| P1.2 | send/route.ts, chat-view.tsx, useChatStore.ts | P3.2 (chat-view.tsx) — do P1.2 first |
| P1.3 | src/lib/plugin-registry.ts | none |
| P1.4 | sessions/route.ts, sessions/[id]/route.ts | none |
| P1.5 | mini-services/chat-service/ (delete), package.json, start.sh | P0.8 (package.json) — combine |
| P2.1 | v1/chat/completions/route.ts | P1.1 (import) — do P1.1 first |
| P2.2 | prisma/schema.prisma, NEW files | P0.6 (schema) — do P0.6 first |
| P2.3 | prisma/schema.prisma, scheduler, schedules UI | P0.6, P2.2 (schema) — sequence |
| P2.4 | agent/dashboard route, agentic-view.tsx | none |
| P2.5 | plugins-view.tsx | P3.3 (view standardization) — do P2.5 first |
| P3.1 | globals.css, themes.ts, tailwind.config.ts | none |
| P3.2 | chat-view.tsx | P1.2 — do P1.2 first |
| P3.3 | all views | P2.5, P3.2 — do after |
| P4.x | various | do after P1-P3 |

---

## Execution Order

```
Batch 1 (parallel, no conflicts):
  ├── P0.1 Edge auth middleware
  ├── P0.2 + P0.3 + P0.5 Security fixes (fetch-url, demo fallback, error boundaries)
  ├── P0.4 + P0.6 SSRF + DB schema
  └── P0.7 + P0.8 Git cleanup + dead code

Batch 2 (parallel, after Batch 1):
  ├── P1.1 LLM client dedup (MUST finish before P1.2, P2.1)
  ├── P1.3 Fix GET plugins
  ├── P1.4 Fix session contamination
  └── P1.5 Remove orphaned WS

Batch 3 (parallel, after Batch 2):
  ├── P1.2 Chat SSE streaming (after P1.1)
  ├── P2.1 Real external API streaming (after P1.1)
  ├── P2.2 + P2.3 Notification API + scheduler integration
  ├── P2.4 Agentic improvements
  └── P2.5 Plugin marketplace UI

Batch 4 (parallel, after Batch 3):
  ├── P3.1 Color psychology system
  ├── P3.2 Multi-dimensional Chat UI (after P1.2)
  ├── P3.3 View standardization
  └── P3.4 API documentation page

Batch 5 (parallel, after Batch 4):
  ├── P4.1-P4.4 Code quality
  └── P5.1-P5.3 Tests
```
