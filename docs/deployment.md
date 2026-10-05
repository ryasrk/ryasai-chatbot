# Deployment Guide

This guide covers deploying ryasai Chatbot in production: Docker (recommended), bare metal, Postgres setup, security hardening, and monitoring.

---

## Quick Start (Docker)

The customer installer pulls prebuilt images and generates `docker-compose.prod.yml`:

```bash
curl -sSL https://ryasai.my.id/install.sh | bash
```

For repository-based Compose setup:

```bash
cp .env.example .env
# Set ENCRYPTION_SECRET_KEY; review the credentials in docker-compose.yml.
docker compose up -d
```

The repository Compose file runs the following services. Its local embedding service has a
build context; use the installer for customer installations with prebuilt embedding images.

| Service | Role |
|---------|------|
| `db` | PostgreSQL 16 with pgvector |
| `redis` | Queues and shared runtime state |
| `migrate` | One-shot `bun scripts/migrate.ts`, gates app and scheduler startup |
| `app` | Bun running the Next.js standalone server |
| `scheduler` | Separate scheduled-job worker |
| `local-embeddings` | Local embedding endpoint, configured per org in Settings |
| `cognee-db-init` | Creates the separate `cognee_db` database |
| `cognee` | Pinned Cognee HTTP memory/graph sidecar |

Repository Compose binds the app to `127.0.0.1:3000`; access it locally or through a reverse
proxy. The installer defaults to port `38180`. Register through the UI, activate the licence,
and configure AI endpoints. PostgreSQL is required; the current Prisma schema has no SQLite mode.

---

## Production Deployment (Docker)

### Environment Variables

Copy `.env.example` to `.env` and set **at minimum** these variables:

| Variable | Required | Example | Notes |
|----------|----------|---------|-------|
| `DATABASE_URL` | Yes | `postgresql://ryasai:STRONG_PW@db:5432/ryasai` | PostgreSQL URL; repository Compose sets its own per-service URL |
| `ENCRYPTION_SECRET_KEY` | Yes | `openssl rand -hex 32` | 64-char hex string for AES-256-GCM. App refuses to start without it. |
| `ADMIN_INITIAL_PASSWORD` | **No** | (unused) | Not read by any code. The first admin is created by the signup form, not from this value |
| `ADMIN_EMAIL` | No | `admin@yourcompany.com` | Unused; signup creates the admin from browser input |
| `AUTH_DEMO_FALLBACK` | Yes (prod) | `false` | **Must be `false` in production.** When `true`, unauthenticated requests impersonate the admin. |
| `NODE_ENV` | Set by compose | `production` | Enables secure cookies, disables dev overlays |
| `PORT` | No | `3000` | Next.js listen port (Dockerfile default: 3000) |
| `COGNEE_ENABLED` | No | unset | Kill switch for the AI memory layer. Unset = the per-org toggle in Settings decides; `false` = force off everywhere; `true` = also on before an org is set up. (Adds a Postgres dependency in prod.) |
| `NEXT_PUBLIC_APP_VERSION` | No | `2.1.0` | Build-time public setting; prebuilt images use the code fallback when no build value is supplied |

**Generate an encryption key:**
```bash
openssl rand -hex 32
```

### Persistence and Health

Keep the named volumes declared in `docker-compose.yml`, including PostgreSQL data, Cognee
graph state and the embedding model cache. Back up the app database and the memory state
before upgrades; see [Operations](./operations.md).

