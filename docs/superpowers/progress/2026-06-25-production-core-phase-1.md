# Production Core Phase 1 Progress

Date started: 2026-06-25
Spec: docs/superpowers/specs/2026-06-25-chatbot-production-core-design.md
Plan status: deleted after execution to reduce non-runtime document clutter; this progress ledger is the durable handoff.

## Current Status

- Active task: Phase 2 UI baseline complete
- Last verified command: `curl http://localhost:3005/` returned HTTP 200
- Next step: Visually review Settings API Keys and REST API Connectors in the browser; then add endpoint whitelist create/test UI.

## Task Log

- [x] Task 1 - Progress Ledger and Prisma Models
- [x] Task 2 - API Key Utility
- [x] Task 3 - REST API Connector Utility
- [x] Task 4 - External API Auth and Health
- [x] Task 5 - Admin API Key Routes
- [x] Task 6 - Admin REST Connector Routes
- [x] Task 7 - External Chat Completion Endpoint
- [x] Task 8 - Verification and Durable Handoff

## Notes

- Work is being done inline on branch `main` because the user explicitly requested immediate implementation.
- The repo already had many modified files before this phase. This phase only intentionally touches files listed in the phase plan.
- `bun run db:push` is unsafe in the current DB because Prisma wants to drop manually-created demo ERP tables. Use explicit `CREATE TABLE IF NOT EXISTS` DDL for phase tables instead.
- `tsconfig.json` now includes `bun-types` so Bun test files type-check under `bunx tsc --noEmit`.
- Commit was not created for this phase because the repo already had pre-existing uncommitted changes in files also touched by this work (`prisma/schema.prisma`, `worklog.md`, `src/lib/ai.ts`). Avoid staging whole files until a human or next session reviews the mixed diff.
- Cleanup after user request: removed server log file `run`, removed completed Phase 1 plan doc, and consolidated `src/lib/external-api-auth.ts` into `src/lib/api-keys.ts`.

## Verification Evidence

- `bun test src/lib/api-keys.test.ts src/lib/rest-api-connectors.test.ts` passed: 7 tests, 0 failures, 14 assertions.
- `bunx tsc --noEmit` passed with exit code 0.
- `bun run lint` passed with exit code 0.
- `bunx prisma validate` passed; schema is valid.
- `bun test --pass-with-no-tests` passed: 7 tests, 0 failures, 14 assertions.

## Implemented Files

- `prisma/schema.prisma`
- `prisma/production-core-phase-1.sql`
- `tsconfig.json`
- `src/lib/api-keys.ts` (also contains external Bearer API key auth helpers)
- `src/lib/api-keys.test.ts`
- `src/lib/rest-api-connectors.ts`
- `src/lib/rest-api-connectors.test.ts`
- `src/lib/ai.ts`
- `src/app/api/v1/health/route.ts`
- `src/app/api/v1/chat/completions/route.ts`
- `src/app/api/settings/api-keys/route.ts`
- `src/app/api/settings/api-keys/[id]/route.ts`
- `src/app/api/data-sources/rest-connectors/route.ts`
- `src/app/api/data-sources/rest-connectors/[id]/route.ts`
- `src/app/api/data-sources/rest-connectors/[id]/endpoints/route.ts`
- `src/app/api/data-sources/rest-connectors/[id]/test/route.ts`
- `docs/superpowers/progress/2026-06-25-production-core-phase-1.md`
- `worklog.md`

## Remaining Follow-Up

- Configure production LLM provider through AI Configuration before expecting successful chat completions; without it, `/api/v1/chat/completions` and the internal Chat send endpoint return HTTP 503 with actionable setup messages.
- Decide whether to add Prisma models for manual `demo_*` tables or continue using explicit DDL files for production-core schema changes.
- Browser visual QA for Chat desktop/mobile is complete for the REST-based repair. Continue visual QA for the remaining non-Chat views if needed.

## Phase 2.3 UI Standardization Progress

- [x] Standardize dashboard layout into production operations dashboard.
- [x] Standardize app shell language for dedicated single-admin deployment.
- [x] Remove demo multi-user/RBAC topbar dropdown.
- [x] Neutralize aurora/glass/shimmer visual treatment in global CSS.
- [x] Run typecheck, lint, unit tests, and HTTP smoke checks.

### Phase 2.3 Verification

- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 12 tests, 0 failures, 21 assertions.
- Dev server started on `http://localhost:3005`.
- Smoke checked running app:
  - `GET /` returned HTTP 200.
  - `GET /api/analytics` returned HTTP 200.
  - `GET /api/v1/health` returned HTTP 200.

## Phase 2.4 Full UI Standardization Progress

