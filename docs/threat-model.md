# Threat Model

## System Boundary

```
┌─────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY                         │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐             │
│  │ Next.js   │  │ Postgres │  │  Redis    │             │
│  │ App + API │──│  + pgvec │  │ (rate     │             │
│  │ + lib/    │  │  + pgtrgm│  │  limit)   │             │
│  └─────┬─────┘  └──────────┘  └───────────┘             │
│        │                                                 │
│  ┌─────┴─────┐  ┌──────────┐  ┌───────────┐             │
│  │Scheduler  │  │ Cognee   │  │  Mini-    │             │
│  │(cron)     │  │ Memory   │  │  services │             │
│  └───────────┘  └──────────┘  └───────────┘             │
└───────────────────────┬─────────────────────────────────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │ LLM APIs │ │   IdP    │ │ Webhooks │
     │ (OpenAI, │ │ (OIDC    │ │ (in/out) │
     │  Anthr.) │ │  SSO)    │ │          │
     └──────────┘ └──────────┘ └──────────┘
        EXTERNAL (untrusted)
```

## Trust Boundaries

1. **User → Edge middleware** — unauthenticated traffic filtered here (cookie validation, rate limiting).
2. **Middleware → API route** — session verified, `getActiveUser()` enforces active + session version.
3. **API route → lib/** — server-only, no direct user input; inputs validated via Zod.
4. **lib → Database** — Prisma parameterized queries (no raw SQL injection). AST guardrails on generated SQL.
5. **lib → External APIs** — SSRF blocklist (RFC1918, link-local, CGNAT, ULA) on all outbound URLs.

## Assets

| Asset | Location | Protection |
|-------|----------|------------|
| Encrypted credentials (DB passwords, API keys) | Postgres `Integration.encryptedConfig` | AES-256-GCM at rest, fail-closed key |
| User data (chat history, sessions) | Postgres `ChatSession`, `ChatMessage` | Session auth, single-tenant isolation |
| LLM API keys | Postgres `LlmConfig.encryptedApiKey` | AES-256-GCM at rest |
| Audit logs | Postgres `AuditLog` | Append-only, fail-closed on critical writes |
| Session tokens | Cookie `x-active-user` | HMAC-signed, sessionVersion anti-fixation |
| Encryption key | Env `ENCRYPTION_SECRET_KEY` | Not in DB, not in code, not logged |

## STRIDE Analysis

| Threat (STRIDE) | Vector | Status | Mitigation |
|----------------|--------|--------|------------|
| **Spoofing** | Attacker fakes session cookie | Mitigated | HMAC-signed token + `sessionVersion` check; fail-closed auth (ADR 0003) |
| **Spoofing** | Stolen cookie replay | Mitigated | 30min inactivity timeout; re-login increments sessionVersion, invalidating old cookies |
| **Spoofing** | Incoming webhook impersonation | Mitigated | HMAC-SHA256 signature verification with `timingSafeEqual` (fail-closed) |
| **Tampering** | SQL injection via natural language | Mitigated | AST-level guardrails (ADR 0002) — SELECT only, LIMIT cap, mutation block |
| **Tampering** | SQL injection via Prisma | Mitigated | Parameterized queries throughout; `nosemgrep` annotations only on safe `findFirst({where:{id}})` |
| **Tampering** | Credential tampering in DB | Mitigated | AES-256-GCM auth tag detects tampering (ADR 0005) |
| **Repudiation** | User denies action | Mitigated | Audit log (fail-closed on critical severity) records all sensitive actions with userId + IP |
| **Info disclosure** | SSRF via URL params / REST connector | Mitigated | SSRF blocklist (RFC1918, 169.254.x.x, CGNAT, ULA) on all outbound requests |
| **Info disclosure** | Cross-tenant data leak | Mitigated | Single-tenant architecture (ADR 0001) — no `companyId`, no shared data |
| **Info disclosure** | Prompt injection (data exfiltration) | Partialially mitigated | Fail-closed auth limits blast radius; alignment check interface available for agentic; LLM output not executed as code |
| **Info disclosure** | Error messages leak internals | Mitigated | Typed error responses (`{code, message}`) — no stack traces in API responses |
| **DoS** | Brute-force login / API abuse | Mitigated | Rate limiting (per-route, POST/PUT/DELETE/PATCH); API key rate limits (per-minute + daily) |
| **DoS** | Unbounded SQL query | Mitigated | LIMIT 100 cap via AST guardrails; per-integration concurrency limiter (3 concurrent) |
| **DoS** | LLM cost amplification | Partialially mitigated | Agentic loop max 3 iterations; token budget interface exists but not fully wired |
| **Elevation of privilege** | Demo fallback in prod | Mitigated | `AUTH_DEMO_FALLBACK=false` default (ADR 0003) |
| **Elevation of privilege** | RBAC bypass | Mitigated | Role field on User (`admin`/`analyst`/`viewer`); SSO subject linkage for OIDC |

## Open Items

1. **Prompt injection (partial):** LLM-generated content is displayed to users but not sandboxed from indirect injection in retrieved documents. Alignment check interface (`src/lib/alignment-check.ts`) is available but not wired into the streaming agentic loop.
2. **Token budget (partial):** `createTokenBudget` exists but is not populated by actual token usage from `logLlmUsage`. Cost-based DoS limiting is incomplete.
3. **Strict TS flags:** `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` not enabled (1005 errors baseline). Type-safety gaps could mask null-deref bugs.

## Security Feature Reference

- SQL AST guardrails: `src/lib/guardrails.ts`
- AES-256-GCM crypto: `src/lib/crypto.ts`
- Session + fail-closed auth: `src/lib/session.ts`
- SSRF blocklist: `src/lib/` (REST connector URL validation)
- Rate limiting: `src/lib/rate-limit.ts`, `src/lib/redis.ts`
- API key management: `src/lib/api-keys.ts`
- Env schema validation: `src/lib/env-schema.ts`
- Webhook HMAC: `src/lib/incoming-webhook.ts`
- RBAC: `src/lib/rbac.ts`
- SSO/OIDC: `src/lib/sso.ts`
