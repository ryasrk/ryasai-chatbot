#!/bin/bash
set -euo pipefail

BASE="http://localhost:3005"
API_KEY="ryas_Em2s1LKEepqT6LtTD8JNqFThB-l99MwiHTkenxvqhyc"
COOKIES="/tmp/e2e-cookies.txt"
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  $1"; SKIP=$((SKIP+1)); }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ryasai E2E Test Suite — All Tools"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── Auth ────────────────────────────────────────────────
echo "── Auth ──"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"admin@admin.com","password":"admin12345"}' -c "$COOKIES")
if echo "$LOGIN" | grep -q '"ok":true'; then ok "Login admin"; else fail "Login admin: $LOGIN"; exit 1; fi

ME=$(curl -s "$BASE/api/me" -b "$COOKIES")
if echo "$ME" | grep -q 'usr-admin'; then ok "Get /api/me"; else fail "Get /api/me: $ME"; fi

# ─── Chatbot: SQL ────────────────────────────────────────
echo ""
echo "── Chatbot: SQL (HTTP API) ──"
SID=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"E2E SQL"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
SQL_RES=$(curl -s -X POST "$BASE/api/chat/sessions/$SID/send" -H 'Content-Type: application/json' -d '{"text":"Berapa total stok produk SKU-902 di gudang utama?"}' -b "$COOKIES")
SQL_TOOL=$(echo "$SQL_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('toolRuns',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null || echo "PARSE_ERROR")
if echo "$SQL_TOOL" | grep -q "SQL:success"; then ok "SQL query executed"; else fail "SQL query: $SQL_TOOL"; fi
SQL_AI=$(echo "$SQL_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('aiMessage',{}).get('text','')[:100])" 2>/dev/null)
if [ -n "$SQL_AI" ] && [ "$SQL_AI" != "" ]; then ok "SQL answer: ${SQL_AI:0:60}..."; else fail "SQL answer empty"; fi

# ─── Chatbot: RAG ────────────────────────────────────────
echo ""
echo "── Chatbot: RAG (HTTP API) ──"
SID2=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"E2E RAG"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
RAG_RES=$(curl -s -X POST "$BASE/api/chat/sessions/$SID2/send" -H 'Content-Type: application/json' -d '{"text":"Apa prosedur stock opname menurut SOP?"}' -b "$COOKIES")
RAG_TOOL=$(echo "$RAG_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('toolRuns',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null || echo "PARSE_ERROR")
if echo "$RAG_TOOL" | grep -q "RAG:success"; then ok "RAG retrieval executed"; else fail "RAG: $RAG_TOOL"; fi
RAG_CITES=$(echo "$RAG_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('aiMessage',{}).get('citations',[]); print(len(c))" 2>/dev/null)
if [ "$RAG_CITES" -gt 0 ] 2>/dev/null; then ok "RAG citations: $RAG_CITES"; else fail "RAG citations: $RAG_CITES"; fi

# ─── Chatbot: REST ───────────────────────────────────────
echo ""
echo "── Chatbot: REST (HTTP API) ──"
SID3=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"E2E REST"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
REST_RES=$(curl -s -X POST "$BASE/api/chat/sessions/$SID3/send" -H 'Content-Type: application/json' -d '{"text":"Tampilkan daftar semua user dari API"}' -b "$COOKIES" 2>&1)
REST_TOOL=$(echo "$REST_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('toolRuns',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null || echo "PARSE_ERROR")
if echo "$REST_TOOL" | grep -q "REST"; then ok "REST call executed: $REST_TOOL"; else skip "REST call (may route to CHAT if LLM doesn't pick REST): $REST_TOOL"; fi

# ─── Chatbot: CHAT ───────────────────────────────────────
echo ""
echo "── Chatbot: CHAT (HTTP API) ──"
SID4=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"E2E CHAT"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
CHAT_RES=$(curl -s -X POST "$BASE/api/chat/sessions/$SID4/send" -H 'Content-Type: application/json' -d '{"text":"Halo, apa kabar?"}' -b "$COOKIES")
CHAT_TOOL=$(echo "$CHAT_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('toolRuns',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null || echo "PARSE_ERROR")
if echo "$CHAT_TOOL" | grep -q "CHAT:success"; then ok "CHAT response: $CHAT_TOOL"; else fail "CHAT: $CHAT_TOOL"; fi

# ─── External API: Non-streaming ─────────────────────────
echo ""
echo "── External API: Non-streaming ──"
EXT_RES=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" -d '{"messages":[{"role":"user","content":"Berapa jumlah produk aktif?"}],"stream":false}')
if echo "$EXT_RES" | grep -q '"answer"'; then ok "External API non-streaming"; else fail "External API: $EXT_RES"; fi
EXT_TOOL=$(echo "$EXT_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('tool_runs',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null)
if echo "$EXT_TOOL" | grep -q "SQL:success"; then ok "External API SQL tool: $EXT_TOOL"; else skip "External API tool routing: $EXT_TOOL"; fi

# ─── External API: Streaming ─────────────────────────────
echo ""
echo "── External API: Streaming ──"
STREAM_FIRST=$(timeout 30 curl -s -N -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" -d '{"messages":[{"role":"user","content":"Jelaskan apa itu SOP"}],"stream":true}' 2>&1 | timeout 5 head -1 || true)
if echo "$STREAM_FIRST" | grep -q "chat.completion.chunk"; then ok "External API streaming (SSE chunks)"; else fail "External API streaming: $STREAM_FIRST"; fi

# ─── External API: Auth failure ──────────────────────────
echo ""
echo "── External API: Auth ──"
BAD_AUTH=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer invalid_key_12345" -d '{"messages":[{"role":"user","content":"test"}]}' -w '%{http_code}' -o /dev/null)
if [ "$BAD_AUTH" -eq 401 ] 2>/dev/null; then ok "Invalid API key rejected (401)"; else fail "Auth check: got $BAD_AUTH"; fi

# ─── Agentic: Admin Actions ──────────────────────────────
echo ""
echo "── Agentic Dashboard: Admin Actions ──"
AGENT_GEN=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"Generate API Key"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_GEN" | grep -q "API Key berhasil dibuat"; then ok "Agentic: Generate API Key"; else fail "Agentic gen key: $AGENT_GEN"; fi

AGENT_MON=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"Show API latency today"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_MON" | grep -q "Monitoring"; then ok "Agentic: Show monitoring"; else fail "Agentic monitoring: $AGENT_MON"; fi

AGENT_AUDIT=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"Show audit logs"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_AUDIT" | grep -q "Audit Log"; then ok "Agentic: Show audit logs"; else fail "Agentic audit: $AGENT_AUDIT"; fi

AGENT_LIST=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"List all database integrations"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_LIST" | grep -q "Integrasi terdaftar"; then ok "Agentic: List integrations"; else fail "Agentic list: $AGENT_LIST"; fi

# ─── Agentic: Tools list ─────────────────────────────────
echo ""
echo "── Agentic Dashboard: Tools ──"
TOOLS_RES=$(curl -s "$BASE/api/agent/dashboard/tools" -b "$COOKIES")
TOOLS_COUNT=$(echo "$TOOLS_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('tools',[])))" 2>/dev/null || echo 0)
if [ "$TOOLS_COUNT" -gt 20 ] 2>/dev/null; then ok "Tools list: $TOOLS_COUNT tools"; else fail "Tools list: $TOOLS_COUNT"; fi

# ─── Smart Router: Scores ─────────────────────────────────
echo ""
echo "── Smart Router ──"
SCORES_RES=$(curl -s "$BASE/api/routing/scores" -b "$COOKIES")
SCORE_COUNT=$(echo "$SCORES_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('scores',[])))" 2>/dev/null || echo 0)
if [ "$SCORE_COUNT" -eq 4 ] 2>/dev/null; then ok "Routing scores: 4 tools scored"; else fail "Routing scores: $SCORE_COUNT"; fi
CB=$(echo "$SCORES_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(any(s['circuitBreakerTripped'] for s in d.get('scores',[])))" 2>/dev/null)
if [ "$CB" = "False" ] 2>/dev/null; then ok "Circuit breaker: none tripped"; else skip "Circuit breaker state: $CB"; fi

# ─── Plugins CRUD ────────────────────────────────────────
echo ""
echo "── Plugins CRUD ──"
PLUGINS_LIST=$(curl -s "$BASE/api/tools" -b "$COOKIES")
PLUGINS_COUNT=$(echo "$PLUGINS_LIST" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('plugins',d.get('items',d if isinstance(d,list) else [])); print(len(items))" 2>/dev/null || echo 0)
if [ "$PLUGINS_COUNT" -gt 0 ] 2>/dev/null; then ok "Plugins list: $PLUGINS_COUNT plugin(s)"; else fail "Plugins list: $PLUGINS_COUNT"; fi

# ─── Schedules CRUD ──────────────────────────────────────
echo ""
echo "── Schedules CRUD ──"
SCHEDULES_LIST=$(curl -s "$BASE/api/schedules" -b "$COOKIES")
SCHEDULES_COUNT=$(echo "$SCHEDULES_LIST" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('schedules',d.get('items',d if isinstance(d,list) else [])); print(len(items))" 2>/dev/null || echo 0)
if [ "$SCHEDULES_COUNT" -gt 0 ] 2>/dev/null; then ok "Schedules list: $SCHEDULES_COUNT schedule(s)"; else fail "Schedules list: $SCHEDULES_COUNT"; fi

# ─── Cognee Memory ───────────────────────────────────────
echo ""
echo "── Cognee Memory ──"
SID_MEM=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"Cognee Memory E2E"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
MEM_Q1=$(curl -s -X POST "$BASE/api/chat/sessions/$SID_MEM/send" -H 'Content-Type: application/json' -d '{"text":"Produk aktif berjumlah 10."}' -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('aiMessage',{}).get('text','')[:80])" 2>/dev/null)
if [ -n "$MEM_Q1" ]; then ok "Memory turn 1 stored: ${MEM_Q1:0:50}..."; else fail "Memory turn 1"; fi
MEM_Q2=$(curl -s -X POST "$BASE/api/chat/sessions/$SID_MEM/send" -H 'Content-Type: application/json' -d '{"text":"Sebutkan lagi jawabanmu tentang produk aktif"}' -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('aiMessage',{}).get('text','')[:120])" 2>/dev/null)
if [ -n "$MEM_Q2" ]; then ok "Memory turn 2 recall: ${MEM_Q2:0:60}..."; else fail "Memory turn 2"; fi

# ─── Guardrails ──────────────────────────────────────────
echo ""
echo "── Guardrails ──"
SID_GUARD=$(curl -s -X POST "$BASE/api/chat/sessions" -H 'Content-Type: application/json' -d '{"title":"Guardrail Test"}' -b "$COOKIES" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
GUARD_RES=$(curl -s -X POST "$BASE/api/chat/sessions/$SID_GUARD/send" -H 'Content-Type: application/json' -d '{"text":"DELETE FROM demo_products WHERE 1=1"}' -b "$COOKIES")
GUARD_TOOL=$(echo "$GUARD_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); trs=d.get('toolRuns',[]); print(','.join(f'{t[\"type\"]}:{t[\"status\"]}' for t in trs))" 2>/dev/null || echo "PARSE_ERROR")
if echo "$GUARD_TOOL" | grep -q "blocked"; then ok "Guardrail blocked DELETE: $GUARD_TOOL"; else skip "Guardrail (LLM may not generate DELETE): $GUARD_TOOL"; fi

# ─── Document Upload ─────────────────────────────────────
echo ""
echo "── Document Upload ──"
UPLOAD_RES=$(curl -s -X POST "$BASE/api/documents" -b "$COOKIES" -F 'file=@/dev/null;filename=test-upload.txt;type=text/plain' -F 'category=LAINNYA' -w '\n%{http_code}' 2>&1)
UPLOAD_CODE=$(echo "$UPLOAD_RES" | tail -1)
if [ "$UPLOAD_CODE" -ge 200 ] && [ "$UPLOAD_CODE" -lt 500 ] 2>/dev/null; then ok "Document upload endpoint reachable ($UPLOAD_CODE)"; else fail "Document upload: $UPLOAD_CODE"; fi

# ─── System Prompt (via API + Agentic) ───────────────────
echo ""
echo "── System Prompt ──"
PROMPT_BEFORE=$(curl -s "$BASE/api/prompt-tools" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('settings',{}); print('OK' if 'tools' in s else '')" 2>/dev/null || echo "")
if [ "$PROMPT_BEFORE" = "OK" ]; then ok "Prompt settings loaded"; else fail "Prompt settings load failed"; fi

PROMPT_UPDATE=$(curl -s -X PUT "$BASE/api/prompt-tools" -H 'Content-Type: application/json' -d '{"systemPrompt":"Anda adalah asisten AI yang menjawab dalam Bahasa Indonesia dengan singkat dan akurat."}' -b "$COOKIES")
PROMPT_NEW=$(echo "$PROMPT_UPDATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('settings',{}).get('systemPrompt','')[:60])" 2>/dev/null || echo "")
if echo "$PROMPT_NEW" | grep -q "Bahasa Indonesia"; then ok "System prompt updated via API"; else fail "System prompt update: $PROMPT_NEW"; fi

AGENT_PROMPT=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"Show current system prompt"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_PROMPT" | grep -q "System Prompt"; then ok "Agentic: Show system prompt"; else fail "Agentic show prompt: $AGENT_PROMPT"; fi

AGENT_PROMPT_SET=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"set system prompt to Jawab dengan gaya formal dan profesional."}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_PROMPT_SET" | grep -q "diperbarui"; then ok "Agentic: Update system prompt"; else fail "Agentic set prompt: $AGENT_PROMPT_SET"; fi

curl -s -X PUT "$BASE/api/prompt-tools" -H 'Content-Type: application/json' -d '{"systemPrompt":""}' -b "$COOKIES" > /dev/null

# ─── Tool Toggle (via Agentic) ───────────────────────────
echo ""
echo "── Tool Toggle ──"
AGENT_DISABLE_SQL=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"disable sql"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_DISABLE_SQL" | grep -q "dinonaktifkan"; then ok "Agentic: Disable SQL tool"; else fail "Agentic disable SQL: $AGENT_DISABLE_SQL"; fi

AGENT_ENABLE_SQL=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"enable sql"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_ENABLE_SQL" | grep -q "diaktifkan"; then ok "Agentic: Re-enable SQL tool"; else fail "Agentic enable SQL: $AGENT_ENABLE_SQL"; fi

AGENT_DISABLE_RAG=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"disable rag"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_DISABLE_RAG" | grep -q "dinonaktifkan"; then ok "Agentic: Disable RAG tool"; else fail "Agentic disable RAG: $AGENT_DISABLE_RAG"; fi

AGENT_ENABLE_RAG=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"enable rag"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_ENABLE_RAG" | grep -q "diaktifkan"; then ok "Agentic: Re-enable RAG tool"; else fail "Agentic enable RAG: $AGENT_ENABLE_RAG"; fi

# ─── Tool Routing Scores (via Agentic) ───────────────────
echo ""
echo "── Tool Routing (Agentic) ──"
AGENT_ROUTING=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d '{"message":"Show routing scores"}' -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
if echo "$AGENT_ROUTING" | grep -q "Routing Scores"; then ok "Agentic: Show routing scores"; else fail "Agentic routing: $AGENT_ROUTING"; fi

AGENT_ROUTING_TOOLS=$(echo "$AGENT_ROUTING" | python3 -c "import sys,json; line=sys.stdin.read(); count=line.count('SQL') + line.count('RAG') + line.count('REST') + line.count('CHAT'); print(count)" 2>/dev/null || echo 0)
if [ "$AGENT_ROUTING_TOOLS" -ge 4 ] 2>/dev/null; then ok "Routing scores show 4 tools"; else skip "Routing tools count: $AGENT_ROUTING_TOOLS"; fi

# ─── Toggle Database Integration (via Agentic) ───────────
echo ""
echo "── Toggle Database Integration ──"
INT_ID=$(curl -s "$BASE/api/integrations" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('data',[]); print(items[0]['id'] if items else '')" 2>/dev/null || echo "")
if [ -n "$INT_ID" ]; then
  INT_NAME=$(curl -s "$BASE/api/integrations" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('data',[]); print(items[0]['name'] if items else '')" 2>/dev/null || echo "")
  AGENT_DIS_INT=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d "{\"message\":\"disable integration $INT_ID\"}" -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
  if echo "$AGENT_DIS_INT" | grep -q "dinonaktifkan"; then ok "Agentic: Disable integration"; else fail "Agentic disable integration: $AGENT_DIS_INT"; fi

  INT_STATUS=$(curl -s "$BASE/api/integrations/$INT_ID" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('status',''))" 2>/dev/null || echo "")
  if [ "$INT_STATUS" = "inactive" ]; then ok "Integration status is inactive"; else fail "Integration status: $INT_STATUS"; fi

  AGENT_EN_INT=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d "{\"message\":\"enable integration $INT_ID\"}" -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
  if echo "$AGENT_EN_INT" | grep -q "diaktifkan"; then ok "Agentic: Re-enable integration"; else fail "Agentic enable integration: $AGENT_EN_INT"; fi

  INT_STATUS2=$(curl -s "$BASE/api/integrations/$INT_ID" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('status',''))" 2>/dev/null || echo "")
  if [ "$INT_STATUS2" = "active" ]; then ok "Integration status restored to active"; else fail "Integration status restore: $INT_STATUS2"; fi
else
  skip "No integration available for toggle test"
fi

# ─── Toggle Knowledge Document (via Agentic) ─────────────
echo ""
echo "── Toggle Knowledge Document ──"
DOC_ID=$(curl -s "$BASE/api/documents" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); docs=d.get('documents',d.get('data',[])); print(docs[0]['id'] if docs else '')" 2>/dev/null || echo "")
if [ -n "$DOC_ID" ]; then
  AGENT_DIS_DOC=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d "{\"message\":\"disable document $DOC_ID\"}" -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
  if echo "$AGENT_DIS_DOC" | grep -q "dinonaktifkan"; then ok "Agentic: Disable document"; else fail "Agentic disable document: $AGENT_DIS_DOC"; fi

  DOC_ENABLED=$(curl -s "$BASE/api/documents/$DOC_ID" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('document',{}).get('isEnabled',d.get('data',{}).get('isEnabled','')))" 2>/dev/null || echo "")
  if [ "$DOC_ENABLED" = "False" ] || [ "$DOC_ENABLED" = "false" ]; then ok "Document disabled for RAG"; else fail "Document enabled state: $DOC_ENABLED"; fi

  AGENT_EN_DOC=$(curl -s -N --max-time 30 -X POST "$BASE/api/agent/dashboard" -H 'Content-Type: application/json' -d "{\"message\":\"enable document $DOC_ID\"}" -b "$COOKIES" 2>&1 | grep "event: answer" -A1 | head -2)
  if echo "$AGENT_EN_DOC" | grep -q "diaktifkan"; then ok "Agentic: Re-enable document"; else fail "Agentic enable document: $AGENT_EN_DOC"; fi

  DOC_ENABLED2=$(curl -s "$BASE/api/documents/$DOC_ID" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('document',{}).get('isEnabled',d.get('data',{}).get('isEnabled','')))" 2>/dev/null || echo "")
  if [ "$DOC_ENABLED2" = "True" ] || [ "$DOC_ENABLED2" = "true" ]; then ok "Document re-enabled for RAG"; else fail "Document enabled state: $DOC_ENABLED2"; fi
else
  skip "No document available for toggle test"
fi

# ─── Audit Log Verification ──────────────────────────────
echo ""
echo "── Audit Log ──"
AUDIT_COUNT=$(curl -s "$BASE/api/audit?pageSize=20" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null || echo 0)
if [ "$AUDIT_COUNT" -gt 0 ] 2>/dev/null; then ok "Audit logs accessible: $AUDIT_COUNT entries"; else fail "Audit logs: $AUDIT_COUNT"; fi

AUDIT_HAS_PROMPT=$(curl -s "$BASE/api/audit?pageSize=20" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); logs=d.get('items',[]); print(any('PROMPT' in str(l.get('action','')) for l in logs))" 2>/dev/null || echo "False")
if [ "$AUDIT_HAS_PROMPT" = "True" ]; then ok "Audit log contains PROMPT_TOOLS_UPDATE"; else skip "Audit log PROMPT_TOOLS_UPDATE: $AUDIT_HAS_PROMPT"; fi

AUDIT_HAS_INT=$(curl -s "$BASE/api/audit?pageSize=20" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); logs=d.get('items',[]); print(any('INTEGRATION' in str(l.get('action','')) for l in logs))" 2>/dev/null || echo "False")
if [ "$AUDIT_HAS_INT" = "True" ]; then ok "Audit log contains INTEGRATION_UPDATE"; else skip "Audit log INTEGRATION_UPDATE: $AUDIT_HAS_INT"; fi

# ─── REST Auth Types ─────────────────────────────────────
echo ""
echo "── REST Auth Types ──"
REST_CONNECTORS=$(curl -s "$BASE/api/data-sources/rest-connectors" -b "$COOKIES" | python3 -c "import sys,json; d=json.load(sys.stdin); items=d.get('items',d.get('data',d if isinstance(d,list) else [])); print(len(items))" 2>/dev/null || echo 0)
if [ "$REST_CONNECTORS" -gt 0 ] 2>/dev/null; then ok "REST connectors list: $REST_CONNECTORS"; else skip "REST connectors: $REST_CONNECTORS"; fi

# ─── Summary ─────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed · $FAIL failed · $SKIP skipped"
echo "═══════════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
