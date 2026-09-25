#!/usr/bin/env bash
# =============================================================================
# ryasai Chatbot — One-command installer (Prebuilt Images Only)
# Usage:  curl -sSL https://ryasai.my.id/install.sh | bash
#         curl -sSL https://ryasai.my.id/install.sh | bash -s -- --port 38180
#         curl -sSL https://ryasai.my.id/install.sh | bash -s -- --with-searxng
# Target: Ubuntu/Debian, 1 vCPU / 1GB+ RAM VPS
# -----------------------------------------------------------------------------
# Installs:
#   1. Docker Engine + Compose plugin
#   2. Sets up /opt/ryasai-chatbot (.env + docker-compose.prod.yml ONLY)
#      NOTE: Never clones source code. Only pulls prebuilt official images.
#   3. Generates .env (secrets auto-created, unique ports configured)
#   4. docker compose pull + up (app + scheduler + redis + postgres + cognee)
#
# Options:
#   --port <number>                  Unique host port to expose (default: 38180).
#                                    Avoids collisions with 80, 443, 3000, 8080.
#   --with-searxng                   Run a private SearXNG for web_search (~256MB RAM).
#   --license-signing-public-key <hex>
#                                    Ed25519 public key (DER hex) used to VERIFY
#                                    License-Validator responses. Also accepted via
#                                    LICENSE_SIGNING_PUBLIC_KEY env var.
# =============================================================================
set -euo pipefail

# --- Colors ----------------------------------------------------------------
C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_BOLD='\033[1m'; C_NC='\033[0m'
info()  { echo -e "${C_GREEN}==>${C_NC} $*"; }
warn()  { echo -e "${C_YELLOW}WARN:${C_NC} $*"; }
fail()  { echo -e "${C_RED}ERROR:${C_NC} $*" >&2; exit 1; }

# --- Options ---------------------------------------------------------------
WITH_SEARXNG=false
LICENSE_PUBKEY_ARG="${LICENSE_SIGNING_PUBLIC_KEY:-}"
APP_PORT_ARG=""
DEFAULT_APP_PORT=38180

while [ $# -gt 0 ]; do
  case "$1" in
    --with-searxng) WITH_SEARXNG=true; shift ;;
    --port)
      [ $# -ge 2 ] || fail "--port requires a port number (e.g. 38180)"
      APP_PORT_ARG="$2"; shift 2 ;;
    --license-signing-public-key)
      [ $# -ge 2 ] || fail "--license-signing-public-key requires a value (DER hex)"
      LICENSE_PUBKEY_ARG="$2"; shift 2 ;;
    # $0 is "bash" when piped from curl, so print help inline rather than self-read.
    -h|--help)
      echo "ryasai Chatbot installer (Prebuilt Images Only)"
      echo "  curl -sSL https://ryasai.my.id/install.sh | bash"
      echo "  curl -sSL https://ryasai.my.id/install.sh | bash -s -- --port 38180"
      echo "  curl -sSL https://ryasai.my.id/install.sh | bash -s -- --with-searxng"
      echo "  curl -sSL https://ryasai.my.id/install.sh | bash -s -- --license-signing-public-key <hex>"
      echo
      echo "  --port <number>                 Unique host port for the web app (default: 38180)."
      echo "  --with-searxng                  Run a private SearXNG for web_search (~256MB RAM)."
      echo "  --license-signing-public-key <hex>"
      echo "                                  Ed25519 public key (DER hex) for verifying license"
      echo "                                  responses. Falls back to \$LICENSE_SIGNING_PUBLIC_KEY."
      echo "                                  If neither is given, license verification stays"
      echo "                                  DISABLED and the app fails closed on licensing."
      exit 0 ;;
    *) fail "Unknown option: $1 (supported: --port <number>, --with-searxng, --license-signing-public-key <hex>)" ;;
  esac
done

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
  warn "RAM < 2GB — creating swap to ensure stable container runtime..."
  SWAP_MB=2048
  DISK_KB=$(df -k / | awk 'NR==2{print $4}')
  [ "$DISK_KB" -lt $((SWAP_MB * 1024)) ] && SWAP_MB=$(( DISK_KB / 2048 ))
  if fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null || \
     dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none 2>/dev/null; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile >/dev/null 2>&1 \
      && { grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
  else
    warn "swapfile creation failed — on 1GB RAM you'll want swap: add one manually if needed."
  fi
fi

# --- Port collision avoidance ---------------------------------------------
is_port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$p" 2>/dev/null | grep -q ":$p" && return 0 || return 1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -q ":$p " && return 0 || return 1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN -P -n >/dev/null 2>&1 && return 0 || return 1
  fi
  return 1
}

