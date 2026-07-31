# API Usage Guide

Practical guide for the ryasai REST API. For the full OpenAPI spec, see `openapi.yaml`.

## Authentication

Two methods:

1. **Session cookie** (browser UI): `Cookie: x-active-user=<token>` — obtained via `POST /api/auth/login`.
2. **API key** (programmatic): `Authorization: Bearer <key>` — obtained via `POST /api/settings/api-keys`. Keys are hashed at rest; only shown once at creation.

All examples below use `http://localhost:3000` as the base URL.

---

## Auth

### POST /api/auth/login — Login

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ryas.ai","password":"admin12345"}'
```

```js
const res = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@ryas.ai', password: 'admin12345' }),
})
```

```python
import requests
r = requests.post('http://localhost:3000/api/auth/login',
    json={'email': 'admin@ryas.ai', 'password': 'admin12345'})
```

### POST /api/auth/logout — Logout

Invalidates the session cookie.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/auth/logout
```

---

## Chat

### POST /api/v1/chat/completions — Chat completion (OpenAI-compatible)

The primary programmatic endpoint. Accepts an OpenAI-style `messages` array and returns the answer with citations and tool runs. Supports `stream: true` for SSE.

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H 'Authorization: Bearer ryas_abc123' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"How many active users?"}]}'
```

```js
const res = await fetch('http://localhost:3000/api/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ryas_abc123', 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'How many active users?' }] }),
})
const data = await res.json()
console.log(data.answer, data.citations, data.tool_runs)
```

```python
r = requests.post('http://localhost:3000/api/v1/chat/completions',
    headers={'Authorization': 'Bearer ryas_abc123'},
    json={'messages': [{'role': 'user', 'content': 'How many active users?'}]})
print(r.json()['answer'])
```

### POST /api/v1/agent/run — Agentic multi-step run

Forces the agentic planner (multi-step DAG execution) for complex queries.

```bash
curl -X POST http://localhost:3000/api/v1/agent/run \
  -H 'Authorization: Bearer ryas_abc123' \
  -H 'Content-Type: application/json' \
  -d '{"question":"Compare Q3 revenue across regions and summarize the top performer"}'
```

### POST /api/chat/sessions/{id}/send — Send message (SSE streaming)

Streams the answer as Server-Sent Events. Use `text/event-stream` response handling.

```bash
curl -b cookies.txt -N http://localhost:3000/api/chat/sessions/sess_123/send \
  -H 'Content-Type: application/json' \
  -d '{"text":"What is the leave policy?"}'
```

### GET /api/chat/sessions — List sessions
### POST /api/chat/sessions — Create session
### GET /api/chat/sessions/{id} — Get session with messages
### DELETE /api/chat/sessions/{id} — Delete session

### GET /api/sessions/{id}/export?format=json|markdown — Export conversation

Returns the full transcript as structured JSON or human-readable Markdown.

```bash
curl -b cookies.txt http://localhost:3000/api/sessions/sess_123/export?format=markdown
```

```js
const res = await fetch('http://localhost:3000/api/sessions/sess_123/export?format=json')
const transcript = await res.text()
```

---

## RAG / Documents

### GET /api/documents — List documents
### POST /api/documents — Upload document (multipart form)

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/documents \
  -F 'file=@policy.pdf' \
  -F 'category=KEBIJAKAN'
```

### GET /api/documents/{id}/versions — List document versions
### POST /api/documents/{id}/versions — Create version snapshot

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/documents/doc_123/versions
```

### POST /api/documents/{id}/versions/{versionId} — Restore document version

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/documents/doc_123/versions/ver_456
```

---

## Integrations (SQL)

### GET /api/integrations — List database integrations
### POST /api/integrations — Create database integration

### POST /api/integrations/{id}/query — Natural-language SQL query

Converts a natural-language question to SQL, validates via AST guardrails, executes, and returns rows + chart data.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/integrations/int_123/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"Show top 5 customers by revenue"}'
```

```js
const res = await fetch('http://localhost:3000/api/integrations/int_123/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ question: 'Show top 5 customers by revenue' }),
})
const { rows, sql, chartData } = await res.json()
```

```python
r = requests.post('http://localhost:3000/api/integrations/int_123/query',
    cookies=cookies, json={'question': 'Show top 5 customers by revenue'})
