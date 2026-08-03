#!/usr/bin/env bash
# =============================================================================
# ryasai Chatbot — One-command installer
# Usage:  curl -sSL https://ryasai.my.id/install.sh | bash
# Target: Ubuntu/Debian, 1 vCPU / 1GB+ RAM VPS
# -----------------------------------------------------------------------------
# Installs:
#   1. Docker Engine + Compose plugin
#   2. Clones ryasai/Chatbot to /opt/ryasai-chatbot
#   3. Generates .env (secrets auto-created, license pointed at ryasai server)
#   4. docker compose pull + up  (app + redis + postgres; images are prebuilt
#      in CI on GitHub — NO compile on the VPS, License-Validator is external)
# =============================================================================
set -euo pipefail

# --- Colors ----------------------------------------------------------------
C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_BOLD='\033[1m'; C_NC='\033[0m'
info()  { echo -e "${C_GREEN}==>${C_NC} $*"; }
warn()  { echo -e "${C_YELLOW}WARN:${C_NC} $*"; }
fail()  { echo -e "${C_RED}ERROR:${C_NC} $*" >&2; exit 1; }

# --- Prereqs ---------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || fail "Run as root (sudo su)."
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
command -v docker >/dev/null || { info "Installing Docker...";
  curl -fsSL https://get.docker.com | sh >/dev/null;
  systemctl enable --now docker >/dev/null 2>&1 || true; }
docker compose version >/dev/null 2>&1 || { info "Installing Docker Compose plugin...";
  apt-get install -y -qq docker-compose-plugin >/dev/null; }

