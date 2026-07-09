#!/bin/bash
# Quick setup & run lottery E2E test
set -e

echo "🎟️ Lottery E2E Test Suite"
echo "=========================="
echo

# Build backend
echo "📦 Building backend..."
npm run build > /dev/null 2>&1
echo "✅ Built"
echo

# Ensure backend is running
if ! nc -z localhost 4000 2>/dev/null; then
  echo "🚀 Starting backend..."
  npm start &
  sleep 3
fi

echo "📝 Running E2E test..."
echo
npx ts-node scripts/test-lottery-e2e.ts

echo
echo "✅ E2E test complete!"
echo
echo "To manually trigger draw for a specific campaign:"
echo "  npx ts-node scripts/trigger-lottery-draw.ts <campaignId>"
