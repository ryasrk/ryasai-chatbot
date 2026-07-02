# Production Final Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real admin login, setup wizard, spec-aligned navigation (AI Configuration, Prompt & Tools, richer Monitoring), and a Playwright e2e suite so the chatbot is production ready.

**Architecture:** Single-page Next.js shell (`src/app/page.tsx`) renders views by `?view=` key. Auth reuses the existing HMAC-signed `x-active-user` cookie (`signSession`/`verifySession` in `src/lib/crypto.ts`) — we add password verification and make the cookie httpOnly via new login/logout routes. Setup gate reads `AppConfig.setupCompleted`. All data panels reuse existing Prisma tables (`ToolRun`, `ApiRequestLog`, `RestApiRequestLog`, `AuditLog`).

**Tech Stack:** Next.js 16, Bun, Prisma + SQLite, zustand, shadcn/ui, `bun test` for unit/route tests, `@playwright/test` (new, dev-only) for e2e.

## Global Constraints

- Project root: `/home/ryasr/ryasai/Chatbot` (WSL Ubuntu-24.04, user `ryasr`). Dev server port 3005.
- Runtime is Bun: run tests with `bun test <file>`, typecheck `bunx tsc --noEmit`, lint `bun run lint`.
- No new runtime dependencies. Only new dev dependency allowed: `@playwright/test`.
- UI copy is Bahasa Indonesia (match existing views); code identifiers/comments English.
- Fail closed: unauthenticated API access returns 401 when `AUTH_DEMO_FALLBACK=false`.
- Never log or return password/hash values. Login failure message is generic (no user enumeration).
- Existing tests (41+) must stay green after every task: `bun test --pass-with-no-tests`.
- Commit after every task (the repo is the git root).

---

### Task 1: Password hashing helpers

**Files:**
- Create: `src/lib/passwords.ts`
- Test: `src/lib/passwords.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): string` (format `scrypt$<saltB64url>$<hashB64url>`), `verifyPassword(password: string, stored: string): boolean` (false for malformed/legacy values like `demo-bcrypt-placeholder`, never throws).

- [ ] **Step 1: Write the failing test** — `src/lib/passwords.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { hashPassword, verifyPassword } from './passwords'

describe('passwords', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('s3cret-pw')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('s3cret-pw', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    expect(verifyPassword('wrong', hashPassword('s3cret-pw'))).toBe(false)
  })

  it('produces unique salts', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  it('rejects malformed stored values without throwing', () => {
    expect(verifyPassword('x', 'demo-bcrypt-placeholder')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'scrypt$not-base64$$$')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test src/lib/passwords.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/lib/passwords.ts`:

```ts
/**
 * Password hashing (scrypt, node:crypto — no external dependency).
 * Stored format: `scrypt$<salt b64url>$<hash b64url>`.
 */
import crypto from 'crypto'

const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEYLEN = 32

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, KEYLEN, SCRYPT)
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT)
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test src/lib/passwords.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit** — `git add src/lib/passwords.ts src/lib/passwords.test.ts && git commit -m "feat: add scrypt password hashing helpers"`

---

### Task 2: Login and logout routes

**Files:**
- Create: `src/app/api/auth/login/route.ts`
- Create: `src/app/api/auth/logout/route.ts`
- Test: `src/app/api/auth/login/route.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (Task 1), `signSession` from `@/lib/crypto`, `writeAudit`/`handleApiError` from `@/lib/session`, `db` from `@/lib/db`.
- Produces: `POST /api/auth/login` `{ email, password }` → 200 `{ ok: true, user: { userId, name, email, role } }` + httpOnly `x-active-user` cookie; 400 missing fields; 401 generic on bad credentials. `POST /api/auth/logout` → 200 `{ ok: true }`, clears cookie. Pure helper `normalizeLoginInput(body: unknown): { email: string; password: string } | null` exported from the login route for tests (follows the pattern of `send/route.test.ts` testing exported pure functions).

- [ ] **Step 1: Write the failing test** — `src/app/api/auth/login/route.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { normalizeLoginInput } from './route'

describe('normalizeLoginInput', () => {
  it('accepts valid input and lowercases email', () => {
    expect(normalizeLoginInput({ email: ' Admin@Acme.com ', password: 'pw' })).toEqual({
      email: 'admin@acme.com',
      password: 'pw',
    })
  })

  it('rejects missing fields', () => {
    expect(normalizeLoginInput({ email: 'a@b.c' })).toBeNull()
    expect(normalizeLoginInput({ password: 'pw' })).toBeNull()
    expect(normalizeLoginInput(null)).toBeNull()
    expect(normalizeLoginInput({ email: '', password: 'pw' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test src/app/api/auth/login/route.test.ts` → FAIL.

- [ ] **Step 3: Implement login route** — `src/app/api/auth/login/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { writeAudit, handleApiError } from '@/lib/session'

export function normalizeLoginInput(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!email || !password) return null
  return { email, password }
}

export async function POST(req: NextRequest) {
  try {
    const input = normalizeLoginInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json({ error: 'Email dan password wajib diisi.' }, { status: 400 })
    }

    const user = await db.user.findUnique({ where: { email: input.email } })
    const ok = !!user && user.isActive && verifyPassword(input.password, user.passwordHash)
    if (!user || !ok) {
      if (user) {
        await writeAudit({
          companyId: user.companyId,
          userId: user.id,
          action: 'LOGIN_FAILED',
          severity: 'warning',
          detail: { email: input.email },
        })
      }
      // Generic message: never reveal whether the email exists.
      return NextResponse.json({ error: 'Email atau password salah.' }, { status: 401 })
    }

    await writeAudit({
      companyId: user.companyId,
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      detail: { email: user.email },
    })

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email, role: user.role },
    })
    res.cookies.set('x-active-user', signSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Gagal memproses login.')
  }
}
```

