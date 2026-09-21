# Coverage gate: `coverage-summary.json` is stale, and the gate now fails in CI

**Status: OPEN. Not caused by the commits that exposed it — but it IS a real coverage
drop, not a stale number.**

## What is happening

`main`'s CI has been red for at least four commits (`d730425`, `0ae43da`, `6050fa1`,
`04b6807`). Two distinct defects were stacked, and fixing the first is what exposed the
second — the coverage gate had never actually run because "Unit tests" failed before it.

| step | before | after the test-env fix |
|---|---|---|
| Unit tests | **failure** | **success** |
| Coverage | skipped | success |
| Coverage gate | skipped | **failure** |

## The gate failure, precisely

```
[coverage-gate] floor(s) above the measured value — was this pasted from a per-file run?
  - src/lib/mcp-client.ts: floor 91% exceeds the merged measurement 52.20%
  - src/lib/plugin-registry.ts: floor 85% exceeds the merged measurement 66.11%
  - src/app/api/agent/dashboard/route.ts: floor 100% exceeds the merged measurement 99.30%
  - src/lib/tool-branches.ts: floor 84% exceeds the merged measurement 83.85%
  - src/lib/embeddings.ts: floor 82% exceeds the merged measurement 81.66%
  - src/lib/smart-router.ts: floor 74% exceeds the merged measurement 56.00%
  - src/lib/ai.ts: floor 73% exceeds the merged measurement 71.55%
  - src/lib/tool-router.ts: floor 69% exceeds the merged measurement 64.71%
  - src/lib/license-client.ts: floor 86% exceeds the merged measurement 84.87%
  - src/lib/llm-client-utils.ts: floor 84% exceeds the merged measurement 82.78%
  - src/lib/web-fetch.ts: floor 73% exceeds the merged measurement 72.62%
  - src/lib/planner.ts: floor 78% exceeds the merged measurement 77.61%
  - src/lib/plugin-selector.ts: floor 88% exceeds the merged measurement 80.59%
  - src/lib/tool-registry.ts: floor 95% exceeds the merged measurement 93.24%
```

## Why the gate passes locally and fails in CI

**The gate PASSES against the committed `coverage-summary.json` and FAILS against a
freshly generated one.** Verified directly:

```
git checkout coverage-summary.json
bun scripts/coverage-gate.ts
  → OK — 199 gated module(s) at or above their floors (repo total 86.8%, 200 files measured)
```

CI always regenerates, so CI always hits the failing path. The floors in
`scripts/coverage-gate.ts` were derived from a summary last regenerated at **`fed3489`
(2026-09-15)**. Since then:

- **19 commits** touching `src/`
- **50** `.ts` files under `src/lib` + `src/app` changed, **12** newly added

New files enter `coverage-summary.json` with their own hit/found contribution, and the
merged per-file denominator grows. Totals moved like this:

| | committed | regenerated |
|---|---|---|
| repo line % | 86.8 | 82.83 |
| linesHit | 22289 | 22877 |
| linesFound | **25679** | **27620** |
| filesMeasured | 200 | 205 |

## The mechanism — measured, and NOT the usual phantom artifact

Totals moved: `hit` **+588** but `found` **+1,941**. Hits do rise, so the easy
conclusion is "phantom denominator, nothing to see". Checking the repo's own
phantom-discounted figure says otherwise:

| metric | committed (`HEAD~3`) | regenerated | delta |
|---|---|---|---|
| linesHit / linesFound | 22289 / 25679 | 22877 / 27620 | +588 / +1941 |
| **reachableLinePct** | **95.87** | **92.48** | **−3.39pp** |
| reachableLinesHit / Found | 19322 / 20154 | 19810 / 21420 | +488 / **+1266** |

Reachable coverage — the figure that already discounts zero-hit records for
non-executable lines — **fell 3.4 points**. Hits rose, but reachable denominators
rose 2.6x faster. That is real dilution: newly added code is less covered than the
existing average, so the repo-wide percentage drops even though more lines are
covered in absolute terms.

Contributors, measured:

- **6 files** exist now that are absent from the older summary: they add
  `hit=655 / found=1464` all by themselves (44% covered — well below the 86.8%
  repo average).
- **19 existing files** grew their denominator by `+802 found` for `+304 hit`
  (38% on the increment).

Two runs over the identical tree produced **byte-identical** output (`hit=22877`,
`found=27620`), so this is not run-to-run noise and the "scheduling-dependent
union" caveat in `scripts/coverage.ts` does not explain it. The earlier draft of
this document guessed "mostly phantom"; the discounted figure disproves that
guess, which is exactly why the reachable metric exists.

An earlier version of this file also claimed 8 breaching files were "6 phantom /
2 real" based on whether `hit` rose. That framing was wrong in both directions and
is replaced by the reachable-coverage comparison above.

## What to do

1. **Do not just re-anchor.** The floors are below the measurement for 14 modules because
   real, mostly-untested code landed. Moving the floors to the new numbers would accept
   the 3.4pp drop permanently and erase the only signal that it happened. Prefer adding
   the missing tests; re-anchor only for the modules where the drop is genuinely
   unreachable-code accounting, with the reachable figure quoted as evidence.
2. **The worst offenders are new, not regressed.** `mcp-client.ts` went 243/267 → 320/613
   (hit up, found more than doubled) and `plugin-registry.ts` 137/161 → 199/301: both grew
   far faster than they were tested. That is where the tests are worth writing.
3. **Consider making staleness impossible.** The failure mode here is that floors live in
   one file and the measurement lives in another, with nothing detecting divergence until
   CI goes red on a fresh measurement. A gate that prints "summary is N commits stale" (or
   a required `bun run coverage` in the same commit as any `src/` change) would have caught
   this 19 commits ago.
4. **Do not simply delete the failing entries.** Per the repo's own guidance, a guard that
   fails your change should be understood, not weakened.

## The other defect in this area (FIXED)

`scripts/test.ts` and `scripts/coverage.ts` both built their child env without
`DATABASE_URL`, while Prisma resolves `env("DATABASE_URL")` at client construction. On CI
(which sets none) three files died with `Environment variable not found: DATABASE_URL` and
exit 101. Fixed by giving both scripts the same fallback, with the host deliberately
unreachable so a unit test cannot silently depend on real rows. Related: `ci.yml` states
"Unit suite needs no database", which was false and is the comment that made this look
like a mystery rather than a missing variable.
