# AGENTS.md — ryasai Chatbot

## Project

Multi-tenant AI assistant deployed ON-PREM per customer (NL → SQL, RAG, REST, streaming chat), licensed with a signed machine-bound key. Stack: Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 5 · Prisma 6 · PostgreSQL 16 (pgvector + pg_trgm) · Bun · Tailwind 4 · shadcn/ui. Proprietary.

> `CLAUDE.md` is a large living log (1000+ lines) of session history — trust it for *why* decisions were made, but verify current state against the code. An earlier "single-tenant refactor" mentioned in its progress log was reverted; the codebase is multi-tenant. `docs/adr/0001-single-tenant-architecture.md` and the helm chart description are likewise stale — the code (org-scoped models, tenant extension) is the source of truth.

## ⛔ Non-negotiable invariants (read before touching these areas)

`src/lib/invariants.test.ts` statically enforces the rules below, and CI runs
it on every push. These encode real production incidents — including incidents
introduced by AI-assisted changes. **If a guard fails your change, do not
delete or weaken the guard**; read the comment block above the failing
assertion (it documents the outage) and restructure your change.

1. **One boot file**: `src/instrumentation.ts` is the ONLY instrumentation
   file, and it MUST call `startJobWorker()`. Never create a root
   `instrumentation.ts` — Next.js resolves it FIRST and silently shadows
   `src/`, which once left the BullMQ worker dead for 16+ hours while 40
   document jobs piled up unprocessed (docs uploaded but never embedded →
   "chatbot doesn't know my documents").
2. **cognee searchTypes**: only names that exist in the PINNED SERVER's enum.
   The authority is the cognee **v1.6.0 server's OpenAPI schema**, captured into
   `src/lib/__fixtures__/cognee-search-types.json` by
   `scripts/refresh-cognee-search-types.ts` (CI runs no cognee sidecar, so the
   snapshot is what the guard reads). `GRAPH_ENTITIES`/`GRAPH_RELATIONSHIPS` came
   from *Python* cognee docs and were never valid; the move to the server's enum
   immediately caught a mirrored `FEEDBACK` that does not exist server-side. Fix a
   renamed literal by refreshing the fixture and syncing `COGNEE_SEARCH_TYPES` —
   never by deleting the guard.
3. **DB drivers load through the static `DRIVER_LOADERS` map** in
   `real-connectors.ts` — `async () => import('pg')` literals, never
   `await import(variable)`. A variable specifier is invisible to Turbopack
   (breaks dev) and to output tracing (drivers silently vanish from the
   standalone Docker image → "driver not installed" in production only).
   Adding a driver = one map entry + `serverExternalPackages` +
   `outputFileTracingIncludes` in `next.config.ts` (all three, guarded).
4. **PDF/DOCX/XLSX extraction must stay lossless-or-empty**: `document-parsers.ts`
   never "falls back" to dumping printable ASCII from raw bytes — that noise
   gets chunked, embedded, and served as knowledge. Image-only PDFs return `''`
   so the doc is marked a placeholder. Behavioral tests live in
   `document-parsers.test.ts` (FlateDecode, `<hex>` strings, multi-stream
   `endstream` resumption, noise-free empty) — extend them when touching the
   parser.

**A guard must be NEGATIVE-CONTROLLED before you trust it.** Plant the violation, confirm the
guard fails, restore byte-identical, confirm it passes. This is not ceremony: on 2026-09-25 the
invariant #1 guard was found to assert only `expect(src).toContain('startJobWorker')`, so
deliberately deleting the CALL left the suite at **49 pass, 0 fail** — the identifier survived in
the `await import('@/lib/job-processor')` destructure one line above. A comment satisfied it too.
It would not have caught a re-introduction of the very incident it documents. It now strips
comments and requires an invocation.

Audit of three guards, negative-controlled, with both directions observed:

| guard | violation planted | result |
|---|---|---|
| #1 boot file | call deleted / call replaced by a comment | 48 pass, **1 fail** after the fix (was 0 fail) |
| #2 cognee searchTypes | fake type appended to the fixture | 48 pass, **1 fail** |
| SQL deny-list single-source | 4 `assertNoDangerousFunctions(sql)` calls renamed | 48 pass, **1 fail** |