The Dockerfile and Compose readiness checks probe `/api/health`. A failed database check
returns HTTP 503. Redis, validator, Cognee and embedding failures are reported in `checks`
and `degraded` without changing the HTTP status. `/api/v1/health` is dependency-free liveness.

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/v1/health
```

### Scheduler as Sidecar

The scheduler (`mini-services/scheduler/index.ts`) is a BullMQ worker that processes repeatable cron jobs from a Redis queue. It is **not** started by the Docker image's `CMD` (which runs only the web server). The web server starts its own BullMQ worker for document processing via `instrumentation.ts`.

**Option A — Compose:** The `scheduler` service is already defined and uses the separate
scheduler image. It waits for the shared migration service and Redis. Do not run schema
pushes from scheduler startup.

**Option B — Separate process (bare metal):**
```bash
bun run mini-services/scheduler/index.ts &
```
See [Bare Metal Deployment](#bare-metal-deployment) below.

> The scheduler uses BullMQ's built-in locking + stalled detection (60s lock, 30s stalled interval, max 1 stalled retry). Multiple scheduler instances won't double-execute — BullMQ's distributed lock prevents it. Still, one scheduler per deployment is the norm. Scheduler supports timezone-aware cron via the `timezone` field on `ScheduledRun` (e.g. `Asia/Jakarta`).

---

## Bare Metal Deployment

### Prerequisites

- **Bun 1.4.2** (the pinned install/test/runtime version)
- **Node 22** (used by the Docker production builder)
- **PostgreSQL 16 with pgvector and pg_trgm**, plus Redis for scheduled work
- PostgreSQL client tools (`psql`, `pg_dump`) for migration inspection and backups

### Steps

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL, ENCRYPTION_SECRET_KEY, AUTH_DEMO_FALLBACK=false

# 3. Generate the client and apply reviewed production migrations
bunx prisma generate
bun run db:deploy

# 4. Build standalone production bundle
bun run build
# Output: .next/standalone/ (self-contained Node server + .next/static + public/)

# 5. Start with production environment loading
bun run start

# 6. Start the scheduler (separate process)
bun run mini-services/scheduler/index.ts
```

### Process Manager

Use **pm2** or **systemd** to keep both processes alive and restart on crash.

**pm2:**
```bash
npm install -g pm2

pm2 start .next/standalone/server.js --name ryasai-web
pm2 start mini-services/scheduler/index.ts --interpreter bun --name ryasai-scheduler

pm2 save
pm2 startup  # enable auto-restart on boot
```

**systemd** (example unit for the web server):
```ini
# /etc/systemd/system/ryasai-web.service
[Unit]
Description=ryasai Chatbot Web Server
After=network.target postgresql.service

[Service]
Type=simple
User=ryasai
WorkingDirectory=/opt/ryasai
EnvironmentFile=/opt/ryasai/.env
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/ryasai-scheduler.service
[Unit]
Description=ryasai Chatbot Scheduler Worker
After=ryasai-web.service

[Service]
Type=simple
User=ryasai
WorkingDirectory=/opt/ryasai
EnvironmentFile=/opt/ryasai/.env
ExecStart=/usr/bin/bun run mini-services/scheduler/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ryasai-web ryasai-scheduler
sudo systemctl start ryasai-web ryasai-scheduler
```

### Caddy Reverse Proxy

A `Caddyfile` is included. Caddy provides automatic HTTPS via Let's Encrypt.

```bash
# Install Caddy: https://caddyserver.com/docs/install
# Set ports via environment (defaults shown):
export CADDY_PORT=81    # Caddy listen port (use 80/443 in prod with a domain)
export WEB_PORT=3000    # Next.js upstream

caddy run --config Caddyfile
```

For production with a real domain, edit the Caddyfile to replace `:{$CADDY_PORT}` with your domain:
```
chatbot.yourcompany.com {
    reverse_proxy localhost:3000
}
```

Caddy will auto-provision TLS certificates.

---

## Postgres Setup

### Step 1 — Install Postgres + pgvector

```bash
sudo apt install postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector

sudo -u postgres psql -c "CREATE USER ryasai WITH PASSWORD 'STRONG_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE ryasai OWNER ryasai;"
sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

### Step 2 — Configure the database URL

The Prisma datasource already uses PostgreSQL. Set `.env`:

```dotenv
DATABASE_URL="postgresql://ryasai:STRONG_PASSWORD@localhost:5432/ryasai?schema=public"
```

### Step 3 — Apply reviewed migrations

```bash
bunx prisma generate
bun run db:deploy
```

`scripts/migrate.ts` deploys versioned SQL. An existing database without migration history
is adopted only if it matches the frozen baseline; a mismatch requires backup and reviewed
reconciliation. Use `prisma db push` only for development prototypes.

### Connection Pooling

For production with many concurrent connections, use **PgBouncer** or **Supavisor** in front of Postgres:

```bash
# PgBouncer (transaction pooling mode)
sudo apt install pgbouncer
# Configure pgbouncer.ini to pool connections to your Postgres
# Point DATABASE_URL at PgBouncer (port 6432) instead of Postgres directly
```

Use a direct database connection for migration and backup operations; validate pooled application
connections against your provider before production use.

### pgvector for Embeddings

Document chunks store embeddings in PostgreSQL, with JSON metadata and a pgvector column.
The configured embedding model must match the stored vectors and column dimensions. Check
semantic retrieval and rebuild embeddings after a model change; see [AI/RAG reference](./architecture-reference.md).

---

## Security Checklist

Run through this before exposing the deployment to the internet.

- [ ] **Rotate `ENCRYPTION_SECRET_KEY`** — generate a fresh 64-char hex key. Never reuse the default/empty value. App refuses to start without it.
- [ ] **Register the first admin through the UI** — there is no seeded account and no default
      password. **Nothing reads `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.** They appear only in `install.sh`, `.env.example` and docs; `POST /api/auth/signup` creates the organization and the first admin from what the USER types in the browser. There is no default login — register through the UI. The installer still writes the values to `.env` for older deployments, but no longer presents them as credentials.
