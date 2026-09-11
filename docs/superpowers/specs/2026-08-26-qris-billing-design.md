# QRIS Subscription Billing — Design

Date: 2026-08-26 · Status: APPROVED

## Goal

Sell ryasai chatbot subscriptions (~100k IDR/month) self-serve via QRIS (Midtrans Snap).
Users register free, are locked out until they pay, buy a multi-month pack, pay by QRIS,
and the License-Validator automatically issues/extends their license.

## Decisions

- Provider: **Midtrans Snap** (QRIS).
- **Flat plan**: one price unlocks everything. New plan value `'flat'` ranks above
  `enterprise` in `PLAN_RANK`; legacy starter/pro/enterprise keep working.
- Packs (env-overridable): 1mo = 100,000 IDR · 3mo = 270,000 · 6mo = 480,000 · 12mo = 840,000.
- Pre-payment state: **locked until paid** (`licenseStatus: 'unpaid'`). No trial.
- Architecture A: billing lives in the chatbot app; validator exposes ONE internal
  generate endpoint.

## Cross-repo contract (app ⇄ License-Validator)

```
POST /internal/licenses/generate          # FastAPI app at ~/ryasai/ryasai-LicenseValidator
Header: X-Internal-Secret: <LICENSE_INTERNAL_SECRET>
Body:   { "product": "ryasai-chatbot", "slug": "<org-slug>", "months": 1|3|6|12 }
200:    { "licenseKey": "...", "expiresAt": "<ISO date>" }
401 bad secret · 400 bad body
```

Semantics: if an active license already exists for `(product, slug)`, extend its expiry
from `max(now, currentExpiry)` by N months and return the SAME key; else create a new
license. Signing/validation endpoints unchanged.

## Chatbot repo changes

### Schema
- New `Order` model: `organizationId`, `months Int`, `amountIdr Int`, `currency String @default("IDR")`,
  `midtransOrderId String @unique`, `snapToken String?`,
  `status String @default("pending") // pending|settlement|expire|deny|cancel|failure`,
  `paidAt DateTime?`, `licenseKeyIssued String?`, `rawNotificationJson String?`, timestamps.
  Carries `organizationId` like every tenant model (tenant extension applies).
- `Organization.licenseStatus` gains `'unpaid'`.

### Signup & lockdown
- `POST /api/auth/signup`: `licenseKey` removed from required fields; org created with
  `licenseStatus: 'unpaid'`, `licensePlan: null`.
- `getLockdownReason()` handles `'unpaid'` → lockdown reason `'unpaid'`.
- Lockdown scoping: locked users must still reach billing. Add opt-out flag on
  `getActiveUser()` (e.g. `{ allowUnlicensed: true }`) used ONLY by `/api/billing/*`,
  `/api/me`, logout, auth routes. All other routes stay blocked.
- UI: lockdown screen shows Buy License CTA.

### Billing lib & routes
- `src/lib/midtrans.ts`: Snap `createTransaction` (server key), webhook signature check
  `sha512(order_id + status_code + gross_amount + ServerKey)` (hex, case-insensitive),
  idempotent settlement handling (replayed notifications are no-ops).
- `src/lib/pricing.ts`: pack table, amounts overridable via `BILLING_PACKS_JSON`.
- Routes:
  - `POST /api/billing/orders` (auth, allowUnlicensed): validate pack → create pending
    Order (midtransOrderId = `ord-<orgslug>-<cuid>`) → Snap token → return token + redirect_url.
  - `POST /api/billing/webhook` (public, signature-verified): on
    `transaction_status=settlement` (QRIS settles directly; also accept `capture`
    with `fraud_status=accept`) → mark order settled idempotently → call validator
    generate → store returned key on org → immediately `validateLicense(key, machineId)`
    so expiry comes from a SIGNED response → set org `licenseStatus/licenseExpiresAt/licensePlan='flat'`.
    Non-settlement statuses update the order only. Persist raw notification JSON.
  - `GET /api/billing/orders/[id]` (auth, own-org only): status polling.
  - `GET /api/billing/pricing` (auth, allowUnlicensed): pack list.
- Settlement handler failure (validator unreachable): order stays settled; retry via a
  BullMQ job or on next revalidation — never lose money-state.

### Hardening folded in
- Remove hardcoded `PUBLIC_KEY_HEX` fallback in `src/lib/license-client.ts` — missing
  `LICENSE_SIGNING_PUBLIC_KEY` fails closed (lockdown).

### Scheduler
- Repeatable daily job: orgs whose `licenseExpiresAt` is within 7 days → admin
  notification via the existing notification system.

### Env
`MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION`,
`LICENSE_INTERNAL_SECRET`, optional `BILLING_PACKS_JSON`.

### Testing
- Unit: signature verify accept/reject/tamper, webhook idempotency, order creation,
  licenseless signup, lockdown allowlist boundaries, pricing table.
- Static guards stay green: `tenant-route-guard.test.ts`, `invariants.test.ts`.
- E2e (follow-up): mock Midtrans alongside mock License-Validator — register → locked →
  buy → settle → unlocked → chat works.

## Out of scope
Auto-recurring, invoice/receipt PDFs, tax handling, proration/refunds (manual initially).