The SQL guard was already written against the INVOCATION (`calls.length >= 4`), which is why it
held. **Prefer matching an invocation, a call count, or behaviour over a bare identifier** — a
string match on a name is satisfied by an import, a comment, or an unrelated mention.

**Verification ritual after touching any of the above**: `bun test src/lib/invariants.test.ts`
plus the area's own test file. For ingestion changes, upload a REAL PDF
(`test-data/coates.2025.book.1996.pdf`, 2.7MB) through `POST /api/documents`
and confirm: chunkCount > 100, embeddings written (`DocumentChunk.embeddingJson`
non-null), `Document.cognifyStatus = 'completed'`, then ask the chatbot a
question only the document can answer and check for citations.

## Commands

```bash
bun install              # deps (uses bun.lock)
bun run dev              # dev server on $PORT (default 3000), sources ./.env
bun run build            # standalone build → .next/standalone
bun run start            # prod standalone server (Bun runtime)
bun run lint             # eslint (0 errors expected; warnings are pre-existing)
bunx tsc --noEmit        # typecheck (0 errors expected)
bun run test             # unit tests — custom per-file runner (see below)
bun run test:integration # integration tests (need live Postgres / network)
bun run e2e              # Playwright, DEV server (8 specs / 12 tests — Postgres e2e DB, mock LLM + mock license validator)
bun run build && bun run e2e:prod
                         # same specs against the PRODUCTION standalone build (see below)
bun run rag-eval         # RAGAS RAG quality eval (LLM-as-judge)
bun run sql-eval         # Text-to-SQL eval — needs EVAL_ORG_ID + --integration <id>
bash start.sh            # Next.js + scheduler worker (seeds empty DB if empty)
e2e prerequisites: Postgres DB `ryasai_e2e` (created once: sudo -u postgres createdb -O ryasai ryasai_e2e && CREATE EXTENSION vector) + `bunx playwright install chromium`
bash reset.sh            # DROP SCHEMA → recreate → prisma db push → seed (empty)
bun run prepare          # install pre-commit hook (.git/hooks/pre-commit)
```

### Testing quirks (important)

- `bun run test` runs `scripts/test.ts`, NOT `bun test src/`. Bun's `mock.module` leaks state across test files in a single process, so each `*.test.ts` gets its own `bun test` subprocess (8-way parallel). Do not switch to `bun test src/` — it will fail with stale-mock errors.
  - **MEASURED 2026-09-30, so nobody re-opens this as a code defect.** A named PAIR that leaks is
    `bun test src/lib/tool-branches.test.ts src/lib/stream-preparers.test.ts` → **106 pass / 4 fail**,
    while each file ALONE is green (`tool-branches` 58/0, `stream-preparers` 52/0) and `bun run test`
    is green as a whole. The four are one RAG-parity test, two SQL repair-loop tests and one guardrail
    test — all of them assert on a `mock.module` the OTHER file registered first (the partial mock
    wins and its missing exports are what fails, not the assertions). This is a harness property of
    running two suites in one Bun process, not a defect in either file, and CI cannot reach it:
    `scripts/test.ts` spawns `Bun.spawn(['bun','test',path], …)` once PER FILE. Fixing it would mean
    making each file's mocks complete against consumers it does not own — more coupling, not less.

- Run a single test file: `bun test src/lib/guardrails.test.ts`
- Tests inject a fallback `ENCRYPTION_SECRET_KEY` if unset, so they run on a fresh checkout without `.env`.
- Integration tests (`*.integration.test.ts` + `connector-dummy.test.ts`) need a live Postgres (some require seeded demo content — run via `bun run test:integration`).
- `src/lib/cognee.e2e.test.ts` is skipped unless `RUN_COGNEE_E2E=true` (needs a live cognee backend).
- **Run both e2e modes before shipping.** `bun run e2e` uses `next dev`; `bun run e2e:prod`
  (`playwright.prod.config.ts`) runs the same specs against `.next/standalone/server.js`
  with `NODE_ENV=production`. Dev and the shipped artifact diverge in ways that are
  invisible in dev and fatal in production: minified client code, prerendered server
  components, real security headers, and `outputFileTracing` deciding which packages
  exist at runtime (a missing DB driver only fails here). Every blocker found in the
  2026-09 audit surfaced by changing the environment, never by re-reading code. CI runs
  both. The prod config sets `E2E_TEST_MODE=true` so the localhost mock LLM is reachable
  — `instrumentation.ts` fails closed if that marker ever appears on a deployment, and
  `invariants.test.ts` asserts no production manifest ships it.
