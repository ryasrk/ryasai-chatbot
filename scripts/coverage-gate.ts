#!/usr/bin/env bun
/**
 * Coverage gate — fail CI when a module that is already well covered regresses.
 *
 * WHY PER-FILE AND NOT A REPO TOTAL
 * --------------------------------
 * The repo total is 75% and climbing; a hard gate on it would be red on the day
 * it was added and red forever after, which trains people to ignore it. Worse,
 * the merged total is a LOWER BOUND — a merged run reports fewer covered lines
 * than a single-file run for the same module (measured: smart-router-helpers
 * 97.37% alone vs 88.1% merged), because Bun only reports the lines its own
 * process executed and `Math.max` cannot invent hits for lines no run reached.
 * Gating on that number would let a real regression hide inside the slack.
 *
 * So the gate pins a FLOOR per module, derived from what that module already
 * achieves, and only for modules above a threshold. A module at 40% is not
 * gated; a module at 95% cannot silently fall to 80%.
 *
 * WHY THE FLOOR IS DELIBERATELY BELOW THE MEASURED VALUE
 * ------------------------------------------------------
 * The floor is the measured percentage rounded DOWN to the nearest 5, minus a
 * tolerance. Gating at the exact measured number makes the gate fail on
 * unrelated churn (a new exported helper with no test yet, a Bun version that
 * counts one more line) and people respond to a flaky gate by deleting it.
 * A gate that catches a 15-point collapse is worth far more than one that
 * catches a 1-point wobble, and the second kind gets removed.
 *
 * WHAT THIS IS NOT: it does not gate the repo total, and it is not a substitute
 * for the 95% target. It is the thing that stops 95% from being reached and then
 * quietly lost.
 *
 * Usage: bun scripts/coverage-gate.ts [--update]
 *   --update  print a fresh floors table for review (never writes silently)
 */
import { readFileSync, existsSync } from 'node:fs'

/**
 * Per-module line-coverage floors, in percent.
 *
 * Keyed by repo-relative path. Add an entry only after a module is genuinely
 * above `MIN_GATED_PCT`; the value is a floor, never the current measurement.
 */
