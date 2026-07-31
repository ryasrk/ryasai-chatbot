# SSO Polish (OIDC) + SAML 2.0 — Design Spec

> Created 2026-07-31. Status: approved. Implementation: loop mode.

---

## 1. Goal

Polish the existing OIDC SSO implementation (add PKCE, tests, docs, UI) and add
SAML 2.0 as a second SSO protocol for enterprises that only have AD FS, Shibboleth,
or other SAML-only IdPs. Both protocols share the existing session infrastructure
(`signSession` + `x-active-user` cookie + `sessionVersion` + `getOrCreateSsoUser`).

## 2. Context

### Existing state
- `src/lib/sso.ts` (293 lines) — full OIDC: discovery, auth URL, code exchange,
  HS256+RS256 JWT verify, JWKS cache, userinfo, get-or-create user.
- `src/app/api/auth/sso/{login,callback,status}/route.ts` — 3 route handlers.
- `prisma/schema.prisma:27` — `User.ssoSubject` field (links OIDC sub claim).
- `src/middleware.ts:19-21` — SSO routes in `PUBLIC_API_PATHS`.
- `src/components/views/login-view.tsx:113` — "Sign in with SSO" button (shows when `ssoConfigured`).

### Gaps in existing OIDC
1. **No PKCE** — `buildAuthUrl()` sends `response_type=code` without `code_challenge`.
   Authorization code interception risk. (Noted in session memory.)
2. **No tests** — `src/lib/sso.test.ts` does not exist.
3. **No docs** — no setup guide for admins.
4. **Status endpoint** returns `{ configured: bool }` — cannot distinguish OIDC vs SAML.

### SAML 2.0 — not implemented
SAML is XML-based (not JSON like OIDC). Requires XML canonicalization (C14N) +
XML signature verification. Hand-rolling is a security risk. Using
`@node-saml/node-saml` (maintained fork of `passport-saml`).

## 3. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SAML library | `@node-saml/node-saml` | Battle-tested XML crypto. Security-critical at trust boundary — ponytail exception: never simplify away security. |
| SAML flow | SP-initiated + IdP-initiated | SP-initiated is primary. IdP-initiated comes for free (callback accepts unsolicited responses). |
| Role mapping | None — all SSO users get `admin` | Matches existing single-admin design. Admin can manually change role after first login. |
| Login UI | Password + SSO button(s) | Show "Sign in with SSO" when OIDC configured, "Sign in with SAML" when SAML configured. Both stacked if both configured. |
| Replay protection | Redis SET NX with 5min TTL | Defense-in-depth. Graceful degradation if Redis unavailable (log warning, skip check). Signature validation is primary barrier. |
| User linking | By `ssoSubject`, then email, else create | Same pattern as existing OIDC. No auto-linking across protocols by email (spoofing risk). |
| Schema changes | None | Existing `User.ssoSubject` stores both OIDC sub and SAML NameID. |

## 4. Architecture

```
Login page (/login)
  ├─ Password form (existing, unchanged)
  ├─ "Sign in with SSO" button (if OIDC configured)  → /api/auth/sso/login
  └─ "Sign in with SAML" button (if SAML configured)  → /api/auth/saml/login

OIDC path (existing, polished):
  /api/auth/sso/login    → redirect to IdP auth endpoint (+ PKCE code_challenge)
  /api/auth/sso/callback → exchange code (+ code_verifier), verify id_token, set session
  /api/auth/sso/status   → { ok, oidc, saml, configured }

SAML path (new):
  /api/auth/saml/login     → generate AuthnRequest, redirect to IdP
  /api/auth/saml/callback  → POST, validate SAML response + assertion, set session
  /api/auth/saml/metadata  → SP metadata XML (admin gives this URL to IdP admin)
```

Both paths end at `getOrCreateSsoUser()` → `signSession()` → set `x-active-user` cookie
→ redirect to `/`. Session validation in `getActiveUser()` is unchanged.

## 5. OIDC Polish

### 5a. PKCE

Add to `src/lib/sso.ts`:

- `generateCodeVerifier()` — 43-128 char cryptographically random string (RFC 7636).
  Use `crypto.randomBytes(32).toString('base64url')` (43 chars, within range).
- `codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url')`.
- Store `code_verifier` in a short-lived cookie `sso_code_verifier` (10min, httpOnly, sameSite lax).
- `buildAuthUrl()` — add `code_challenge` + `code_challenge_method=S256` to auth URL params.
- `exchangeCode()` — add `code_verifier` to token exchange body.
- `sso/login/route.ts` — generate verifier, set cookie, pass challenge to `buildAuthUrl`.
- `sso/callback/route.ts` — read `sso_code_verifier` cookie, pass to `exchangeCode`, delete cookie.

