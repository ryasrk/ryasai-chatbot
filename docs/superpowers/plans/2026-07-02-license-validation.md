# License Validation Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-gate the Chatbot behind a license key validated against the existing License-Validator server (same protocol as D2T), with activation UI, offline grace, and machine binding.

**Architecture:** A TypeScript port of D2T's `LicenseGuard` (minus anti-debugger theater): pure protocol helpers in `src/lib/license-protocol.ts`, a stateful guard with DB-backed encrypted cache in `src/lib/license.ts`, enforcement inside `getActiveUser()` and the `/api/v1` API-key path, admin routes under `/api/license/*`, a Settings tab plus a blocking shell screen. The License-Validator server (`/home/ryasr/ryasai/License-Validator`, FastAPI, port 9000) is used unchanged; Chatbot licenses use `product = "chatbot"`.

**Tech Stack:** Bun + Next.js 16, Prisma/SQLite, existing `encryptConfig`/`decryptConfig` (AES-256-GCM) from `src/lib/crypto.ts`, `bun test`.

## Global Constraints

- Project root: `/home/ryasr/ryasai/Chatbot` (WSL Ubuntu-24.04). Dev server port 3005. License-Validator source: `/home/ryasr/ryasai/License-Validator` (runs on port 9000).
- **Prerequisite: the production-final-phase plan (login/setup gates) must be merged first.** This plan assumes `getActiveUser`, `handleApiError`, `LoginView`/`SetupView` gates in `page.tsx`, and the Settings tabs layout already exist.
- No new dependencies (runtime or dev).
- Protocol must match License-Validator byte-for-byte: signature = HMAC-SHA256 hex of `"{ts}:{method}:{path}:{body}"`, body = compact JSON with sorted keys, and the signed string IS the request body sent.
- UI copy Bahasa Indonesia; identifiers/comments English.
- Blocked requests return HTTP **402** with an actionable message.
- Never log or return the full license key (mask like `XXXX-…-XXXX`, use existing `maskConfig` conventions).
- Existing tests stay green after every task: `bun test --pass-with-no-tests`. Typecheck `bunx tsc --noEmit`, lint `bun run lint`. Commit after every task.

---

### Task 1: Protocol helpers (signing, stable stringify, grace logic)

**Files:**
- Create: `src/lib/license-protocol.ts`
- Test: `src/lib/license-protocol.test.ts`

**Interfaces (produces):**

```ts
stableStringify(obj: Record<string, unknown>): string        // compact JSON, keys sorted (recursive)
signLicenseRequest(secret: string, method: string, path: string, body: string, nowSec?: number): { 'X-Signature': string; 'X-Timestamp': string }
verifyResponseSignature(secret: string, data: unknown, signature: string): boolean  // first 32 hex chars, timing-safe
parseValidateResponse(data: unknown): { valid: boolean; plan: string | null; expiresAt: string | null; message: string }
isWithinGrace(lastValidatedAtIso: string, graceHours: number, now?: Date): boolean
```

- [ ] **Step 1: Write the failing test** — `src/lib/license-protocol.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import crypto from 'crypto'
import {
  stableStringify,
  signLicenseRequest,
  verifyResponseSignature,
  parseValidateResponse,
  isWithinGrace,
} from './license-protocol'

describe('stableStringify', () => {
  it('matches Python json.dumps(sort_keys=True, separators=(",",":"))', () => {
    expect(stableStringify({ b: 1, a: 'x', c: { z: true, y: null } })).toBe(
      '{"a":"x","b":1,"c":{"y":null,"z":true}}',
    )
  })
})

describe('signLicenseRequest', () => {
  it('produces the documented HMAC over ts:method:path:body', () => {
    const body = stableStringify({ license_key: 'K', machine_id: 'M', product: 'chatbot' })
    const headers = signLicenseRequest('secret', 'POST', '/api/v1/license/validate', body, 1700000000)
    expect(headers['X-Timestamp']).toBe('1700000000')
    const expected = crypto
      .createHmac('sha256', 'secret')
      .update(`1700000000:POST:/api/v1/license/validate:${body}`)
      .digest('hex')
    expect(headers['X-Signature']).toBe(expected)
  })
})

describe('verifyResponseSignature', () => {
  it('accepts a signature computed over sorted compact json (32-char prefix)', () => {
    const data = { valid: true, plan: 'pro' }
    const sig = crypto.createHmac('sha256', 's').update(stableStringify(data)).digest('hex')
    expect(verifyResponseSignature('s', data, sig)).toBe(true)
    expect(verifyResponseSignature('s', data, sig.slice(0, 32))).toBe(true)
    expect(verifyResponseSignature('s', data, 'f'.repeat(64))).toBe(false)
  })
})

describe('parseValidateResponse', () => {
  it('parses a valid response', () => {
    expect(parseValidateResponse({ valid: true, plan: 'pro', expires_at: '2027-01-01T00:00:00', message: 'ok' }))
      .toEqual({ valid: true, plan: 'pro', expiresAt: '2027-01-01T00:00:00', message: 'ok' })
  })
  it('is safe on garbage', () => {
    expect(parseValidateResponse(null)).toEqual({ valid: false, plan: null, expiresAt: null, message: '' })
  })
})

describe('isWithinGrace', () => {
  const now = new Date('2026-07-02T12:00:00Z')
  it('true inside the window', () => {
    expect(isWithinGrace('2026-07-02T00:00:00Z', 24, now)).toBe(true)
  })
  it('false outside the window or unparseable', () => {
    expect(isWithinGrace('2026-06-30T00:00:00Z', 24, now)).toBe(false)
    expect(isWithinGrace('garbage', 24, now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to fail** — `bun test src/lib/license-protocol.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/lib/license-protocol.ts`:

```ts
/**
 * License-Validator wire protocol helpers (pure — no IO).
 * Must stay byte-compatible with the Python server:
 *   signature = HMAC-SHA256(secret, `${ts}:${method}:${path}:${body}`)
 *   body      = compact JSON with recursively sorted keys
 */