- e2e mock stack: `e2e/global-setup.ts` seeds the e2e DB, starts a mock License-Validator on `:4546` (Ed25519 test keypair from `e2e-keys.ts` → `LICENSE_SIGNING_PUBLIC_KEY`) and a mock LLM on `:4545`; the app runs on `:3105` with `E2E_DATABASE_URL`. Playwright `workers: 1` (shared DB).
- `src/lib/tenant-route-guard.test.ts` statically enforces org-context entry on every route — if it fails for a new route, add `enterWithOrg((await getActiveUser()).organizationId)` (or `bypassOrg` if genuinely cross-org).
- `scripts/test.ts` discovers the current test inventory and reports file totals. Integration files opt in via `bun run test:integration`. Every new lib file should ship with a `*.test.ts`.

### Pre-commit hook

`scripts/pre-commit.sh` runs `bunx tsc --noEmit --incremental` then `bun run lint -- --quiet`. It blocks on errors only (warnings pass). Installed by `bun run prepare` (also runs on `bun install` via the `prepare` script).

### CI gotchas

- CI (`ci.yml`) runs `rm -rf node_modules/.prisma && bunx prisma generate` before typecheck — a cache-restored stale Prisma client makes every Prisma type resolve to `{}` and tsc emits ~130 errors. If tsc suddenly fails en masse locally, delete `node_modules/.prisma` and regenerate.
- The e2e job pins `ENCRYPTION_SECRET_KEY` and uses a `pgvector/pgvector:pg16` service container; the app build itself is validated separately by `build-images.yml`.

## Architecture (pointer)

Deep reference for the AI/RAG internals lives in **`docs/architecture-reference.md`** — read it before changing
retrieval, prompts, Text-to-SQL, guardrails, session memory, or answer confidence. It covers the pipeline
entrypoints, the session-history window and rolling summary, the Text-to-SQL prompt conventions, the
LLM-to-database safety layers (including what each layer does NOT cover), and the evidence-sufficiency incident.

It is a separate file for a MEASURED reason: at 20 KB it was a third of `AGENTS.md`, and pushing the rules below it
past the instruction budget so they never loaded.

Before trying to make a chat answer faster, read **`docs/latency-reference.md`**: it records what was measured, what
shipped, and two tempting speed-ups that were rejected with the evidence.

## Cross-tenant IDOR: `findUnique` on a client-supplied id (2026-09 audit)

The original incident occurred when `findUnique` was unscoped. The runtime
extension now adds an `organizationId` predicate using Prisma 6's extended
unique filters. This defence does not replace the client-ID convention below. The long-standing rationale in `prisma-tenant.ts` was
*"IDs are cuid() random — cross-tenant access by ID is infeasible"*. **That
rationale is false and has been removed**: `api/mcp/servers/route.ts` returns
`id: true` to the browser, so a legitimate org-A user holds their own server ids
in plain sight and those same ids resolve in org B's context.

Two routes were exploitable, and BOTH called `getActiveUser()` + `enterWithOrg()`
— so `tenant-route-guard.test.ts` passed them. The goroutine was correct; the
query simply ignored the context it established.

| route | hole |
|---|---|
| `api/mcp/servers/[id]` GET/PATCH/DELETE | read/modify/delete another org's MCP server by id |
| `chat/sessions/[id]/send` | `body.promptId` read another org's `SavedPrompt` and injected its text into this org's system prompt |

**Rule**: loading a row by a CLIENT-SUPPLIED identifier must use `findFirst` (or
`findFirstOrThrow`), never `findUnique`. Use `findUnique` only for (a) pre-auth
lookups where no org exists yet (login/signup/invite/setup) and (b) re-reading a
row the same handler just created. `invariants.test.ts` carries an explicit
allowlist of files permitted to contain `findUnique` and fails on any new one —
if your route legitimately needs it, add it there **with the reason**.


## Alignment gate: two fail-opens (2026-09 audit)

`checkAlignment` is an advisory guardrail (it annotates an answer, it does not
block the request). Two defects made it weaker than it read:

1. **`ALIGNMENT_CHECK` enum mismatch.** `env-schema.ts` declares
   `z.enum(['http','llm','disabled'])`, but all four call sites tested
   `=== 'true'`. Setting the SCHEMA-VALID value `ALIGNMENT_CHECK=llm` — the
   documented way to enable the LLM judge — silently DISABLED the guardrail.
   Now read through the single predicate `isAlignmentCheckEnabled()`
   (`alignment-check.ts`); `invariants.test.ts` fails on any reintroduced
   `process.env.ALIGNMENT_CHECK === 'true'`.
2. **Non-streaming bypass.** `runStreamingAgenticLoop` checked alignment *inside*
   its substantial-evidence branch, but `runAgenticLoop` `return`ed from that same
   branch ~10 lines BEFORE its own check. The identical question was guarded over
   SSE and unguarded over HTTP, while `docs/threat-model.md` claimed both were
   covered. Both loops now call one shared `alignmentNoteFor()` helper — a second
   inline copy is exactly how they diverged.

The judge fails **open** on error (a judging outage must not silence every reply)
but logs a warning and reports `reason: 'alignment check skipped (judge
unavailable)'` — deliberately not "failed", because `aligned: true` next to
"failed" reads as "checked and fine", the opposite of what happened.

## Multi-Tenancy

- **Tenant root**: `Organization` model. `User.organizationId` links 1 user → 1 org. Every data model carries `organizationId`.
- **Auto-scoping**: `src/lib/prisma-tenant.ts` uses shared `AsyncLocalStorage` stores to inject `organizationId` into supported read and write operations, including unique reads. Missing context and explicit foreign tenant IDs fail closed. Use `findFirst` for client-supplied IDs; raw SQL and nested relation operations still require explicit ownership checks.
- **Escape hatch**: `bypassOrg(fn)` for setup/SSO/signup/seed where no org context exists yet.
- **Context setup**: `getActiveUser()` (in `session.ts`) calls `enterWithOrg(orgId)` — but **`AsyncLocalStorage.enterWith()` does NOT propagate back to the caller's frame**. Every route handler MUST call `enterWithOrg(user.organizationId)` itself right after `getActiveUser()`, or all its DB queries run unscoped (cross-tenant leak). `src/lib/tenant-route-guard.test.ts` enforces this statically — keep it green when adding routes.
- **RBAC**: `admin > analyst > viewer`. `requireRole(user, 'admin')` guards admin routes.
- **Plan gating**: `starter | pro | enterprise`. `hasPlan(user.plan, 'pro')` gates premium features (`src/lib/plan-gating.ts`).
- **License validation**: external License-Validator service (`LICENSE_VALIDATOR_URL`, default `http://localhost:9000`). Ed25519 signed responses + grace period + periodic revalidation. `getActiveUser()` checks license status and throws `LicenseError` on expiry.
- **License enforcement covers background work too**: `getLockdownReason` (`license-client.ts`) is the single predicate for "is this org locked down"; the HTTP path reaches it via `getActiveUser()`, and the **scheduler worker calls it directly in `processJob`** before doing any work. INCIDENT (2026-09): the worker had no gate, so a locked-down org's scheduled runs kept calling the LLM and touching the DB unattended. A locked org's job is **skipped** (not retried — a bad license is permanent, and retrying burns all 3 attempts per tick), recorded as `ScheduledRunLog.status='skipped'` + a `warning` audit row, and rendered as a "Skipped" badge in the schedules view. `unreachable`-within-grace still runs. **Any new process that executes work for an org must consult `getLockdownReason`** — never re-implement the status→lockdown mapping (`invariants.test.ts` enforces both).
- **Key files**: `src/lib/prisma-tenant.ts`, `src/lib/session.ts`, `src/lib/license-client.ts`, `src/lib/plan-gating.ts`, `src/lib/api-keys.ts`.

## Deployment model: on-prem, single install, licensed via OUR validator

**ryasai is deployed ON-PREM per customer.** One install = one deployment, and the
customer runs it on their own hardware. There is no multi-tenant SaaS control
plane: the `Organization` row is that install's own tenant root, and the app
reaches OUT to **OUR** License Validator (`~/ryasai/ryasai-LicenseValidator`,
a separate repo/service we operate) to validate its license key + machine id.

The direction matters and is easy to invert: the app is the CLIENT. It POSTs to
`/api/v1/license/validate` with `{license_key, machine_id, product}` and gets back
an Ed25519-signed verdict. Our validator is the authority; a self-hosted install
cannot mint its own license.

