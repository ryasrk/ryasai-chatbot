# Deployment Guide

This guide covers deploying ryasai Chatbot in production: Docker (recommended), bare metal, Postgres setup, security hardening, and monitoring.

---

## Quick Start (Docker)

The fastest path — Postgres + app in two containers:

```bash
cp .env.example .env
# Edit .env: set ENCRYPTION_SECRET_KEY and ADMIN_INITIAL_PASSWORD (see below)
docker compose up -d
```

**Services started:**

| Service | Container | Port | Role |
|---------|-----------|------|------|
| `app` | ryasai-chatbot | 3000 | Next.js standalone server (runs `prisma db push` then `server.js`) |
| `db` | pgvector/pgvector:pg16 | 5432 (internal) | PostgreSQL 16 + pgvector |

Access the app at `http://localhost:3000`. The setup wizard runs on first launch — create the admin account there.

> **SQLite instead of Postgres?** Comment out `DATABASE_URL` in `app.environment`, remove the `db` service + `depends_on`, set `DATABASE_URL=file:./db/custom.db` in `.env`. The `/app/db` volume persists the SQLite file. See `docker-compose.yml` header comments.

---

## Production Deployment (Docker)

### Environment Variables

Copy `.env.example` to `.env` and set **at minimum** these variables:

| Variable | Required | Example | Notes |
|----------|----------|---------|-------|
| `DATABASE_URL` | Yes | `postgresql://ryasai:STRONG_PW@db:5432/ryasai` | Postgres URL (compose default) or `file:./db/custom.db` for SQLite |
| `ENCRYPTION_SECRET_KEY` | Yes | `openssl rand -hex 32` | 64-char hex string for AES-256-GCM. App refuses to start without it. |
| `ADMIN_INITIAL_PASSWORD` | Yes | (strong password) | Initial admin password — change after first login via Settings > Profil |
| `ADMIN_EMAIL` | No | `admin@yourcompany.com` | Default: `admin@example.com` |
| `AUTH_DEMO_FALLBACK` | Yes (prod) | `false` | **Must be `false` in production.** When `true`, unauthenticated requests impersonate the admin. |
| `NODE_ENV` | Set by compose | `production` | Enables secure cookies, disables dev overlays |
| `PORT` | No | `3000` | Next.js listen port (Dockerfile default: 3000) |
| `COGNEE_ENABLED` | No | `false` | Enable AI memory layer (adds Postgres dependency for prod) |
| `NEXT_PUBLIC_APP_VERSION` | No | `2.0.0` | Shown in UI footer |

**Generate an encryption key:**
```bash
openssl rand -hex 32
```

### Postgres vs SQLite Mode