print(r.json()['rows'])
```

---

## Plugins

### GET /api/tools — List plugins
### POST /api/tools — Create/register plugin (webhook tool)

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/tools \
  -H 'Content-Type: application/json' \
  -d '{"toolId":"weather","name":"Weather","description":"Get current weather","manifestJson":"..."}'
```

---

## Prompts

### GET /api/prompts?category=sql&mine=true — List saved prompts

```bash
curl -b cookies.txt 'http://localhost:3000/api/prompts?category=sql&mine=true'
```

### POST /api/prompts — Create saved prompt

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/prompts \
  -H 'Content-Type: application/json' \
  -d '{"title":"Summarize SQL results","content":"Summarize these query results:","category":"sql","isPublic":true}'
```

### GET /api/prompts/{id} — Get single prompt
### PUT /api/prompts/{id} — Update prompt
### DELETE /api/prompts/{id} — Delete prompt

---

## MCP Servers

### GET /api/mcp/servers — List MCP servers
### POST /api/mcp/servers — Register MCP server

Supports stdio, sse, and http transports. For sse/http, add `headers` for authentication (encrypted at rest).

```bash
# stdio (local process)
curl -b cookies.txt -X POST http://localhost:3000/api/mcp/servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"filesystem","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}'

# http (remote, with auth headers)
curl -b cookies.txt -X POST http://localhost:3000/api/mcp/servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"remote-mcp","transport":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer token123"}}'
```

### POST /api/mcp/servers/{id}/test — Test MCP server connection

Returns tool list if connection succeeds. Throws `MCP_ERROR` (502) on failure.
---

## Scheduler

### GET /api/schedules — List scheduled runs
### POST /api/schedules — Create scheduled run (cron + prompt)

Supports timezone-aware cron via the `timezone` field (e.g. `Asia/Jakarta`). Defaults to UTC.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"name":"Daily Sales Report","cronExpr":"0 9 * * *","prompt":"Summarize yesterday'\''s sales","timezone":"Asia/Jakarta"}'
```

```python
r = requests.post('http://localhost:3000/api/schedules',
    cookies=cookies,
    json={'name': 'Daily Sales Report', 'cronExpr': '0 9 * * *', 'prompt': "Summarize yesterday's sales", 'timezone': 'Asia/Jakarta'})
```

### PATCH /api/schedules/{id} — Update schedule
### DELETE /api/schedules/{id} — Delete schedule
### GET /api/schedules/{id}/runs — List execution history

---

## Notifications

### GET /api/notifications — List notification configs
### POST /api/notifications — Create notification config (webhook/email/Telegram)

---

## Incoming Webhooks

### POST /api/webhooks/incoming — Process external webhook

Receives an external query, verifies HMAC-SHA256 signature, runs chat completion, returns answer. Header `x-webhook-signature` must be the HMAC-SHA256 of the raw body using `INCOMING_WEBHOOK_SECRET`.

```bash
BODY='{"query":"How many users?"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$INCOMING_WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:3000/api/webhooks/incoming \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: $SIG" \
  -d "$BODY"
```

```python
import hmac, hashlib, requests
body = '{"query":"How many users?"}'
sig = hmac.new(INCOMING_WEBHOOK_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
r = requests.post('http://localhost:3000/api/webhooks/incoming',
    headers={'Content-Type': 'application/json', 'x-webhook-signature': sig},
    data=body)
```

---

## Admin

### GET /api/settings/api-keys — List API keys
### POST /api/settings/api-keys — Create API key

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/settings/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"label":"CI Pipeline"}'
```

### GET /api/monitoring — Monitoring stats (24h)
### GET /api/traces — List LLM traces
### GET /api/v1/health — Liveness check (lightweight)
### GET /api/health — Full health check (DB + Redis)

---

## Response Format

All endpoints return `{ ok: true, ...data }` on success or `{ ok: false, error: "message" }` on failure (except `/api/v1/*` which follows OpenAI-style `{ error: { code, message, hint? } }`). HTTP status codes: 200 (success), 201 (created), 400 (validation), 401 (unauthorized), 404 (not found), 429 (rate limited), 500 (server error).