- [x] Standardize shared `Card` primitive: 8px radius, tighter spacing, no default shadow.
- [x] Standardize shared `Dialog` primitive: lighter overlay, consistent padding, production title sizing.
- [x] Standardize shared `Sheet` primitive: consistent width baseline, bordered header/footer, shorter transitions.
- [x] Remove visible RBAC/multi-tenant/demo/local-inference copy conflicts from production-facing settings and integration screens.
- [x] Keep LLM configuration API-only: removed visible Ollama/local provider option.
- [x] Run typecheck, lint, unit tests, and HTTP smoke checks.

### Phase 2.4 Verification

- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 12 tests, 0 failures, 21 assertions.
- Smoke checked running app on `http://localhost:3005`:
  - `GET /` returned HTTP 200.
  - `GET /api/analytics` returned HTTP 200.
  - `GET /api/integrations` returned HTTP 200.
  - `GET /api/documents` returned HTTP 200.
  - `GET /api/settings/api-keys` returned HTTP 200.

## Phase 2.5 Chat Audit And Repair Progress

- [x] Build a reproducible feedback loop for the broken Chat menu.
- [x] Confirm root cause: Chat send was hard-dependent on an unavailable Socket.IO mini-service/gateway.
- [x] Add internal REST send endpoint for production Chat.
- [x] Rework Chat UI to use REST API delivery instead of blocking on WebSocket state.
- [x] Persist AI error messages when LLM provider setup is missing.
- [x] Add `?view=chat` deep-link support for direct Chat access and browser QA.
- [x] Remove primary-shell initial opacity/stagger animations that made screenshots/load look pale or blank.
- [x] Clean mobile Chat layout: no duplicate prompts, shorter placeholder, fewer mobile prompt cards.
- [x] Run typecheck, lint, tests, HTTP smoke, and browser screenshot QA.

### Phase 2.5 Verification

- Root-cause repro before fix:
  - Socket smoke to `http://localhost:3005/?XTransformPort=3003` returned `connect_error websocket error`.
  - `GET /api/chat/sessions` returned HTTP 200, proving session REST was healthy while Chat UI was blocked by socket availability.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 14 tests, 0 failures, 23 assertions.
- HTTP smoke on running app:
  - `POST /api/chat/sessions` created a session.
  - `POST /api/chat/sessions/[id]/send` returned HTTP 503 with clear AI Configuration copy because no LLM provider is configured.
  - `GET /api/chat/sessions/[id]` after the 503 showed two persisted messages: the user prompt and an AI `status="error"` setup message.
- Browser QA:
  - `http://localhost:3005/?view=chat` opens the Chat view directly.
  - Playwright screenshots captured for desktop `1440x900` and mobile `390x844`.
  - Final mobile Chat screenshot shows the REST API badge, compact prompt list, source selector, and input without clipped duplicate prompt chips.

## Phase 2.6 Chat Session Delete Fix

- [x] Reproduce delete behavior with a create/delete/list API loop.
- [x] Confirm API/database delete is correct: deleted session detail returns 404 and list excludes the deleted id.
- [x] Fix Chat UI state handling after delete:
  - delete now re-fetches `/api/chat/sessions` from the server after success or 404,
  - callbacks use the latest Zustand state via `useChatStore.getState()`,
  - active deleted session is cleared and the next server-confirmed session is selected,
  - delete button is visible on mobile/touch and shows a spinner while deleting,
  - manually-created session titles are timestamped to avoid many identical `Sesi Baru` rows.
- [x] Run typecheck, lint, tests, and delete-loop smoke verification.

### Phase 2.6 Verification

- API repro before UI fix showed:
  - `DELETE /api/chat/sessions/[id]` returned HTTP 200.
  - `GET /api/chat/sessions/[id]` returned HTTP 404.
  - `GET /api/chat/sessions` did not include the deleted id.
- Final verification:
  - `bunx tsc --noEmit` passed.
  - `bun run lint` passed.
  - `bun test --pass-with-no-tests` passed: 14 tests, 0 failures, 23 assertions.
  - Final delete-loop smoke returned `{ "found": false }`.

## Phase 2.7 UI CRUD Best Practices

- [x] Standardize server revalidation after mutation across Chat, Knowledge, Data Sources, REST connectors, and Settings API Keys.
- [x] Avoid stale UI snapshots in Chat by reading latest Zustand state inside callbacks.
- [x] Make delete operations idempotent in the UI: HTTP 404 is treated as already removed, followed by list revalidation.
- [x] Add per-item deleting states where the admin can remove documents or integrations.
- [x] Close stale detail/schema/query panels when the backing item has been removed.
- [x] Clarify Chat source selector wording from `Otomatis (RAG + DB)` to `Otomatis (semua sumber)`.
- [x] Run typecheck, lint, unit tests, API smoke checks, and browser DOM verification.

### Phase 2.7 Verification

- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 14 tests, 0 failures, 23 assertions.
- Smoke checked production mutation loops on running app:
  - Chat session create/delete/list returned `{ "area": "chat", "found": false }`.
  - API key create/revoke/list returned `{ "area": "api-key", "active": null, "revoked": false }`, confirming revoked keys are not present in the active-key list.
  - Integration create/delete/list returned `{ "area": "integration", "found": false }`.
