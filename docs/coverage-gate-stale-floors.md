# Coverage gate: `coverage-summary.json` is stale, and the gate now fails in CI

**Status: OPEN. Not caused by the commits that exposed it.**

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

## Why it is stale-state drift, not a code regression

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

## The mechanism matters — most of these are NOT real coverage losses

Classifying each breaching file by whether its `hit` count moved:

| file | committed | regenerated | verdict |
|---|---|---|---|
| `mcp-client.ts` | 243/267 | 320/613 | **hits ROSE** → phantom denominator |
| `plugin-registry.ts` | 137/161 | 199/301 | **hits ROSE** → phantom |
| `ai.ts` | 417/567 | 430/601 | **hits ROSE** → phantom |
| `planner.ts` | 540/681 | 572/737 | **hits ROSE** → phantom |
| `plugin-selector.ts` | 181/204 | 191/237 | **hits ROSE** → phantom |
| `tool-registry.ts` | 258/269 | 262/281 | **hits ROSE** → phantom |
| `smart-router.ts` | 408/549 | 238/425 | hits FELL → real loss |
| `tool-router.ts` | 255/367 | 253/391 | hits FELL → real loss |

6 of 8 are the **phantom-record artifact already documented in `scripts/coverage.ts`**:
Bun emits zero-hit DA records for non-executable lines in suites that load a module
transitively, and `coverage.ts` merges per-line with `Math.max` — so `found` is a
scheduling-dependent union while `hit` counts agree across environments. More files
running (205 vs 200) inflates denominators without any code becoming less tested.

**2 files show a genuine hit decrease** (`smart-router.ts`, `tool-router.ts`) and need a
real look before anyone assumes this is all artifact.

## What to do

1. **Regenerate the baseline, then re-anchor floors.** Run `bun run coverage` on a clean
   tree and update the floors in `scripts/coverage-gate.ts` from the merged measurement —
   **never** from a single-file `--coverage` run (the gate says this itself).
2. **Attribute the two real losses** (`smart-router.ts`, `tool-router.ts`) to whatever
   commit removed their coverage before re-anchoring, or the re-anchor launders a genuine
   regression.
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
