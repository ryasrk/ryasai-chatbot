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

# Coverage gate — only when a report already exists, so this stays fast. It reads
# coverage-summary.json rather than re-measuring (a full run takes ~20 minutes and
# nobody would keep a 20-minute pre-commit hook). If tests were changed without
# refreshing the report, CI still runs the real measurement.
if [ -f coverage-summary.json ]; then
  NEWER=$(find src scripts -newer coverage-summary.json -name '*.test.ts' 2>/dev/null | head -1)
  if [ -n "$NEWER" ]; then
    echo "[pre-commit] Test files changed since coverage-summary.json — refreshing is the job of 'bun run coverage'."
    echo "[pre-commit] Skipping the gate here; CI will run it against a fresh measurement."
  else
    bun scripts/coverage-gate.ts
    GATE_EXIT=$?
    if [ $GATE_EXIT -ne 0 ]; then
      echo "[pre-commit] coverage regressed — see scripts/coverage-gate.ts"
      exit 1
    fi
  fi
fi

echo "[pre-commit] OK — lint + typecheck clean."
exit 0
