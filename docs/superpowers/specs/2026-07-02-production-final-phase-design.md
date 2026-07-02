# Production Core — Final Phase Design

Date: 2026-07-02
Project: `/home/ryasr/ryasai/Chatbot`
Parent spec: `2026-06-25-chatbot-production-core-design.md` (still authoritative for product scope)

## Goal

Close the remaining gap between the current app and the approved production-core
spec so the chatbot is production ready end to end: real admin login, setup
wizard, spec-aligned navigation, and an automated e2e suite.

Backend (RAG, connectors, tool router, external API, API keys, monitoring data)
is already implemented in earlier phases and is reused, not rebuilt.

## Phase A — Real Auth

Replace `AUTH_DEMO_FALLBACK` impersonation with a login path.

- `POST /api/auth/login`: body `{ email, password }`. Verify against
  `User.passwordHash`, on success set the existing signed session cookie
  (`signSession` from `src/lib/crypto.ts`) as `httpOnly`, `sameSite=lax`,
  `secure` in production. Generic 401 on failure (no user enumeration).
  Audit log on success and failure.
- `POST /api/auth/logout`: clear the cookie, audit log.
- App shell (`src/app/page.tsx`): when `/api/me` returns 401, render a login
  screen instead of the dashboard. No separate route needed — the app is a
  single-page shell already.
- No new auth dependency. Password hashing reuses whatever the seed script
  already uses; if it is weak (plain sha), upgrade to `node:crypto` scrypt.
- Single admin: no registration, no roles UI, no password reset flow in v1
  (admin resets via env/seed).

## Phase B — Setup Wizard

- Gate: `GET /api/me` (or a lightweight `/api/setup/status`) exposes
  `AppConfig.setupCompleted`. When false, the shell renders `SetupView`
  instead of the normal navigation.
- Steps (per parent spec): 1) create/confirm admin account, 2) configure LLM
  API, 3) test model, 4) upload sample document or skip, 5) add connector or
  skip, 6) test chat, 7) mark setup completed.
- Each step calls existing APIs (`/api/llm-config`, `/api/documents`,
  `/api/integrations`, chat send). New surface is only the wizard UI plus
  `POST /api/setup/complete` that flips `AppConfig.setupCompleted`.

## Phase C — Navigation Restructure

Align the shell to the spec's menus:

Chat, Knowledge, Data Sources, AI Configuration, Prompt & Tools, Monitoring,
Settings. Setup appears only while incomplete.

- `integrations-view` → **Data Sources** (rename + REST connectors already there).
- `security-view` → **Monitoring**; add panels backed by existing tables:
  tool runs, failed requests, blocked SQL, token usage, latency.
- AI provider settings move out of Settings into **AI Configuration**.
- New **Prompt & Tools** view: system prompt, routing rules, allowed tools,
  SQL guardrail settings, REST whitelist overview (existing APIs).
- Remove user-switching / multi-user UI from the product shell.
- `view-routing.ts` gets the new keys; old query-param values map to the new
  views so bookmarks don't break.

## Phase D — Playwright E2E

- One new dev dependency: `@playwright/test` (chromium only).
- Suite runs against a dev server pointed at a scratch SQLite DB
  (`DATABASE_URL=file:./db/e2e.db`, `AUTH_DEMO_FALLBACK=false`), seeded fresh
  per run.
- Golden-path specs only:
  1. login (wrong password rejected, right password lands on app)
  2. setup wizard end to end (with skips where external services are needed)
  3. upload a TXT document → ask a question in chat → answer shows a citation
  4. create API key → external `POST /api/v1/chat/completions` auth works
  5. logout
- LLM calls in e2e run against a tiny local mock (an HTTP stub started by the
  test setup) so the suite is deterministic and needs no real API key.

## Error Handling

Follows the parent spec: fail closed when secrets are missing, 401 for
unauthenticated API access, actionable UI errors. Login failures are audited.

## Testing Strategy

- Unit/route tests continue with `bun test` (existing 41+ tests must stay green).
- New route tests: login success/failure/lockout-free behavior, setup complete
  endpoint, view-routing mapping.
- Playwright suite as above; `bunx tsc --noEmit` and `bun run lint` gate each phase.

## Out of Scope

- Multi-user, roles, password reset, SSO.
- Cypress, CI pipeline changes, Docker.
- Any rework of RAG/connector/tool-router internals.

## Delivery Order

A → B → C → D. Auth first because the wizard gate and e2e depend on it.