| Mode | When to use | Setup |
|------|-------------|-------|
| **Postgres** (default compose) | Production, > 10K chunks, concurrent users, pgvector embeddings | `docker compose up` — pgvector image included. Change `provider` in `prisma/schema.prisma` to `"postgresql"`. See [Postgres Setup](#postgres-setup) below. |
| **SQLite** | Dev, single-user demo, < 10K chunks | Set `DATABASE_URL=file:./db/custom.db`, remove `db` service from compose. Volume `/app/db` persists the file. |

### Volume Mounts

The compose file mounts `pgdata` for Postgres data persistence. For SQLite mode, the Dockerfile declares `VOLUME ["/app/db"]` — mount a named volume to persist the SQLite file across container rebuilds:

```yaml
volumes:
  - ./data/db:/app/db
```

### Health Check

The Dockerfile includes a built-in health check hitting `/api/v1/health`:

```
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
```

Manual check:
```bash
curl http://localhost:3000/api/v1/health
# {"ok":true,"service":"ryasai","version":"2.0.0","time":"2026-07-25T..."}
```

### Scheduler as Sidecar

The scheduler (`mini-services/scheduler/index.ts`) is a background worker that polls `ScheduledRun` rows every 60s and executes due prompts. It is **not** started by the Docker image's `CMD` (which runs only the web server).

**Option A — Separate container (recommended for Docker):**

Add a `scheduler` service to `docker-compose.yml`:
```yaml
  scheduler:
    build: .
    command: >
      sh -c "bunx prisma db push --accept-data-loss && bun run mini-services/scheduler/index.ts"
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - ryasai-net
```

**Option B — Separate process (bare metal):**
```bash
bun run mini-services/scheduler/index.ts &
```
See [Bare Metal Deployment](#bare-metal-deployment) below.

> The scheduler uses an optimistic-lock claim pattern so multiple scheduler instances won't double-execute the same run. Still, one scheduler per deployment is the norm.

---

## Bare Metal Deployment

### Prerequisites

- **Bun 1+** (for install/build)
- **Node 22+** (for running the standalone prod build)
- **PostgreSQL 14+ with pgvector** (if using Postgres mode) or no DB for SQLite

### Steps

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL, ENCRYPTION_SECRET_KEY, ADMIN_INITIAL_PASSWORD, AUTH_DEMO_FALLBACK=false

# 3. Apply database schema
bunx prisma db push --accept-data-loss
bunx prisma generate

# 4. Build standalone production bundle
bun run build
# Output: .next/standalone/ (self-contained Node server + .next/static + public/)

# 5. Seed demo data (optional — skip for fresh production installs)
bun run scripts/seed.ts

# 6. Start the production server
node .next/standalone/server.js
# Or with env loading:
bun run start

# 7. Start the scheduler (separate process)
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

### Step 2 — Update Prisma Datasource

Edit `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Update `.env`:
```
DATABASE_URL="postgresql://ryasai:STRONG_PASSWORD@localhost:5432/ryasai?schema=public"
```

### Step 3 — Apply Schema + Adapt Raw SQL

```bash
bunx prisma migrate dev --name init
bunx prisma generate
```

Three files contain SQLite-specific raw SQL that needs Postgres adaptation. **See `docs/postgres-migration.md` for the full step-by-step guide** (PRAGMA → information_schema, FTS5 → tsvector, JSON embeddings → pgvector column).

The docker-compose `db` service uses `pgvector/pgvector:pg16` which has the extension pre-installed.

### Connection Pooling

For production with many concurrent connections, use **PgBouncer** or **Supavisor** in front of Postgres:

```bash
# PgBouncer (transaction pooling mode)
sudo apt install pgbouncer
# Configure pgbouncer.ini to pool connections to your Postgres
# Point DATABASE_URL at PgBouncer (port 6432) instead of Postgres directly
```

Prisma 6 supports PgBouncer transaction mode natively — no `?pgbouncer=true` parameter needed.

### pgvector for Embeddings

The current implementation stores embeddings as JSON strings in SQLite and computes cosine similarity in JavaScript. For > 10K document chunks, migrate to a pgvector column with an IVFFlat index for sub-millisecond similarity search. See `docs/postgres-migration.md` Step 4c.

---

## Security Checklist

Run through this before exposing the deployment to the internet.

- [ ] **Rotate `ENCRYPTION_SECRET_KEY`** — generate a fresh 64-char hex key. Never reuse the default/empty value. App refuses to start without it.
- [ ] **Set strong `ADMIN_INITIAL_PASSWORD`** — then change it immediately after first login via Settings > Profil > Ganti Sandi.
- [ ] **Set `AUTH_DEMO_FALLBACK=false`** — when `true`, unauthenticated requests impersonate the admin. This **must** be `false` in any production deployment.
- [ ] **Configure CORS for external API** — the `/api/v1/*` endpoints set `Access-Control-Allow-Origin: *` by default. If your integration is scoped to specific origins, modify `corsHeaders` in `src/app/api/v1/chat/completions/route.ts` or place a CORS-restricting reverse proxy (Caddy/Nginx) in front.
- [ ] **Enable audit logging** — on by default. All security-relevant actions (login, SQL execute, guardrail block, API key creation, integration create) are written to `AuditLog`. View via Security > Audit Log.
- [ ] **Set API key rate limits** — when creating API keys via Settings > Integration API, set `requestLimitPerMinute` and `dailyRequestLimit` to sane values for your integration. The enforcement is per-key (in-memory counter + DB-backed daily reset).
- [ ] **Restrict `WS_CORS_ORIGIN`** — set to your specific origins (comma-separated). Never use a wildcard in production.
- [ ] **Use HTTPS** — Caddy auto-provisions TLS. If using a different proxy, terminate TLS at the edge.
- [ ] **Secure the database** — Postgres should not be exposed externally. The compose network (`ryasai-net`) keeps `db` internal. For bare metal, bind Postgres to `localhost` or use a firewall.
- [ ] **Review SSRF blocklist** — the app blocks RFC1918, link-local, CGNAT, and ULA addresses for outbound webhook/plugin/MCP calls. Verify this covers your internal network ranges.

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

```
                    User (browser)
                         │
                         ▼
              Caddy (reverse proxy, TLS)
                         │
                         ▼
              Next.js standalone (port 3000)
                    │
         ┌──────────┼──────────────────────────┐
         │          │                          │
    Chat API    Agentic API              Admin API
    (SSE)       (planner + tools)     (sessions, integrations,
         │          │                  documents, plugins, MCP,
         │          │                  notifications, schedules,
         │          │                  monitoring, traces)
         ▼          ▼
    ┌─────────────────────────┐
    │   Smart Router           │  self-adjusting: schema + perf
    │   → SQL | RAG | REST     │  + latency + similarity + breaker
    │     | CHAT | PLUGIN      │
    └─────────────────────────┘
         │           │          │
         ▼           ▼          ▼
    Connector    RAG Engine   Plugin Registry
    (SQL exec +  (hybrid:      (9 prebuilt +
     guardrail)  lexical +     custom webhook
                 semantic +    tools, SSRF-guarded)
                 FTS + vector
                 store)
         │           │          │
         ▼           ▼          ▼
    ┌─────────────────────────────────┐
    │   Database (SQLite or Postgres) │
    │   + pgvector (embeddings, opt)  │
    │   + Cognee (memory, opt)        │
    └─────────────────────────────────┘

              Scheduler (sidecar process)
              polls ScheduledRun rows every 60s
              → executes due prompts → notifications
```

**Key design properties:**

- **Fail-closed by default** — missing config, expired key, ambiguous permission → refuse + audit. Never guess.
- **SQL guardrails** — every LLM-generated SQL passes AST validation (SELECT only, LIMIT 100, no DML/DDL) before execution.
- **Tenant isolation** — single-admin deployment; all resources scoped to the single admin user.
- **Streaming end-to-end** — SSE token streaming for both internal chat and the external OpenAI-compatible API.
- **Every tool run is observable** — `ToolRun` row with latency, status, input/output summary. Guardrail blocks → `AuditLog` at critical severity.
