#!/bin/bash
# reset.sh — reset database to initial state (fresh seed)
# Usage:  bash reset.sh
set -euo pipefail
cd "$(dirname "$0")"

# Load env vars
set -a; . ./.env 2>/dev/null; set +a

DB_NAME="${DB_NAME:-ryasai}"
DB_USER="${DB_USER:-ryasai}"

# ponytail: the old version piped 'echo "q" | sudo -S' and fell back to
# PGPASSWORD=q — a silent junk-password brute that either hung on a sudo prompt
# or failed invisibly, leaving a half-reset DB. Now: detect a usable privilege
# path up front and fail with clear instructions otherwise.
run_psql_as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    su postgres -c "psql -d $DB_NAME $1"
  elif sudo -n true 2>/dev/null; then
    # passwordless sudo only — we cannot answer an interactive password prompt
    # reliably from this script (and must never guess one)
    sudo -n su postgres -c "psql -d $DB_NAME $1"
  elif command -v psql >/dev/null && [ -n "${PGPASSWORD:-}" ] && [ -n "${PG_SUPERUSER:-}" ]; then
    # explicit operator-provided superuser credentials (no defaults, no guessing)
    PGPASSWORD="$PGPASSWORD" psql -h "${PGHOST:-localhost}" -U "$PG_SUPERUSER" -d "$DB_NAME" -c "$1"
  else
    echo "ERROR: cannot run psql as the postgres superuser." >&2
    echo "Provide ONE of:" >&2
    echo "  • run as root:            sudo bash reset.sh" >&2
    echo "  • passwordless sudo:      configure NOPASSWD for \$USER" >&2
    echo "  • superuser credentials:  export PG_SUPERUSER=postgres PGPASSWORD=... (and optionally PGHOST)" >&2
    exit 1
  fi
}

echo "⚠️  All data will be deleted. Press Ctrl+C to cancel..."
sleep 2

echo "🗑️  Dropping all tables..."
run_psql_as_postgres "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER; GRANT ALL ON SCHEMA public TO public;"

echo "📦 Creating pgvector extension..."
run_psql_as_postgres "CREATE EXTENSION IF NOT EXISTS vector;"

echo "📋 Applying schema..."
bunx prisma db push --accept-data-loss

echo "🌱 Seeding data..."
bun run scripts/seed.ts

echo ""
echo "✅ Database reset complete!"
echo ""
echo "Pure empty state. Start the app and register:"
echo "  1. Register (name, email, password)"
echo "  2. Activate License (enter license key)"
echo "  3. Setup Wizard (LLM config, etc.)"
