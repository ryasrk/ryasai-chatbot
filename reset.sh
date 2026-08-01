#!/bin/bash
# reset.sh — reset database to initial state (fresh seed)
# Usage:  bash reset.sh
set -euo pipefail
cd "$(dirname "$0")"

# Load env vars
set -a; . ./.env 2>/dev/null; set +a

echo "⚠️  All data will be deleted. Press Ctrl+C to cancel..."
sleep 2

echo "🗑️  Dropping schema..."
bunx prisma db push --accept-data-loss --force-reset

echo "📦 Creating pgvector extension..."
PGPASSWORD="${PGPASSWORD:-q}" psql -h localhost -U postgres -d ryasai -c 'CREATE EXTENSION IF NOT EXISTS vector;' 2>/dev/null || \
  sudo -n su postgres -c "psql -d ryasai -c 'CREATE EXTENSION IF NOT EXISTS vector;'" 2>/dev/null || \
  echo "⚠️  Could not create vector extension. Create it manually as superuser."

echo "📋 Applying schema..."
bunx prisma db push --accept-data-loss

echo "🌱 Seeding data..."
timeout 120 bun run scripts/seed.ts || true

echo ""
echo "✅ Database reset complete!"
echo ""
echo "Login:"
echo "  Admin    → admin@ryas.ai / admin12345"
echo "  Analyst  → manager@ryas.ai / user12345"
echo "  Viewer   → staff@ryas.ai / user12345"