**Consequences — several earlier notes in this file were written as if this were a
multi-tenant SaaS and are WRONG for this business:**

- **There is no usage metering, no token budget, and no cost tracking to sell.**
  Billing is the signed LICENSE (a flat per-install entitlement). We do not charge
  per token, per seat, or per query, and we could not if we wanted to: the install
  is on the customer's premises with the customer's LLM key. Repeatedly, agents —
  and I — have "found" a missing cost/quota/budget feature here. **It is not
  missing; it is deliberately absent.** Verify the business model before proposing
  metering work.
- The token budget (`llm-budget.ts`, `assertWithinBudget` in the chat send route)
  is **dormant**: it exists as an optional operator safety valve against a runaway
  agent loop, is OFF unless `LLM_DAILY_TOKEN_BUDGET` is set, and is not a billing
  mechanism. Do not build on it.
- **Plan tiers / quotas (`starter|pro|enterprise`, `checkQuota`) are dormant
  licensing-era leftovers**, not a revenue path. The shipped commercial model is
  `licensePlan = 'flat'` — one entitlement, all features. Per-org quota checks
  still exist and are enforced where wired; they are simply never the thing that
  separates a paying customer from a non-paying one (the LICENSE is).
- **Multi-tenancy IS still load-bearing even here** — do not "simplify" it away.
  A single install can host several `Organization` rows (signup creates one), and
  more importantly the org scoping is what keeps data separated within the
  install and what every security guard in this file depends on. The past
  "single-tenant refactor" that removed `organizationId` was REVERTED for good
  reason; re-read the Cross-tenant IDOR section before touching it.

## Bring-your-own-key: the customer pays their provider, not us

**ryasai ships no LLM and no embedding model.** Every org supplies its own chat
endpoint, API key, and embedding endpoint in Settings > AI Configuration
(`LlmConfig`: `baseUrl`/`encryptedApiKey`/`model` + the `embedding*` quartet).
There is no platform key and no platform fallback anywhere in the transport —
verified: `llm-client.ts` sends only `cfg.apiKey`, which comes from the org's own
row via `getLlmRuntimeConfig()` (`findFirst` → org-scoped by the tenant
extension). An org with no config resolves `null` and the call fails closed.

Verified live (`trial/21-byok-isolation.ts`): two configured orgs each resolve
their OWN model + key with no cross-org bleed, and an unconfigured org gets
`null` rather than someone else's credentials.

**What this means for the money model — do not get this backwards:**

- **There is no per-org LLM COGS.** Token spend lands on the customer's provider
  invoice. `LlmUsageLog` tracks tokens for monitoring and for the customer's own
  runaway-loop protection — NOT for our margin. Do not build billing on it, and
  do not assume a cost column is missing-but-needed; our costs are hosting,
  Postgres, Redis and bandwidth, which are roughly flat per tenant.
- **The token budget is a dormant operator safety valve, not a product feature.**
  `LLM_DAILY_TOKEN_BUDGET` is env-configured (one process-wide number, OFF by
  default) and exists only to stop a runaway agent loop. It is not a billing
  mechanism and there is no per-org budget UI to build — see "Deployment model"
  above: the entitlement is the signed license, not a usage meter.
- The schema line calling `LlmUsageLog` "cost tracking" was **removed** — it
  described a billing model we are not in and would mislead the next reader into
  building usage-based charging on top of the customer's own key.

**BYOK failure handling is a first-class UX problem.** Because the credential is
the customer's, a 401/402/404 is never an operator misconfiguration — it is
their action item. Previously EVERY provider failure collapsed into one status
and told the user *"AI provider is not configured. Open Settings…"*, which is
actively misleading when the URL and model are already correct and only the key
is dead, credit ran out, or the model was renamed. `classifyProviderFailure()`
(`llm-client-utils.ts`) now separates `auth` / `quota` / `model_missing` /
`model_unsupported` / `unreachable` / `unknown`, and `LlmProviderError` carries
that classification on the error so callers can show a precise fix. The raw
provider body is NEVER sent to a client (it can echo the key prefix) — it stays
in server-side logs; only the category + hint cross the wire.
`toTypedError` maps it to 502 (upstream), not 500 (our fault).


## Billing and editable context prompts (pointer)