- [ ] **Set `AUTH_DEMO_FALLBACK=false`** — when `true`, unauthenticated requests impersonate the admin. This **must** be `false` in any production deployment.
- [ ] **Configure CORS for external API** — set `CHAT_API_CORS_ORIGIN` env var to your specific origin(s). Defaults to `*` (all origins) for development. For production, restrict to your integration's origin.
- [ ] **Enable audit logging** — on by default. All security-relevant actions (login, SQL execute, guardrail block, API key creation, integration create) are written to `AuditLog`. View via Security > Audit Log.
- [ ] **Set API key rate limits** — when creating API keys via Settings > Integration API, set `requestLimitPerMinute` and `dailyRequestLimit` to sane values for your integration. The enforcement is per-key (in-memory counter + DB-backed daily reset).
- [ ] **Use HTTPS** — Caddy auto-provisions TLS. If using a different proxy, terminate TLS at the edge.
- [ ] **Secure the database** — Postgres should not be exposed externally. The compose network (`ryasai-net`) keeps `db` internal. For bare metal, bind Postgres to `localhost` or use a firewall.
- [ ] **Review SSRF blocklist** — the app blocks RFC1918, link-local, CGNAT, ULA, and cloud metadata endpoints (`metadata.google.internal`, `metadata.aws.internal`, `metadata.azure.com`) for outbound webhook/plugin/MCP/REST calls. DNS-rebinding protection via `dns.lookup` is also applied. Verify this covers your internal network ranges.
- [ ] **Enable OpenTelemetry** (optional) — set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces to your OTLP collector. SDK auto-detects from endpoint env var.

---

## Monitoring

### Built-in Endpoints

| Endpoint | Auth | Returns |
|----------|------|---------|
| `GET /api/v1/health` | None | `{ ok, service, version, time }` — for load balancer health checks |
| `GET /api/monitoring` | Session cookie | 24h stats: tool run count, avg latency, failed API count, LLM token usage by purpose, last 50 tool runs / failed requests / REST errors / blocked SQL |
| `GET /api/traces?limit=N` | Session cookie | Last N LLM call traces (in-memory ring buffer, max 100): purpose, model, latency, tokens, status |

Access the monitoring dashboard in the UI: **Security** view shows stat cards + tabs (Audit Log, Tracing, Failed Requests, Blocked SQL).

### LLM Observability Forwarding (Optional)

Forward LLM call traces to external observability platforms via environment variables. Both are fire-and-forget (never block the response):

**Langfuse:**
```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASEURL=https://cloud.langfuse.com
```

**Helicone:**
```env
HELICONE_API_KEY=sk-helicone-...
```

Traces are still kept in the in-memory ring buffer (last 100) regardless of forwarding. The ring buffer is lost on restart — for persistent tracing, enable Langfuse/Helicone forwarding.

### LLM Token Usage

Every LLM call (router, SQL gen, RAG, REST, synthesis, chat) is logged to the `LlmUsageLog` table with prompt/completion/total token counts and a purpose label. The monitoring API aggregates these over 24h and groups by purpose.

---

## Architecture

The app, document worker and separate scheduler use the same organization-scoped data layer.
PostgreSQL stores application data; Redis backs queues; the Cognee HTTP sidecar uses its own
database and persisted graph state. Chat requests reach the configured BYOK endpoints.

See [Architecture](../ARCHITECTURE.md) for the service boundaries, tenant-entry conventions,
shared SQL/RAG pipelines and validation limits.