APP_PORT="${APP_PORT_ARG:-${APP_PORT:-$DEFAULT_APP_PORT}}"

if is_port_in_use "$APP_PORT"; then
  warn "Port $APP_PORT is already in use by another service on this host."
  if [ -z "$APP_PORT_ARG" ]; then
    for candidate in $(seq 38181 38220); do
      if ! is_port_in_use "$candidate"; then
        info "Automatically selected free unique port: $candidate"
        APP_PORT="$candidate"
        break
      fi
    done
  else
    fail "Specified port $APP_PORT is in use. Please choose an available port with --port <number>."
  fi
fi

WS_PORT=$(( APP_PORT + 3 ))
CADDY_PORT=$(( APP_PORT + 1 ))

# --- Deploy dir (NO SOURCE CODE CLONING) -----------------------------------
APP_DIR=/opt/ryasai-chatbot
BACKUP_DIR="$APP_DIR/backups"
IS_UPDATE=false

if [ -f "$APP_DIR/.env" ]; then
  IS_UPDATE=true
  info "Existing install detected in $APP_DIR — running UPDATE (data preserved)..."
  # Preserve existing APP_PORT if previously set in .env
  EXISTING_PORT=$(grep -E '^APP_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ' || true)
  if [ -n "$EXISTING_PORT" ] && [ -z "$APP_PORT_ARG" ]; then
    APP_PORT="$EXISTING_PORT"
  fi
else
  info "Setting up deployment directory -> $APP_DIR"
  mkdir -p "$APP_DIR"
fi

# Clean up any legacy source code files from earlier versions if present
if [ -d "$APP_DIR/.git" ] || [ -d "$APP_DIR/src" ]; then
  warn "Cleaning up legacy source code tree in $APP_DIR (prebuilt images used exclusively)..."
  rm -rf "$APP_DIR/.git" "$APP_DIR/src" "$APP_DIR/benchmark" "$APP_DIR/docs" "$APP_DIR/tests" "$APP_DIR/Dockerfile"* "$APP_DIR/tsconfig"* 2>/dev/null || true
fi

cd "$APP_DIR"

# --- .env ------------------------------------------------------------------
if [ ! -f .env ]; then
  info "Generating .env with unique port configuration..."
  ENC_KEY=$(openssl rand -hex 32)
  ADMIN_PASS=$(openssl rand -hex 8)
  cat > .env <<EOF
# Database — change to an external host if you already run PostgreSQL elsewhere
DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai

# Internal container port matches standard Next.js (3000)
PORT=3000

# Unique host ports (avoids collisions with 80, 443, 3000, 8080, etc.)
APP_PORT=$APP_PORT
WS_PORT=$WS_PORT
CADDY_PORT=$CADDY_PORT
WEB_PORT=$APP_PORT

# Security
ENCRYPTION_SECRET_KEY=$ENC_KEY
AUTH_DEMO_FALLBACK=false
DB_QUERY_LOG=false
WS_CORS_ORIGIN=http://localhost:$APP_PORT

# Toggles
# COGNEE_SERVER_URL connects to the internal compose cognee sidecar
COGNEE_SERVER_URL=http://cognee:8000
CONTEXTUAL_RETRIEVAL=true
NEXT_PUBLIC_APP_VERSION=1.0.0
NEXT_PUBLIC_WS_PORT=$WS_PORT

# Bootstrap admin (sign up with these credentials after install)
ADMIN_EMAIL=admin@ryasai.local
ADMIN_INITIAL_PASSWORD=$ADMIN_PASS

# License validation — central ryasai license server.
LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
LICENSE_PRODUCT=ryasai-chatbot
LICENSE_SIGNING_PUBLIC_KEY=${LICENSE_PUBKEY_ARG}
LICENSE_GRACE_PERIOD_DAYS=7
LICENSE_REVALIDATION_INTERVAL_HOURS=24

# Data-source DB (optional, for Text-to-SQL on your own DB)
RELATIONAL_DB_URL=

