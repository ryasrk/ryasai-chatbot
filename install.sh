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
#   4. docker compose up -d  (app + redis + postgres, License-Validator is external)
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

if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing install..."
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning ryasai Chatbot -> $APP_DIR"
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

# --- Compose (app + redis + pg, NO license-server; that runs on ryasai) -----
cat > docker-compose.prod.yml <<'EOF'
services:
  app:
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
    restart: unless-stopped
    networks: [ryasai-net]

  scheduler:
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
    restart: unless-stopped
    networks: [ryasai-net]

  redis:
    image: redis:7-alpine
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

# --- Build & run -----------------------------------------------------------
info "Building images (this takes a few minutes on 1 vCPU)..."
docker compose -f docker-compose.prod.yml up -d --build

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
