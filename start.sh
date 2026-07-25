#!/bin/bash
# start.sh — mulai semua service (Next.js + scheduler)
# Cara pakai:  bash start.sh     atau   ./start.sh
# Hentikan dengan Ctrl+C
set -euo pipefail
cd "$(dirname "$0")"

pids=""

cleanup() {
    echo ""
    echo "🛑 Menghentikan semua service..."
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
    echo "✅ Semua service dihentikan."
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

# Cek database ada, kalau belum ada auto-reset
if [ ! -f db/custom.db ]; then
    echo "🗄️  Database belum ada, menjalankan setup awal..."
    bunx prisma db push --accept-data-loss
    bun run scripts/seed.ts
    echo ""
fi

echo "🚀 Memulai Next.js dev server (port $PORT)..."
bun run dev &
NEXT_PID=$!
pids="$NEXT_PID"

echo "🚀 Memulai scheduler worker..."
cd mini-services/scheduler
bun run index.ts &
SCHED_PID=$!
pids="$pids $SCHED_PID"
cd ../..

echo ""
echo "🎉 Semua service berjalan!"
echo "   Next.js     → http://localhost:$PORT"
echo "   Scheduler   → background worker"
echo ""
echo "💡 Tekan Ctrl+C untuk hentikan semua"
echo ""

wait