- Browser DOM QA on `http://localhost:3005/?view=chat` confirmed:
  - source selector displays `Otomatis (semua sumber)`,
  - helper copy displays `Router memilih Knowledge, Database, REST API, atau Chat.`,
  - old `RAG + DB` copy is no longer rendered.

## Phase 2.8 Audit Log Page Size

- [x] Limit Security/Audit Log UI requests to 20 events per page.
- [x] Add backend guard so `/api/audit?pageSize=50` is capped to `pageSize: 20`.
- [x] Update visible Audit Log copy to explain the 20-event page cap.
- [x] Add regression test for audit pagination.
- [x] Run targeted test, typecheck, lint, and full test suite.

### Phase 2.8 Verification

- Red test first failed because `parseAuditPagination` was not exported yet.
- `bun test src/app/api/audit/route.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 15 tests, 0 failures, 24 assertions.

## Phase 2.9 Data Sources DB/API Separation

- [x] Confirm UX issue: database integration modal exposed `DATABASE/API` type choices while REST API already had a dedicated connector flow.
- [x] Rename main action to `Tambah Database`.
- [x] Make database create dialog database-only.
- [x] Remove ambiguous `Tipe` selector from the database dialog.
- [x] Remove `REST_API` from database provider choices.
- [x] Keep REST API setup in the `REST API Connectors` section with clearer `Tambah REST` copy.
- [x] Harden backend `/api/integrations` so it only accepts database providers.
- [x] Add regression test for rejecting REST API creation through `/api/integrations`.
- [x] Run targeted test, typecheck, lint, full tests, and HTTP smoke.

### Phase 2.9 Verification

- Red test first failed because `validateCreateIntegrationInput` was not exported yet.
- `bun test src/app/api/integrations/route.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 16 tests, 0 failures, 26 assertions.
- `GET http://localhost:3005/?view=integrations` returned HTTP 200.

## Phase 2.10 Hydration, Settings API Key, Chat Sessions

- [x] Reproduce and trace hydration risk to first-render `window.location.search` usage in `src/app/page.tsx`.
- [x] Add deterministic view-routing helper for query-string view parsing.
- [x] Change `Home` initial render to match server and apply URL view after hydration.
- [x] Add regression test for view query parsing.
- [x] Remove native password reveal from LLM API key input by using text input plus CSS masking.
- [x] Keep only one custom eye toggle for the LLM API key field.
- [x] Add Chat session list header with collapse/expand state.
- [x] Make Chat session delete buttons visible with fixed right-side hit area.
- [x] Run typecheck, lint, full tests, and CDP browser QA.

### Phase 2.10 Verification

- Red test first failed because `src/lib/view-routing.ts` did not exist.
- `bun test src/lib/view-routing.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 17 tests, 0 failures, 30 assertions.
- Dev server restarted on `http://localhost:3005`.
- Browser QA via Chrome DevTools Protocol:
  - `?view=settings` reported no hydration errors.
  - After clicking `AI / LLM`, `#llm-apikey` exists with `type="text"`, masked class present, one app eye button, and zero native password inputs.
  - `?view=chat` reported no hydration errors.
  - Chat session list starts expanded, has visible delete buttons, and collapses to `aria-expanded="false"` with helper text visible.

## Phase 2.11 Chat Card Overlap Layout

- [x] Replace Chat two-column flex sizing with a grid layout that reserves a stable session-sidebar width and keeps the chat panel `minmax(0, 1fr)`.
- [x] Remove absolute-positioned delete buttons from session cards.
- [x] Add normal right-side action area for message count and delete button so session titles are not covered.
- [x] Change long session titles from one-line truncation to two-line clamp with word wrapping.
- [x] Bound user/AI bubble width and add `overflow-wrap:anywhere`.
- [x] Add `overflow-hidden`/`min-w-0` protections to AI message cards.
- [x] Wrap inline code and keep SQL blocks inside internal scroll areas.
- [x] Make citation/source cards wrap long source labels without pushing card width.
- [x] Make Chat composer source selector/helper row use a grid so controls do not overlap.
- [x] Run typecheck, lint, full tests, HTTP smoke, and browser layout QA.

### Phase 2.11 Verification

- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- CDP browser QA at `1543x774`:
  - document width stayed within viewport,
  - no element was detected outside the viewport,
  - session delete buttons were visible,
  - no hydration errors were logged.
- CDP browser QA at `390x844`:
  - body/document width stayed equal to viewport width,
  - SQL code remained inside an internal scroll area,
  - no hydration errors were logged.
- Screenshot captured at `/tmp/ryasai-chat-layout-fix.png`.
- `bun test --pass-with-no-tests` passed: 17 tests, 0 failures, 30 assertions.
- `GET http://localhost:3005/?view=chat` returned HTTP 200.

## Phase 2.12 Chat Session Rail Collapse