# Private SearXNG for web_search. Empty = fall back to scraping DuckDuckGo.
SEARXNG_URL=
EOF
  chmod 600 .env
  warn "Generated admin password: $ADMIN_PASS  (save this NOW, or run: grep ADMIN_INITIAL_PASSWORD .env)"
else
  info ".env already exists — keeping it."
  # Ensure APP_PORT line is set
  if ! grep -q '^APP_PORT=' .env 2>/dev/null; then
    printf '\nAPP_PORT=%s\n' "$APP_PORT" >> .env
  fi
fi

# Track license signing key
LICENSE_KEY_CONFIGURED=false
if [ -n "$LICENSE_PUBKEY_ARG" ] && grep -qE '^LICENSE_SIGNING_PUBLIC_KEY=..+' .env 2>/dev/null; then
  LICENSE_KEY_CONFIGURED=true
elif ! grep -q '^LICENSE_SIGNING_PUBLIC_KEY=' .env 2>/dev/null; then
  printf '\n# License response verification key (Ed25519 DER hex) — see install.sh --help\nLICENSE_SIGNING_PUBLIC_KEY=\n' >> .env
fi
if [ -n "$LICENSE_PUBKEY_ARG" ]; then
  if ! printf '%s' "$LICENSE_PUBKEY_ARG" | grep -qE '^[0-9a-fA-F]{60,}$'; then
    warn "LICENSE_SIGNING_PUBLIC_KEY does not look like a DER hex key (expected ~88 hex chars) — license verification may fail closed."
  fi
  sed -i "s|^LICENSE_SIGNING_PUBLIC_KEY=.*|LICENSE_SIGNING_PUBLIC_KEY=$LICENSE_PUBKEY_ARG|" .env
  LICENSE_KEY_CONFIGURED=true
fi

# SEARXNG_URL flag management
SEARXNG_TARGET=""
[ "$WITH_SEARXNG" = true ] && SEARXNG_TARGET="http://searxng:8080"
if grep -q '^SEARXNG_URL=' .env 2>/dev/null; then
  sed -i "s|^SEARXNG_URL=.*|SEARXNG_URL=$SEARXNG_TARGET|" .env
else
  printf '\n# Private SearXNG for web_search (empty = DuckDuckGo fallback)\nSEARXNG_URL=%s\n' "$SEARXNG_TARGET" >> .env
fi

