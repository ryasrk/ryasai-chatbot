#!/bin/bash
# reset.sh — reset database to initial state (fresh seed)
# Usage:  bash reset.sh
set -euo pipefail
cd "$(dirname "$0")"

# Load env vars
set -a; . ./.env 2>/dev/null; set +a

echo "⚠️  All data will be deleted. Press Ctrl+C to cancel..."
sleep 2

echo "🗑️  Dropping all tables..."
echo "q" | sudo -S su postgres -c "psql -d ryasai -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ryasai; GRANT ALL ON SCHEMA public TO public;'" 2>/dev/null || \
  PGPASSWORD="${PGPASSWORD:-q}" psql -h localhost -U postgres -d ryasai -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ryasai; GRANT ALL ON SCHEMA public TO public;' 2>/dev/null || \
  echo "⚠️  Could not drop schema. Try manually."

echo "📦 Creating pgvector extension..."
echo "q" | sudo -S su postgres -c "psql -d ryasai -c 'CREATE EXTENSION IF NOT EXISTS vector;'" 2>/dev/null || \
  PGPASSWORD="${PGPASSWORD:-q}" psql -h localhost -U postgres -d ryasai -c 'CREATE EXTENSION IF NOT EXISTS vector;' 2>/dev/null || \
  echo "⚠️  Could not create vector extension. Create it manually as superuser."

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
