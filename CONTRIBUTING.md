# Contributing

## Development Setup

```bash
bun install
bunx prisma db push
bunx prisma generate
bun run dev
```

## Before Submitting

All of the following must pass before opening a PR:

- `bunx tsc --noEmit` — 0 errors
- `bun run lint` — 0 errors
- `bun run test` — all tests pass
- `bun run e2e` and `bun run build && bun run e2e:prod` — validate browser behavior in development and in the shipped standalone build

## Code Style

- TypeScript strict mode; no `any` without justification.
- English in all strings, comments, and docs.
- Server-only libraries live in `src/lib/` and must never be imported into client components.
- Comments explain **why**, not **what**.
- No new dependencies without discussion.

## Branches — exactly two live, permanently

| branch | role | what may be pushed to it |
|---|---|---|
| `main` | **released**. Every commit here is a version customers can install. | only merged release PRs, and the `v*.*.*` tag that names the release |
| `dev` | **integration**. Work lands here first, CI runs, then it is promoted to `main` when a release is cut. | feature, fix and docs commits, directly or via a short-lived PR |

Everything else is **temporary and deleted after merge**. MEASURED REASON this rule exists: this repo
accumulated **18 local and 28 remote branches** — 14 of them from one session's PRs alone — so the branch
list stopped describing the project and started being an archive of finished work. Branch names are not
storage: once a PR is merged, `main` holds the commit and the branch name holds nothing.

The one exception is a bot's branch: `dependabot/**` is owned by Dependabot and is deleted when its PR
closes or merges. Do not delete one by hand while its PR is open.

```bash
# after a merge, delete the branch — both copies
git branch -d <branch>              # local, -d refuses an unmerged branch on purpose
git push origin --delete <branch>   # remote
```

**Verify a branch is merged before deleting it**, and check CONTENT rather than the commit graph: this
project squash-merges, so `git merge-base --is-ancestor <branch> main` reports a merged PR as "not merged"
because the original commits never entered `main`. `git diff main..<branch> --stat` showing only DELETIONS is
the signal that `main` is strictly ahead.

### After every release: merge `main` back into `dev`

**Do not skip this.** Squashing a `dev` branch onto `main` ALWAYS leaves the two diverged: the squashed commit
on `main` is not the commits on `dev`, so git sees `dev -> main` as permanently out of date and the next release
PR conflicts on every line the release touched.

```bash
git checkout dev && git merge origin/main     # resolves the version-number conflicts
```

The conflicts are almost always the version stamp, in the same files every time (`package.json`, `.env.example`,
`install.sh`, `otel.ts`, `public-config.ts`, `topbar.tsx`, `CHANGELOG.md`). **Resolve by one stated rule: the
NEWER version wins** — `dev` carries it. Deciding by "whichever side I read first" is how a release ends up stamped
with a version that is not the one being shipped, which is precisely what `release-version.test.ts` exists to
catch, and it will catch it only if you run it after resolving:

```bash
# ANCHOR THE PATTERN TO THE START OF A LINE, as git writes it. A bare `grep '<<<<<<<'` matches this very line —
# the literal appears in the documentation that tells you to look for it — so it reports a conflict on a clean tree
# and trains you to ignore the check. Measured: unanchored = 1 hit on a clean repo, anchored = 0.
grep -rlE '^<<<<<<< ' . --exclude-dir=node_modules --exclude-dir=.git   # MUST be empty
bun test src/lib/release-version.test.ts                               # all locations agree
```

TWO ALTERNATIVES, if the merge-back becomes annoying enough to justify them: merge `dev` into `main` with a merge
commit instead of squashing (the graph stays connected and nothing needs syncing), or rebase `dev` onto `main`
after each release (rewrites history, so it breaks anyone else with the branch checked out). The merge-back is
the cheapest of the three; pick deliberately rather than by accident.

## Release tagging — every release gets a tag

A moving image tag is a pointer, not a release: `:app` silently advances to whatever `main` last produced, so
"the version I tested" and "the version the customer runs" become different artifacts under one name, with
nothing to roll back TO. **Tag every release**, so a customer can pin and a rollback has a target.

| change | version | example |
|---|---|---|
| `fix:` only | **patch** | `1.0.0` → `1.0.1` |
| any `feat:`, no breaking change | **minor** | `1.0.0` → `1.1.0` |
| a breaking change (a customer must act) | **major** | `1.0.0` → `2.0.0` |

```bash
# 1. bump the version in ALL eight stamped locations (the guard lists them and fails if one lags)
bun test src/lib/release-version.test.ts
# 2. cut the CHANGELOG heading from [Unreleased] to the version and date
# 3. land it on main, then tag the commit main is AT
git tag -a v1.1.0 -m "Release 1.1.0" && git push origin v1.1.0
```

`docs/RELEASE.md` is the full checklist, including the steps no local test can do (the registry checks that
once shipped an install nobody could complete). `src/lib/release-version.test.ts` enforces that the tag, the
`version` field and the other stamped locations all agree — a tag that disagrees with the artifact produces an
image whose name says one version and whose UI displays another.

## Pull Request Process

- Squash merge is the default.
- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`.
- One logical change per PR.
- Include tests for new logic.
- **Delete the branch after merge.** See "Branches" above.

## Database releases

Production uses `bun run db:deploy` and versioned SQL in `prisma/migrations`.
Prototype changes with `db push` only on a development database, then generate
and review a migration. Test it against a fresh database and an upgraded copy.
The baseline snapshot is frozen; legacy adoption rejects an incompatible schema.
Before release, exercise backup/restore on a separate empty database and run
both `bun run e2e` and `bun run build && bun run e2e:prod`.

Live quality checks use the dedicated eval org's BYOK configuration and its
`EVAL_ENCRYPTION_SECRET_KEY`. Configure the workflow variables
`EVAL_RAG_GOLDEN_FILE` and `EVAL_SQL_GOLDEN_FILE` with reviewed repository paths.
Each set needs at least 40 questions. RAG requires a different judge model or
endpoint and no skipped judgements. SQL requires expected row counts and
first-row values on every case. Missing setup or failing thresholds fails the
live workflow; offline tests do not substitute for these measurements.