import crypto from 'crypto'

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    return JSON.stringify(value)
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${parts.join(',')}}`
}

export function signLicenseRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { 'X-Signature': string; 'X-Timestamp': string } {
  const ts = String(nowSec)
  const sig = crypto.createHmac('sha256', secret).update(`${ts}:${method}:${path}:${body}`).digest('hex')
  return { 'X-Signature': sig, 'X-Timestamp': ts }
}

/** Server signs the first 32 hex chars of HMAC(sorted-compact-json). Warn-only check. */
export function verifyResponseSignature(secret: string, data: unknown, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(stableStringify(data)).digest('hex')
  const a = Buffer.from(expected.slice(0, 32))
  const b = Buffer.from(signature.slice(0, 32))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface ValidateResult {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  message: string
}

export function parseValidateResponse(data: unknown): ValidateResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return {
    valid: d.valid === true,
    plan: typeof d.plan === 'string' ? d.plan : null,
    expiresAt: typeof d.expires_at === 'string' ? d.expires_at : null,
    message: typeof d.message === 'string' ? d.message : '',
  }
}

export function isWithinGrace(lastValidatedAtIso: string, graceHours: number, now = new Date()): boolean {
  const t = Date.parse(lastValidatedAtIso)
  if (Number.isNaN(t)) return false
  return now.getTime() - t < graceHours * 3600_000
}
```

- [ ] **Step 4: Run to pass** — `bun test src/lib/license-protocol.test.ts` → PASS (7 tests).

- [ ] **Step 5: Cross-check signature against the server's Python** (one-off, not committed):

```bash
cd ~/ryasai/License-Validator && python3 - <<'EOF'
import hmac, hashlib, json
body = json.dumps({"license_key":"K","machine_id":"M","product":"chatbot"}, separators=(",",":"), sort_keys=True)
print(hmac.new(b"secret", f"1700000000:POST:/api/v1/license/validate:{body}".encode(), hashlib.sha256).hexdigest())
EOF
```

Expected: identical hex to the value asserted in Step 1's test (compute it once with `bun -e` and compare).

- [ ] **Step 6: Commit** — `git add src/lib/license-protocol.ts src/lib/license-protocol.test.ts && git commit -m "feat: license-validator wire protocol helpers"`

---

### Task 2: Schema + config plumbing

**Files:**
- Modify: `prisma/schema.prisma` (`model AppConfig`)
- Modify: `src/lib/config.ts` (license env values)
- Modify: `.env.example`, `.env`

**Interfaces (produces):**
- `AppConfig.licenseKeyEncrypted String?`, `AppConfig.licenseCache String?`
- `serverConfig.license: { serverUrl: string | null; hmacSecret: string | null; bootstrapKey: string | null; graceHours: number; revalidateMinutes: number }`

- [ ] **Step 1: Schema** — add to `model AppConfig`:

```prisma
licenseKeyEncrypted String?
licenseCache        String?   // encrypted JSON: { valid, plan, expiresAt, lastValidatedAt, machineId }
```

Run `bunx prisma db push && bunx prisma generate`.