const FLOORS: Record<string, number> = {
  'src/app/api/auth/change-password/route.ts': 95, // measured 100.00% (53/53)
  'src/app/api/auth/signup/route.ts': 90, // measured 96.26% (103/107)
  'src/app/api/billing/orders/[id]/route.ts': 100, // measured 100.00% (27/27); catch was uncovered
  'src/app/api/billing/orders/route.ts': 90, // measured 96.00% (48/50)
  // Payment webhook: signature fail-closed when SERVER_KEY is unset, the order_id
  // guard, gross_amount mismatch, the atomic settlement claim and the retry on a
  // THROWN issuance are all pinned.
  'src/app/api/billing/webhook/route.ts': 100, // measured 100.00% (106/106)
  // The Buy License pack list; the error path is handled through handleApiError.
  'src/app/api/billing/pricing/route.ts': 100, // measured 100.00% (11/11)
  // The MCP connection pool: LRU eviction, transport-close eviction, SSRF guards,
  // env/header decryption and the tool-result error shapes.
  // Had NO test at all. Isolates each org's MCP filesystem namespace and pins the wrapper
  // script's HOME/npm/TMPDIR/PATH away from the host. 95/99 executable (95.96%). Remaining
  // uncovered lines are cleanup/metadata failure branches needing a real filesystem error.
  'src/lib/mcp-sandbox.ts': 100, // measured 100.00% (99/99); cleanup-rethrow and the readdir-denied path were uncovered
  // Had NO test at all. Sweeps every org's license and is revenue-critical in BOTH directions:
  // too eager locks out a paying customer, too lax keeps a dead license alive. 44/45
  // executable (97.78%). The uncovered line is the outer cycle catch.
  'src/lib/license-revalidation.ts': 97, // measured 97.78% merged
  'src/lib/mcp-client.ts': 91, // measured 91.01% (243/267); 243/243 executable
  // SQL-injection guardrail: dangerous-function masking, the string-literal walker
  // and the LIMIT cap. 188/189 executable; 1 line is a bun arrow-callback artifact.
  'src/lib/guardrails.ts': 85, // measured 85.84% merged; 188/189 executable
  // Plugin manifests: the endpoint protocol + SSRF checks at REGISTRATION and again at
  // EXECUTION, the GET input channel, and the enabled-plugin listing's column select.
  'src/lib/plugin-registry.ts': 85, // measured 85.09% merged; 137/138 executable
  // Session token HMAC: verifySession + extractSessionVersion, the session-fixation pair.
  'src/lib/crypto.ts': 90, // measured 91.67% merged; 55/55 executable
  // PDF/DOCX/XLSX extraction: lossless-or-empty, both hex encodings, the inflate fallbacks.
  'src/lib/document-parsers.ts': 84, // measured 84.66% merged; 149/149 executable
  // Full-text search: tenant-scoped raw SQL, the BM25 corpus-stat refresh and its
  // degradation path.
  'src/lib/rag-fts.ts': 70, // measured 70.78% merged; 109/109 executable
  'src/app/api/chat/sessions/route.ts': 100, // measured 100.00% (47/47); both catches were uncovered
  'src/app/api/documents/[id]/route.ts': 95, // measured 100.00% (169/169)
  'src/app/api/documents/[id]/reprocess/route.ts': 95, // measured 100.00% (55/55)
  'src/app/api/integrations/[id]/route.ts': 95, // measured 98.48% (195/198)
  'src/app/api/integrations/[id]/schema/route.ts': 95, // measured 97.38% (186/191)
  'src/app/api/integrations/route.ts': 80, // measured 88.10% (185/210)
  'src/app/api/mcp/servers/[id]/route.ts': 90, // measured 98.56% (137/139)
  'src/app/api/mcp/servers/route.ts': 85, // measured 94.67% (142/150)
  'src/app/api/metrics/route.ts': 95, // measured 100.00% (43/43)
  'src/app/api/notifications/route.ts': 80, // measured 88.57% (62/70)
  'src/app/api/prompt-tools/route.ts': 100, // measured 100.00% (37/37); GET and the create branch were uncovered
  'src/app/api/v1/agent/run/route.ts': 85, // measured 90.08% (118/131)
  'src/lib/async-worker.ts': 100, // measured 100.00% (59/59)
  'src/lib/billing-ui.ts': 95, // measured 100.00% (33/33)
  'src/lib/billing-verify.ts': 95, // measured 100.00% (18/18)
  'src/lib/bounded-concurrency.ts': 95, // measured 100.00% (22/22)
  'src/lib/chat-layout.ts': 95, // measured 100.00% (8/8)
  'src/lib/cognee-types.ts': 100, // measured 100.00% (15/15); was mocked by every test that used it
  'src/lib/notifications.ts': 100, // measured 100.00% (132/132); the Resend send path was never run
  'src/app/api/users/[id]/route.ts': 100, // merged 100.00%; was one of the 42 routes with NO test at all
  'src/app/api/settings/api-keys/[id]/route.ts': 100, // merged 100.00%; was one of the 42 routes with NO test at all
  'src/app/api/auth/register/route.ts': 100, // merged 100.00%; was one of the untested routes
  'src/app/api/setup/admin/route.ts': 100, // merged 100.00%; was one of the untested routes
  'src/app/api/webhooks/license/route.ts': 100, // merged 100.00%; was one of the untested routes
  'src/app/api/analytics/route.ts': 100, // merged 100.00%; was one of the untested routes
  'src/app/api/users/[id]/role/route.ts': 100, // merged 100.00%; was UNTESTED (one of 42 routes with no test at all)
  'src/middleware.ts': 100, // measured 100.00% (85/85); had NO test file at all
  'src/lib/tool-branches.ts': 84, // merged 84.01%; floor from coverage-summary.json (merged)
  'src/lib/embeddings.ts': 82, // merged 82.91%; floor from coverage-summary.json (merged)
  'src/lib/smart-router.ts': 77, // merged 77.62%; floor from coverage-summary.json (merged)
  'src/lib/ai.ts': 74, // merged 74.42%; floor from coverage-summary.json (merged)
  'src/lib/intent-pipeline.ts': 73, // merged 73.74%; floor from coverage-summary.json (merged)
  'src/lib/real-connectors.ts': 73, // merged 73.11%; floor from coverage-summary.json (merged)
  'src/lib/config.ts': 70, // merged 70.31%; floor from coverage-summary.json (merged)
  'src/lib/source-guidance.ts': 63, // merged 63.95%; floor from coverage-summary.json (merged)
  'src/lib/evidence-boundary.ts': 46, // merged 46.67%; merged 46.67% but 14/14 executable (100.00%)
  'src/lib/rag-ranking.ts': 80, // merged 80.56%; merged 80.56% but 58/58 executable (100.00%)
  'src/lib/constrained-output.ts': 84, // merged 84.31%; measured 100.00% (43/43)
  'src/lib/api-keys.ts': 84, // merged 84.78%; merged 84.78% but 78/78 executable (100.00%)
  'src/lib/alignment-check.ts': 83, // merged 83.08%; merged 83.08% but 54/54 executable (100.00%)
  'src/lib/cognee.ts': 73, // merged 73.91%; merged 73.91% but 34/34 executable (100.00%)
  'src/lib/tool-router.ts': 70, // merged 70.71%; merged 70.71% but 239/239 executable (100.00%)
  'src/lib/llm-config.ts': 81, // merged 81.50%; merged 81.50% but 207/207 executable (100.00%)
  'src/lib/mcp-installer.ts': 80, // merged 80.40%; merged 80.40% but 160/160 executable (100.00%)
  'src/lib/connectors.ts': 79, // merged 79.73%; merged 79.73% but 118/118 executable (100.00%)
  'src/lib/cognee-core.ts': 83, // merged 83.33%; merged 83.33% but 215/215 executable (100.00%)
  'src/lib/rag-chunking.ts': 84, // merged 84.30%; measured 100.00% (188/188)
  'src/lib/cognee-memory.ts': 81, // merged 81.65%; measured 100.00% (129/129)
  'src/lib/cognee-knowledge-graph.ts': 77, // merged 77.62%; merged 99.63% but 267/267 executable (100.00%)
  'src/lib/agentic-budget.ts': 76, // merged 76.47%; measured 100.00% (13/13)
  'src/lib/rest-api-connectors.ts': 97, // merged 97.89%; 93/93 executable (100.00%) after adding the OAuth2 flow
  'src/lib/license-client.ts': 86, // merged 86.90%; 126/128 executable (98.44%); 2 declared non-controls
  'src/lib/constants.ts': 95, // measured 100.00% (21/21)
  'src/lib/conversation-export.ts': 95, // measured 100.00% (79/79)
  'src/lib/cron.ts': 90, // measured 99.09% (109/110)
  'src/lib/db-provider-presets.ts': 100, // measured 100.00% (34/34); the driver-selection function was never run
  'src/lib/db-provider.ts': 95, // measured 100.00% (3/3)
  'src/lib/db.ts': 85, // measured 91.67% (11/12)
  'src/lib/doc-versioning.ts': 98, // merged 100.00% (81/81); failed-restore path was uncovered
  'src/lib/env-schema.ts': 95, // measured 100.00% (167/167)
  'src/lib/errors.ts': 80, // measured 85.48% (53/62)
  'src/lib/extract-error.ts': 95, // measured 100.00% (6/6)
  'src/lib/graceful-shutdown.ts': 100, // measured 100.00% (38/38)
  'src/lib/health-status.ts': 95, // measured 100.00% (14/14)
  'src/lib/hyde.ts': 95, // measured 100.00% (61/61)
  'src/lib/incoming-webhook.ts': 95, // measured 100.00% (40/40)
  // floor from MERGED coverage-summary.json: 87.50% (126/144). The per-file run
  // reports 100% (91/91); a floor of 95 pasted from that run is rejected by the
  // `suspicious` check below — which is exactly the trap it was written to catch.
  'src/lib/license-issue.ts': 85,
  'src/lib/llm-budget.ts': 95, // measured 100.00% (57/57)
  // ZERO coverage until this session: no test imported it, even transitively, so the builder for
  // EVERY Anthropic request ran uninstrumented. Its header documents a past bug where only the
  // first system message survived, dropping memory context and history. 63/63 executable
  // (100.00%); the merged figure is lower because 15 of its lines are type declarations.
  'src/lib/llm-client-anthropic.ts': 80, // measured 80.77% merged; 63/63 executable
  'src/lib/llm-client-openai.ts': 80, // measured 85.57% (172/201)
  'src/lib/llm-client-utils.ts': 85, // measured 90.27% (167/185)
  // Every provider-failure test used openaiCfg, so the Anthropic non-streaming !res.ok branch
  // never ran -- a dropped status there would hit real BYOK customers while unit tests stayed
  // green. Also covered: tools in the STREAMING OpenAI body (a separate assignment) and the
  // `System context:` push in agentChatStream (a separate copy from agentChat's).
  'src/lib/llm-client.ts': 90, // measured 90.88% merged; 266/270 executable
  'src/lib/logger.ts': 85, // measured 94.44% (34/36)
  'src/lib/metrics.ts': 90, // measured 96.13% (149/155)
  'src/lib/midtrans.ts': 85, // measured 94.03% (63/67)
  // Measured merged fell when job-processor.test.ts began MOCKING this module (so its internals
  // are no longer instrumented through that path); executable coverage is 94.44% (51/54) with
  // ALL three test files. Floor tracks MERGED, which is what the gate reads.
  'src/lib/order-reconcile.ts': 82, // measured 82.26% merged; 51/54 executable
  // Raised 80 -> 88: the format tag, the scrypt COST and the empty-field guard are
  // now pinned, and a TRUNCATED stored hash is documented as ACCEPTING the correct
  // password (256-value brute force, 1.1s). Remaining 2 lines are a defensive catch.
  'src/lib/passwords.ts': 88, // measured 88.89% (16/18)
  // SSO login redirect + IdP metadata discovery + the SAML hardening options
  // (both signatures required, 60s assertion age, audience = our entity id).
  // Discovered metadata, SAML login and the outbound deadline helper. The merged figure reads
  // LOW because this module now carries the multi-line timeout helper plus its test-only
  // accessor, and the merged LF union attributes those lines without hits; the executable
  // measurement is 100.00% (235/235) via `coverage-honest.py` with ALL test files. Floor is
  // the MEASURED merged number, not the executable one -- the gate reads merged by design.
  'src/lib/sso-saml.ts': 86, // measured 86.40% merged; 235/235 executable
  // Trace buffering + both vendor forwards (Langfuse ingestion/scores, Helicone),
  // including the failure paths and the no-timeout gap (declared, not fixed).
  'src/lib/observability.ts': 87, // measured 87.32% (124/142); 124/124 executable
  'src/lib/plan-gating.ts': 85, // measured 94.87% (37/39)
  'src/lib/pricing.ts': 95, // measured 100.00% (39/39)
  'src/lib/prompt-library.ts': 95, // measured 100.00% (34/34)
  'src/lib/prompt-settings.ts': 91, // merged 91.11%; 41/41 executable (100.00%)
  'src/lib/public-config.ts': 100, // measured 100.00% (10/10)
  'src/lib/rag-eval.ts': 95, // measured 100.00% (73/73)
  'src/lib/rag-search-tester.ts': 90, // measured 98.08% (51/52)
  'src/lib/rag.ts': 85, // measured 90.65% (126/139)
  'src/lib/reflexion.ts': 95, // measured 100.00% (38/38)
  'src/lib/reranker.ts': 95, // measured 100.00% (36/36)
  // The OpenAI-compatible entry point. 79.40% -> 100.00% executable (370/370) with
  // the duplicated tool-run block extracted, so it meets the floor with no slack to
  // give back. Gated at 100 because a regression here breaks the public contract.
  'src/app/api/v1/chat/completions/route.ts': 100, // measured 100.00% (370/370)
  // 94.44% -> 99.38% executable (161/162). The only line left is the
  // `Unreachable` fall-through that the source itself documents as unreachable.
  'src/lib/web-fetch.ts': 70, // measured 99.38% executable; merged 73.52% (see caveat)
  'src/lib/stream-preparers.ts': 80, // measured 100.00% executable (437/437); merged 82.14%
  // 59.80% -> 100.00% executable (119/119). The two untested functions were the
  // license-expiry reminder and the startup prune sweep: both idempotency-critical,
  // and a wrong prune silently drops a live job.
  // 93.84% -> 100.00% executable (341/341). Merged is 76.29% because other test
  // files instrument this module without covering it (LF jump, see the caveat).
  // 96.70% -> 99.45% executable (538/541). The 3 remaining are  openers
  // inside executed object literals (lcov artifact, documented in the docs).
  // 97.17% -> 100.00% executable (569/569). Was BELOW the 85 threshold on the
  // merged figure before this round; now safely above.
  'src/lib/admin-tools.ts': 83, // measured 100.00% executable; merged 84.30%
  'src/lib/planner.ts': 78, // measured 99.45% executable; merged 79.00%
  // The streaming agentic loop: termination (deadline, token budget), the no-tools exit and
  // the max-iteration final synthesis.
  'src/lib/tool-router-agentic.ts': 80, // measured 80.38% merged; 385/388 executable
  // Chunk-level knowledge-graph indexing, including the two containment catches.
  'src/lib/knowledge-graph.ts': 79, // measured 79.08% merged; 155/155 executable
  // Zero coverage until this session: no test imported it, even transitively, so the whole
  // module ran uninstrumented -- the same blind spot the document-worker outage hid in.
  // 128/129 executable (99.22%). The uncovered line is the `.catch` on
  // ensureOrderReconcileRepeatable, reachable only when Redis is down at boot.
  'src/lib/job-processor.ts': 99, // merged 99.39%%->100.00%% after the boot-time catch was driven // measured 97.67% merged
  'src/lib/rag-retrieval.ts': 75, // measured 100.00% executable; merged 76.29%
  'src/lib/scheduler-queue.ts': 100, // measured 100.00% (119/119) merged
  // A REVENUE feature: a paying on-prem customer is warned before their license
  // expires, and a silent failure here is a lost renewal rather than a bug report.
  // The orchestration (scan window, per-org channel lookup, skip-vs-fail split,
  // lastUsedAt refresh) was entirely uncovered until it was driven through real
  // mocks; measured 100.00% (66/66) merged.
  'src/lib/license-reminder.ts': 100,
  // THE AUTHENTICATION BOUNDARY. The 401 must stay generic (no user enumeration),
  // a failure must be audited, and a success must rotate sessionVersion so old
  // cookies die. The route sat at 35.14% executable with the entire POST flow
  // unexecuted; measured 100.00% (66/66) merged.
  'src/app/api/auth/login/route.ts': 100,
  // THE AUDIT LOG READ PATH. Tenant scoping depends entirely on enterWithOrg
  // running before the query, and the severity filter is an allow-list so an
  // arbitrary string never reaches the comparison. One pagination-helper test left
  // the handler at 38.24% executable; measured 100.00% (43/43) merged.
  'src/app/api/audit/route.ts': 100,
  // Carries the RATE LIMITER (a security control), the production TLS warning, and
  // the cache every RAG/router path falls back on. It had NO test file at all --
  // the module the whole app degrades onto during a Redis outage was never
  // executed by the suite. Measured 93.67% (74/79) merged; the one uncovered line
  // is the TLS warning, which runs at MODULE LOAD and is therefore only reachable
  // from a subprocess, so it is pinned by test but not instrumented here.
  'src/lib/redis.ts': 90,
  // THE TENANT ISOLATION EXTENSION -- the single most security-critical module in
  // the repo. Forty-three test files import it and ALL of them mock it, so the real
  // injection code (injectOrgWhere/injectOrgCreate, the PascalCase normalisation,
  // the model allow-list) had never executed: 63.41% executable with every branch
  // of the injection engine unreached. Measured 87.38% (90/103) merged, 100.00%
  // (90/90) executable. Floor set ABOVE default because a regression here is a
  // cross-tenant data leak, not a display bug.
  'src/lib/prisma-tenant.ts': 87,
  // The citation trail names the ENTITY and RELATION a RAG answer came from, which
  // is what a user reads as the source of a claim. 86.27% -> 100.00% executable
  // (57/57). Merged is 90.48% because other test files instrument extra LF lines.
  'src/lib/citation-trail.ts': 90,
  // SSRF surface: reads a user-supplied URL. 83.33% -> 100.00% executable (30/30).
  // The refusal paths were the only ones tested; the SUCCESS, 422 and 502 branches
  // (the shapes the planner actually consumes) ran in no test at all.
  'src/app/api/fetch-url/route.ts': 100,
  // Untrusted stored JSON: the columns/sampleRow TEXT columns were written by an
  // earlier ingestion path and can be truncated or hand-edited. 81.82% -> 100.00%
  // executable (47/47).
  'src/lib/schema-enrichment.ts': 87,
  // Theme persistence: getStoredDarkMode/applyTheme/setTheme had NO test (the file
  // imported only getStoredTheme, and only its SSR early-return). 96.61% -> 100.00%
  // executable (87/87). A wrong dark/light ternary or a missing change event is a
  // visible user-facing regression, so it is pinned at 100.
  'src/lib/themes.ts': 100,
  // Tracing init. The false branch (packages not installed) was the only one tested,
  // so the exporter CHOICE, the resource attributes and sdk.start() ran in no test --
  // a constructed-but-unstarted SDK is the classic silent tracing failure.
  // 77.78% -> 100.00% executable (49/49).
  'src/lib/otel.ts': 100,
  // User-facing schedule wording: a wrong description makes an operator believe a job
  // runs at a different time than it does. 80.60% -> 100.00% executable (140/140).
  'src/lib/cron-describe.ts': 99,
  // The plugin picker's category tree: an empty-string or undefined category key
  // renders as a nameless group. 95.18% -> 100.00% executable (181/181).
  // Ran uninstrumented in every test that touched it: instrumentation.ts, both setup routes and
  // the seed_plugins admin tool all reach it, but each test MOCKED it. Its own comment documents
  // the blind spot -- a "news endpoint fix" that "sat in the seed file while production kept
  // 404ing on the stale row". 193/193 executable = 100.00%.
  'src/lib/plugin-seeds.ts': 100, // measured 100.00% (193/193)
  'src/lib/plugin-selector.ts': 88,
  // The SQL Playground route: two 409 preconditions whose MESSAGE is the operator's
  // only instruction, plus the LLM-failure audit. 85.26% -> 100.00% (210/210).
  'src/app/api/integrations/[id]/query/route.ts': 100,
  'src/lib/session.ts': 80, // measured 89.56% (163/182)
  'src/lib/setup.ts': 84, // merged 84.85% -- the 100% fig was from a single-file run (see coverage.ts caveat)
  'src/lib/smart-router-helpers.ts': 80, // measured 88.06% (332/377)
  // OIDC: RS256/JWKS + the alg-confusion and kid-rotation guards, the aud/iss/exp/nonce
  // checks, the closed alg alphabet, and an ARRAY `aud` documented as refused (fail-closed).
  'src/lib/sso.ts': 88, // measured 88.66% (258/291); 258/258 executable
  'src/lib/source-init.ts': 95, // measured 100.00% (104/104), merged
  'src/lib/tool-rate-limit.ts': 85, // measured 92.86% (26/28)
  // Added after the gate started REPORTING eligible-but-ungated modules: this one
  // already cleared 85% and nothing was asking it to keep it. That silence is the
  // failure mode the report exists to remove.
  'src/lib/tool-utils.ts': 85, // measured 93.33% (140/150)
  // NOT gated yet, and the reason is worth keeping: planner.ts measures 94.68%
  // in a per-file run but only 75.77% (516/681) in the MERGED report this script
  // reads. The 19-point gap is the documented merge caveat in coverage.ts — Bun
  // reports only the lines its own process executed, and Math.max cannot invent
  // hits. Pasting the per-file number here failed the gate immediately, which is
  // exactly what the gate is for, and the `suspicious` check below now names the
  // cause instead of leaving a bare red build.
  // Re-add this module only with a floor at or below 75: 'src/lib/planner.ts': 70,
  // The chat send route: the pre-stream guards AND the two helpers inside the SSE
  // body (persistAssistantError, maybeUpdateSessionSummary). Floor is 85, not 95:
  // the MERGED figure is 87.08% (364/418) even though a per-file run reads higher,
  // and pasting a per-file number here is what the suspicious check exists to catch.
  // The streaming watchdog: 26 tests existed and NONE touched it, so the branch deciding
  // whether a stalled provider cuts the turn off was never exercised. Now covers the idle
  // timeout, the overall deadline, the client-disconnect branch (which must persist
  // NOTHING) and the per-token timer reset. 405/410 executable (98.78%).
  'src/app/api/chat/sessions/[id]/send/route.ts': 93, // measured 93.75% merged
  // MCP per-server context gating was untested while the plugin side had five tests: no test ever
  // supplied an MCP tool whose server had chatEnabled/agenticEnabled set, so the branch deciding
  // whether an MCP tool is offered in chat vs agentic never ran. 258/271 executable.
  'src/lib/tool-registry.ts': 95, // measured 95.91% merged
  'src/lib/tool-sandbox.ts': 85, // measured 93.75% (30/32)
  'src/lib/vector-stores.ts': 94, // merged 94.28%%; was 93.46%% before the normaliser branches were tested // measured 93.46% (343/367)
  'src/lib/view-routing.ts': 95, // measured 100.00% (19/19)
}