- [x] Confirm previous collapse behavior only hid session-list content and did not resize the sidebar column.
- [x] Add `chatShellGridClass(collapsed)` helper for expanded vs collapsed Chat grid columns.
- [x] Add regression test for desktop Chat grid width classes.
- [x] Lift collapse state into `ChatView` so the parent grid changes width.
- [x] Change desktop collapsed session panel into a 64px rail.
- [x] Keep mobile sheet as a normal full session panel.
- [x] Run targeted test, typecheck, lint, full tests, and browser layout QA.

### Phase 2.12 Verification

- Red test first failed because `src/lib/chat-layout.ts` did not exist.
- `bun test src/lib/chat-layout.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 18 tests, 0 failures, 32 assertions.
- CDP browser QA at `1543x774` confirmed:
  - session sidebar changed from `360px` to `64px`,
  - chat panel changed from `825px` to `1121px`,
  - chat gained `296px` horizontal space,
  - no viewport offenders,
  - no hydration errors.
- Screenshot captured at `/tmp/ryasai-chat-collapsed-rail.png`.

## Phase 2.13 Chat Collapse Icon Motion

- [x] Replace vertical/down collapse icon with left-panel direction icons.
- [x] Use `PanelLeftClose` when the session panel is expanded.
- [x] Use `PanelLeftOpen` when the session panel is collapsed.
- [x] Change collapse motion from grid-template interpolation to session-panel width interpolation.
- [x] Animate session panel width from `clamp(280px,24vw,360px)` to `64px`.
- [x] Add smooth `300ms` cubic easing for sidebar width transition.
- [x] Update layout helper test for grid/width classes.
- [x] Run targeted test, typecheck, lint, full tests, and browser motion QA.

### Phase 2.13 Verification

- Red test first failed because `chatSessionPanelWidthClass` did not exist.
- `bun test src/lib/chat-layout.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 18 tests, 0 failures, 33 assertions.
- CDP browser QA at `1543x774` confirmed:
  - expanded icon uses `panel-left-close`,
  - collapsed icon uses `panel-left-open`,
  - sidebar width animated through `90.58px` before settling at `64px`,
  - chat panel gained `296px`,
  - no hydration errors.
- Screenshot captured at `/tmp/ryasai-chat-smooth-collapse.png`.

## Phase 2.14 Chat Send Delete Race

- [x] Investigate `dev.log` 500 during Chat send after a session delete.
- [x] Identify root cause: assistant reply persistence can hit Prisma `P2003` when the session is deleted while the LLM/tool-router request is still in flight.
- [x] Add regression tests for `P2003` and `P2025` internal Chat send error classification.
- [x] Map those expected delete races to HTTP 404 with `Sesi tidak ditemukan.` instead of logging/returning a generic 500.
- [x] Run targeted test, typecheck, lint, and full test suite.

### Phase 2.14 Verification

- Red test first failed: `statusForInternalChatError({ code: 'P2003' })` and `P2025` returned 500.
- `bun test src/app/api/chat/sessions/[id]/send/route.test.ts` passed: 4 tests, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 20 tests, 0 failures, 35 assertions.

## Phase 2.15 Chatbot Quality Audit Fixtures

- [x] Create live audit fixtures through production APIs for every supported DB provider:
  - `SQLITE_DEMO`
  - `POSTGRESQL`
  - `MYSQL`
  - `MSSQL`
- [x] Confirm each DB fixture reflects 8 demo ERP tables and is active.
- [x] Add durable static REST dummy fixtures:
  - `public/audit-dummy/inventory.json`
  - `public/audit-dummy/tickets.json`
- [x] Create REST connector `Audit Static REST 20260626064518` pointing to `http://localhost:3005`.
- [x] Add whitelisted REST endpoints:
  - `GET /audit-dummy/inventory.json`
  - `GET /audit-dummy/tickets.json`
- [x] Live-test SQL Chat answer for each DB provider with SKU-902 stock question.
- [x] Live-test REST Chat answer with static inventory endpoint.
- [x] Fix REST answer quality issue where the answer prompt called REST context `RAG`.
- [x] Fix REST router prompt so `sampleResponse` is treated as schema example, not final data.
- [x] Fix REST router prompt so it does not invent query/body params when `parameterSchema` is empty.
- [x] Run targeted tests, typecheck, lint, full tests, and live REST retest.

### Phase 2.15 Live Audit Results

- SQL expected result: SKU-902 total quantity = `7,900`.
- SQL live result:
  - `SQLITE_DEMO`: success, answer `7.900`, citation type `DATABASE`, tool run `SQL/success`.
  - `POSTGRESQL`: success, answer `7.900`, citation type `DATABASE`, tool run `SQL/success`.
  - `MYSQL`: success, answer `7.900`, citation type `DATABASE`, tool run `SQL/success`.
  - `MSSQL`: success, answer `7.900`, citation type `DATABASE`, tool run `SQL/success`.