### 5b. Tests (`src/lib/sso.test.ts`)

| Test group | Cases |
|-----------|-------|
| `isOidcConfigured()` | true when all env set, false when any missing |
| `buildAuthUrl()` | correct URL, params include `code_challenge` + `S256` |
| `decodeIdToken()` | valid JWT parsed, invalid format throws |
| `verifyIdToken()` HS256 | valid signature passes, wrong secret fails, expired throws, wrong iss/aud/nonce throws |
| `verifyIdTokenRs256()` | valid RS256 passes, wrong kid throws, JWKS fetch + cache works |
| `exchangeCode()` | correct token endpoint call, includes `code_verifier`, missing id_token throws |
| `getOrCreateSsoUser()` | existing by sub → updates sessionVersion, existing by email → links ssoSubject, new user → creates with `passwordHash: '!'`, missing sub throws |
| `generateStateNonce()` + `generateCodeVerifier()` | returns non-empty strings, different each call |

Mock `fetch` (OIDC discovery + JWKS + userinfo) and `db` (prisma). No real network/DB.

### 5c. Status + UI + docs

- Expand `/api/auth/sso/status` to `{ ok, oidc, saml, configured: oidc || saml }`.
  `configured` kept for backward compat.
- `login-view.tsx` — fetch new status, show SSO button when `oidc`, SAML button when `saml`.
- Add OIDC env vars to README config table.
- Write `docs/sso-setup.md` OIDC section (Keycloak, Azure AD, Auth0, Google).

## 6. SAML 2.0 Implementation

### 6a. Library + env vars

Dependency: `@node-saml/node-saml` (core SAML, no passport needed).

Env vars (all prefixed `SAML_*`):

| Variable | Required | Description |
|----------|----------|-------------|
| `SAML_IDP_ENTRY_POINT` | Yes* | IdP SSO URL (where we redirect for login) |
| `SAML_IDP_CERT` | Yes* | IdP public cert (PEM) for verifying signatures |
| `SAML_SP_ENTITY_ID` | Yes | Our entity ID (e.g. `https://chatbot.company.com`) |
| `SAML_SP_CALLBACK_URL` | Yes | Our ACS URL (e.g. `https://chatbot.company.com/api/auth/saml/callback`) |
| `SAML_IDP_METADATA_URL` | No | If set, auto-discover entryPoint + cert from IdP metadata |
| `SAML_SP_CERT` | No | Our cert for signing AuthnRequests (if IdP requires signed requests) |
| `SAML_SP_PRIVATE_KEY` | No | Our private key for signing |

*If `SAML_IDP_METADATA_URL` is set, entryPoint + cert are auto-discovered — manual vars optional.

### 6b. New files

| File | Purpose |
|------|---------|
| `src/lib/sso-saml.ts` | SAML config, AuthnRequest, response validation, metadata, get-or-create user |
| `src/lib/sso-saml.test.ts` | Unit tests |
| `src/app/api/auth/saml/login/route.ts` | GET → generate AuthnRequest, redirect to IdP |
| `src/app/api/auth/saml/callback/route.ts` | POST → validate response, set session, redirect |
| `src/app/api/auth/saml/metadata/route.ts` | GET → SP metadata XML |

### 6c. SAML flow (SP-initiated)

```
User clicks "Sign in with SAML"
  │
  ▼
GET /api/auth/saml/login
  → generate AuthnRequest XML (signed if SAML_SP_CERT configured)
  → 302 redirect to SAML_IDP_ENTRY_POINT with SAMLRequest param (base64-deflated XML)
  │
  ▼
User authenticates at IdP
  │
  ▼
IdP POSTs SAMLResponse to /api/auth/saml/callback
  → validate response signature (IdP cert)
  → validate assertion signature
  → validate conditions: notBefore, notOnOrAfter, audience, recipient
  → replay protection: check assertion ID in Redis (5min TTL)
  → extract NameID → ssoSubject
  → extract email + name attributes (URI + OID format)
  → getOrCreateSsoUser() → signSession() → set cookie → redirect to /
```

IdP-initiated login: same callback accepts unsolicited POSTs. Same validation path.

### 6d. Attribute extraction

SAML attributes vary by IdP. Check both URI and OID formats:
- Email: `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` OR `urn:oid:0.9.2342.19200300.100.1.3`
- Name: `http://schemas.xmlprolog.org/ws/2005/05/identity/claims/name` OR `urn:oid:2.5.4.3` (CN) OR `urn:oid:2.5.4.42` (GN)
- Fallback: NameID value if no email attribute

### 6e. Security checks

