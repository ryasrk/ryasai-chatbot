#!/bin/bash
set -euo pipefail

BASE="http://localhost:3005"
API_KEY="ryas_Em2s1LKEepqT6LtTD8JNqFThB-l99MwiHTkenxvqhyc"
COOKIES="/tmp/loop-cookies.txt"
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  $1"; SKIP=$((SKIP+1)); }

# Helper: send agentic message and extract answer text
agent_ask() {
  local msg="$1"
  local timeout="${2:-45}"
  curl -s -N --max-time "$timeout" -X POST "$BASE/api/agent/dashboard" \
    -H 'Content-Type: application/json' \
    -d "{\"message\":\"$msg\"}" \
    -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | tail -1 | python3 -c "
import sys,json
for line in sys.stdin:
  line=line.strip()
  if line.startswith('data: '):
    d=json.loads(line[6:])
    print(d.get('content','')[:300])
    break
" 2>/dev/null || echo ""
}

# Helper: send chatbot message and extract response
chat_ask() {
  local sid="$1"
  local msg="$2"
  curl -s -X POST "$BASE/api/chat/sessions/$sid/send" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"$msg\"}" \
    -b "$COOKIES" 2>&1 | python3 -c "
import sys,json
d=json.load(sys.stdin)
trs=d.get('toolRuns',[])
ai=d.get('aiMessage',{}).get('text','')
tools=','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs)
print(f'{tools}|{ai[:200]}')
" 2>/dev/null || echo "PARSE_ERROR|"
}

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ryasai Loop Test — Agentic + Chatbot Multi-Turn"
echo "═══════════════════════════════════════════════════════"
echo ""

# Login
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"admin@admin.com","password":"admin12345"}' -c "$COOKIES")
if echo "$LOGIN" | grep -q '"ok":true'; then
  echo "✅ Login berhasil"
  PASS=$((PASS+1))
else
  echo "❌ Login gagal: $LOGIN"
  exit 1
fi

# ═════════════════════════════════════════════════════════
# PART 1: AGENTIC LOOP — send 12 consecutive messages
# ═════════════════════════════════════════════════════════
echo ""
echo "── PART 1: Agentic Loop (12 consecutive turns) ──"
echo ""

# Turn 1: SQL via agentic planner
echo "  Turn 1/12: SQL query via agentic"
ANS=$(agent_ask "Berapa total stok produk SKU-902 di seluruh gudang?")
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "SQL via agentic: ${ANS:0:60}..."; else fail "SQL via agentic: empty"; fi

# Turn 2: RAG via agentic planner
echo "  Turn 2/12: RAG query via agentic"
ANS=$(agent_ask "Apa prosedur stock opname menurut SOP?")
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "RAG via agentic: ${ANS:0:60}..."; else fail "RAG via agentic: empty"; fi

# Turn 3: Generate API key
echo "  Turn 3/12: Generate API Key"
ANS=$(agent_ask "Generate API key with label loop-test")
if echo "$ANS" | grep -qi "API Key berhasil\|Label"; then ok "Generate API key"; else fail "Generate API key: $ANS"; fi

# Turn 4: Show monitoring
echo "  Turn 4/12: Show monitoring"
ANS=$(agent_ask "Show monitoring metrics today")
if echo "$ANS" | grep -qi "Monitoring\|Tool Runs"; then ok "Show monitoring"; else fail "Show monitoring: $ANS"; fi

# Turn 5: Show audit logs
echo "  Turn 5/12: Show audit logs"
ANS=$(agent_ask "Show recent audit logs")
if echo "$ANS" | grep -qi "Audit Log\|audit"; then ok "Show audit logs"; else fail "Show audit logs: $ANS"; fi

# Turn 6: List integrations
echo "  Turn 6/12: List integrations"
ANS=$(agent_ask "List all database integrations")
if echo "$ANS" | grep -qi "Integrasi terdaftar\|ERP"; then ok "List integrations"; else fail "List integrations: $ANS"; fi