- REST expected result: SKU-902 total quantity = `7,900`.
- REST live result after fixes:
  - answer `7.900`,
  - citation type `REST_API`,
  - source `Audit Static REST 20260626064518 GET /audit-dummy/inventory.json`,
  - `query_used` has `query:{}` because static endpoint has no parameter schema,
  - tool run `REST_API/success`.

### Phase 2.15 Verification

- Red test first failed because `answerContextLabel` was not exported.
- Red test first failed because `REST_ROUTER_SYSTEM_PROMPT` did not include `sampleResponse hanya contoh struktur`.
- Red test first failed because `REST_ROUTER_SYSTEM_PROMPT` did not include the no-invented-params rule.
- `bun test src/lib/ai.test.ts` passed: 3 tests, 0 failures.
- Live REST retest returned correct `7.900` answer and clean REST citation metadata.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 23 tests, 0 failures, 38 assertions.

## Phase 2.16 RAG Chunking Audit

- [x] Audit current chunker and retrieval flow:
  - upload route uses `chunkText()`,
  - search route uses keyword overlap over `DocumentChunk`,
  - Chat RAG branch uses `retrieveTopChunks()` and `generateAnswer()`.
- [x] Identify quality bug: one long single-paragraph document became one oversized chunk because `chunkText()` only split on double-newlines.
- [x] Add regression test for long single-paragraph documents.
- [x] Update `chunkText()` to preserve paragraph splitting but split oversized chunks by words with a `1400` char ceiling.
- [x] Live-upload long single-paragraph audit fixture through `/api/documents`.
- [x] Verify resulting document has bounded chunks.
- [x] Verify `/api/documents/search` retrieves the audit fixture.
- [x] Verify Chat RAG answer uses the audit fixture with `RAG/success` tool run.
- [x] Run targeted test, typecheck, lint, and full test suite.

### Phase 2.16 Live Audit Results

- Uploaded `audit-rag-long-single-paragraph-20260626065051.txt`.
- Before fix: equivalent long single-paragraph input produced `1` chunk in regression test.
- After fix:
  - upload produced `22` chunks,
  - max chunk length was `1400` chars,
  - search query `AUDITRAG-20260626065051 SLA pembayaran invoice` returned `5` results,
  - top results came from the uploaded audit document,
  - Chat RAG answer cited `audit-rag-long-single-paragraph-20260626065051.txt`,
  - tool run was `RAG/success`.

### Phase 2.16 Verification

- Red test first failed: `chunkText()` returned `1` chunk for a 23k-char single paragraph.
- `bun test src/lib/rag.test.ts` passed: 1 test, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 24 tests, 0 failures, 40 assertions.

## Phase 2.17 Hybrid RAG Quality Phase 1

- [x] Add chunk overlap to long paragraph splitting:
  - `chunkText(content, { maxChars, overlapChars })` keeps trailing word overlap between adjacent chunks,
  - default chunk ceiling remains `1400` chars,
  - default overlap is `180` chars.
- [x] Add shared retrieval scoring in `src/lib/rag.ts`:
  - exact content token hit,
  - keyword hit,
  - adjacent phrase hit,
  - explicit `scoreBreakdown`.
- [x] Move `/api/documents/search` and Chat RAG onto the same retrieval helper:
  - one scoring path for API search and Chat,
  - audit logs now include `queryTokens`, `candidatesScanned`, and `topScore`.
- [x] Add chunk-level citations:
  - citation now carries `chunkIndex`, `snippet`, and `score`,
  - Chat RAG context labels each chunk with source, chunk index, and score,
  - UI label now says `Lihat detail sumber` for document citations, not `Lihat kueri SQL`.
- [x] Fix quality issue found during live audit:
  - top-K retrieval could be monopolized by repetitive chunks from one document,
  - added `selectTopRetrievedChunks()` with max `2` chunks per document,
  - this lets answer-bearing chunks from other documents enter the RAG context.
- [x] Run live Search API and Chat RAG audits.

### Phase 2.17 Live Audit Results

- Uploaded live fixture `audit-rag-quality-1782474511365.txt`.
- Upload result:
  - HTTP `201`,
  - `14` chunks.
- Search audit query:
  - `Dari dokumen SOP, berapa SLA pembayaran invoice enterprise setelah dokumen lengkap?`
  - HTTP `200`,
  - query tokens: `dokumen`, `pembayaran`, `invoice`, `enterprise`, `lengkap`,
  - `68` chunks scanned,
  - results include both old repetitive fixture and new answer-bearing fixture,
  - new fixture chunks include score breakdown `contentHits:5`, `keywordHits:3`, `phraseHits:3`, `total:20`.
- Chat RAG audit before diversity fix:
  - tool run was `RAG/success`,
  - citations were chunk-level,
  - answer could not mention `14 hari` because old repetitive chunks monopolized top context.
