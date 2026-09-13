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
  'src/app/api/billing/orders/[id]/route.ts': 85, // measured 92.59% (25/27)
  'src/app/api/billing/orders/route.ts': 90, // measured 96.00% (48/50)
  'src/app/api/billing/webhook/route.ts': 90, // measured 95.28% (101/106)
  'src/app/api/chat/sessions/route.ts': 85, // measured 93.62% (44/47)
  'src/app/api/documents/[id]/route.ts': 95, // measured 100.00% (169/169)
  'src/app/api/documents/[id]/reprocess/route.ts': 95, // measured 100.00% (55/55)
  'src/app/api/integrations/[id]/route.ts': 95, // measured 98.48% (195/198)
  'src/app/api/integrations/[id]/schema/route.ts': 95, // measured 97.38% (186/191)
  'src/app/api/integrations/route.ts': 80, // measured 88.10% (185/210)
  'src/app/api/mcp/servers/[id]/route.ts': 90, // measured 98.56% (137/139)
  'src/app/api/mcp/servers/route.ts': 85, // measured 94.67% (142/150)
  'src/app/api/metrics/route.ts': 95, // measured 100.00% (43/43)
  'src/app/api/notifications/route.ts': 80, // measured 88.57% (62/70)
  'src/app/api/prompt-tools/route.ts': 85, // measured 94.59% (35/37)
  'src/app/api/v1/agent/run/route.ts': 85, // measured 90.08% (118/131)
  'src/lib/async-worker.ts': 90, // measured 96.61% (57/59)
  'src/lib/billing-ui.ts': 95, // measured 100.00% (33/33)
  'src/lib/billing-verify.ts': 95, // measured 100.00% (18/18)
  'src/lib/bounded-concurrency.ts': 95, // measured 100.00% (22/22)
  'src/lib/chat-layout.ts': 95, // measured 100.00% (8/8)
  'src/lib/cognee-types.ts': 85, // measured 93.33% (14/15)
  'src/lib/constants.ts': 95, // measured 100.00% (21/21)
  'src/lib/conversation-export.ts': 95, // measured 100.00% (79/79)
  'src/lib/cron.ts': 90, // measured 99.09% (109/110)
  'src/lib/db-provider-presets.ts': 80, // measured 85.29% (29/34)
  'src/lib/db-provider.ts': 95, // measured 100.00% (3/3)
  'src/lib/db.ts': 85, // measured 91.67% (11/12)
  'src/lib/doc-versioning.ts': 90, // measured 97.53% (79/81)
  'src/lib/env-schema.ts': 95, // measured 100.00% (167/167)
  'src/lib/errors.ts': 80, // measured 85.48% (53/62)
  'src/lib/extract-error.ts': 95, // measured 100.00% (6/6)
  'src/lib/graceful-shutdown.ts': 85, // measured 92.11% (35/38)
  'src/lib/health-status.ts': 95, // measured 100.00% (14/14)
  'src/lib/hyde.ts': 95, // measured 100.00% (61/61)
  'src/lib/incoming-webhook.ts': 95, // measured 100.00% (40/40)
  // floor from MERGED coverage-summary.json: 87.50% (126/144). The per-file run
  // reports 100% (91/91); a floor of 95 pasted from that run is rejected by the
  // `suspicious` check below — which is exactly the trap it was written to catch.
  'src/lib/license-issue.ts': 85,
  'src/lib/llm-budget.ts': 95, // measured 100.00% (57/57)
  'src/lib/llm-client-openai.ts': 80, // measured 85.57% (172/201)
  'src/lib/llm-client-utils.ts': 85, // measured 90.27% (167/185)
  'src/lib/llm-client.ts': 80, // measured 89.53% (265/296)
  'src/lib/logger.ts': 85, // measured 94.44% (34/36)
  'src/lib/metrics.ts': 90, // measured 96.13% (149/155)
  'src/lib/midtrans.ts': 85, // measured 94.03% (63/67)
  'src/lib/order-reconcile.ts': 85, // measured 91.07% (51/56)
  'src/lib/passwords.ts': 80, // measured 88.89% (16/18)
  'src/lib/plan-gating.ts': 85, // measured 94.87% (37/39)
  'src/lib/pricing.ts': 95, // measured 100.00% (39/39)
  'src/lib/prompt-library.ts': 95, // measured 100.00% (34/34)
  'src/lib/prompt-settings.ts': 85, // measured 91.11% (41/45)
  'src/lib/public-config.ts': 80, // measured 88.89% (8/9)
  'src/lib/rag-eval.ts': 95, // measured 100.00% (73/73)
  'src/lib/rag-search-tester.ts': 90, // measured 98.08% (51/52)
  'src/lib/rag.ts': 85, // measured 90.65% (126/139)
  'src/lib/reflexion.ts': 95, // measured 100.00% (38/38)
  'src/lib/reranker.ts': 95, // measured 100.00% (36/36)
  // The OpenAI-compatible entry point. 79.40% -> 100.00% executable (370/370) with
  // the duplicated tool-run block extracted, so it meets the floor with no slack to
  // give back. Gated at 100 because a regression here breaks the public contract.
  'src/app/api/v1/chat/completions/route.ts': 100, // measured 100.00% (370/370)
  'src/lib/stream-preparers.ts': 80, // measured 100.00% executable (437/437); merged 82.14%
  'src/lib/session.ts': 80, // measured 89.56% (163/182)
  'src/lib/setup.ts': 95, // measured 100.00% (28/28)
  'src/lib/smart-router-helpers.ts': 80, // measured 88.06% (332/377)
  'src/lib/sso.ts': 85, // measured 87.97% (256/291) — RS256/JWKS path added this round
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
  'src/app/api/chat/sessions/[id]/send/route.ts': 85, // measured 87.08% (364/418), merged
  'src/lib/tool-registry.ts': 85, // measured 91.82% (247/269)
  'src/lib/tool-sandbox.ts': 85, // measured 93.75% (30/32)
  'src/lib/vector-stores.ts': 85, // measured 93.46% (343/367)
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
