#!/usr/bin/env sh
# Pre-commit hook — run lint + typecheck on staged files.
# ponytail: no husky/lint-staged dependency — just a shell script installed via `bun run prepare`.

echo "[pre-commit] Running lint + typecheck on staged files..."

# Typecheck (full project — TS doesn't have a per-file mode)
bunx tsc --noEmit --incremental
TSC_EXIT=$?
if [ $TSC_EXIT -ne 0 ]; then
  echo "[pre-commit] tsc failed — fix type errors before committing."
  exit 1
fi

# Lint (eslint with --max-warnings 0 would block on warnings; we only block on errors)
bun run lint -- --quiet
LINT_EXIT=$?
if [ $LINT_EXIT -ne 0 ]; then
  echo "[pre-commit] eslint found errors — fix before committing."
  exit 1
fi

echo "[pre-commit] OK — lint + typecheck clean."
exit 0