- Chat RAG audit after diversity fix:
  - HTTP `200`,
  - tool run `RAG/success`,
  - citations include `chunkIndex`, `score`, and `snippet`,
  - context includes `audit-rag-quality-1782474511365.txt`,
  - answer returned: `SLA pembayaran invoice enterprise adalah maksimal 14 hari kalender setelah dokumen lengkap`.

### Phase 2.17 Verification

- Red test first failed because `chunkText()` did not satisfy overlap behavior.
- Red test first failed because `scoreChunk` was not exported.
- Red test first failed because `sortRetrievedChunks` was not exported.
- Red test first failed because `buildDocumentCitation` was not exported.
- Red test first failed because `citationDetailLabel` was not exported.
- Red test first failed because `selectTopRetrievedChunks` was not exported.
- `bun test src/lib/rag.test.ts src/lib/tool-router.test.ts src/lib/chat-layout.test.ts` passed: 10 tests, 0 failures.
- `bun test --pass-with-no-tests` passed: 30 tests, 0 failures, 53 assertions.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.

## Phase 2.18 Knowledge Retrieval Tester Metadata

- [x] Audit Knowledge UI retrieval tester after Phase 2.17 backend changes.
- [x] Add shared tester response helper:
  - `normalizeRagSearchResponse()` parses search results safely,
  - carries `queryTokens`, `topK`, and `candidatesScanned`,
  - preserves nested `scoreBreakdown` with `contentHits`, `keywordHits`, and `phraseHits`.
- [x] Update Knowledge UI tester:
  - shows chunks scanned,
  - shows effective top-K,
  - shows query tokens,
  - shows phrase-hit score beside content/keyword hits.
- [x] Keep existing `/api/documents/search` contract; no schema or API migration.

### Phase 2.18 Live Audit Results

- Search tester API smoke query:
  - `SLA pembayaran invoice enterprise dokumen lengkap`
  - HTTP `200`,
  - `topK: 4`,
  - `candidatesScanned: 68`,
  - query tokens: `pembayaran`, `invoice`, `enterprise`, `dokumen`, `lengkap`,
  - top result: `audit-rag-quality-1782474511365.txt`, chunk `0`,
  - score breakdown: `contentHits:5`, `keywordHits:3`, `phraseHits:4`, `total:23`.

### Phase 2.18 Verification

- Red test first failed because `src/lib/rag-search-tester.ts` did not exist.
- `bun test src/lib/rag-search-tester.test.ts` passed: 1 test, 0 failures.
- `bun test src/lib/rag-search-tester.test.ts src/lib/rag.test.ts` passed: 6 tests, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 31 tests, 0 failures, 56 assertions.

## Phase 2.19 API Embeddings Hybrid Retrieval

- [x] Add API embedding support without local inference:
  - OpenAI-compatible providers call `{baseUrl}/embeddings`,
  - Ollama API providers call `{baseUrl}/api/embed`,
  - app never runs an embedding model locally.
- [x] Extend storage:
  - `DocumentChunk.embeddingJson`,
  - `DocumentChunk.embeddingProvider`,
  - `DocumentChunk.embeddingModel`,
  - `DocumentChunk.embeddedAt`,
  - embedding config fields on `LlmConfig`.
- [x] Add safe SQL migration file: `prisma/hybrid-rag-embeddings.sql`.
- [x] Apply nullable columns to dev SQLite manually because `prisma db push` would drop non-Prisma demo tables.
- [x] Add embedding helper module:
  - cosine similarity,
  - OpenAI-compatible response parsing,
  - Ollama response parsing,
  - hybrid lexical + semantic score,
  - best-effort document chunk embedding.
- [x] Update upload flow:
  - new documents are chunked,
  - keywords are saved,
  - embeddings are generated if embedding config exists,
  - upload still succeeds with lexical fallback if embedding API is unavailable.
- [x] Add admin rebuild endpoint:
  - `POST /api/documents/embeddings/rebuild`,
  - rebuilds embeddings for existing ready documents.
- [x] Update retrieval:
  - lexical scoring always runs,
  - query embedding runs only when config exists,
  - semantic score is applied only when chunk embedding model matches active query embedding model,
  - stale embeddings are ignored.
- [x] Update UI:
  - Settings > AI/LLM includes Embedding RAG provider/base URL/model/key,
  - Knowledge has `Rebuild Embeddings`,
  - Knowledge tester shows semantic score when hybrid retrieval is active.

### Phase 2.19 Live Audit Results

- Started a temporary local mock Ollama API at `http://localhost:11435`.
- Saved embedding config:
  - provider `OLLAMA`,
  - base URL `http://localhost:11435`,
  - model `mock-embed`.
- Rebuild result:
  - HTTP `200`,
  - `6` documents,
  - `68` chunks embedded,
  - `0` skipped.