# --- Swap safety net (1 vCPU / 1GB RAM builds can OOM) ----------------------
TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_MB" -lt 2000 ] && ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
  warn "RAM < 2GB — creating swap so the Docker build won't OOM..."
  SWAP_MB=2048
  DISK_KB=$(df -k / | awk 'NR==2{print $4}')
  [ "$DISK_KB" -lt $((SWAP_MB * 1024)) ] && SWAP_MB=$(( DISK_KB / 2048 ))
  if fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null || \
     dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none 2>/dev/null; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile >/dev/null 2>&1 \
      && { grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
  else
    warn "swapfile creation failed (fallocate+dd) — on 1GB RAM you'll want swap: add one manually or install will likely OOM."
  fi
fi

# --- Deploy dir ------------------------------------------------------------
APP_DIR=/opt/ryasai-chatbot
REPO_URL=https://github.com/ryasrk/ryasai-chatbot.git
BACKUP_DIR="$APP_DIR/backups"
IS_UPDATE=false

if [ -d "$APP_DIR/.git" ] || [ -f "$APP_DIR/.env" ]; then
  IS_UPDATE=true
  info "Existing install detected — running UPDATE (data preserved, no rebuild)..."
  git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1 || {
    # local working tree may be dirty (e.g. a prior failed install) — reset
    # tracked files but keep .env untouched (git reset never touches it)
    git -C "$APP_DIR" fetch --depth 1 origin >/dev/null 2>&1 && \
      git -C "$APP_DIR" reset --hard origin/HEAD >/dev/null 2>&1 || true
  }
else
  info "Cloning ryasai Chatbot -> $APP_DIR"
  mkdir -p "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- .env ------------------------------------------------------------------
if [ ! -f .env ]; then
  info "Generating .env..."
  ENC_KEY=$(openssl rand -hex 32)
  ADMIN_PASS=$(openssl rand -hex 8)
  cat > .env <<EOF
# Database — change to an external host if you already run PostgreSQL elsewhere
DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai

# App listens on 3000 inside the container (matches Dockerfile)
PORT=3000
WS_PORT=3003
CADDY_PORT=81
WEB_PORT=3000

# Security
ENCRYPTION_SECRET_KEY=$ENC_KEY
DB_QUERY_LOG=false
WS_CORS_ORIGIN=http://localhost:3000

# Toggles
COGNEE_ENABLED=false
CONTEXTUAL_RETRIEVAL=true
NEXT_PUBLIC_APP_VERSION=0.5.0
NEXT_PUBLIC_WS_PORT=3003

# Bootstrap admin (sign up with these after install)
ADMIN_EMAIL=admin@ryasai.local
ADMIN_INITIAL_PASSWORD=$ADMIN_PASS

# Email notifications (Resend). Leave blank to use webhook/telegram only.
# RESEND_API_KEY=
# EMAIL_FROM=ryasai@yourdomain.com

# License validation — central ryasai license server
LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
LICENSE_PRODUCT=ryasai-chatbot
LICENSE_SIGNING_PUBLIC_KEY=302a300506032b6570032100eaaadb217b2c7548bed70b3e22f357ef16d1690feb251ae7c8b178de5b95df8a
LICENSE_GRACE_PERIOD_DAYS=7
LICENSE_REVALIDATION_INTERVAL_HOURS=24

# Data-source DB (optional, for Text-to-SQL on your own DB)
RELATIONAL_DB_URL=
EOF
  chmod 600 .env
  warn "Generated admin password: $ADMIN_PASS  (save this NOW, or run: grep ADMIN_INITIAL_PASSWORD .env)"
else
  info ".env already exists — keeping it."
fi

# --- Pre-update backup (UPDATE only) ---------------------------------------
# Before touching the DB schema/images, dump Postgres + Redis to $BACKUP_DIR and
# keep the last N. Fresh installs skip this (no data yet). Failure is non-fatal.
if [ "$IS_UPDATE" = true ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  if docker compose -f docker-compose.prod.yml ps --status running --services db >/dev/null 2>&1 \
     && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U ryasai -d ryasai > "$BACKUP_DIR/ryasai-$STAMP.sql" 2>/dev/null; then
    info "DB backup saved -> $BACKUP_DIR/ryasai-$STAMP.sql"
  else
    warn "DB backup skipped (db not running yet — first update or fresh install)."
  fi
  # Keep newest 5 dumps
  ls -1t "$BACKUP_DIR"/ryasai-*.sql 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

# --- Compose (app + redis + pg, NO license-server; that runs on ryasai) -----
# Images are PREBUILT in GitHub Actions and pushed to GHCR — the VPS never
# compiles the app (a Next build is ~15min on 1 vCPU and OOMs at 1GB).
# Schema is applied by the `migrate` one-shot job (reuses the scheduler image,
# which ships the full prisma CLI) before app/scheduler start.
cat > docker-compose.prod.yml <<'EOF'
services:
  migrate:
    image: ghcr.io/ryasrk/ryasai-chatbot:scheduler
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    entrypoint: ["bun", "node_modules/prisma/build/index.js", "db", "push", "--accept-data-loss", "--skip-generate"]
    restart: "no"
    networks: [ryasai-net]

  app:
    image: ghcr.io/ryasrk/ryasai-chatbot:app
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
      - REDIS_URL=redis://redis:6379
      - NODE_ENV=production
      - LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
      - LICENSE_PRODUCT=ryasai-chatbot
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped
    networks: [ryasai-net]

  scheduler:
    image: ghcr.io/ryasrk/ryasai-chatbot:scheduler
    build:
      context: .
      dockerfile: Dockerfile.scheduler
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
      - REDIS_URL=redis://redis:6379
      - NODE_ENV=production
      - LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
      - LICENSE_PRODUCT=ryasai-chatbot
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped
    networks: [ryasai-net]

  redis:
    image: redis:7-alpine
    # ponytail: cap RAM on a 1GB box; volatile-lru evicts only TTL'd keys,
    # so BullMQ job data (no TTL) is kept. Tradeoff documented in compose.
    command: ["redis-server", "--maxmemory", "64mb", "--maxmemory-policy", "volatile-lru"]
    volumes: [redisdata:/data]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 10s, timeout: 3s, retries: 3 }
    restart: unless-stopped
    networks: [ryasai-net]

  db:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_USER=ryasai
      - POSTGRES_PASSWORD=ryasai
      - POSTGRES_DB=ryasai
    # ponytail: recipe-size Postgres — defaults assume 2GB+; these caps keep
    # it under ~200MB so app+redis+pg fit in 1GB RAM.
    command: ["postgres", "-c", "shared_buffers=64MB", "-c", "max_connections=40", "-c", "effective_cache_size=128MB", "-c", "maintenance_work_mem=32MB"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U ryasai -d ryasai"], interval: 10s, timeout: 5s, retries: 5 }
    restart: unless-stopped
    networks: [ryasai-net]

networks:
  ryasai-net:
volumes:
  pgdata:
  redisdata:
EOF

# --- Disk guard: never let the disk fill up ----------------------------------
# Before pulling, check free space. If low, prune unused Docker data FIRST
# (containers/images/build-cache) so the pull never dies mid-extract. Named
# volumes (pgdata/redisdata = user data) are NEVER touched.
MIN_FREE_MB=2000
MB_FREE=$(df -m / | awk 'NR==2{print $4}')
if [ "$MB_FREE" -lt "$MIN_FREE_MB" ]; then
  warn "Low disk (${MB_FREE}MB free, need $MIN_FREE_MB) — pruning unused Docker data (volumes kept)..."
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  MB_FREE=$(df -m / | awk 'NR==2{print $4}')
  info "Free after prune: ${MB_FREE}MB"
fi

# --- Pull & run (no build on the VPS — images are prebuilt in CI) -----------
info "Pulling prebuilt images..."
if docker compose -f docker-compose.prod.yml pull; then
  info "Starting services (migrate -> app + scheduler)..."
  docker compose -f docker-compose.prod.yml up -d --remove-orphans
else
  if [ "$IS_UPDATE" = true ]; then
    # ponytail: on UPDATE never fall back to building — the pull failed for a
    # runtime reason (e.g. disk full/network), and a source build on 1 vCPU can
    # OOM + fills the disk that blocked the pull. The stack stays on the old
    # image, which is already running. Retry `bash install.sh` after freeing space.
    warn "Image pull failed — KEEPING current install (data untouched). Free disk space and re-run install.sh."
    info "Current services:"
    docker compose -f docker-compose.prod.yml ps || true
  else
    # fresh install: GHCR images may not be published yet — build locally so
    # installs never hard-fail.
    warn "Prebuilt images not found — building from source (slow on 1 vCPU)..."
    docker compose -f docker-compose.prod.yml up -d --remove-orphans --build
  fi
fi

# --- Prune stale data (every run) — drop old app/scheduler layers so the -------
# disk never fills up. -af removes ALL images not referenced by a running/stopped
# container (old versions of app/scheduler/pgvector/redis after each bump) plus
# build cache. This is a dedicated VPS — nothing else needs those images. Very
# important: `--volumes` is NEVER used, so pgdata/redisdata (user data) survive.
docker container prune -f >/dev/null 2>&1 || true
docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true

# --- Health ----------------------------------------------------------------
info "Waiting for app to come up..."
for i in $(seq 1 60); do
  curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1 && break || sleep 3
done

echo
echo "=============================================================="
echo "  ryasai Chatbot installed."
echo "=============================================================="
echo
echo "  Access (local):   http://localhost:3000"
echo "  Admin email:      $(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2)"
echo "  Admin password:   $(grep -E '^ADMIN_INITIAL_PASSWORD=' .env | cut -d= -f2)"
echo
echo "  Put behind Caddy/Nginx on this server with your domain, e.g.:"
echo ""
echo "    license-side:   license.ryasai.my.id  -> License-Validator (already deployed)"
echo "    app-side:       yourdomain.com        -> 127.0.0.1:3000"
echo ""
echo "  Logs:     docker compose -f docker-compose.prod.yml logs -f app"
echo "  Restart:  docker compose -f docker-compose.prod.yml restart"
echo "  Stop:     docker compose -f docker-compose.prod.yml down"
echo "=============================================================="
