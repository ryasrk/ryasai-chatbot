#!/bin/bash
# reset.sh — reset database ke kondisi awal (fresh seed)
# Cara pakai:  bash reset.sh     atau   ./reset.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "⚠️  Semua data akan dihapus. Tekan Ctrl+C untuk batal..."
sleep 2

echo "🗑️  Menghapus database lama..."
rm -f db/custom.db db/custom.db-journal db/e2e.db db/e2e.db-journal

echo "📋 Membuat ulang schema..."
bunx prisma db push --accept-data-loss

echo "🌱 Seeding data awal..."
bun run scripts/seed.ts

echo ""
echo "✅ Database direset ke kondisi awal!"
echo ""
echo "Login:"
echo "  Admin    → admin@ryas.ai / admin12345"
echo "  Manager  → manager@ryas.ai / user12345"
echo "  Staff    → staff@ryas.ai / user12345"