- Hybrid search result:
  - HTTP `200`,
  - top source `audit-rag-quality-1782474511365.txt`,
  - `lexicalTotal: 23`,
  - `semanticSimilarity: 0.7964502423828337`,
  - `semanticScore: 9.56`,
  - final score `32.56`.
- Restored embedding config to blank OpenAI-compatible defaults after smoke so no dead mock endpoint remains.
- Fallback search after restore:
  - HTTP `200`,
  - top source `audit-rag-quality-1782474511365.txt`,
  - score `23`,
  - `semanticScore: 0`,
  - lexical fallback remains healthy.

### Phase 2.19 Verification

- Red test first failed because `src/lib/embeddings.ts` did not exist.
- Red test first failed because `applySemanticScore` was not exported.
- `bun test src/lib/embeddings.test.ts src/lib/rag.test.ts src/lib/rag-search-tester.test.ts` passed: 10 tests, 0 failures.
- `bunx prisma generate` passed.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 35 tests, 0 failures, 66 assertions.

## Phase 2.20 Vector DB + Smart Mapping AI

- [x] Add vector DB config model and API:
  - provider `INTERNAL`, `QDRANT`, `MILVUS`,
  - base URL,
  - encrypted API key,
  - collection name,
  - vector size,
  - distance metric.
- [x] Add vector store adapter:
  - stable UUID point IDs from chunk IDs,
  - Qdrant collection create/upsert/search,
  - Milvus collection create/upsert/search,
  - tenant filter by `companyId`,
  - external vector DB is optional; internal lexical/SQLite remains fallback.
- [x] Add vector DB UI in Knowledge:
  - provider selector,
  - base URL,
  - collection,
  - dimension,
  - distance,
  - API key,
  - save/test actions.
- [x] Wire embedding rebuild to vector DB:
  - when vector DB config exists, embeddings are upserted to Qdrant/Milvus,
  - if vector DB is internal/unconfigured, embeddings stay in SQLite only.
- [x] Update retrieval:
  - query embedding searches vector DB when configured,
  - vector hits are loaded from SQLite by `chunkId`,
  - vector score contributes to the same hybrid score,
  - fallback to full lexical scan when vector DB is unavailable.
- [x] Add Smart Mapping AI:
  - `SmartMapping` model,
  - generate/list API,
  - prompt builder for source metadata,
  - heuristic fallback when LLM unavailable,
  - merge guard so generic AI output keeps inferred entity when lexical inference is stronger,
  - router prompt receives active mapping hints.
- [x] Add Smart Mapping UI in Knowledge:
  - manual summary input,
  - generate action,
  - mapping cards with routing/entity/synonyms.
- [x] Add safe SQL migration file: `prisma/vector-store-smart-mapping.sql`.
- [x] Apply migration to local SQLite.

### Phase 2.20 Live Audit Results

- Vector config smoke:
  - `GET /api/vector-store` returned default `INTERNAL`,
  - `PUT /api/vector-store` saved `INTERNAL`,
  - mock Qdrant at `http://localhost:6334`,
  - saved provider `QDRANT`,
  - `POST /api/vector-store` created/tested collection successfully,
  - restored provider to `INTERNAL`.
- Smart mapping smoke:
  - generated manual mapping from summary `demo_inventory sku warehouse quantity stock invoice amount customer ticket sla`,
  - result `entityType: inventory`,
  - routing hint `SQL`,
  - synonyms included `inventory`, `stock`, `warehouse stock`, `SKU`, `qty`.

### Phase 2.20 Verification

- Red test first failed because `src/lib/vector-stores.ts` did not exist.
- Red test first failed because `src/lib/smart-mapping.ts` did not exist.
- Red test first failed because `mergeSmartMapping` was not exported.
- `bun test src/lib/vector-stores.test.ts src/lib/smart-mapping.test.ts` passed.
- `bunx prisma generate` passed.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 41 tests, 0 failures, 82 assertions.

## Phase 2.21 — RAG Performance + Quality Ops

- [x] Add FTS5/BM25 candidate retrieval:
  - `DocumentChunkFts` virtual table,
  - safe rebuild endpoint,
  - upload-time FTS upsert,
  - retrieval now scans BM25 candidates before fallback all-scan.
- [x] Add stronger document parsers:
  - PDF literal text,
  - DOCX stored/deflated ZIP XML,
  - XLSX shared strings + sheet values.
- [x] Add RAG evaluation suite:
  - helper metrics,
  - API endpoint,
  - Knowledge UI panel for golden questions.
- [x] Add Smart Mapping approval/edit lifecycle:
  - normalized edit payload,
  - patch route,
  - delete route,
  - Knowledge UI edit/status/delete controls.
- [x] Add Knowledge UI BM25 rebuild action.
- [x] Apply FTS migration to local SQLite.
- [x] Restart dev server on `http://localhost:3005` after clearing generated `.next`.

### Phase 2.21 Live Audit Results