- [ ] **Step 4: Implement logout route** — `src/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'

export async function POST() {
  try {
    try {
      const user = await getActiveUser()
      await writeAudit({
        companyId: user.companyId,
        userId: user.userId,
        action: 'LOGOUT',
        detail: { email: user.email },
      })
    } catch {
      // No active session — still clear the cookie below.
    }
    const res = NextResponse.json({ ok: true })
    res.cookies.set('x-active-user', '', { httpOnly: true, maxAge: 0, path: '/' })
    return res
  } catch (e) {
    return handleApiError(e, 'Gagal logout.')
  }
}
```

- [ ] **Step 5: Verify** — `bun test src/app/api/auth/login/route.test.ts` → PASS. `bunx tsc --noEmit` → clean.

- [ ] **Step 6: Live smoke** (dev server on 3005 must be running; `bun run dev` if not):

```bash
curl -s -X POST http://localhost:3005/api/auth/login -H 'Content-Type: application/json' -d '{}' # → 400
curl -s -X POST http://localhost:3005/api/auth/login -H 'Content-Type: application/json' -d '{"email":"nobody@x.y","password":"z"}' # → 401
curl -s -X POST http://localhost:3005/api/auth/logout # → {"ok":true}
```

- [ ] **Step 7: Commit** — `git add src/app/api/auth && git commit -m "feat: add login/logout routes with httpOnly signed session cookie"`

---

### Task 3: Real admin password in seed + env plumbing

**Files:**
- Modify: `scripts/seed.ts` (line ~46: `passwordHash: 'demo-bcrypt-placeholder'`)
- Modify: `.env.example` (add `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`)
- Modify: `.env` (same keys, real values)

**Interfaces:**
- Consumes: `hashPassword` (Task 1).
- Produces: seeded admin user whose `passwordHash` verifies against `ADMIN_INITIAL_PASSWORD` (default `admin12345` for dev), admin email from `ADMIN_EMAIL` when set.

- [ ] **Step 1: Modify seed** — in `scripts/seed.ts`, import `hashPassword` from `../src/lib/passwords` and replace the placeholder. For the admin-role user, honor env overrides:

```ts
import { hashPassword } from '../src/lib/passwords'

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const adminPassword = process.env.ADMIN_INITIAL_PASSWORD || 'admin12345'
```

In the user-creation loop replace `passwordHash: 'demo-bcrypt-placeholder'` with `passwordHash: hashPassword(u.role === 'admin' ? adminPassword : 'user12345')` and, for the admin entry, use `email: adminEmail ?? u.email`.

- [ ] **Step 2: Add env keys** — append to `.env.example`:

```env
# Single admin login (used by seed + setup wizard)
ADMIN_EMAIL=admin@example.com
ADMIN_INITIAL_PASSWORD=change-me
```

Set real values in `.env` (keep `AUTH_DEMO_FALLBACK=true` for now; flipped in Task 12).

- [ ] **Step 3: Re-seed and verify login end to end**:

```bash
bun run scripts/seed.ts
curl -s -X POST http://localhost:3005/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_INITIAL_PASSWORD>"}'
# Expected: {"ok":true,"user":{...}} and Set-Cookie: x-active-user=...; HttpOnly
```

- [ ] **Step 4: Verify suite** — `bun test --pass-with-no-tests` → all green.

- [ ] **Step 5: Commit** — `git add scripts/seed.ts .env.example && git commit -m "feat: seed admin with real scrypt password from env"`

---

### Task 4: Login screen in the app shell

**Files:**
- Create: `src/components/views/login-view.tsx`
- Modify: `src/store/useActiveUserStore.ts` (add `unauthorized` flag)
- Modify: `src/hooks/use-active-user.ts` (expose it)
- Modify: `src/app/page.tsx` (render LoginView when unauthorized)
- Modify: `src/components/views/topbar.tsx` (logout button)

**Interfaces:**
- Consumes: `POST /api/auth/login`, `POST /api/auth/logout` (Task 2).
- Produces: store state `unauthorized: boolean` (set when `GET /api/me` returns 401, cleared on successful refresh); `<LoginView />` component that calls `refresh()` from the store after successful login.

- [ ] **Step 1: Store change** — in `useActiveUserStore.ts` add `unauthorized: boolean` (initial `false`) to the interface and state, and change `refresh` to:

```ts
refresh: async () => {
  set({ loading: true })
  try {
    const res = await fetch('/api/me', { cache: 'no-store' })
    if (res.ok) {
      set({ user: await res.json(), unauthorized: false })
    } else if (res.status === 401) {
      set({ user: null, unauthorized: true })
    }
  } catch {
    /* ignore */
  } finally {
    set({ loading: false })
  }
},
```

In `src/hooks/use-active-user.ts` read and return `unauthorized` alongside `user`/`loading`.

- [ ] **Step 2: LoginView** — `src/components/views/login-view.tsx`:

