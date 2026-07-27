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
- `bun run e2e` — run if your change touches UI

## Code Style

- TypeScript strict mode; no `any` without justification.
- English in all strings, comments, and docs.
- Server-only libraries live in `src/lib/` and must never be imported into client components.
- Comments explain **why**, not **what**.
- No new dependencies without discussion.

## Pull Request Process

- Squash merge is the default.
- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`.
- One logical change per PR.
- Include tests for new logic.
