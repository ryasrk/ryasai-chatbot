#!/bin/bash
# start.sh — start all services (Next.js + scheduler)
# Usage:  bash start.sh   or   ./start.sh
# Stop with Ctrl+C
set -euo pipefail
cd "$(dirname "$0")"

pids=""

cleanup() {
    echo ""
    echo "Stopping all services..."
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    echo "All services stopped."
    exit 0
}
trap cleanup INT TERM

# Load .env
if [ -f .env ]; then
    set -a
    . .env 2>/dev/null
    set +a
fi

PORT="${PORT:-3000}"

# Check if database has tables — only seed if empty
TABLE_COUNT=$(PGPASSWORD="${PGPASSWORD:-ryasai_dev}" psql -h localhost -U ryasai -d ryasai -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ' || echo "0")

if [ "$TABLE_COUNT" = "0" ] || [ -z "$TABLE_COUNT" ]; then
    echo "Database is empty, running initial setup..."
    echo "q" | sudo -S su postgres -c "psql -d ryasai -c 'CREATE EXTENSION IF NOT EXISTS vector;'" 2>/dev/null || true
    bunx prisma db push --accept-data-loss
    bun run scripts/seed.ts
    echo ""
else
    echo "Database has $TABLE_COUNT tables. Skipping setup."
fi

echo "Starting Next.js dev server (port $PORT)..."
bun run dev &
NEXT_PID=$!
pids="$NEXT_PID"

echo "Starting scheduler worker..."
cd mini-services/scheduler
bun run index.ts &
SCHED_PID=$!
pids="$pids $SCHED_PID"
cd ../..

echo ""
echo "All services running!"
echo "   Next.js   -> http://localhost:$PORT"
echo "   Scheduler -> background worker"
echo ""
echo "Press Ctrl+C to stop all"
echo ""

wait