# --- Pre-update backup (UPDATE only) ---------------------------------------
if [ "$IS_UPDATE" = true ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  if docker compose -f docker-compose.prod.yml ps --status running --services db >/dev/null 2>&1 \
     && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U ryasai -d ryasai > "$BACKUP_DIR/ryasai-$STAMP.sql" 2>/dev/null; then
    info "DB backup saved -> $BACKUP_DIR/ryasai-$STAMP.sql"
  fi
  # Keep newest 5 dumps
  ls -1t "$BACKUP_DIR"/ryasai-*.sql 2>/dev/null | tail -n +6 | xargs -r rm -f || true
fi

# --- Compose (Pure Prebuilt Images, NO source code build directives) --------
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
    entrypoint: ["bun", "node_modules/prisma/build/index.js", "db", "push", "--skip-generate"]
    restart: "no"
    networks: [ryasai-net]

  app:
    image: ghcr.io/ryasrk/ryasai-chatbot:app
    ports:
      - "127.0.0.1:${APP_PORT:-38180}:3000"
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
      - REDIS_URL=redis://redis:6379
      - NODE_ENV=production
      - LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
      - LICENSE_PRODUCT=ryasai-chatbot
      # Needed to reach the local embedding service. isBlockedHost() refuses
      # private/loopback hosts to prevent SSRF, and that guard applies to
      # self-hosted inference too: without this the app cannot call
      # `local-embeddings`, `resolveQueryEmbedding` returns null, and semantic
      # retrieval silently degrades to BM25 only while still reporting a
      # healthy-looking similarity score. Scoped to the service name.
      - LLM_ALLOWED_HOSTS=${LLM_ALLOWED_HOSTS:-local-embeddings}
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD-SHELL", "bun -e \"const r = await fetch('http://127.0.0.1:3000/api/v1/health'); process.exit(r.ok ? 0 : 1)\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    restart: unless-stopped
    networks: [ryasai-net]

  scheduler:
    image: ghcr.io/ryasrk/ryasai-chatbot:scheduler
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai
      - REDIS_URL=redis://redis:6379
      - NODE_ENV=production
      - LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
      - LICENSE_PRODUCT=ryasai-chatbot
      # Ingestion (embedDocumentChunks) runs here, so the worker needs the same
      # local-embeddings reachability as `app`. Missing this is invisible in
      # testing: the HTTP path still embeds, while documents uploaded by a
      # background job silently store no vectors.
      - LLM_ALLOWED_HOSTS=${LLM_ALLOWED_HOSTS:-local-embeddings}
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    restart: unless-stopped
    networks: [ryasai-net]

  # Local embedding server: semantic RAG + cognee without a hosted key.
  #
  # WHY IT SHIPS BY DEFAULT: without it `resolveQueryEmbedding` returns null and
  # retrieval silently degrades to lexical (BM25) only, while still reporting a
  # healthy-looking similarity score — MEASURED at 0/5 on hard paraphrase
  # questions versus 3/5 with it (tools/local-embeddings/README.md).
  #
  # DIMENSION: 384-dim model, and `DocumentChunk.embedding` is `vector(384)`, so
  # they match by construction. A mismatch is the worst failure mode here: every
  # vector write falls back to `embeddingJson` and the pgvector leg returns an
  # empty candidate set, with only a console warning. Change EMBEDDING_MODEL and
  # you MUST resize the Prisma column to the same width and re-embed.
  local-embeddings:
    image: ghcr.io/ryasrk/ryasai-chatbot:embeddings
    environment:
      - EMBEDDING_MODEL=${EMBEDDING_MODEL:-sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2}
      - EMBEDDING_HOST=0.0.0.0
      - EMBEDDING_PORT=8081
    volumes:
      # ~470MB of weights download on first use; without this every restart
      # re-downloads them from HuggingFace.
      - hfcache:/root/.cache/huggingface
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=5).status==200 else 1)\""]
      interval: 30s
      timeout: 10s
      retries: 3
      # First boot downloads ~470MB, so a tighter start_period would mark a
      # healthy container permanently unhealthy.
      start_period: 300s
    restart: unless-stopped
    networks: [ryasai-net]

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--maxmemory", "64mb", "--maxmemory-policy", "volatile-lru"]
    volumes: [redisdata:/data]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 10s, timeout: 3s, retries: 3 }
    restart: unless-stopped
    networks: [ryasai-net]

  cognee:
    image: cognee/cognee:1.6.0
    environment:
      - SYSTEM_ROOT_DIRECTORY=/cognee-storage/system
      - DATA_ROOT_DIRECTORY=/cognee-storage/data
      - DB_PROVIDER=sqlite
      - GRAPH_DATABASE_PROVIDER=kuzu
      - VECTOR_DB_PROVIDER=lancedb
      - ENABLE_BACKEND_ACCESS_CONTROL=false
      - LLM_PROVIDER=${COGNEE_LLM_PROVIDER:-openai}
      - LLM_API_KEY=${COGNEE_LLM_API_KEY:-}
      - LLM_ENDPOINT=${COGNEE_LLM_ENDPOINT:-}
      - LLM_MODEL=${COGNEE_LLM_MODEL:-}
      - EMBEDDING_PROVIDER=${COGNEE_EMBEDDING_PROVIDER:-openai}
      # MEASURED: litellm keys off PROVIDER, not ENDPOINT. With provider `openai`
      # and an EMPTY key it ignores EMBEDDING_ENDPOINT and calls api.openai.com,
      # which fails every write with `No credentials for provider: openai` and an
      # HTTP 400 — a message that points at OpenAI when the real problem is our
      # own local server never being contacted. A non-empty placeholder keeps it
      # on the OpenAI-compatible path (api_base) where the local server is used.
      # The value is never validated: local-embeddings does not authenticate.
      - EMBEDDING_API_KEY=${COGNEE_EMBEDDING_API_KEY:-local-no-auth}
      - EMBEDDING_ENDPOINT=${COGNEE_EMBEDDING_ENDPOINT:-http://local-embeddings:8081/v1}
      - EMBEDDING_MODEL=${COGNEE_EMBEDDING_MODEL:-sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2}
      # 384, NOT 1536: cognee shares the local embedding server with RAG, whose
      # model is 384-dim. cognee stores vectors separately from DocumentChunk, so
      # this does not have to match the pgvector column — but it MUST match what
      # the endpoint actually returns, or every write fails with a pydantic
      # "List should have at least N items" error that names the wrong cause.
      - EMBEDDING_DIMENSIONS=${COGNEE_EMBEDDING_DIMENSIONS:-384}
      - COGNEE_SKIP_CONNECTION_TEST=true
      - LITELLM_DROP_PARAMS=true
      - LLM_ALLOWED_HOSTS=${COGNEE_LLM_ALLOWED_HOSTS:-*}
      # --- v1.6.0 latency: turn OFF the per-turn session analysis -----------------
      # MEASURED against this sidecar and a real store, before these three:
      #   write 22-30s, search 24-95s (two consecutive searches took 81s each).
      # The server log showed the cause was NOT retrieval: "Found 3 chunks from
      # vector search" took 49 MILLISECONDS, then `SessionTurnAnalysis` ran, failed
      # schema validation and retried — "litellm_native validation retry 1/3: 1
      # validation error for SessionTurnAnalysis", six times in one log. WITH these
      # three off: write 9s, search 0.21s, and the stored token is still recalled.
      # AUTO_FEEDBACK=false is the load-bearing one; IMPROVE_AUTO_ENABLED=false stops
      # the post-remember improve() pass; USAGE_LOGGING=false drops usage rows we do
      # not bill on (the licence is flat, so nothing consumes them).
      - AUTO_FEEDBACK=${COGNEE_AUTO_FEEDBACK:-false}
      - IMPROVE_AUTO_ENABLED=${COGNEE_IMPROVE_AUTO:-false}
      - USAGE_LOGGING=false
    # The sidecar must reach the customer's own model endpoints. On a single-host install
    # those are usually on the host itself (an on-prem gateway, a local embedding server),
    # and a container cannot resolve `localhost` to its host — without this, writes fail
    # with a connection error that names the endpoint rather than the cause.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    # Applies cognee-fence-patch.sh before the image's own entrypoint. The pinned image's
    # fence-stripper is anchored to the WHOLE response, so an extraction whose JSON is
    # wrapped in a markdown fence alongside any prose is rejected and retried — measured
    # 228s for a first write on a fresh dataset. See the script for the full account.
    entrypoint: ["/bin/bash", "/opt/cognee-patch/entrypoint-with-patch.sh"]
    volumes:
      - ./cognee-patch:/opt/cognee-patch:ro
      - cogneedata:/cognee-storage
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 90s
    restart: unless-stopped
    networks:
      - ryasai-net

  db:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_USER=ryasai
      - POSTGRES_PASSWORD=ryasai
      - POSTGRES_DB=ryasai
    command: ["postgres", "-c", "shared_buffers=64MB", "-c", "max_connections=40", "-c", "effective_cache_size=128MB", "-c", "maintenance_work_mem=32MB"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U ryasai -d ryasai"], interval: 10s, timeout: 5s, retries: 5 }
    restart: unless-stopped
    networks: [ryasai-net]
EOF

# --- Optional: private SearXNG (--with-searxng) -----------------------------
if [ "$WITH_SEARXNG" = true ]; then
  if [ "$TOTAL_MB" -lt 1800 ]; then
    warn "--with-searxng on a ${TOTAL_MB}MB box: SearXNG wants ~256MB."
  fi
  mkdir -p searxng
  if [ ! -f searxng/settings.yml ]; then
    info "Writing searxng/settings.yml..."
    cat > searxng/settings.yml <<EOF
use_default_settings: true
server:
  secret_key: "$(openssl rand -hex 32)"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
EOF
    chmod 600 searxng/settings.yml
  fi
  cat >> docker-compose.prod.yml <<'EOF'

  searxng:
    image: searxng/searxng:latest
    volumes: ["./searxng:/etc/searxng:rw"]
    environment:
      - SEARXNG_BASE_URL=http://searxng:8080/
    mem_limit: 256m
    restart: unless-stopped
    networks: [ryasai-net]
EOF
fi

# --- cognee fence patch (see the cognee service above) --------------------------------
# Written here rather than downloaded: this installer may be the only thing on the machine,
# and a fetch would make a customer install depend on network reach at deploy time.
# Idempotent — the script exits early if already applied, so re-running is safe.
mkdir -p cognee-patch
cat > cognee-patch/patch-fence-strip.sh <<'PATCHEOF'
#!/usr/bin/env bash
# Patch cognee's markdown-fence handling inside the running sidecar.
#
# WHY THIS EXISTS
#
# cognee's own `_strip_json_fence` (native_adapter.py) removes a wrapping markdown
# fence — but its regex is anchored to the WHOLE response:
#
#     \A\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*\Z
#
# So it only fires when the fence is the entire message. A model that writes a sentence
# before or after the block — which is the common case, and what this deployment's
# endpoint actually does — falls through, pydantic sees a backtick, and the extraction is
# rejected. MEASURED against this deployment's sidecar: 24 such rejections in one
# container's log, of the shapes
#
#     '```json\n{\n  "nodes": [...all values to strings'
#     'Fixed the field names (```json\n{\n ... \n```'
#
# Each costs a retry ("litellm_native validation retry 1/3", "Retrying … in 16.5
# seconds") and one write against a FRESH dataset measured 228 seconds.
#
# Note the model is not at fault: this endpoint DOES emit clean JSON when asked for
# `response_format: {"type": "json_object"}` (verified directly, returns `{"a":1}` with no
# fence). It is only the `json_schema` path that comes back fenced — and the upstream
# fence-stripper that exists for exactly this case cannot see the fence.
#
# WHAT IT DOES
#
# Replaces the anchored regex with an unanchored one, so a fence is found anywhere in the
# response. Semantics are otherwise identical: if no fence is present, the text is returned
# unchanged, so a model that already returns clean JSON is unaffected.
#
# THIS IS A PATCH TO A VENDORED IMAGE, NOT A FIX WE CONTROL.
#
# It is applied at container start, so it does not persist in the image and is visible
# here rather than hiding in a Dockerfile layer. It should be removed the moment upstream
# widens the regex (check with `python3 -c` below, or by grepping for CLO-596, the ticket
# the existing helper references). Until then the alternative is a known 24-in-one-log
# failure rate that surfaces to the user as "memory sometimes forgets".
#
# Usage (inside the cognee container, as root):
#   /patch-fence-strip.sh          # apply
#   /patch-fence-strip.sh --check   # report whether it is applied
set -euo pipefail

# BOTH copies must be patched, and this is not defensive tidiness: the image ships the
# package twice (`/app/cognee` and `/app/.venv/lib/python3.12/site-packages/cognee`), and
# which one a process imports depends on how it was started. Patching one and testing the
# other is how a fix looks applied and behaves unpatched.
ADAPTERS=(
  /app/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py
  /app/.venv/lib/python3.12/site-packages/cognee/infrastructure/llm/structured_output_framework/litellm_native/native_adapter.py
)

PRESENT=()
for a in "${ADAPTERS[@]}"; do [ -f "$a" ] && PRESENT+=("$a"); done
if [ ${#PRESENT[@]} -eq 0 ]; then
  echo "[patch-fence] no adapter found at any known path — cognee layout changed; update this script." >&2
  exit 2
fi

ALL_APPLIED=1
for a in "${PRESENT[@]}"; do
  grep -q 'UNANCHORED-BEGIN' "$a" || ALL_APPLIED=0
done
if [ "${1:-}" = "--check" ]; then
  [ "$ALL_APPLIED" = 1 ] && { echo "[patch-fence] applied (${#PRESENT[@]} copies)"; exit 0; }
  echo "[patch-fence] NOT applied"; exit 1
fi
[ "$ALL_APPLIED" = 1 ] && { echo "[patch-fence] already applied"; exit 0; }

for ADAPTER in "${PRESENT[@]}"; do
python3 - "$ADAPTER" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

# The upstream pattern, matched by its distinctive anchors rather than by exact text so a
# whitespace or comment change upstream does not silently skip the patch.
# Match by LINE, not by a regex over the whole expression: the literal contains `\A`,
# `\s*` and a triple-backtick run, and any pattern trying to describe it precisely is
# fragile in exactly the way that would leave the patch silently unapplied. One line, one
# assignment, replaced wholesale.
old_literal = None
for line in src.splitlines():
    if line.startswith('_JSON_FENCE_RE = re.compile('):
        old_literal = line
        break
if old_literal is None:
    print("[patch-fence] could not find the _JSON_FENCE_RE assignment — upstream changed; inspect before patching", file=sys.stderr)
    sys.exit(3)
if '\\A' not in old_literal:
    print(f"[patch-fence] the pattern no longer looks anchored ({old_literal!r}); upstream may have fixed this — refusing to patch", file=sys.stderr)
    sys.exit(3)

new_literal = (
    '_JSON_FENCE_RE = re.compile(r"```(?:json)?\\s*\\n?(.*?)\\n?\\s*```", re.DOTALL)'
    '  # UNANCHORED-BEGIN: find a fence ANYWHERE, not only when it wraps the whole reply.'
    ' Upstream anchors to \\A...\\Z, so a model that writes a sentence before or after the'
    ' block is not stripped and the extraction is rejected. See patch-fence-strip.sh.'
)

src = src.replace(old_literal, new_literal, 1)

# The widened pattern is useless while the CALL still anchors to the start of the string:
# `_JSON_FENCE_RE.match(text)` only looks at position 0, so prose BEFORE the fence is never
# seen. MEASURED on this deployment's own rejections, where the model wrote
# "Fixed the field names (" and then the block. `.search()` finds the fence anywhere, which
# is the whole point of removing the anchors.
if '_JSON_FENCE_RE.search(text)' not in src:
    if '_JSON_FENCE_RE.match(text)' not in src:
        print("[patch-fence] neither .match() nor .search() call found — upstream changed; inspect", file=sys.stderr)
        sys.exit(4)
    src = src.replace('_JSON_FENCE_RE.match(text)', '_JSON_FENCE_RE.search(text)', 1)

# Guard: the helper must still return the ORIGINAL text when there is no fence, otherwise a
# clean-JSON model would start returning "None".
if 'return match.group(1) if match else text' not in src:
    print("[patch-fence] expected _strip_json_fence body changed — refusing to patch", file=sys.stderr)
    sys.exit(5)

open(path, "w", encoding="utf-8").write(src)
print("[patch-fence] regex widened; fences are now found anywhere in the response")
PY

# Compile-check the result. A syntax error here would take the whole memory backend down,
# which is a far worse outcome than the fences we are fixing.
python3 -c "import ast,sys; ast.parse(open('$ADAPTER', encoding='utf-8').read())" \
  || { echo "[patch-fence] patched file does not parse: $ADAPTER" >&2; exit 6; }

# Behavioural check, not just a syntax check: exercise the four shapes on the file we just
# wrote. MEASURED before the fix: only the "fence wraps everything" case passed; prose before
# or after the block — the shapes this deployment actually produces — fell through.
python3 - "$ADAPTER" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("patched_adapter", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
cases = {
    "fence wraps all":      '```json\n{"a":1}\n```',
    "prose after fence":    '```json\n{"a":1}\n```\nHope this helps!',
    "prose before fence":   'Here you go:\n```json\n{"a":1}\n```',
    "clean json (no fence)": '{"a":1}',
}
bad = [k for k, v in cases.items() if not mod._strip_json_fence(v).startswith("{")]
if bad:
    print(f"[patch-fence] behaviour check failed for {bad} in {sys.argv[1]}", file=sys.stderr)
    sys.exit(7)
print(f"[patch-fence] behaviour verified: {len(cases)}/{len(cases)} shapes")
PYEOF

echo "[patch-fence] applied to $ADAPTER"
done

PATCHEOF
cat > cognee-patch/entrypoint-with-patch.sh <<'ENTRYEOF'
#!/bin/bash
# Wrapper entrypoint for the pinned cognee sidecar.
#
# Applies tools/cognee-server/patch-fence-strip.sh, then hands off to the image's own
# /app/entrypoint.sh unchanged. Doing it this way rather than rebuilding the image keeps the
# patch visible and easy to delete once upstream fixes the regex — see that script for the
# full account of why it exists and how to tell when it is no longer needed.
#
# FAIL-OPEN BY DESIGN. If the patch cannot be applied, the server still starts: a sidecar
# that refuses to boot is a total memory outage, while an unpatched sidecar is the
# behaviour this deployment had before the patch (slower writes, some rejected
# extractions). The failure is echoed loudly so it cannot pass unnoticed.
set -u

PATCH=/opt/cognee-patch/patch-fence-strip.sh

if [ -f "$PATCH" ]; then
  if bash "$PATCH"; then
    echo "[entrypoint] fence patch applied"
  else
    echo "[entrypoint] WARNING: fence patch FAILED (exit $?). Server will start UNPATCHED — expect" >&2
    echo "[entrypoint]          slower writes on new datasets and intermittent rejected" >&2
    echo "[entrypoint]          extractions. The patch does NOT survive an image upgrade." >&2
  fi
else
  echo "[entrypoint] WARNING: $PATCH not found — starting unpatched." >&2
fi

exec /app/entrypoint.sh "$@"

ENTRYEOF
chmod +x cognee-patch/*.sh

cat >> docker-compose.prod.yml <<'EOF'

networks:
  ryasai-net:
volumes:
  pgdata:
  redisdata:
  cogneedata:
  hfcache:
EOF

# --- Disk guard ------------------------------------------------------------
MIN_FREE_MB=2000
MB_FREE=$(df -m / | awk 'NR==2{print $4}')
if [ "$MB_FREE" -lt "$MIN_FREE_MB" ]; then
  warn "Low disk (${MB_FREE}MB free, need $MIN_FREE_MB) — pruning unused Docker images..."
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
fi

# --- Pull & run (PREBUILT IMAGES ONLY, NO BUILD FALLBACK) ------------------
info "Pulling official prebuilt images..."
if ! docker compose -f docker-compose.prod.yml pull; then
  if [ "$IS_UPDATE" = true ]; then
    warn "Image pull failed — keeping existing running containers. Check network connection and re-run."
    exit 1
  else
    fail "Failed to pull prebuilt images from registry. Check network connection or registry access."
  fi
fi

info "Starting services (db + redis + cognee -> migrate -> app + scheduler)..."
docker compose -f docker-compose.prod.yml up -d --remove-orphans

# --- Health ----------------------------------------------------------------
info "Waiting for app to come up on 127.0.0.1:${APP_PORT}..."
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${APP_PORT}/api/v1/health" >/dev/null 2>&1 && break || sleep 3
done

echo
echo "=============================================================="
echo "  ryasai Chatbot installed (Prebuilt Images Only)."
echo "=============================================================="
echo
echo "  Access (local):   http://127.0.0.1:${APP_PORT}"
echo "  Admin email:      $(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2)"
echo "  Admin password:   $(grep -E '^ADMIN_INITIAL_PASSWORD=' .env | cut -d= -f2)"
echo
if [ "$LICENSE_KEY_CONFIGURED" != true ]; then
  echo "**************************************************************"
  echo "*  ⚠️  LICENSING NOT OPERATIONAL — ACTION REQUIRED            *"
  echo "*                                                            *"
  echo "*  LICENSE_SIGNING_PUBLIC_KEY is not set. License responses  *"
  echo "*  cannot be signature-verified, so licensing FAILS CLOSED:  *"
  echo "*  signup/license activation will not work.                  *"
  echo "*                                                            *"
  echo "*  Fix: re-run this installer with the operator-provisioned  *"
  echo "*  key from the ryasai license server:                       *"
  echo "*    bash install.sh --license-signing-public-key <hex>      *"
  echo "*  (or export LICENSE_SIGNING_PUBLIC_KEY=<hex> first)        *"
  echo "**************************************************************"
  echo
fi
echo "  Put behind Caddy/Nginx on this server with your domain, e.g.:"
echo ""
echo "    license-side:   license.ryasai.my.id  -> License-Validator (central)"
echo "    app-side:       yourdomain.com        -> 127.0.0.1:${APP_PORT}"
echo ""
echo "  Example Nginx reverse proxy configuration:"
echo "    server {"
echo "        server_name yourdomain.com;"
echo "        location / {"
echo "            proxy_pass http://127.0.0.1:${APP_PORT};"
echo "            proxy_set_header Host \$host;"
echo "            proxy_set_header X-Real-IP \$remote_addr;"
echo "            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
echo "            proxy_set_header X-Forwarded-Proto \$scheme;"
echo "            proxy_set_header Upgrade \$http_upgrade;"
echo "            proxy_set_header Connection \"upgrade\";"
echo "        }"
echo "    }"
echo ""
echo "  Logs:     docker compose -f docker-compose.prod.yml logs -f app"
echo "  Restart:  docker compose -f docker-compose.prod.yml restart"
echo "  Stop:     docker compose -f docker-compose.prod.yml down"
echo "=============================================================="