- [ ] **Step 2: Config** — in `src/lib/config.ts`, extend `serverConfig` (follow the existing `optionalString`/`optionalInt` helpers):

```ts
license: {
  serverUrl: process.env.LICENSE_SERVER_URL?.trim() || null,
  hmacSecret: process.env.LICENSE_HMAC_SECRET?.trim() || null,
  bootstrapKey: process.env.LICENSE_KEY?.trim() || null,
  graceHours: optionalInt('LICENSE_GRACE_HOURS', 24),
  revalidateMinutes: optionalInt('LICENSE_REVALIDATE_MINUTES', 30),
},
```

- [ ] **Step 3: Env files** — append to `.env.example` (and `.env` with real values):

```env
# License validation (License-Validator server)
LICENSE_SERVER_URL=http://localhost:9000
LICENSE_HMAC_SECRET=
LICENSE_KEY=
LICENSE_GRACE_HOURS=24
LICENSE_REVALIDATE_MINUTES=30
```

- [ ] **Step 4: Verify** — `bunx tsc --noEmit && bun test --pass-with-no-tests` → green.
- [ ] **Step 5: Commit** — `git add prisma/schema.prisma src/lib/config.ts .env.example && git commit -m "feat: license schema and env plumbing"`

---

### Task 3: License guard (`src/lib/license.ts`)

**Files:**
- Create: `src/lib/license.ts`
- Test: `src/lib/license.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, `serverConfig.license`, `encryptConfig`/`decryptConfig` from `@/lib/crypto`, `db` from `@/lib/db`.
- Produces:

```ts
class LicenseInvalidError extends Error { readonly code = 'LICENSE_INVALID' }
interface LicenseStatus {
  configured: boolean            // server url set AND a key stored
  valid: boolean
  plan: string | null
  expiresAt: string | null
  lastCheckedAt: string | null
  graceUntil: string | null      // set when currently valid only via offline grace
  machineId: string
  message: string
}
getMachineId(): string                                  // /etc/machine-id → fallback persisted db/.machine_id (random UUID)
getLicenseStatus(force?: boolean): Promise<LicenseStatus>  // cached in-memory; revalidates when stale or force
requireValidLicense(): Promise<void>                    // throws LicenseInvalidError when not valid
activateLicense(licenseKey: string): Promise<LicenseStatus> // save encrypted key + validate now
deactivateLicense(): Promise<{ ok: boolean; message: string }> // server deactivate + clear key/cache
_resetLicenseStateForTests(): void
```

- [ ] **Step 1: Write the failing test** — `src/lib/license.test.ts`. Use a real `Bun.serve` stub as the license server (deterministic, no mocking framework):

```ts
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'

// Env must be set BEFORE importing the module under test.
process.env.LICENSE_SERVER_URL = 'http://localhost:49172'
process.env.LICENSE_HMAC_SECRET = 'test-secret'

const { getLicenseStatus, activateLicense, requireValidLicense, LicenseInvalidError, _resetLicenseStateForTests } =
  await import('./license')

let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: { valid: true, plan: 'pro', expires_at: null, message: 'License valid.' },
}
let lastRequest: { path: string; headers: Headers; body: string } | null = null

const stub = Bun.serve({
  port: 49172,
  async fetch(req) {
    lastRequest = { path: new URL(req.url).pathname, headers: req.headers, body: await req.text() }
    return Response.json(nextResponse.body, { status: nextResponse.status })
  },
})
afterAll(() => stub.stop(true))
beforeEach(() => _resetLicenseStateForTests())

describe('license guard', () => {
  it('activate → valid status, signed request sent', async () => {
    const status = await activateLicense('CHAT-TEST-KEY-0001')
    expect(status.valid).toBe(true)
    expect(status.plan).toBe('pro')
    expect(lastRequest?.path).toBe('/api/v1/license/validate')
    expect(lastRequest?.headers.get('x-signature')).toBeTruthy()
    expect(JSON.parse(lastRequest!.body).product).toBe('chatbot')
  })

  it('requireValidLicense passes when valid, throws when server says invalid', async () => {
    await activateLicense('CHAT-TEST-KEY-0001')
    await requireValidLicense() // no throw

    nextResponse = { status: 200, body: { valid: false, message: 'License has been deactivated.' } }
    const status = await getLicenseStatus(true)
    expect(status.valid).toBe(false)
    expect(requireValidLicense()).rejects.toBeInstanceOf(LicenseInvalidError)
  })

  it('falls back to cached validity within grace when server unreachable', async () => {
    await activateLicense('CHAT-TEST-KEY-0001')
    stub.stop(true) // simulate outage — restart a fresh stub afterAll-safe? use a dedicated port per test instead
  })
})
```

Note for the implementer: the outage test is cleaner with `process.env.LICENSE_SERVER_URL` pointed at a closed port (e.g. `http://localhost:49999`) after seeding the cache — do that rather than stopping the shared stub. These tests hit the real dev SQLite via `db` (AppConfig row); acceptable here (the repo's route tests already do this); reset written fields in `beforeEach` via `db.appConfig.updateMany({ data: { licenseKeyEncrypted: null, licenseCache: null } })`.