```tsx
'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error ?? 'Login gagal. Coba lagi.')
        return
      }
      onSuccess()
    } catch {
      setError('Tidak dapat menghubungi server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Image src="/logo.svg" alt="ryasai" width={48} height={48} className="rounded-md mb-2" />
          <CardTitle>Masuk sebagai Admin</CardTitle>
          <CardDescription>Gunakan akun admin untuk mengelola chatbot.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Masuk'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Shell gate** — in `src/app/page.tsx`, destructure `unauthorized` and `refresh` from `useActiveUser()`; before the main return add:

```tsx
if (!loading && unauthorized) {
  return <LoginView onSuccess={refresh} />
}
```

- [ ] **Step 4: Logout button** — in `topbar.tsx` add next to the user chip:

```tsx
<button
  onClick={async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.reload()
  }}
  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
  aria-label="Keluar"
  title="Keluar"
>
  <LogOut className="h-4 w-4" />
</button>
```

(import `LogOut` from `lucide-react`).

- [ ] **Step 5: Verify manually** — with `AUTH_DEMO_FALLBACK=false` temporarily in `.env` (restart dev server): open `http://localhost:3005` → login form appears; wrong password shows error; correct login lands on dashboard; logout returns to form. Restore `AUTH_DEMO_FALLBACK=true` and restart.

- [ ] **Step 6: Verify suite** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests` → green.

- [ ] **Step 7: Commit** — `git add -A src/components/views/login-view.tsx src/store src/hooks src/app/page.tsx src/components/views/topbar.tsx && git commit -m "feat: login screen, logout button, unauthorized gate in shell"`

---

### Task 5: Remove multi-user switching (spec: single admin)

**Files:**
- Modify: `src/app/api/me/route.ts` (delete the `POST` handler)
- Delete: `src/app/api/me/users/route.ts`
- Modify: `src/store/useActiveUserStore.ts` (remove `companyUsers`, `loadCompanyUsers`, `switchUser`)
- Modify: `src/hooks/use-active-user.ts` (same)
- Modify: any consumers (find with `grep -rn 'switchUser\|companyUsers\|loadCompanyUsers' src`)

**Interfaces:**
- Produces: `/api/me` is GET-only; store shape `{ user, loading, unauthorized, refresh }`.

- [ ] **Step 1: Find consumers** — `grep -rn 'switchUser\|companyUsers\|loadCompanyUsers' src` and remove each usage (typically a user-switch dropdown in dashboard or settings; delete the UI element, keep the rest of the component).
- [ ] **Step 2: Delete API surface** — remove `POST` from `src/app/api/me/route.ts` (keep GET), delete `src/app/api/me/users/route.ts`.
- [ ] **Step 3: Slim the store and hook** to `{ user, loading, unauthorized, refresh }`.
- [ ] **Step 4: Verify** — `bunx tsc --noEmit` (this catches every dangling reference), `bun run lint`, `bun test --pass-with-no-tests`, and `curl -s -X POST http://localhost:3005/api/me` → 405.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: remove multi-user switching (single-admin product)"`

---

### Task 6: Setup status/admin/complete APIs

**Files:**
- Create: `src/app/api/setup/status/route.ts`
- Create: `src/app/api/setup/admin/route.ts`
- Create: `src/app/api/setup/complete/route.ts`
- Create: `src/lib/setup.ts`
- Test: `src/lib/setup.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 1), `signSession`, `getActiveUser`, `db`.
- Produces:
  - `getSetupState(db): Promise<{ setupCompleted: boolean; hasAdmin: boolean }>` in `src/lib/setup.ts` — `hasAdmin` = an active admin exists with a `scrypt$` password hash.
  - `GET /api/setup/status` (public) → `{ ok: true, setupCompleted, hasAdmin }`.
  - `POST /api/setup/admin` (public, but 409 once `setupCompleted`) — body `{ name, email, password }` (password min 8 chars). Creates the singleton Company + AppConfig if missing, upserts the admin user with hashed password, sets the session cookie (auto-login), audit `SETUP_ADMIN_CREATED`. → 201 `{ ok: true }`.
  - `POST /api/setup/complete` (auth required) — sets `AppConfig.setupCompleted = true`, audit `SETUP_COMPLETED`. → 200 `{ ok: true }`.

- [ ] **Step 1: Write the failing test** — `src/lib/setup.test.ts` for the pure input validator:

```ts
import { describe, expect, it } from 'bun:test'
import { normalizeSetupAdminInput } from './setup'