- `POST /api/documents/fts/rebuild` returned `indexed: 68`.
- `POST /api/documents/search` with `stok gudang sku` returned 3 relevant results and `candidatesScanned: 8`.
- `POST /api/rag/evaluate` returned:
  - `precisionAtK: 1`,
  - `groundedRate: 1`,
  - `avgLatencyMs: 4`.
- Smart Mapping lifecycle smoke:
  - create returned HTTP 201,
  - patch status to `disabled` returned HTTP 200,
  - delete returned HTTP 200.

### Phase 2.21 Verification

- Red test first failed because `src/lib/rag-fts.ts` did not exist.
- Red test first failed because `src/lib/document-parsers.ts` did not exist.
- Red test first failed because `src/lib/rag-eval.ts` did not exist.
- Red test first failed because `normalizeSmartMappingUpdate` was not exported.
- `bun test src/lib/rag-fts.test.ts src/lib/document-parsers.test.ts src/lib/rag-eval.test.ts src/lib/smart-mapping.test.ts` passed: 10 tests, 0 failures.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 48 tests, 0 failures, 92 assertions.

## Codex Token Tooling Install

- [x] Install Caveman skills from `JuliusBrussee/caveman`.
- [x] Install Ponytail skills from `DietrichGebert/ponytail`.
- [x] Confirm RTK CLI from `rtk-ai/rtk` is already installed as `rtk 0.42.4`.
- [x] Configure RTK globally for Codex through `~/.codex/AGENTS.md` and `~/.codex/RTK.md`.
- [x] Add Ponytail marketplace to Codex.
- [x] Add Caveman marketplace to Codex from persistent local clone at `~/.codex/marketplaces/caveman`.

### Codex Token Tooling Verification

- Caveman skills present: `caveman`, `caveman-compress`, `caveman-review`, `caveman-help`, `caveman-stats`, `caveman-commit`, `cavecrew`.
- Ponytail skills present: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`.
- `rtk gain` runs successfully and reports no tracking data yet.
- `rtk init --codex --global --show` reports global RTK configuration OK.
- `~/.codex/config.toml` contains `[marketplaces.ponytail]` and `[marketplaces.caveman]`.

## Phase 2 UI Progress

- [x] Add Settings API Keys tab with create/list/revoke and curl example.
- [x] Add Data Sources REST API Connectors panel with create/list and endpoint visibility.
- [x] Add REST connector endpoint whitelist and test-request sheet.
- [x] Run focused verification after UI changes.

## Phase 2.2 Progress

- [x] REST connector setup is now visible in the UI: admin can add whitelisted endpoints and run test requests from the Data Sources screen.
- [x] Extract shared non-streaming tool router for external API chat completions.
- [x] Route `/api/v1/chat/completions` through CHAT, RAG, SQL, and REST branches.
- [x] Add `stream=true` SSE response support for external API clients.
- [x] Run full verification and smoke checks.

### Phase 2.2 Verification

- `bun test src/lib/tool-router.test.ts` first failed because `src/lib/tool-router.ts` did not exist, confirming the helper tests were red before implementation.
- `bun test src/lib/tool-router.test.ts` passed after implementation: 3 tests, 0 failures, 4 assertions.
- `bun test src/app/api/v1/chat/completions/route.test.ts` first failed because `statusForExternalChatError` did not exist.
- `bun test src/app/api/v1/chat/completions/route.test.ts` passed after implementation: 2 tests, 0 failures, 3 assertions.
- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 12 tests, 0 failures, 21 assertions.
- Smoke checked running app on port 3005:
  - `GET /api/v1/health` returned HTTP 200 with `{"ok":true,"service":"ryasai","version":"2.0.0",...}`.
  - `GET /` returned HTTP 200.
  - `GET /api/settings/api-keys` returned HTTP 200; smoke-created API keys were revoked afterward.
  - `GET /api/data-sources/rest-connectors` returned HTTP 200 with `{"ok":true,"items":[]}`.
  - `POST /api/v1/chat/completions` without API key returned HTTP 401.
  - API key create → invalid chat body → revoke flow returned HTTP 201 → 400 → 200.
  - API key create → valid chat body while no LLM provider is configured → revoke flow returned HTTP 201 → 503 → 200, with a clear AI Configuration message.
  - API key create → `stream=true` valid chat body while no LLM provider is configured → revoke flow returned HTTP 201 → 503 → 200, confirming streaming is no longer blocked by the old phase-1 guard.

### Phase 2 Verification

- `bunx tsc --noEmit` passed.
- `bun run lint` passed.
- `bun test --pass-with-no-tests` passed: 7 tests, 0 failures, 14 assertions.
- Smoke checked running app on port 3005:
  - `GET /api/v1/health` returned `{"ok":true,"service":"ryasai","version":"2.0.0",...}`.
  - `GET /api/settings/api-keys` returned `{"ok":true,"items":[]}`.
  - `GET /api/data-sources/rest-connectors` returned `{"ok":true,"items":[]}`.
  - `GET /` returned HTTP 200.