- [ ] **Step 2: Run to fail** — `bun test src/lib/license.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/lib/license.ts`:

```ts
/**
 * License guard — client for the License-Validator server (D2T-compatible).
 * Hard gate: requireValidLicense() throws LicenseInvalidError → HTTP 402.
 *
 * State: module-level cache revalidated every LICENSE_REVALIDATE_MINUTES;
 * offline grace of LICENSE_GRACE_HOURS backed by an encrypted cache row in
 * AppConfig.licenseCache. Machine-bound via /etc/machine-id.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db } from '@/lib/db'
import { serverConfig } from '@/lib/config'
import { encryptConfig, decryptConfig } from '@/lib/crypto'
import {
  signLicenseRequest,
  stableStringify,
  parseValidateResponse,
  verifyResponseSignature,
  isWithinGrace,
} from '@/lib/license-protocol'

export class LicenseInvalidError extends Error {
  readonly code = 'LICENSE_INVALID'
  constructor(message = 'Lisensi tidak valid. Aktifkan lisensi di Settings → License.') {
    super(message)
    this.name = 'LicenseInvalidError'
  }
}

export interface LicenseStatus {
  configured: boolean
  valid: boolean
  plan: string | null
  expiresAt: string | null
  lastCheckedAt: string | null
  graceUntil: string | null
  machineId: string
  message: string
}

interface CacheEntry {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  lastValidatedAt: string
  machineId: string
}

const PRODUCT = 'chatbot'
let state: (LicenseStatus & { checkedAtMs: number }) | null = null
let machineIdMemo: string | null = null

export function _resetLicenseStateForTests() {
  state = null
}

export function getMachineId(): string {
  if (machineIdMemo) return machineIdMemo
  try {
    machineIdMemo = fs.readFileSync('/etc/machine-id', 'utf-8').trim()
    if (machineIdMemo) return machineIdMemo
  } catch { /* fall through */ }
  const fallback = path.join(process.cwd(), 'db', '.machine_id')
  try {
    machineIdMemo = fs.readFileSync(fallback, 'utf-8').trim()
    if (machineIdMemo) return machineIdMemo
  } catch { /* fall through */ }
  machineIdMemo = crypto.randomUUID().replace(/-/g, '')
  try {
    fs.mkdirSync(path.dirname(fallback), { recursive: true })
    fs.writeFileSync(fallback, machineIdMemo)
  } catch { /* ephemeral id is still better than crashing */ }
  return machineIdMemo
}

async function getAppConfig() {
  return db.appConfig.findFirst({
    select: { id: true, licenseKeyEncrypted: true, licenseCache: true },
  })
}

async function loadKey(): Promise<string | null> {
  const cfg = await getAppConfig()
  if (cfg?.licenseKeyEncrypted) {
    try {
      const obj = decryptConfig(cfg.licenseKeyEncrypted)
      if (typeof obj.licenseKey === 'string' && obj.licenseKey) return obj.licenseKey
    } catch { /* corrupted — treat as unset */ }
  }
  return serverConfig.license.bootstrapKey
}

function readCache(raw: string | null | undefined): CacheEntry | null {
  if (!raw) return null
  try {
    const obj = decryptConfig(raw) as unknown as CacheEntry
    if (typeof obj.lastValidatedAt !== 'string' || obj.machineId !== getMachineId()) return null
    return obj
  } catch {
    return null
  }
}

async function saveCache(entry: CacheEntry) {
  const cfg = await getAppConfig()
  if (!cfg) return
  await db.appConfig.update({
    where: { id: cfg.id },
    data: { licenseCache: encryptConfig(entry as unknown as Record<string, unknown>) },
  })
}

function toStatus(partial: Partial<LicenseStatus>): LicenseStatus {
  return {
    configured: false,
    valid: false,
    plan: null,
    expiresAt: null,
    lastCheckedAt: null,
    graceUntil: null,
    machineId: getMachineId(),
    message: '',
    ...partial,
  }
}

async function validateAgainstServer(licenseKey: string): Promise<LicenseStatus> {
  const { serverUrl, hmacSecret, graceHours } = serverConfig.license
  if (!serverUrl) {
    return toStatus({ message: 'LICENSE_SERVER_URL belum diisi di .env.' })
  }
  const payload = {
    license_key: licenseKey,
    machine_id: getMachineId(),
    product: PRODUCT,
    version: process.env.npm_package_version ?? '0.2.0',
    hostname: os.hostname(),
    os_info: `${os.type()} ${os.release()}`,
  }
  const body = stableStringify(payload)
  const reqPath = '/api/v1/license/validate'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (hmacSecret) Object.assign(headers, signLicenseRequest(hmacSecret, 'POST', reqPath, body))

  try {
    const res = await fetch(`${serverUrl}${reqPath}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 200) {
      const data = await res.json()
      const sig = res.headers.get('X-Response-Signature')
      if (sig && hmacSecret && !verifyResponseSignature(hmacSecret, data, sig)) {
        console.warn('[license] response signature mismatch — possible MITM')
      }
      const r = parseValidateResponse(data)
      const now = new Date().toISOString()
      await saveCache({ valid: r.valid, plan: r.plan, expiresAt: r.expiresAt, lastValidatedAt: now, machineId: getMachineId() })
      return toStatus({
        configured: true,
        valid: r.valid,
        plan: r.plan,
        expiresAt: r.expiresAt,
        lastCheckedAt: now,
        message: r.message,
      })
    }
    if (res.status === 401 || res.status === 403) {
      return toStatus({ configured: true, valid: false, lastCheckedAt: new Date().toISOString(), message: 'Lisensi ditolak oleh server.' })
    }
    // 5xx → offline grace below
  } catch { /* network error → offline grace below */ }

  const cfg = await getAppConfig()
  const cached = readCache(cfg?.licenseCache)
  if (cached?.valid && isWithinGrace(cached.lastValidatedAt, graceHours)) {
    const graceUntil = new Date(Date.parse(cached.lastValidatedAt) + graceHours * 3600_000).toISOString()
    return toStatus({
      configured: true,
      valid: true,
      plan: cached.plan,
      expiresAt: cached.expiresAt,
      lastCheckedAt: cached.lastValidatedAt,
      graceUntil,
      message: `Server lisensi tidak terjangkau — mode offline sampai ${graceUntil}.`,
    })
  }
  return toStatus({
    configured: true,
    valid: false,
    lastCheckedAt: cached?.lastValidatedAt ?? null,
    message: 'Server lisensi tidak terjangkau dan masa tenggang offline habis.',
  })
}