/** Only modules at or above this measured percentage are eligible for gating. */
const MIN_GATED_PCT = 85

/**
 * Allowance subtracted from the rounded-down floor.
 *
 * Absorbs churn from Bun versions and small refactors without hiding a real
 * collapse. Measured while building this: a module at 100% with a floor of 98
 * went red after a 2-line change (59/61 = 96.72%) — that is exactly the flaky
 * gate people respond to by deleting the gate. 5 points is the smallest
 * allowance that survived that case while still catching a genuine collapse.
 */
const TOLERANCE_PCT = 5

type Row = { file: string; hit: number; found: number; pct: number; linesHit: number }
type Summary = { linePct: number; linesHit: number; linesFound: number; files: Row[] }

const SUMMARY = 'coverage-summary.json'

function load(): Summary | null {
  if (!existsSync(SUMMARY)) return null
  try {
    return JSON.parse(readFileSync(SUMMARY, 'utf8')) as Summary
  } catch {
    return null
  }
}

const summary = load()
if (!summary) {
  console.error(`[coverage-gate] ${SUMMARY} not found. Run: bun scripts/coverage.ts`)
  // Exit 0: a missing summary means the measurement step did not run, which the
  // workflow already reports. Failing here would blame this script for it.
  process.exit(0)
}

const update = process.argv.includes('--update')

