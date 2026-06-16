#!/usr/bin/env bash
# Manual stamp card test for a real user + campaign (local or prod API).
#
# Usage:
#   export API_URL="http://localhost:4000/api"   # or your Render URL + /api
#   export CUSTOMER_EMAIL="omkar@gmail.com"
#   export CUSTOMER_PASSWORD="your-password"
#   export CAMPAIGN_NAME="stampNwin"             # optional — auto-picks if only one stamp campaign
#   export VENDOR_EMAIL="vendor@example.com"     # optional — to fetch live PIN
#   export VENDOR_PASSWORD="vendor-password"
#   ./scripts/test-stamp-manual-user.sh
#
# Simulate "next day" (already stamped today): run SQL first, see bottom of this file.

set -euo pipefail

API_URL="${API_URL:-http://localhost:4000/api}"
CUSTOMER_EMAIL="${CUSTOMER_EMAIL:?Set CUSTOMER_EMAIL}"
CUSTOMER_PASSWORD="${CUSTOMER_PASSWORD:?Set CUSTOMER_PASSWORD}"
CAMPAIGN_NAME="${CAMPAIGN_NAME:-stampNwin}"

echo "═══ Stamp manual test ═══"
echo "API: $API_URL"
echo "Customer: $CUSTOMER_EMAIL"
echo "Campaign: $CAMPAIGN_NAME"
echo ""

# 1) Customer sign-in
SIGNIN=$(curl -sS -X POST "$API_URL/auth/customer/signin" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$CUSTOMER_EMAIL\",\"password\":\"$CUSTOMER_PASSWORD\"}")

TOKEN=$(echo "$SIGNIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('token',''))" 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  echo "Sign-in failed:"
  echo "$SIGNIN" | python3 -m json.tool 2>/dev/null || echo "$SIGNIN"
  exit 1
fi
echo "✓ Signed in as customer"

# 2) Find campaign id from public businesses list
BUSINESSES=$(curl -sS "$API_URL/campaigns/public/businesses")
CAMPAIGN_ID=$(echo "$BUSINESSES" | python3 -c "
import sys, json, os
name = os.environ.get('CAMPAIGN_NAME', '').lower()
data = json.load(sys.stdin).get('data', [])
for b in data:
  for c in b.get('campaigns', []):
    if c.get('mechanic') == 'stamp' and (not name or c.get('name','').lower() == name):
      print(c['id'])
      raise SystemExit(0)
print('')
")

if [ -z "$CAMPAIGN_ID" ]; then
  echo "Campaign '$CAMPAIGN_NAME' not found in active public list."
  echo "$BUSINESSES" | python3 -m json.tool
  exit 1
fi
echo "✓ Campaign id: $CAMPAIGN_ID"

# 3) Stamp state (before)
echo ""
echo "── Stamp state (before) ──"
curl -sS "$API_URL/campaigns/$CAMPAIGN_ID/stamp-state" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 4) Live PIN (vendor) or manual
PIN="${STAFF_PIN:-}"
if [ -z "$PIN" ] && [ -n "${VENDOR_EMAIL:-}" ] && [ -n "${VENDOR_PASSWORD:-}" ]; then
  VT=$(curl -sS -X POST "$API_URL/auth/business/signin" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$VENDOR_EMAIL\",\"password\":\"$VENDOR_PASSWORD\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('token',''))")
  PIN=$(curl -sS "$API_URL/campaigns/$CAMPAIGN_ID/pin" \
    -H "Authorization: Bearer $VT" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('pin',''))")
fi

if [ -z "$PIN" ]; then
  echo ""
  echo "Set STAFF_PIN=123 or VENDOR_EMAIL + VENDOR_PASSWORD to auto-fetch PIN."
  echo "Skipping verify-pin + collect."
  exit 0
fi
echo "✓ Staff PIN: $PIN"

# 5) Verify PIN → play session
VERIFY=$(curl -sS -X POST "$API_URL/campaigns/$CAMPAIGN_ID/verify-pin" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"pin\":\"$PIN\"}")

PLAY_SESSION=$(echo "$VERIFY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('playSessionToken',''))" 2>/dev/null || true)
if [ -z "$PLAY_SESSION" ]; then
  echo "PIN verify failed:"
  echo "$VERIFY" | python3 -m json.tool 2>/dev/null || echo "$VERIFY"
  exit 1
fi
echo "✓ PIN verified"

# 6) Collect stamp
echo ""
echo "── Collect stamp ──"
COLLECT=$(curl -sS -X POST "$API_URL/campaigns/$CAMPAIGN_ID/stamp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"playSessionToken\":\"$PLAY_SESSION\"}")

echo "$COLLECT" | python3 -m json.tool

# 7) Stamp state (after)
echo ""
echo "── Stamp state (after) ──"
curl -sS "$API_URL/campaigns/$CAMPAIGN_ID/stamp-state" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 8) Wallet rewards
echo ""
echo "── Customer rewards ──"
curl -sS "$API_URL/campaigns/customer/rewards" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

echo ""
echo "Done. Check: stampsCollected, surpriseTriggerAt, bigTriggerAt, surpriseAwarded, bigAwarded"