describe('normalizeSetupAdminInput', () => {
  it('accepts valid input', () => {
    expect(
      normalizeSetupAdminInput({ name: 'Admin', email: ' A@B.co ', password: 'longenough' }),
    ).toEqual({ name: 'Admin', email: 'a@b.co', password: 'longenough' })
  })
  it('rejects short passwords', () => {
    expect(normalizeSetupAdminInput({ name: 'A', email: 'a@b.co', password: 'short' })).toBeNull()
  })
  it('rejects missing fields', () => {
    expect(normalizeSetupAdminInput({})).toBeNull()
    expect(normalizeSetupAdminInput(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to fail** — `bun test src/lib/setup.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/lib/setup.ts`**:

```ts
import type { PrismaClient } from '@prisma/client'

export interface SetupAdminInput {
  name: string
  email: string
  password: string
}

export function normalizeSetupAdminInput(body: unknown): SetupAdminInput | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!name || !email || password.length < 8) return null
  return { name, email, password }
}

export async function getSetupState(db: PrismaClient) {
  const appConfig = await db.appConfig.findFirst({ select: { setupCompleted: true } })
  const admin = await db.user.findFirst({
    where: { role: 'admin', isActive: true, passwordHash: { startsWith: 'scrypt$' } },
    select: { id: true },
  })
  return { setupCompleted: appConfig?.setupCompleted ?? false, hasAdmin: !!admin }
}
```

- [ ] **Step 4: Implement the three routes.** `status/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSetupState } from '@/lib/setup'
import { handleApiError } from '@/lib/session'

export async function GET() {
  try {
    const state = await getSetupState(db)
    return NextResponse.json({ ok: true, ...state })
  } catch (e) {
    return handleApiError(e, 'Gagal membaca status setup.')
  }
}
```

`admin/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { normalizeSetupAdminInput, getSetupState } from '@/lib/setup'
import { writeAudit, handleApiError } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const state = await getSetupState(db)
    if (state.setupCompleted) {
      return NextResponse.json({ error: 'Setup sudah selesai.' }, { status: 409 })
    }
    const input = normalizeSetupAdminInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json(
        { error: 'Nama, email, dan password (min. 8 karakter) wajib diisi.' },
        { status: 400 },
      )
    }

    let company = await db.company.findFirst()
    if (!company) company = await db.company.create({ data: { name: 'Organisasi Saya' } })
    await db.appConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id },
      update: {},
    })

    const user = await db.user.upsert({
      where: { email: input.email },
      create: {
        email: input.email,
        name: input.name,
        role: 'admin',
        companyId: company.id,
        passwordHash: hashPassword(input.password),
        isActive: true,
      },
      update: { name: input.name, role: 'admin', passwordHash: hashPassword(input.password), isActive: true },
    })

    await writeAudit({
      companyId: company.id,
      userId: user.id,
      action: 'SETUP_ADMIN_CREATED',
      detail: { email: user.email },
    })

    const res = NextResponse.json({ ok: true }, { status: 201 })
    res.cookies.set('x-active-user', signSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Gagal membuat akun admin.')
  }
}
```

`complete/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'

export async function POST() {
  try {
    const user = await getActiveUser()
    await db.appConfig.upsert({
      where: { companyId: user.companyId },
      create: { companyId: user.companyId, setupCompleted: true },
      update: { setupCompleted: true },
    })
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'SETUP_COMPLETED',
      detail: {},
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleApiError(e, 'Gagal menyelesaikan setup.')
  }
}
```

Note: check `model Company` required fields in `prisma/schema.prisma` before the `company.create` call; add any required scalars (e.g. slug) with sensible defaults.

- [ ] **Step 5: Verify** — `bun test src/lib/setup.test.ts` PASS; `bunx tsc --noEmit`; smoke:

```bash
curl -s http://localhost:3005/api/setup/status         # → {"ok":true,"setupCompleted":...,"hasAdmin":true}
curl -s -X POST http://localhost:3005/api/setup/complete # → {"ok":true} (demo fallback auth)
curl -s -X POST http://localhost:3005/api/setup/admin -H 'Content-Type: application/json' -d '{}' # → 409 (now completed)
```

Then reset for dev: `wsl sqlite3` or Prisma studio not needed — run `bun run scripts/seed.ts` if it resets AppConfig; otherwise leave completed=true (dev DB is already set up).

- [ ] **Step 6: Commit** — `git add src/lib/setup.ts src/lib/setup.test.ts src/app/api/setup && git commit -m "feat: setup status/admin/complete APIs"`

---

### Task 7: Setup wizard view + shell gate

**Files:**
- Create: `src/components/views/setup-view.tsx`
- Modify: `src/app/page.tsx` (gate on setup status)

**Interfaces:**
- Consumes: `GET /api/setup/status`, `POST /api/setup/admin`, `POST /api/setup/complete` (Task 6), existing `GET/PUT /api/llm-config`, `POST /api/llm-config/models` (model list test), `POST /api/documents` (upload), `POST /api/chat/sessions` + `POST /api/chat/sessions/:id/send` (test chat).
- Produces: `<SetupView onDone={() => void} />` — full-screen wizard; shell renders it when `setupCompleted === false`.

- [ ] **Step 1: Shell gate** — in `page.tsx`, after the auth gate, add setup-status state:

```tsx
const [setup, setSetup] = useState<{ setupCompleted: boolean; hasAdmin: boolean } | null>(null)
useEffect(() => {
  fetch('/api/setup/status').then(async (r) => setSetup(r.ok ? await r.json() : { setupCompleted: true, hasAdmin: true }))
}, [])
// after the unauthorized gate:
if (setup && !setup.setupCompleted) {
  return <SetupView hasAdmin={setup.hasAdmin} onDone={() => { setSetup({ setupCompleted: true, hasAdmin: true }); refresh() }} />
}
```

Ordering: when `!hasAdmin`, SetupView renders even if unauthorized (the admin-account step performs auto-login). So the gate order is: `if (setup && !setup.setupCompleted) return <SetupView …/>` BEFORE the unauthorized gate.

- [ ] **Step 2: SetupView** — a stepper with 6 steps. Full component skeleton (fill styling from existing views; each step is a small function component inside the file):

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'

const STEPS = ['Akun Admin', 'LLM API', 'Tes Model', 'Dokumen', 'Data Source', 'Tes Chat'] as const

export function SetupView({ hasAdmin, onDone }: { hasAdmin: boolean; onDone: () => void }) {
  const [step, setStep] = useState(hasAdmin ? 1 : 0)
  const next = () => setStep((s) => s + 1)

  async function finish() {
    await fetch('/api/setup/complete', { method: 'POST' })
    onDone()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Setup Awal — {STEPS[step]}</CardTitle>
          <CardDescription>Langkah {step + 1} dari {STEPS.length}</CardDescription>
          <Progress value={((step + 1) / STEPS.length) * 100} />
        </CardHeader>
        <CardContent>
          {step === 0 && <AdminStep onNext={next} />}
          {step === 1 && <LlmStep onNext={next} />}
          {step === 2 && <TestModelStep onNext={next} />}
          {step === 3 && <DocumentStep onNext={next} />}
          {step === 4 && <DataSourceStep onNext={next} />}
          {step === 5 && <TestChatStep onFinish={finish} />}
        </CardContent>
      </Card>
    </div>
  )
}
```

Step behaviors (implement each as an inline component in the same file):
- `AdminStep`: name/email/password form → `POST /api/setup/admin`; on 201 call `onNext()`; show `error` from response on failure.
- `LlmStep`: base URL / API key / model fields → `PUT /api/llm-config` with the same body shape the AI settings tab in `settings-view.tsx` sends (copy the fetch call from there); "Lewati" button also allowed (skip → next).
- `TestModelStep`: button calls `POST /api/llm-config/models` (model sync); success shows model count, then next. Skippable.
- `DocumentStep`: file input → same upload call as `knowledge-base-view.tsx` (`POST /api/documents` multipart); "Lewati" skips.
- `DataSourceStep`: text explaining Data Sources can be configured later; "Lewati" (this step is informational in v1 — adding a DB/REST connector mid-wizard duplicates the Data Sources view for little gain).
- `TestChatStep`: input + button → `POST /api/chat/sessions` then `POST /api/chat/sessions/:id/send` (copy request shape from `chat-view.tsx`); shows the reply text; "Selesai" calls `onFinish()` (enabled even if the chat test fails, with a warning).

- [ ] **Step 3: Verify manually** — reset flag: `cd ~/ryasai/Chatbot && bunx prisma studio` is overkill; instead run:

```bash
bun -e "const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.appConfig.updateMany({data:{setupCompleted:false}}).then(()=>db.\$disconnect())"
```

Reload app → wizard appears at step 2 (admin exists); walk through with skips → "Selesai" → dashboard loads. Confirm `/api/setup/status` now returns `setupCompleted: true`.

- [ ] **Step 4: Verify suite** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests`.

- [ ] **Step 5: Commit** — `git add src/components/views/setup-view.tsx src/app/page.tsx && git commit -m "feat: first-run setup wizard with completion gate"`

---

### Task 8: Prompt & Tools settings (storage + API + enforcement)

**Files:**
- Modify: `prisma/schema.prisma` (`AppConfig` gets `promptSettings String?`)
- Create: `src/lib/prompt-settings.ts`
- Test: `src/lib/prompt-settings.test.ts`
- Create: `src/app/api/prompt-tools/route.ts`
- Modify: `src/lib/tool-router.ts` (respect disabled tools)
- Modify: `src/app/api/chat/sessions/[id]/send/route.ts` and `src/app/api/v1/chat/completions/route.ts` (prepend custom system prompt — find where messages are assembled and where `routeTool`/tool-router entry is called)

**Interfaces:**
- Produces:
  - `PromptSettings = { systemPrompt: string; tools: { rag: boolean; sql: boolean; restApi: boolean } }`
  - `parsePromptSettings(json: string | null | undefined): PromptSettings` (safe defaults: empty prompt, all tools true)
  - `getPromptSettings(db, companyId): Promise<PromptSettings>`
  - `GET /api/prompt-tools` → `{ ok: true, settings }`; `PUT /api/prompt-tools` body `{ systemPrompt?, tools? }` → merged + saved, audit `PROMPT_TOOLS_UPDATE`.
  - Tool router: when a route resolves to a disabled tool, fall back to `CHAT` (and note it in the ToolRun inputSummary).

- [ ] **Step 1: Failing test** — `src/lib/prompt-settings.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { parsePromptSettings, mergePromptSettings } from './prompt-settings'

describe('prompt settings', () => {
  it('returns defaults for null/garbage', () => {
    const d = parsePromptSettings(null)
    expect(d).toEqual({ systemPrompt: '', tools: { rag: true, sql: true, restApi: true } })
    expect(parsePromptSettings('{oops')).toEqual(d)
  })
  it('parses stored json and fills missing keys', () => {
    const s = parsePromptSettings('{"systemPrompt":"Jawab singkat.","tools":{"sql":false}}')
    expect(s.systemPrompt).toBe('Jawab singkat.')
    expect(s.tools).toEqual({ rag: true, sql: false, restApi: true })
  })
  it('merges updates over current', () => {
    const cur = parsePromptSettings(null)
    const m = mergePromptSettings(cur, { tools: { rag: false } })
    expect(m.tools).toEqual({ rag: false, sql: true, restApi: true })
    expect(m.systemPrompt).toBe('')
  })
})
```

- [ ] **Step 2: Run to fail**, then implement `src/lib/prompt-settings.ts`:

```ts
import type { PrismaClient } from '@prisma/client'

export interface PromptSettings {
  systemPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

const DEFAULTS: PromptSettings = { systemPrompt: '', tools: { rag: true, sql: true, restApi: true } }

export function parsePromptSettings(json: string | null | undefined): PromptSettings {
  if (!json) return structuredClone(DEFAULTS)
  try {
    const raw = JSON.parse(json) as Partial<PromptSettings>
    return {
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
      tools: {
        rag: raw.tools?.rag ?? true,
        sql: raw.tools?.sql ?? true,
        restApi: raw.tools?.restApi ?? true,
      },
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export function mergePromptSettings(
  current: PromptSettings,
  update: { systemPrompt?: unknown; tools?: Partial<PromptSettings['tools']> },
): PromptSettings {
  return {
    systemPrompt: typeof update.systemPrompt === 'string' ? update.systemPrompt : current.systemPrompt,
    tools: {
      rag: typeof update.tools?.rag === 'boolean' ? update.tools.rag : current.tools.rag,
      sql: typeof update.tools?.sql === 'boolean' ? update.tools.sql : current.tools.sql,
      restApi: typeof update.tools?.restApi === 'boolean' ? update.tools.restApi : current.tools.restApi,
    },
  }
}

export async function getPromptSettings(db: PrismaClient, companyId: string): Promise<PromptSettings> {
  const cfg = await db.appConfig.findUnique({ where: { companyId }, select: { promptSettings: true } })
  return parsePromptSettings(cfg?.promptSettings)
}
```

- [ ] **Step 3: Schema + migration** — add `promptSettings String?` to `model AppConfig`, then `bunx prisma db push && bunx prisma generate`.

- [ ] **Step 4: API route** — `src/app/api/prompt-tools/route.ts`: GET returns `getPromptSettings`; PUT parses body, `mergePromptSettings`, saves `JSON.stringify(settings)` to `appConfig.promptSettings` (upsert by companyId), writes audit `PROMPT_TOOLS_UPDATE`, returns `{ ok: true, settings }`. Wrap both in try/`handleApiError`, auth via `getActiveUser()`.

- [ ] **Step 5: Enforcement** — in `src/lib/tool-router.ts`, the entry function that picks RAG/SQL/REST (find the exported router used by both chat routes): load settings via `getPromptSettings(db, companyId)`; if the chosen route's tool is disabled, use the CHAT branch instead. Prepend `settings.systemPrompt` (when non-empty) as the first system message where the LLM messages array is built (both send route and tool-router paths — locate with `grep -n "role: 'system'" src/lib src/app/api -r`). Keep the existing built-in prompts; the custom prompt is prepended before them.

- [ ] **Step 6: Verify** — unit tests pass; `bunx tsc --noEmit`; smoke:

```bash
curl -s http://localhost:3005/api/prompt-tools
curl -s -X PUT http://localhost:3005/api/prompt-tools -H 'Content-Type: application/json' -d '{"systemPrompt":"Jawab dalam Bahasa Indonesia.","tools":{"sql":false}}'
```

Then a chat question that would route to SQL now answers via CHAT (check ToolRun rows or response provenance).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: prompt & tools settings with router enforcement"`

---

### Task 9: AI Configuration and Prompt & Tools views + navigation keys

**Files:**
- Create: `src/components/views/ai-configuration-view.tsx` (move the `llm` tab content out of `settings-view.tsx`)
- Create: `src/components/views/prompt-tools-view.tsx`
- Modify: `src/components/views/settings-view.tsx` (remove `llm` tab)
- Modify: `src/lib/view-routing.ts` + test `src/lib/view-routing.test.ts`
- Modify: `src/app/page.tsx` (NAV + renderView)

**Interfaces:**
- Consumes: `GET/PUT /api/prompt-tools` (Task 8), existing `/api/llm-config`, `/api/data-sources/rest-connectors`.
- Produces: `ViewKey` union gains `'ai-config' | 'prompt-tools'`; components `AIConfigurationView`, `PromptToolsView`.

- [ ] **Step 1: Failing test** — extend `src/lib/view-routing.test.ts`:

```ts
it('resolves the new production views', () => {
  expect(resolveViewFromSearch('?view=ai-config')).toBe('ai-config')
  expect(resolveViewFromSearch('?view=prompt-tools')).toBe('prompt-tools')
})
```

Run `bun test src/lib/view-routing.test.ts` → FAIL.

- [ ] **Step 2: Add keys** — in `view-routing.ts` add `'ai-config'` and `'prompt-tools'` to `VIEW_KEYS`. Test passes.

- [ ] **Step 3: AIConfigurationView** — cut the entire `llm` TabsContent implementation (the tab component function and its imports) from `settings-view.tsx` into `ai-configuration-view.tsx`, exported as `AIConfigurationView`. Remove the `llm` TabsTrigger/TabsContent from settings. No behavior change — same fetches to `/api/llm-config` and `/api/llm-config/models`.

- [ ] **Step 4: PromptToolsView** — new view with two cards:
  1. **System Prompt & Tools** — textarea bound to `settings.systemPrompt`, three `Switch` rows (RAG, SQL read-only, REST API) bound to `settings.tools`, "Simpan" → `PUT /api/prompt-tools`.
  2. **Guardrails & Whitelist** — read-only: short list of active SQL guardrail rules (static copy describing read-only enforcement) and the REST endpoint whitelist fetched from `GET /api/data-sources/rest-connectors` (connector name + enabled endpoint count, link to Data Sources view via `?view=integrations`).

- [ ] **Step 5: Wire shell** — in `page.tsx` add NAV entries and renderView cases:

```tsx
{ key: 'ai-config', label: 'AI Configuration', icon: Brain, desc: 'Provider, model, embedding' },
{ key: 'prompt-tools', label: 'Prompt & Tools', icon: Wrench, desc: 'System prompt dan routing' },
```

(import `Wrench` from lucide-react; place after Knowledge, before Monitoring — final order: Dashboard, Chat, Data Sources, Knowledge, AI Configuration, Prompt & Tools, Monitoring, Settings. Dashboard stays as landing summary — deliberate deviation, it hosts the spec's health overview.)

- [ ] **Step 6: Verify** — `bun test src/lib/view-routing.test.ts` PASS; `bunx tsc --noEmit && bun run lint`; manual: both new menus render, LLM settings gone from Settings, save prompt settings works.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: AI Configuration and Prompt & Tools views"`

---

### Task 10: Monitoring additions (tool runs, failed requests, token/latency)

**Files:**
- Create: `src/app/api/monitoring/route.ts`
- Modify: `src/components/views/security-view.tsx` (add tabs)

**Interfaces:**
- Consumes: existing tables `ToolRun`, `ApiRequestLog`, `RestApiRequestLog`, `AuditLog` (`GUARDRAIL_BLOCK` action).
- Produces: `GET /api/monitoring` → `{ ok: true, toolRuns: [...last 50], failedApiRequests: [...last 50 status>=400], restApiErrors: [...last 50 with errorMessage], blockedSql: [...last 50 GUARDRAIL_BLOCK audits], stats: { toolRunCount24h, avgToolLatencyMs24h, failedApiCount24h } }`.

- [ ] **Step 1: Implement route** — `src/app/api/monitoring/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

export async function GET() {
  try {
    const user = await getActiveUser()
    const companyId = user.companyId
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [toolRuns, failedApiRequests, restApiErrors, blockedSql, toolRunCount24h, latencyAgg, failedApiCount24h] =
      await Promise.all([
        db.toolRun.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        db.apiRequestLog.findMany({
          where: { status: { gte: 400 }, apiKey: { companyId } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.restApiRequestLog.findMany({
          where: { errorMessage: { not: null }, endpoint: { connector: { companyId } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.auditLog.findMany({
          where: { companyId, action: 'GUARDRAIL_BLOCK' },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.toolRun.count({ where: { companyId, createdAt: { gte: dayAgo } } }),
        db.toolRun.aggregate({
          where: { companyId, createdAt: { gte: dayAgo }, latencyMs: { not: null } },
          _avg: { latencyMs: true },
        }),
        db.apiRequestLog.count({
          where: { status: { gte: 400 }, createdAt: { gte: dayAgo }, apiKey: { companyId } },
        }),
      ])

    return NextResponse.json({
      ok: true,
      toolRuns,
      failedApiRequests,
      restApiErrors,
      blockedSql,
      stats: {
        toolRunCount24h,
        avgToolLatencyMs24h: Math.round(latencyAgg._avg.latencyMs ?? 0),
        failedApiCount24h,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat data monitoring.')
  }
}
```

Note: verify relation names (`apiKey`, `endpoint.connector`) against `prisma/schema.prisma` lines 320–410 and adjust the `where` clauses if the relation fields differ.

- [ ] **Step 2: UI** — wrap the existing `SecurityView` audit content in `Tabs` (pattern from `settings-view.tsx`): tab "Audit Log" = current content; new tabs "Tool Runs", "Failed Requests", "Blocked SQL" — each a `Table` over the corresponding `/api/monitoring` array (columns: waktu, tipe/aksi, status, latency, ringkasan/error). Add three stat cards on top from `stats`.

- [ ] **Step 3: Verify** — `curl -s http://localhost:3005/api/monitoring | head -c 400` → ok:true with arrays; manual: Monitoring view shows tabs; run one chat message to generate a ToolRun and confirm it appears. `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: monitoring API and tool-run/failure panels"`

---

### Task 11: Playwright e2e suite

**Files:**
- Create: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/mock-llm.ts`, `e2e/auth.spec.ts`, `e2e/setup-wizard.spec.ts`, `e2e/knowledge-chat.spec.ts`, `e2e/api-key.spec.ts`
- Create: `scripts/e2e-seed.ts`
- Modify: `package.json` (scripts `e2e`), `.gitignore` (`db/e2e.db`, `playwright-report`, `test-results`)

**Interfaces:**
- Consumes: everything above. Mock LLM = tiny Bun HTTP server on port 4545 answering OpenAI-compatible `/v1/models`, `/v1/chat/completions` (fixed reply), `/v1/embeddings` (zero vectors).
- Produces: `bun run e2e` runs the suite headless against a dev server on port 3105 with `DATABASE_URL=file:../db/e2e.db`, `AUTH_DEMO_FALLBACK=false`.

- [ ] **Step 1: Install** — `bun add -d @playwright/test && bunx playwright install chromium` (if system deps missing: `sudo bunx playwright install-deps chromium`).

- [ ] **Step 2: Mock LLM** — `e2e/mock-llm.ts`:

```ts
// Standalone OpenAI-compatible stub; started by global-setup.
export function startMockLlm(port = 4545) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ data: [{ id: 'mock-model' }] })
      }
      if (url.pathname.endsWith('/chat/completions')) {
        return Response.json({
          id: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Jawaban uji dari mock LLM.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }
      if (url.pathname.endsWith('/embeddings')) {
        const body = (await req.json()) as { input: string | string[] }
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        return Response.json({ data: inputs.map((_, i) => ({ index: i, embedding: new Array(64).fill(0.001) })) })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

if (import.meta.main) {
  startMockLlm()
  console.log('mock llm on :4545')
}
```

- [ ] **Step 3: E2E seed** — `scripts/e2e-seed.ts`: deletes `db/e2e.db`, runs `prisma db push` against it, applies `prisma/rag-fts.sql`, creates nothing else (the setup-wizard spec creates the admin). Implement as a shell-out script:

```ts
import { $ } from 'bun'
await $`rm -f db/e2e.db db/e2e.db-journal`
await $`env DATABASE_URL=file:../db/e2e.db bunx prisma db push --skip-generate`
await $`sqlite3 db/e2e.db < prisma/rag-fts.sql`
console.log('e2e db ready')
```

(check how `DATABASE_URL` is resolved relative to `prisma/schema.prisma` — copy the exact form used in `.env`.)

- [ ] **Step 4: Config** — `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1, // single shared sqlite db — keep specs serial
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3105', trace: 'retain-on-failure' },
  webServer: [
    {
      command:
        'env DATABASE_URL=file:../db/e2e.db AUTH_DEMO_FALLBACK=false PORT=3105 DEFAULT_LLM_BASE_URL=http://localhost:4545/v1 bun node_modules/.bin/next dev -p 3105',
      url: 'http://localhost:3105/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
```

`e2e/global-setup.ts`:

```ts
import { $ } from 'bun'
import { startMockLlm } from './mock-llm'

export default async function globalSetup() {
  await $`bun run scripts/e2e-seed.ts`
  const server = startMockLlm(4545)
  return async () => { server.stop(true) }
}
```

Check whether the chat UI needs the socket.io mini-service (`mini-services/chat-service`); if `use-chat-socket.ts` falls back to REST when the socket is down, skip it — otherwise add a second `webServer` entry running `bun mini-services/chat-service/index.ts` with its port env.

- [ ] **Step 5: Specs.** Ordered by filename (serial). `e2e/setup-wizard.spec.ts` runs first (fresh DB → wizard):

```ts
import { test, expect } from '@playwright/test'

test('first run: setup wizard creates admin and completes', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Setup Awal')).toBeVisible()
  await page.getByLabel('Nama').fill('Admin E2E')
  await page.getByLabel('Email').fill('admin@e2e.test')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: /lanjut|simpan/i }).click()
  // LLM step — point at mock
  await page.getByLabel(/base url/i).fill('http://localhost:4545/v1')
  await page.getByLabel(/api key/i).fill('mock-key')
  await page.getByLabel(/^model/i).fill('mock-model')
  await page.getByRole('button', { name: /simpan|lanjut/i }).click()
  // remaining steps: skip / next until finish
  for (const label of [/lanjut|tes|lewati/i, /lewati/i, /lewati/i]) {
    await page.getByRole('button', { name: label }).first().click()
  }
  await page.getByRole('button', { name: /selesai/i }).click()
  await expect(page.getByText('Dashboard')).toBeVisible()
})
```

`e2e/auth.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

test('rejects wrong password, accepts correct, logs out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Masuk sebagai Admin')).toBeVisible()
  await page.getByLabel('Email').fill('admin@e2e.test')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Masuk' }).click()
  await expect(page.getByRole('alert')).toContainText('salah')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Masuk' }).click()
  await expect(page.getByText('Dashboard')).toBeVisible()
  await page.getByRole('button', { name: 'Keluar' }).click()
  await expect(page.getByText('Masuk sebagai Admin')).toBeVisible()
})
```

`e2e/knowledge-chat.spec.ts`: login helper (POST `/api/auth/login` via `page.request`, then `page.goto('/')`); go to `?view=knowledge`, upload a small TXT fixture (`page.setInputFiles`) containing a distinctive fact ("Kode gudang utama adalah GDG-77."); wait for indexed status; go to `?view=chat`, ask "Apa kode gudang utama?", assert the reply area eventually shows a citation element (whatever the citation chip renders — locate in `chat-view.tsx` and use its text/testid).

`e2e/api-key.spec.ts`: login via API; create API key via UI (Settings → API Keys) or via `page.request.post('/api/settings/api-keys', …)`; then `page.request.post('/api/v1/chat/completions', { headers: { Authorization: 'Bearer <key>' }, data: { model: 'mock-model', messages: [{ role: 'user', content: 'halo' }] } })` → expect 200 and `choices[0].message.content` non-empty; request without key → 401.

- [ ] **Step 6: package.json script** — `"e2e": "playwright test"`. Add ignores to `.gitignore`.

- [ ] **Step 7: Run** — `bun run e2e` → all specs pass. Iterate on selectors (this step legitimately takes several rounds; keep selectors role/label-based, add `data-testid` to app components where labels are ambiguous).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "test: playwright e2e suite (setup, auth, knowledge chat, external api)"`

---

### Task 12: Production readiness verification

**Files:**
- Modify: `.env` (`AUTH_DEMO_FALLBACK=false`)
- Modify: `docs/superpowers/progress/` — append a progress file `2026-07-02-production-final-phase.md`

- [ ] **Step 1: Flip the flag** — set `AUTH_DEMO_FALLBACK=false` in `.env`. Restart dev server; confirm login screen appears and all views work after login; confirm `curl -s http://localhost:3005/api/documents` → 401 without cookie.
- [ ] **Step 2: Production build** — `bun run build` → succeeds. `bun run start` (standalone) → `GET /api/v1/health` 200, login works, one chat round-trip works. Stop it and restart dev.
- [ ] **Step 3: Full verification** — `bunx tsc --noEmit && bun run lint && bun test --pass-with-no-tests && bun run e2e` → all green. Record outputs in the progress file (worklog.md entry too, matching its existing format).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "chore: production hardening — demo fallback off, verified build + e2e"`

---

## Self-Review Notes

- Spec coverage: Phase A → Tasks 1–5; Phase B → Tasks 6–7; Phase C → Tasks 8–10; Phase D → Task 11; fail-closed/production checks → Task 12. Dashboard retained as landing (documented deviation, Task 9 Step 5).
- Type consistency: cookie name `x-active-user` everywhere; `ViewKey` additions `'ai-config' | 'prompt-tools'`; `PromptSettings` shape identical in Tasks 8–9.
- Known verify-before-code points are marked inline (Company required fields Task 6, relation names Task 10, socket fallback Task 11 Step 4, DATABASE_URL relative form Task 11 Step 3).
