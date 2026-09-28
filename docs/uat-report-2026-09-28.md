# UAT Report — 2026-09-28

**Method**: 10 subagents, each a distinct real-user persona, testing a LOCAL install in parallel.
**Build**: `ab8e2e9` (= `main 831ccca`) standalone, `http://localhost:3000`.
**Production**: not tested by agents. Read-only smoke test by the orchestrator only.

Plan: `docs/uat-plan-2026-09-28.md`

---

## Headline

**The core promise holds.** Natural language → SQL works on real data, RAG retrieves real policy text with
correct citations, RBAC is enforced server-side, and the licence gate blocks unlicensed orgs.

**The systematic weakness is SCOPE HONESTY, not correctness.** When a question cannot be answered from the
available data, the system does not reliably say "that data does not exist" — it produces a plausible
artifact (a SQL statement that reads nothing, a chunk from a different document, a confident number from a
neighbouring table). An analyst acting on those answers would be misled while believing they were
data-backed.

---

## Verified by the orchestrator (agent claims re-tested)

An agent's finding is a lead, not a fact. These were re-tested here.

### CONFIRMED — major

**1. A fabricated SQL statement is presented as database evidence** (`P4`)

`"Berapa jumlah supplier yang terdaftar di sistem?"` — no `supplier` table exists in ANY connected database.
Four runs, same question, four different SQL statements:

| run | SQL actually run | answer |
|---|---|---|
| 1 | `SELECT 0 AS "jumlah_supplier" LIMIT 100` | "0 supplier" |
| 2 | `SELECT 0 AS "jumlah_supplier" LIMIT 100` | "0 supplier" |
| 3 | `SELECT COUNT(*) AS jumlah_gudang FROM "gudang" LIMIT 100` | "no supplier information" |
| reported by P4 | `SELECT COUNT(*) AS "jumlah_supplier" FROM "gudang"` | **"3 supplier"** |

Evidence the claim is about something real:
```
information_schema.tables ILIKE '%supplier%'  ->  0 rows in uat_sales, uat_hr, uat_logistics
SELECT count(*) FROM gudang                    ->  3
validateAndSanitizeLlmSql('SELECT 0 AS "jumlah_supplier" LIMIT 100')  ->  { ok: true }
```

`SELECT 0 AS "x"` reads no data at all, passes the guardrail, and the UI renders it under a
`DATABASE` citation with a `query_used` field. **A user is shown a SQL statement as proof of a data-backed
answer when the statement queries nothing.**

The P4 "3 supplier" form was **not reproducible in 4 attempts** (runs 1–3 answered honestly). I report the
class, not that exact output.

**2. A dead session renders the AI-config form EMPTY with no error** (`P1`)

Confirmed in code, not just observed. `ai-configuration-view.tsx:211-231`:
```js
fetch('/api/llm-config').then(r => r.json()).then(llm => {
  if (llm?.ok && llm.data) { setCfg(...); setModel(...) }   // not called on 401
}).catch(() => { /* ignore */ })                             // error swallowed, no state
  .finally(() => setLoading(false))                          // form renders anyway
```
No 401 handling anywhere in the file. So an expired session produces an **empty model field with no
message**, while the header still shows a logged-in user. An admin concludes their configuration was lost
— which is exactly the bug a real user reported. The model DOES persist when the session is healthy
(verified: survives navigation and reload).

### REFUTED — not a defect

**3. "Unauthenticated `POST /api/auth/register` mints an org + admin"** (`P2`) — **partly true, and
behaving as designed.** The route IS public and DOES create an org (verified: 4 → 5 orgs) — but the org is
created `licenseStatus: 'none'` / `setupCompleted: false`, and every feature route is blocked:

```
login as that user        -> 200
/api/me /api/documents /api/integrations /api/chat/sessions -> 200 (the gate allows these for checkout)
send a chat message       -> event: error  {"code":"LLM_ERROR"}   ← refused, NO LLM cost
```
`getActiveUser` documents this: `allowUnlicensed` is used ONLY by `/api/billing/*`, `/api/me` and auth so a
locked user can reach checkout; "every other route keeps blocking unpaid orgs". **No data and no LLM spend
leak.** P2's severity is overstated.

**4. "Blocker: invite link unusable (host `0.0.0.0`)"** (`P2`) — plausible and worth fixing, but I did not
verify it in this pass; it is a **lead**, listed under unverified below rather than asserted.

---

## Findings from the agents, NOT independently verified here

Listed so nothing is lost, and labelled as unverified rather than presented as fact. Each came with
command-level evidence in the agent's own report.

### Correctness of answers

