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
5. **lib → External APIs** — SSRF blocklist (RFC1918, link-local, CGNAT, ULA, cloud metadata) on all outbound URLs + DNS-rebinding protection via `dns.lookup` (`isBlockedHostAsync`).

## Assets

| Asset | Location | Protection |
|-------|----------|------------|
| Encrypted credentials (DB passwords, API keys) | Postgres `Integration.encryptedConfig` | AES-256-GCM at rest, fail-closed key |
| User data (chat history, sessions) | Postgres `ChatSession`, `ChatMessage` | Session auth, org-scoped isolation (`organizationId` + Prisma tenant extension) |
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
| **Info disclosure** | SSRF via URL params / REST connector / MCP / plugin | Mitigated | SSRF blocklist + DNS-rebinding check (`isBlockedHostAsync`) at both registration and execution time on all outbound URLs (REST, plugin, MCP, webhook, LLM config) |
| **Info disclosure** | Cross-tenant data leak | Mitigated | Multi-tenant org isolation — `organizationId` on every model, auto-injected by the Prisma tenant extension (`src/lib/prisma-tenant.ts`); `tenant-route-guard.test.ts` statically enforces org-context entry per route |
| **Info disclosure** | Prompt injection (data exfiltration) | Partially mitigated | Fail-closed auth limits blast radius; alignment check wired into agentic loops but off by default (`ALIGNMENT_CHECK=true`); LLM output not executed as code |
| **Info disclosure** | Error messages leak internals | Mitigated | Typed error responses (`{code, message}`) — no stack traces in API responses |
| **Tampering** | SQL injection via KG relation insert | Mitigated | Parameterized `$executeRaw` per relation (was raw string interpolation) |
| **Spoofing** | External API endpoints bypassed by middleware | Mitigated | `/api/v1/chat/completions`, `/api/v1/agent/run`, `/api/webhooks/incoming` in `PUBLIC_API_PATHS` (do their own Bearer/HMAC auth) |
| **DoS** | Brute-force login / API abuse | Mitigated | Rate limiting (per-route, POST/PUT/DELETE/PATCH); API key rate limits (per-minute + daily) |
| **DoS** | Unbounded SQL query | Mitigated | LIMIT 100 cap via AST guardrails; per-integration concurrency limiter (3 concurrent) |
| **DoS** | LLM cost amplification | Partially mitigated | Agentic loop max 3 iterations + per-run token budget (`AGENTIC_TOKEN_BUDGET`, default 50000); no per-org daily cost ceiling |
| **Elevation of privilege** | Demo fallback in prod | Mitigated | `AUTH_DEMO_FALLBACK=false` default (ADR 0003) |
| **Elevation of privilege** | RBAC bypass | Mitigated | Role field on User (`admin`/`analyst`/`viewer`); SSO subject linkage for OIDC |

## Open Items

1. **Prompt injection (partial):** LLM-generated content is displayed to users but not sandboxed from indirect injection in retrieved documents. Alignment check (`src/lib/alignment-check.ts`) IS wired into both agentic loops (`src/lib/tool-router-agentic.ts`) behind `ALIGNMENT_CHECK=true` / `ALIGNMENT_CHECK_URL`, but it is off by default, so the protection is opt-in.
2. **Token budget (opt-in default):** `createTokenBudget` is wired into both agentic loops (`src/lib/tool-router-agentic.ts` — `budget.track()` + `budget.isExhausted()` per iteration); the default cap is `AGENTIC_TOKEN_BUDGET` (50000) and is enforced, but it is a per-run guard, not a per-org/daily cost ceiling.
3. **Rate limiting not distributed:** In-memory rate limiting per instance. Redis `rateLimit()` exists but not wired into middleware. Multi-instance deployments get N× the limit.
4. **No per-tool rate limiting:** SQL/REST/Plugin executions are not individually rate limited — only the HTTP endpoint is limited.
5. **Key derivation not a KDF:** Non-hex `ENCRYPTION_SECRET_KEY` uses raw SHA-256, not scrypt/argon2. Enforce 64-char hex key for production.
6. **Audit log not tamper-proof:** `AuditLog` is a regular Postgres table — any DB admin can modify rows. No hash chain or append-only constraint.
7. **OTel spans not used in production code paths:** `initOtel()` is now called, but `withSpan`/`getTracer` are not used in any production lib (ai.ts, tool-router.ts, rag.ts, etc.). Only the SDK is initialized.
8. **In-memory inactivity tracker:** Per-instance, not distributed. Multi-instance deployments need Redis-backed tracker.
9. **No PKCE in OIDC flow:** SSO uses authorization code flow without `code_challenge`/`code_verifier`.

## Security Feature Reference

- SQL AST guardrails: `src/lib/guardrails.ts`
- AES-256-GCM crypto: `src/lib/crypto.ts`
- Session + fail-closed auth: `src/lib/session.ts`
- SSRF blocklist + DNS-rebinding: `src/lib/llm-config.ts` (`isBlockedHost` + `isBlockedHostAsync`)
- Rate limiting: `src/lib/redis.ts` (in-memory limiter in `src/middleware.ts`)
- API key management: `src/lib/api-keys.ts`
- Env schema validation: `src/lib/env-schema.ts`
- Webhook HMAC: `src/lib/incoming-webhook.ts`
- SSO/OIDC: `src/lib/sso.ts`
- MCP client hardening: `src/lib/mcp-client.ts` (timeouts, LRU, DNS-rebinding, encrypted headers)
- Circuit breaker: `src/lib/smart-router.ts` (half-open recovery)