The QRIS purchase flow, the enforced plan quotas, the SSO org-resolution rule, and the per-source context-prompt
injection all live in **`docs/billing-and-prompts-reference.md`**.

**Read `## Deployment model` above first** — it is the section that states what the money model actually is: the
signed license is the entitlement, there is no usage metering, and the customer's own LLM key pays for tokens.

## Silent-failure classes found by probing

Twenty defects across twelve rounds shared one shape: **the code reported success for work it had
not done, or dropped data on the way out** — and every one was found by executing a probe, not by
reading the code. The full catalogue, with measurements and the reasoning for each fix, lives in
**`docs/silent-failure-classes.md`**. Read it before trusting a guard, reversing a test's
expectation, or changing how a prompt is delivered.

| # | class | the tell |
|---|-------|----------|
| 1 | a guard matching a WORD, not a CALL | deleting the call left the suite green |
| 2 | a wipe reported done when the forget failed | `catch {}` around an operation whose RESULT you report |
| 3 | a field SELECTED but never MAPPED | data correct at both ends, lost in the middle |
| 4 | a classified error whose `hint` is dropped | a test pinned the vague half as CORRECT |
| 5 | a defence correct and TESTED while callers bypass it | testing the wrapper never proves anyone calls it |
| 6 | a null that means two different things | a dead dependency and an empty result took one branch |
| 7 | a keyword list hijacking a routing decision | the WRONG answer scored higher than a right one |
| 8 | a documented rule a LATER guard silently overrides | the prompt was right; a downstream guard made it unreachable |
| 9 | a fix placed where it can never run | correct logic inside a branch that never executes |
| 10 | a branch on prose | the `reason` string gained a suffix and stopped matching |
| 11 | an instruction never DELIVERED | over the provider's system-message ceiling, so discarded |
| 12 | a rule set delivered in the wrong ROLE | same, plus system authority for untrusted text |
| 13 | two meanings sharing one value | -1 ("unknown") read as 0 ("empty"), so a mechanism was fed nothing |
| 14 | a dead mechanism that reports itself healthy | a schedule stops permanently and the row still says active |
| 15 | the same input, two routes, one sample | a gate "fixed" on the strength of a single odd run |
| 16 | a status meaning "accepted" read as "ready" | a document is searchable only in part, and nothing says so |
| 17 | a guard that cannot fail | ask "what would make this false?" before trusting it |
| 18 | a fixture uploaded twice, asserted by ranking | a duplicate document makes a retrieval assertion non-deterministic |
| 19 | a published artifact set drifting from the referenced set | "a build step exists" is not "the tag is reachable" |
| 20 | two harnesses for one suite, configured differently | the gate measured the harness, not the code |

**Rules that follow from these:**

- Trace a value from its SOURCE to its CONSUMER and check each hop, rather than assuming that
  presence at the ends implies a path between them. Numbers 3 and 4 both had the data correct at
  BOTH ends and lost it in the middle.
- When a mechanism is built to produce an actionable message (a classifier, a hint field, a
  `code`), grep for its CONSUMERS. A classifier nobody calls and a hint nobody displays are the
  same defect as no classifier at all.
- A test that asserts the current behaviour of a lossy stage can pin the loss in place. When
  reversing one, state in the test why the old expectation was wrong — the next reader will
  otherwise "fix" it back.
- Assert on the **response body**, not on the query. A field can be selected, typed and documented
  and still not be returned.
- `catch {}` around an operation whose RESULT YOU REPORT is a false-success bug. Either propagate
  the failure or record it in a field the UI reads. Graceful degradation is for work that is
  optional (memory recall returning `''`); it is not for work whose completion you claim.
- When one function in a family gets a rule right and a sibling does not, the outlier is the bug —
  check the family, not just the call site.
- **If a prompt seems ignored, verify it was DELIVERED** — check `prompt_tokens` against the text
  you sent, not just the code path. A system message over ~2000 characters is discarded whole.
- **Sweep a suspected boundary; do not probe it once.** A single probe at 3033 chars reported a
  prompt as delivered; a sweep located the cliff between 2000 and 2100.
- **A test whose negative control SURVIVES is vacuous — rewrite it, do not keep it.** A guard that
  cannot fail is worse than no guard, because it reports safety.
- **Check what your PROBE returns before believing its verdict.** An unexpectedly empty data source
  usually means the reader is wrong, not the source.