- Response signature verified against IdP cert
- Assertion signature verified
- Time window: `notBefore` / `notOnOrAfter` checked (reject if outside ±clock skew, default 60s)
- Audience restriction: must match `SAML_SP_ENTITY_ID`
- Recipient: must match `SAML_SP_CALLBACK_URL`
- Replay protection: `isAssertionReplayed(assertionId)` via Redis SET NX with 5min TTL

### 6f. Replay protection (Redis)

Add to `src/lib/redis.ts`:

```typescript
export async function isAssertionReplayed(assertionId: string): Promise<boolean> {
  const key = `saml:assertion:${assertionId}`
  const set = await redis.set(key, '1', 'PX', 300_000, 'NX')
  return !set
}
```

Graceful degradation: if Redis unavailable, skip replay check + log warning. Signature
validation is the primary security barrier; replay protection is defense-in-depth.

## 7. Middleware + Schema

### 7a. Middleware

Add to `PUBLIC_API_PATHS` in `src/middleware.ts`:
- `/api/auth/saml/login`
- `/api/auth/saml/callback`
- `/api/auth/saml/metadata`

### 7b. Prisma schema

No changes. Existing `User.ssoSubject` stores both OIDC sub and SAML NameID.

## 8. Login UI

- `/api/auth/sso/status` → `{ ok, oidc, saml, configured: oidc || saml }`
- `login-view.tsx`:
  - Show "Sign in with SSO" when `oidc` is true → `/api/auth/sso/login`
  - Show "Sign in with SAML" when `saml` is true → `/api/auth/saml/login`
  - Both stacked if both configured (SSO first, SAML second)
  - Neither if neither configured (password-only, current behavior)
- Same outline button style as existing SSO button.

## 9. Testing

### 9a. OIDC tests (`src/lib/sso.test.ts`)

See section 5b. 8 test groups, all mocked (no real network/DB).

### 9b. SAML tests (`src/lib/sso-saml.test.ts`)

| Test group | Cases |
|-----------|-------|
| `isSamlConfigured()` | true when env vars set, false when missing |
| `buildSamlConfig()` | correct config object, metadata URL auto-discovery |
| `generateSpMetadata()` | valid XML, correct entityID, correct ACS URL, includes signing cert when configured |
| `validateSamlResponse()` | valid → extracts NameID + email + name, bad signature → throws, expired → throws, wrong audience → throws, replayed → throws |
| `getOrCreateSsoUser()` | existing by sub, existing by email, new user, missing sub throws |

Mock `@node-saml/node-saml` + `db`. No real IdP.

### 9c. E2E (`e2e/sso.spec.ts`)

1. No SSO env vars → no SSO buttons on login page
2. OIDC env vars set → "Sign in with SSO" button appears
3. SAML env vars set → "Sign in with SAML" button appears
4. Both set → both buttons appear

Mock env vars via test setup. No real IdP.

## 10. Documentation

### 10a. `docs/sso-setup.md` (new)

**OIDC section:**
- Overview + when to use
- Env vars table
- Provider setup: Keycloak, Azure AD/Entra ID, Auth0, Google Workspace
- Testing instructions

**SAML section:**
- Overview + when to use (legacy IdPs, AD FS, Shibboleth)
- Env vars table
- SP setup steps (get metadata URL → give to IdP admin → set env vars → restart)
- Provider notes: AD FS, Shibboleth, Okta SAML
- Troubleshooting: signature errors, clock skew, attribute mapping

### 10b. README + `.env.example`

Add all OIDC + SAML env vars to config table and `.env.example`.

## 11. Implementation Order

**Phase 1 — OIDC Polish (1-2 days)**
1. Add PKCE to `sso.ts`
2. Write `src/lib/sso.test.ts`
3. Expand `/api/auth/sso/status` response
4. Update `login-view.tsx`
5. Add OIDC env vars to README + `.env.example`
6. Write `docs/sso-setup.md` OIDC section
7. Verify: lint, tsc, test, build

**Phase 2 — SAML 2.0 (3-4 days)**
8. `bun add @node-saml/node-saml`
9. Write `src/lib/sso-saml.ts`
10. Write `src/lib/sso-saml.test.ts`
11. Add 3 SAML routes
12. Add SAML routes to middleware `PUBLIC_API_PATHS`
13. Add `isAssertionReplayed()` to `redis.ts`
14. Expand `/api/auth/sso/status` to return real `saml` value
15. Update `login-view.tsx` for SAML button
16. Add SAML env vars to README + `.env.example`
17. Write SAML section of `docs/sso-setup.md`
18. Add `e2e/sso.spec.ts`
19. Verify: lint, tsc, test, build, e2e

**Total: 4-6 days, ~12 new/modified files, 1 new dependency**