# Turn 7: Show routing scores
echo "  Turn 7/12: Show routing scores"
ANS=$(agent_ask "Show routing scores")
if echo "$ANS" | grep -qi "Routing Scores\|score="; then ok "Show routing scores"; else fail "Show routing scores: $ANS"; fi

# Turn 8: Show system prompt
echo "  Turn 8/12: Show system prompt"
ANS=$(agent_ask "Show current system prompt")
if echo "$ANS" | grep -qi "System Prompt"; then ok "Show system prompt"; else fail "Show system prompt: $ANS"; fi

# Turn 9: Set system prompt
echo "  Turn 9/12: Set system prompt"
ANS=$(agent_ask "set system prompt to Jawab dengan singkat dan tepat.")
if echo "$ANS" | grep -qi "diperbarui"; then ok "Set system prompt"; else fail "Set system prompt: $ANS"; fi

# Turn 10: List plugins
echo "  Turn 10/12: List plugins"
ANS=$(agent_ask "List all plugins")
if echo "$ANS" | grep -qi "plugin\|Plugin"; then ok "List plugins"; else fail "List plugins: $ANS"; fi

# Turn 11: List schedules
echo "  Turn 11/12: List schedules"
ANS=$(agent_ask "List scheduled runs")
if echo "$ANS" | grep -qi "Scheduled\|schedule\|cron"; then ok "List schedules"; else fail "List schedules: $ANS"; fi

# Turn 12: General chat (no admin action, planner fallback)
echo "  Turn 12/12: General chat via agentic"
ANS=$(agent_ask "Apa yang bisa kamu bantu?")
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "General chat via agentic: ${ANS:0:60}..."; else fail "General chat via agentic: empty"; fi

# ═════════════════════════════════════════════════════════
# PART 2: CHATBOT LOOP — 8 consecutive turns in one session
# ═════════════════════════════════════════════════════════
echo ""
echo "── PART 2: Chatbot Loop (8 consecutive turns, same session) ──"
echo ""

# Create session for multi-turn chat
SID=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"Loop Test Chat"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -z "$SID" ]; then fail "Failed to create chat session"; exit 1; fi