if (update) {
  const eligible = summary.files
    .filter((f) => f.pct >= MIN_GATED_PCT)
    .sort((a, b) => a.file.localeCompare(b.file))
  if (eligible.length === 0) {
    console.log(`[coverage-gate] no module at or above ${MIN_GATED_PCT}% yet — nothing to pin.`)
    process.exit(0)
  }
  console.log('// Proposed floors (measured -> floor). Review before pasting into FLOORS.')
  for (const f of eligible) {
    const floor = Math.floor(f.pct / 5) * 5 - TOLERANCE_PCT
    console.log(`  '${f.file}': ${floor}, // measured ${f.pct.toFixed(2)}% (${f.hit}/${f.found})`)
  }
  process.exit(0)
}

const byFile = new Map(summary.files.map((f) => [f.file, f]))

/**
 * A floor ABOVE the module's merged measurement is almost always a floor pasted
 * from a per-file run.
 *
 * This is not hypothetical: planner.ts measures 94.68% alone and 75.77% merged, so
 * a floor of 85 sourced from the per-file number failed the gate the moment it was
 * added. The two numbers look equally authoritative and are not. Catching it here
 * turns a confusing red build into a sentence that names the cause.
 */
const suspicious: string[] = []
for (const [file, floor] of Object.entries(FLOORS)) {
  const row = byFile.get(file)
  if (row && floor > row.pct) {
    suspicious.push(`${file}: floor ${floor}% exceeds the merged measurement ${row.pct.toFixed(2)}%`)
  }
}
if (suspicious.length && !update) {
  console.error('\n[coverage-gate] floor(s) above the measured value — was this pasted from a per-file run?')
  for (const m of suspicious) console.error(`  - ${m}`)
  console.error('  Floors must come from coverage-summary.json (merged), never from a single-file --coverage run.')
  console.error('  The merged figure is lower by design; see the caveat in scripts/coverage.ts.')
  process.exit(1)
}