- **When one value carries two meanings, check every comparison against it.** Prefer keeping
  "unknown" distinct from "empty" so no guard can mistake one for the other.

## Conventions

- **English** in all user-facing strings (UI, errors, system prompts, comments).
- **Server-only libs** in `src/lib/` — never import `db`, `crypto`, `config`, or `session` into client components.
- **Fail-closed**: missing config/keys → throw, never fall back to insecure behavior. (`AUTH_DEMO_FALLBACK` defaults to `false`.)
- **Path alias**: `@/*` → `./src/*` (configured in `tsconfig.json`).
- **Comments explain *why*** — the codebase uses `// ponytail:` markers for hard-won context. Preserve these.
- **Typed errors**: `src/lib/errors.ts` defines `AppError` with 16 codes. `handleApiError()` in `session.ts` maps them to HTTP responses with `{ error: { code, message, hint? } }`.
- **New tools/plugins**: ship with a unit test for the executor + a guardrail test if it touches external systems.
- **Prisma schema changes**: prototype with `bunx prisma db push` in development, regenerate the client, then record a reviewed migration. Production runs `bun run db:deploy`; never replace the frozen baseline snapshot with the latest schema.

## Setup

- Copy `.env.example` to `.env`. **`DATABASE_URL`** (postgresql://, Postgres 16 + pgvector) and **`ENCRYPTION_SECRET_KEY`** (64-char hex or any passphrase, derived via SHA-256) are required — the app refuses to start without the key.
- Postgres needs the `vector` extension: `CREATE EXTENSION IF NOT EXISTS vector;` (run as superuser). `reset.sh` and `start.sh` attempt this via `sudo`.
- Local dev DB bootstrap (one-time):
  ```bash
  sudo apt-get install -y postgresql-16-pgvector
  sudo -u postgres psql -c "CREATE ROLE ryasai LOGIN PASSWORD 'ryasai_dev';"
  sudo -u postgres createdb -O ryasai ryasai
  sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS vector;"
  bunx prisma db push
  ```
- `bunx prisma db push` applies the schema. `bunx prisma generate` regenerates the client (Prisma also runs this automatically after `bun install`).
- `scripts/seed.ts` seeds an **empty** database (the signup flow creates the org/admin). Demo data (Chinook, Pagila, etc.) is migrated separately via `scripts/migrate-demo-to-postgres.ts`.
- Scheduler requires Redis. Without Redis, the app degrades gracefully (synchronous processing, in-memory rate limits).

## Database integrations (Supabase/Neon/PlanetScale…)

- Managed providers hand users a **connection string** — the create-integration dialog accepts it and pre-fills the fields; the server (`parseConnectionString` in `real-connectors.ts`) re-parses authoritatively.
- Managed providers default to TLS (`sslByDefault` in `db-provider-presets.ts`). TLS verification is ON by default; `DB_SSL_REJECT_UNAUTHORIZED=0` is the dev/self-signed opt-out.
- Connection failures are **classified** (`describeConnectionError`): `auth` / `ssl` / `dns` / `timeout` / `refused` / `database_missing` / `driver_missing`. The UI shows the classified hint; never regress to the opaque "Connection failed" string.
- `POST /api/integrations/[id]/test` (the UI "Test Connection" button) re-tests on a fresh pool and refreshes the schema cache.
- Supabase specifics: the **pooler** host needs the full dotted username (`postgres.<project-ref>`) and port 6543 (transaction mode) / 5432 (session mode); direct connections use `db.<project-ref>.supabase.co:5432`. Schema reflection defaults to `public` — pass `?schema=` or a `schema` field for others.
- Schema enrichment (`SELECT DISTINCT` per text column) runs under a budget (150 queries, concurrency 6) so large managed DBs don't hang first-time reflection.

## Build & Deploy (pointer)

How the released image is built, how the DISPLAYED version reaches a customer (the `.env` line does NOT do it — the
hardcoded fallback in `src/lib/public-config.ts` is the real mechanism), the known `middleware` deprecation warning,
and the compose-first deployment shape are in **`docs/build-and-deploy-reference.md`**.

The one fact worth knowing without opening it: **the version fallback in the code is what a customer sees**, because
the Dockerfile declares no `ARG`. It must be bumped with every release — see `CONTRIBUTING.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