export async function getLicenseStatus(force = false): Promise<LicenseStatus> {
  const staleMs = serverConfig.license.revalidateMinutes * 60_000
  if (!force && state && Date.now() - state.checkedAtMs < staleMs) return state
  const key = await loadKey()
  const status = key
    ? await validateAgainstServer(key)
    : toStatus({ message: 'Belum ada license key. Aktifkan di Settings → License.' })
  state = { ...status, checkedAtMs: Date.now() }
  return status
}

export async function requireValidLicense(): Promise<void> {
  const s = await getLicenseStatus()
  if (!s.valid) throw new LicenseInvalidError(s.message || undefined)
}

export async function activateLicense(licenseKey: string): Promise<LicenseStatus> {
  const cfg = await getAppConfig()
  if (cfg) {
    await db.appConfig.update({
      where: { id: cfg.id },
      data: { licenseKeyEncrypted: encryptConfig({ licenseKey }) },
    })
  }
  return getLicenseStatus(true)
}

export async function deactivateLicense(): Promise<{ ok: boolean; message: string }> {
  const { serverUrl, hmacSecret } = serverConfig.license
  const key = await loadKey()
  let message = 'Lisensi dinonaktifkan di perangkat ini.'
  if (key && serverUrl) {
    const payload = {
      license_key: key,
      machine_id: getMachineId(),
      product: PRODUCT,
      version: '',
      hostname: os.hostname(),
      os_info: '',
    }
    const body = stableStringify(payload)
    const reqPath = '/api/v1/license/deactivate'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (hmacSecret) Object.assign(headers, signLicenseRequest(hmacSecret, 'POST', reqPath, body))
    try {
      await fetch(`${serverUrl}${reqPath}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
    } catch {
      message = 'Server lisensi tidak terjangkau — slot mesin mungkin masih terpakai.'
    }
  }
  const cfg = await getAppConfig()
  if (cfg) {
    await db.appConfig.update({
      where: { id: cfg.id },
      data: { licenseKeyEncrypted: null, licenseCache: null },
    })
  }
  state = null
  return { ok: true, message }
}
```

Check before coding: `encryptConfig`'s exact signature in `src/lib/crypto.ts` (it takes `Record<string, unknown>` — the cache entry cast above matches).

- [ ] **Step 4: Run to pass** — `bun test src/lib/license.test.ts` → PASS. Also `bun test --pass-with-no-tests` (no regressions).

- [ ] **Step 5: Commit** — `git add src/lib/license.ts src/lib/license.test.ts && git commit -m "feat: license guard with offline grace and machine binding"`

---

### Task 4: `/api/license/*` routes

**Files:**
- Create: `src/app/api/license/route.ts` (GET status)
- Create: `src/app/api/license/activate/route.ts`
- Create: `src/app/api/license/recheck/route.ts`
- Create: `src/app/api/license/deactivate/route.ts`

**Interfaces:**
- Consumes: Task 3 guard, `getActiveUser` (with `skipLicenseCheck` from Task 5 — until Task 5 lands, plain `getActiveUser()`), `writeAudit`, `handleApiError`.
- Produces: `GET /api/license` → `{ ok: true, status: LicenseStatus }`; `POST /api/license/activate` `{ licenseKey }` → 200 `{ ok: true, status }` | 400; `POST /api/license/recheck` → `{ ok: true, status }`; `POST /api/license/deactivate` → `{ ok: true, message }`. All admin-authenticated, all EXEMPT from the license gate.

- [ ] **Step 1: Implement the four routes.** `route.ts` (GET):

```ts
import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { getLicenseStatus } from '@/lib/license'

export async function GET() {
  try {
    await getActiveUser({ skipLicenseCheck: true })
    return NextResponse.json({ ok: true, status: await getLicenseStatus() })
  } catch (e) {
    return handleApiError(e, 'Gagal membaca status lisensi.')
  }
}
```

`activate/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { activateLicense } from '@/lib/license'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser({ skipLicenseCheck: true })
    const body = await req.json().catch(() => ({}))
    const licenseKey = typeof body?.licenseKey === 'string' ? body.licenseKey.trim() : ''
    if (!licenseKey) {
      return NextResponse.json({ error: 'License key wajib diisi.' }, { status: 400 })
    }
    const status = await activateLicense(licenseKey)
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'LICENSE_ACTIVATE',
      severity: status.valid ? 'info' : 'warning',
      detail: { valid: status.valid, plan: status.plan, keyMasked: `${licenseKey.slice(0, 4)}…${licenseKey.slice(-4)}` },
    })
    return NextResponse.json({ ok: true, status })
  } catch (e) {
    return handleApiError(e, 'Gagal mengaktifkan lisensi.')
  }
}
```

`recheck/route.ts`: same pattern — `getLicenseStatus(true)`, audit `LICENSE_RECHECK`, return `{ ok: true, status }`.
`deactivate/route.ts`: same pattern — `deactivateLicense()`, audit `LICENSE_DEACTIVATE` severity `warning`, return `{ ok: true, ...result }`.

- [ ] **Step 2: Verify** — `bunx tsc --noEmit`; smoke (dev server, demo fallback on):

```bash
curl -s http://localhost:3005/api/license                      # → {"ok":true,"status":{"configured":false,...}}
curl -s -X POST http://localhost:3005/api/license/activate -H 'Content-Type: application/json' -d '{}'  # → 400
curl -s -X POST http://localhost:3005/api/license/recheck      # → {"ok":true,...}
```

- [ ] **Step 3: Commit** — `git add src/app/api/license && git commit -m "feat: license status/activate/recheck/deactivate routes"`

---

### Task 5: Enforcement chokepoints (hard gate)

**Files:**
- Modify: `src/lib/session.ts` (`getActiveUser` + `handleApiError`)
- Modify: allowlisted routes to pass `{ skipLicenseCheck: true }`
- Modify: `/api/v1` API-key auth path (find with `grep -rn 'verifyApiKey\|Authorization' src/app/api/v1 src/lib/api-keys.ts`)
- Test: extend `src/lib/license.test.ts` or route tests as fits

**Interfaces:**
- Produces: `getActiveUser(opts?: { skipLicenseCheck?: boolean })` — when the check runs and the license is invalid, throws `LicenseInvalidError`; `handleApiError` maps `LicenseInvalidError` → **402** `{ error, code: 'LICENSE_INVALID' }`.

- [ ] **Step 1: session.ts** — add to `getActiveUser` signature `opts?: { skipLicenseCheck?: boolean }` and, right before returning the resolved user (both the cookie path and the demo-fallback path):

```ts
if (!opts?.skipLicenseCheck) {
  await requireValidLicense()
}
```

Import `requireValidLicense`, `LicenseInvalidError` from `@/lib/license`. Extend `handleApiError`:

```ts
if (e instanceof LicenseInvalidError) {
  return NextResponse.json({ error: e.message, code: 'LICENSE_INVALID' }, { status: 402 })
}
```

- [ ] **Step 2: Allowlist** — pass `{ skipLicenseCheck: true }` at these call sites ONLY (locate each with `grep -rn 'getActiveUser(' src/app/api`):
  - `src/app/api/me/route.ts` (GET)
  - `src/app/api/auth/logout/route.ts`
  - `src/app/api/setup/complete/route.ts`
  - all four `src/app/api/license/*` routes (already done in Task 4)

  Everything else keeps the default → gated. (`/api/auth/login`, `/api/setup/status`, `/api/setup/admin`, `/api/v1/health` don't call `getActiveUser` at all — verify with grep, leave as is.)

- [ ] **Step 3: External API gate** — in the `/api/v1/chat/completions` route (and any other `/api/v1` route that authenticates via API key), after the API key is verified successfully add:

```ts
await requireValidLicense()
```

The route's error handling must map `LicenseInvalidError` to 402 — reuse `handleApiError` if that route already uses it; otherwise add an explicit catch (check `src/app/api/v1/chat/completions/route.ts` error style first — it has its own `statusForExternalChatError`; extend that mapping with `LICENSE_INVALID → 402`).

- [ ] **Step 4: Failing-then-passing check** — with no license configured and `LICENSE_SERVER_URL` set:

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/api/documents   # → 402
curl -s http://localhost:3005/api/license | head -c 120                      # → 200 (allowlisted)
curl -s http://localhost:3005/api/me | head -c 120                           # → 200 (allowlisted)
```

Then activate a valid key (Task 7 smoke) → `/api/documents` returns 200 again.

- [ ] **Step 5: Verify suite** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests`. NOTE: existing route tests that exercise `getActiveUser` may now fail if no license is configured in the test env — set `LICENSE_SERVER_URL=` (empty) plus a pre-seeded valid cache, OR (simpler, do this) add an env escape used ONLY by tests: in `requireValidLicense`, return early when `serverConfig.isTest === true` unless `process.env.LICENSE_TEST_ENFORCE=1` (the license tests set that var). Check how `serverConfig.isTest` is derived in `config.ts` and follow it.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: hard license gate on session and external API paths"`

---

### Task 6: License UI (Settings tab + blocking screen)

**Files:**
- Create: `src/components/views/license-panel.tsx` (shared panel used by both surfaces)
- Modify: `src/components/views/settings-view.tsx` (new "License" tab)
- Modify: `src/app/page.tsx` (blocking gate)

**Interfaces:**
- Consumes: `/api/license*` routes (Task 4); 402 responses carry `code: 'LICENSE_INVALID'`.
- Produces: `<LicensePanel />` (status + activate form + recheck/deactivate); shell gate rendering a full-screen license screen when `GET /api/license` reports `valid: false` (after login/setup gates).

- [ ] **Step 1: LicensePanel** — one component, used in both places:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, Loader2, RefreshCcw, ShieldOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface LicenseStatus {
  configured: boolean
  valid: boolean
  plan: string | null
  expiresAt: string | null
  lastCheckedAt: string | null
  graceUntil: string | null
  machineId: string
  message: string
}

export function LicensePanel({ onValid }: { onValid?: () => void }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path = '/api/license', init?: RequestInit) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, init)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error ?? 'Gagal memuat status lisensi.')
        return
      }
      const s: LicenseStatus = data.status ?? data
      setStatus(s)
      if (s.valid) onValid?.()
    } catch {
      setError('Tidak dapat menghubungi server.')
    } finally {
      setBusy(false)
    }
  }, [onValid])

  useEffect(() => { load() }, [load])

  const activate = () =>
    load('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {status?.valid ? <BadgeCheck className="h-5 w-5 text-emerald-600" /> : <ShieldOff className="h-5 w-5 text-destructive" />}
          Lisensi Produk
        </CardTitle>
        <CardDescription>
          {status?.valid
            ? `Aktif${status.plan ? ` — plan ${status.plan}` : ''}${status.expiresAt ? `, berlaku sampai ${status.expiresAt.slice(0, 10)}` : ''}`
            : status?.message || 'Lisensi belum aktif.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Machine ID: {status.machineId.slice(0, 12)}…</Badge>
            {status.lastCheckedAt && <Badge variant="outline">Cek terakhir: {status.lastCheckedAt.slice(0, 19).replace('T', ' ')}</Badge>}
            {status.graceUntil && <Badge variant="outline" className="border-amber-300 text-amber-700">Mode offline s/d {status.graceUntil.slice(0, 16).replace('T', ' ')}</Badge>}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="license-key">License Key</Label>
          <div className="flex gap-2">
            <Input id="license-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="CHAT-XXXX-XXXX-XXXX" />
            <Button onClick={activate} disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aktifkan'}
            </Button>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => load('/api/license/recheck', { method: 'POST' })} disabled={busy}>
            <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Cek Ulang
          </Button>
          {status?.configured && (
            <Button variant="outline" size="sm" onClick={() => load('/api/license/deactivate', { method: 'POST' })} disabled={busy}>
              Nonaktifkan di perangkat ini
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Settings tab** — in `settings-view.tsx` add a `TabsTrigger value="license"` ("License") and `TabsContent` rendering `<LicensePanel />` (same pattern as the other tabs).

- [ ] **Step 3: Shell gate** — in `page.tsx`, after the login and setup gates, fetch license status once:

```tsx
const [license, setLicense] = useState<{ valid: boolean } | null>(null)
useEffect(() => {
  if (loading || unauthorized) return
  fetch('/api/license').then(async (r) => {
    const d = r.ok ? await r.json() : null
    setLicense(d?.status ?? { valid: false })
  }).catch(() => setLicense({ valid: false }))
}, [loading, unauthorized])

// after login/setup gates:
if (license && !license.valid) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-lg">
        <LicensePanel onValid={() => setLicense({ valid: true })} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify manually** — no key: app shows the license screen after login; Settings unreachable (that's fine — the blocking screen hosts the same panel). Activate with a valid key (see Task 7) → app loads; License tab in Settings shows status; "Cek Ulang" works.

- [ ] **Step 5: Verify suite** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: license activation UI and blocking gate"`

---

### Task 7: Live smoke against the real License-Validator + docs

**Files:**
- Modify: `docs/superpowers/progress/2026-07-02-license-validation.md` (create)
- Modify: `worklog.md` (append entry, existing format)

- [ ] **Step 1: Start the validator** — `cd ~/ryasai/License-Validator && docker compose up -d` (or `uvicorn main:app --port 9000` in its venv; check its README/docker-compose.yml for the canonical way). Confirm `curl -s http://localhost:9000/health`.
- [ ] **Step 2: Create a chatbot license** — via the validator's admin API/dashboard (`routes/admin.py`: `POST /api/.../licenses` with `product: "chatbot"`, small `max_machines`, near-term expiry for testing). Note its auth requirements (`auth_routes.py` — admin setup/login token) and obtain a token first if required.
- [ ] **Step 3: Full lifecycle smoke** on the Chatbot (dev server, `LICENSE_SERVER_URL=http://localhost:9000`):
  1. No key → UI blocking screen; `/api/documents` → 402.
  2. Activate with the created key → valid; app loads; validator dashboard shows the machine activation.
  3. `POST /api/license/recheck` → still valid.
  4. Revoke the license on the validator → recheck → invalid; UI blocks; `/api/v1/chat/completions` with an API key → 402.
  5. Re-create/re-activate → deactivate from Chatbot → validator machine slot freed.
  6. Stop the validator container → recheck → still valid (grace mode badge shown).
- [ ] **Step 4: Full verification** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests && bun run e2e` (e2e from the previous plan must still pass — its scratch env has no license; confirm the test-env escape from Task 5 Step 5 covers it, or seed a valid cache in the e2e seed script).
- [ ] **Step 5: Progress doc + worklog** — record smoke results in both files.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs: license validation progress + smoke results"`

---

## Self-Review Notes

- Spec coverage: protocol/guard → Tasks 1–3; routes → Task 4; hard gate both auth models → Task 5; UI (tab + blocking screen) → Task 6; smoke vs real validator + grace → Task 7. Tiers deliberately out of scope (displayed only).
- Type consistency: `LicenseStatus` shape identical across Tasks 3/4/6; error code `LICENSE_INVALID` and HTTP 402 consistent across Tasks 3/5/6; product string `"chatbot"` everywhere.
- Verify-before-code points marked inline: `encryptConfig` signature (Task 3), `/api/v1` auth call sites and `statusForExternalChatError` (Task 5), `serverConfig.isTest` derivation (Task 5), validator startup + admin auth (Task 7).
- Interaction with in-flight plan: prerequisite noted in Global Constraints; e2e interplay handled in Task 7 Step 4.