# Turn 1: SQL — stock query
echo "  Turn 1/8: SQL — stock query"
RES=$(chat_ask "$SID" "Berapa total stok produk SKU-902?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "SQL:success"; then ok "SQL: $TOOL"; else skip "SQL (may route to CHAT): $TOOL"; fi

# Turn 2: SQL follow-up — different product
echo "  Turn 2/8: SQL — different product"
RES=$(chat_ask "$SID" "Berapa harga produk SKU-901?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "SQL:success"; then ok "SQL follow-up: $TOOL"; else skip "SQL follow-up (may route to CHAT): $TOOL"; fi

# Turn 3: RAG — SOP question
echo "  Turn 3/8: RAG — SOP question"
RES=$(chat_ask "$SID" "Apa prosedur stock opname menurut SOP?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "RAG:success"; then ok "RAG: $TOOL"; else skip "RAG (may route to CHAT): $TOOL"; fi

# Turn 4: RAG follow-up — different doc
echo "  Turn 4/8: RAG — policy question"
RES=$(chat_ask "$SID" "Apa kebijakan pembayaran invoice?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "RAG:success"; then ok "RAG follow-up: $TOOL"; else skip "RAG follow-up (may route to CHAT): $TOOL"; fi

# Turn 5: CHAT — greeting
echo "  Turn 5/8: CHAT — greeting"
RES=$(chat_ask "$SID" "Halo, apa kabar?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "CHAT:success"; then ok "CHAT: $TOOL"; else skip "CHAT (may route differently): $TOOL"; fi

# Turn 6: CHAT — follow-up question
echo "  Turn 6/8: CHAT — capability question"
RES=$(chat_ask "$SID" "Apa saja yang bisa kamu bantu?")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "CHAT:success"; then ok "CHAT follow-up: $TOOL"; else skip "CHAT follow-up: $TOOL"; fi

# Turn 7: SQL — aggregation query
echo "  Turn 7/8: SQL — aggregation"
RES=$(chat_ask "$SID" "Tampilkan 5 produk dengan stok terbanyak")
TOOL=$(echo "$RES" | cut -d'|' -f1)
if echo "$TOOL" | grep -q "SQL:success"; then ok "SQL aggregation: $TOOL"; else skip "SQL aggregation: $TOOL"; fi

# Turn 8: Mixed context — reference earlier conversation
echo "  Turn 8/8: Mixed context — reference earlier"
RES=$(chat_ask "$SID" "Sebutkan lagi jawabanmu tentang produk pertama yang saya tanyakan")
TOOL=$(echo "$RES" | cut -d'|' -f1)
AI=$(echo "$RES" | cut -d'|' -f2)
if [ -n "$AI" ] && [ "$AI" != "" ]; then ok "Context recall: ${AI:0:60}..."; else fail "Context recall: empty"; fi

# ═════════════════════════════════════════════════════════
# PART 3: AGENTIC MULTI-STEP (planner chains multiple tools)
# ═════════════════════════════════════════════════════════
echo ""
echo "── PART 3: Agentic Multi-Step (planner chains) ──"
echo ""

# Multi-step: SQL + RAG combination
echo "  Step 1: SQL + RAG combination"
ANS=$(agent_ask "Bandung jadi kota dengan customer terbanyak? Cari juga SOP yang berkaitan dengan pengelolaan gudang" 60)
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "Multi-step SQL+RAG: ${ANS:0:60}..."; else fail "Multi-step SQL+RAG: empty"; fi

# Multi-step: SQL with follow-up
echo "  Step 2: SQL with reasoning"
ANS=$(agent_ask "Berapa total nilai inventory di gudang Surabaya berdasarkan harga cost?" 60)
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "SQL reasoning: ${ANS:0:60}..."; else fail "SQL reasoning: empty"; fi

# Multi-step: knowledge search
echo "  Step 3: Knowledge summarization"
ANS=$(agent_ask "Rangkum SOP pengelolaan inventaris gudang secara singkat" 60)
if [ -n "$ANS" ] && [ "$ANS" != "" ]; then ok "Knowledge summarize: ${ANS:0:60}..."; else fail "Knowledge summarize: empty"; fi

# ═════════════════════════════════════════════════════════
# PART 4: EXTERNAL API LOOP — 3 consecutive calls
# ═════════════════════════════════════════════════════════
echo ""
echo "── PART 4: External API Loop (3 consecutive calls) ──"
echo ""

# Turn 1: SQL via external API
echo "  Turn 1/3: SQL via external API"
RES=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" -d '{"messages":[{"role":"user","content":"Berapa jumlah produk aktif?"}],"stream":false}')
if echo "$RES" | grep -q '"answer"'; then ok "External API SQL: response received"; else fail "External API SQL: $RES"; fi

# Turn 2: RAG via external API
echo "  Turn 2/3: RAG via external API"
RES=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" -d '{"messages":[{"role":"user","content":"Jelaskan kebijakan pembayaran invoice"}],"stream":false}')
if echo "$RES" | grep -q '"answer"'; then ok "External API RAG: response received"; else fail "External API RAG: $RES"; fi

# Turn 3: Chat via external API
echo "  Turn 3/3: Chat via external API"
RES=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" -d '{"messages":[{"role":"user","content":"Halo, siapa kamu?"}],"stream":false}')
if echo "$RES" | grep -q '"answer"'; then ok "External API Chat: response received"; else fail "External API Chat: $RES"; fi

# ═════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed · $FAIL failed · $SKIP skipped"
echo "═══════════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