| severity | finding | persona |
|---|---|---|
| major | Undisclosed `status` filter changes results: the 3rd-largest customer is absent from "5 pelanggan terbesar" and two figures are understated ~24% and ~62%, with no note that cancelled orders were excluded | P3 |
| major | The same question yields two different best-selling products because three different status filters (`= 'selesai'`, `<> 'dibatalkan'`, none) appear across 8 questions | P3 |
| major | TI-incident answer imports the *risk-management* document's "24 jam / 14 hari kerja" into the TI SOP and omits the real P1 SLA (15 menit / 4 jam), while citing doc 06 inside a doc-07 answer | P5 |
| major | Semantic retrieval contributes nothing: `semanticSimilarity: 0` on every result; `"annual leave entitlement"` returns 0 hits from a 56-chunk corpus. Embeddings exist (384-dim, non-degenerate) but are not used — plus a config mismatch (`vectorSize: 1536` reported vs `vector_dims 384` stored) | P5 |
| major | A retrieval miss becomes a confident false negative: "the annual-leave figure is not stated" when chunk#1 of `01-kebijakan-cuti.md` states 12 days. The retrieved chunks were 4,0,3,0,2,3,0,5 — chunk 1 was never fetched | P4 |
| minor | Search results are not returned in descending score order, and the UI labels them "Match #1…", so the top-labelled match is often the least relevant chunk (a 0.25 ranked above a 0.5) | P5 |
| minor | "Rata-rata per pelanggan" silently covers 5 of 8 customers | P3 |

### Silent-failure surfaces

| severity | finding | persona |
|---|---|---|
| major | A scheduled daily report has **never succeeded** — 3/3 runs `error` (LLM timeout / 60s timeout) — and its SQL is blocked as a false-positive "boolean-blind CASE probe" for an ordinary city→region mapping | P3 |
| major | `viewer`/`analyst` can READ the full user directory, audit log and API-key logs while writes to the same resources are correctly 403 | P2 |
| major | No UI path to change an existing member's role | P2 |
| minor | `DELETE /api/users/<id>` returns **200 but only soft-deletes** — offboarded staff persist as `isActive=false` and the `(organizationId,email)` unique constraint blocks re-inviting that address | P2 |
| minor | An expired session renders as "0 documents / Failed to load" with a "Try Again" button that can never succeed, instead of prompting sign-in | P5 |
| minor | RAG answers emit **no** `tool_start`/`tool_end` events, so retrieval is invisible in the stream while SQL answers do emit them | P5 |
| minor | AI-Memory status is shown five contradictory ways across screens ("Unreachable" / "Disconnected" / "disabled" / "running" / "9 pending") | P1, P5 |
| minor | `QueryHistory` is not written for SQL answers (0 rows) while `ToolRun` is (3 rows) — the generated SQL is only recoverable from the message citation | P4 |
| minor | `Answer from:` picker omits the Knowledge/documents source, offering only the three databases | P4 |

### Observed once, not reproducible

- One Indonesian question answered in **French** (number and SQL correct). 1 of 4 observed by P1.
- A document left permanently unsearchable (`cognify=failed`) while the tile reads "11 Ready".

---

## What the personas confirmed WORKS

Stated because a UAT that only lists defects is not evidence of quality.

- **NL→SQL is accurate.** 8/8 questions routed to SQL, `ToolRun` 78 success / 0 failure. Five answers were
  verified independently against the databases and **all five matched**, including a full Rp5.656.500 total
  and per-product unit counts. Empty results were reported honestly ("0 — tidak ada nilai pesanan").
- **The bot self-corrects visibly.** It volunteered: *"hasil ini berbeda dari jawaban sebelumnya yang hanya
  menghitung pesanan berstatus selesai…"* — flagging its own earlier filter.
- **RAG retrieves and cites correctly on direct questions.** "Berapa hari jatah cuti tahunan?" → **12 hari**,
  matching chunk#1. A trap question about a non-existent "di atas 50 juta" band was handled honestly.
  A genuine cross-document conflict (`1 jam` vs `24 jam`) was **flagged with a comparison table** rather
  than silently resolved.
- **Lexical retrieval is strong**: 20/20 doc-level hits on gold questions, correct chunk in top-4 for 18/20.
- **Analyst-facing UI is genuinely good**: markdown tables, a bar chart, a `Sources (n)` panel, and an
  expandable **"View SQL query"** so a non-SQL user can audit the bot.
- **RBAC is enforced server-side**, with an explicit refusal: `403 Requires admin role. You have analyst.`
  Positive control passed: an admin change took effect, three viewer attempts left data unchanged.
- **The licence gate blocks unlicensed orgs** (verified above).
- **Keyboard/screen-reader findings were specific and actionable** (P10, in full in the agent report).

---

## Coverage

**Touched**: chat SSE API · SQL routing + citations + chart data · RAG retrieval, citations, documents/search ·
sessions (create/rename/delete/history) · dashboard · AI config · prompt-tools · integrations (test/schema) ·
users + RBAC · API keys · schedules · plugins · MCP · knowledge upload/delete · vector store · monitoring ·
guardrails · audit log · licence gate.

**Skipped / blocked**: fresh-org onboarding (hard-gated at licence activation, no key) · REST connectors ·
notifications · agentic console execution · exports · non-admin document upload (403 by design) ·
cross-lingual RAG through the chat pipeline · the full P10 accessibility sweep details.

---

## Known limitation of this UAT run itself

All 10 agents shared **one** account (`e2e@test.local`), and that account enforces **single-session
semantics**: a second login invalidates the first. Measured by P3: token valid at `t=+0s`, `401` at `t=+8s`
after another login, with `User.sessionVersion` incrementing. This cost every agent retries and produced
several transient 401-driven "failures" that were **not** product defects.

It also produced one genuine finding — the empty-config-form bug above — because a dead session is a real
state. **A future UAT should give each agent its own account.**