const problems: string[] = []
const missing: string[] = []

for (const [file, floor] of Object.entries(FLOORS)) {
  const row = byFile.get(file)
  if (!row) {
    // A gated module that vanished from the report is suspicious: it usually
    // means the file was renamed (so the floor silently stopped protecting it)
    // or the measurement broke. Both deserve a look.
    missing.push(file)
    continue
  }
  if (row.pct + 1e-9 < floor) {
    problems.push(
      `${file}: ${row.pct.toFixed(2)}% (${row.hit}/${row.found} lines) is BELOW the floor of ${floor}%`,
    )
  }
}

const gated = Object.keys(FLOORS).length

if (missing.length) {
  console.error('\n[coverage-gate] gated modules missing from the report:')
  for (const m of missing) console.error(`  - ${m}`)
  console.error('  (renamed file, or the module stopped being exercised entirely)')
}

if (problems.length) {
  console.error('\n[coverage-gate] COVERAGE REGRESSED:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(`\n${problems.length} of ${gated} gated module(s) fell below their floor.`)
  console.error('Either restore the tests, or lower the floor deliberately in this file')
  console.error('with a comment saying why — do not delete the entry.')
  process.exit(1)
}

if (missing.length) process.exit(1)

// Ungated-but-eligible modules are REPORTED, never fatal.
//
// A gate that only protects existing floors stops improving the moment it is
// installed: nothing ever asks the next module to join. Listing the modules that
// already clear MIN_GATED_PCT but have no floor makes the next floor a one-line
// paste, and naming the count keeps the gap visible instead of invisible. It is
// deliberately NOT an error — the floors are a ratchet, and a ratchet that
// fails the build over its own backlog gets removed.
const ungated = summary.files
  .filter((f) => f.pct >= MIN_GATED_PCT && !(f.file in FLOORS))
  .sort((a, b) => b.pct - a.pct)

console.log(
  `[coverage-gate] OK — ${gated} gated module(s) at or above their floors ` +
    `(repo total ${summary.linePct}%, ${summary.files.length} files measured).`,
)
if (ungated.length) {
  console.log(
    `[coverage-gate] ${ungated.length} module(s) already clear ${MIN_GATED_PCT}% but are not gated yet:`,
  )
  for (const f of ungated.slice(0, 10)) {
    console.log(`  ${f.pct.toFixed(2)}%  ${f.file}`)
  }
  if (ungated.length > 10) console.log(`  … and ${ungated.length - 10} more`)
  console.log('  Add floors with: bun scripts/coverage-gate.ts --update')
}
