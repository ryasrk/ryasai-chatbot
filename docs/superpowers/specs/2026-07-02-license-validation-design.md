# License Validation Integration Design

Date: 2026-07-02
Project: `/home/ryasr/ryasai/Chatbot`
Reference implementation: `/home/ryasr/ryasai/D2T/backend/license/` (client) and
`/home/ryasr/ryasai/License-Validator/` (server — used as-is, no server changes).

## Goal

Gate the Chatbot product behind a license key validated against the existing
License-Validator server, following the same protocol D2T uses. Hard gate:
without a valid license the admin can log in and reach the License screen, but
every other feature (chat, knowledge, data sources, external `/api/v1` API) is
blocked.

## Decisions (approved)

- **Enforcement:** hard gate (403-style block, status code 402 for API calls).
- **Anti-tamper:** minimal — HMAC request signing, encrypted local cache,
  machine binding. No debugger detection / integrity monitor (trivially
  bypassable in Node, not worth the complexity).
- **Server:** the existing License-Validator is used unchanged. A license for
  the Chatbot is created in its dashboard with `product = "chatbot"`.

## Protocol (must match License-Validator exactly)

- `POST {LICENSE_SERVER_URL}/api/v1/license/validate`
  body `{ license_key, machine_id, product: "chatbot", version, hostname, os_info }`
  → `{ valid, plan, expires_at, message }`. Server handles machine slots
  (max_machines), expiry, product match, revocation, and logs every attempt.
- `POST {LICENSE_SERVER_URL}/api/v1/license/deactivate` — same body, frees the
  machine slot.
- Request signing (optional on server, we always send):
  `X-Timestamp: <unix seconds>`, `X-Signature: HMAC-SHA256(LICENSE_HMAC_SECRET,
  "{ts}:{method}:{path}:{body}")` where body is compact JSON with sorted keys —
  the exact string sent as the request body.
- Response signature `X-Response-Signature` verified when present (warn-only,
  like D2T).

## Client Architecture (Chatbot side)

- `src/lib/license-protocol.ts` — pure functions: stable-stringify, request
  signing, response parsing, grace-window logic. Fully unit-tested.
- `src/lib/license.ts` — the guard: module-level in-memory state, validate
  against server, encrypted cache in `AppConfig.licenseCache` (AES-256-GCM via
  existing `encryptConfig`), machine id from `/etc/machine-id` with a
  persisted-file fallback, stale-while-blocking revalidation every
  `LICENSE_REVALIDATE_MINUTES` (30), offline grace `LICENSE_GRACE_HOURS` (24).
  License key stored encrypted in `AppConfig.licenseKeyEncrypted`
  (env `LICENSE_KEY` seeds it on first boot for headless deploys).
- Failure semantics (same as D2T): server says invalid/expired/limit → invalid
  immediately (no grace). Server unreachable or 5xx → fall back to cache within
  the grace window.

## Enforcement Chokepoints

Two, covering both auth models:

1. `getActiveUser()` in `src/lib/session.ts` gains a license check (throws
   `LicenseInvalidError` → mapped to HTTP 402 by `handleApiError`). Allowlisted
   routes opt out via `getActiveUser({ skipLicenseCheck: true })`: auth,
   `/api/me`, setup, and `/api/license/*` routes only.
2. The API-key authentication path used by `/api/v1/chat/completions` performs
   the same check (external clients get 402 with a clear message).

## In-App Surface

- `GET /api/license` → status `{ configured, valid, plan, expiresAt,
  lastCheckedAt, graceUntil, machineId, message }` (admin auth, exempt from gate).
- `POST /api/license/activate` `{ licenseKey }` → save encrypted + validate now.
- `POST /api/license/recheck` → force revalidation.
- `POST /api/license/deactivate` → server deactivate + clear key.
- UI: License tab in Settings (status card, activate form, recheck/deactivate
  buttons) and a full-screen blocking `LicenseView` in the shell when the
  license is not valid (rendered after login/setup gates, offering the same
  activation form).

## Environment

```env
LICENSE_SERVER_URL=http://localhost:9000
LICENSE_HMAC_SECRET=        # optional; must equal License-Validator SECRET_KEY when set
LICENSE_KEY=                # optional bootstrap; UI activation is the primary path
LICENSE_GRACE_HOURS=24
LICENSE_REVALIDATE_MINUTES=30
```

Missing `LICENSE_SERVER_URL` → license state "unconfigured" → gate blocks with
an actionable message (fail closed).

## Testing

- Unit: signing (byte-exact against a Python-computed fixture), stable
  stringify, grace logic, cache round-trip, status mapping.
- Route: activate/status with a mocked validate server (Bun.serve stub).
- Smoke: against the real License-Validator started locally, full lifecycle —
  create license (product "chatbot") → activate → valid → revoke on server →
  recheck → gate blocks.

## Out of Scope

- Tiers/credits (D2T-style FREE/STARTER/PRO) — hard gate only, `plan` is
  displayed but not interpreted.
- License-Validator server changes.
- Debugger detection / integrity monitoring.

## Sequencing

This plan touches `session.ts`, `settings-view.tsx`, and `page.tsx`, which the
in-flight production-final-phase plan also modifies. **Execute only after that
plan's tasks are merged** (it defines the login/setup gates this design slots
behind).
