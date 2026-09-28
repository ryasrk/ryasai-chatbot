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

# --- Version identity -------------------------------------------------------
#
# KEEP IN STEP with package.json, .env.example, src/lib/public-config.ts,
# src/components/views/topbar.tsx, src/lib/otel.ts and CHANGELOG.md.
# `src/lib/release-version.test.ts` fails the build when they disagree, and also when a pushed
# `v<version>` tag disagrees — so a release published as `:1.1.0` cannot report `1.0.0` in its UI.
INSTALLER_VERSION="1.0.0"

# The set of variable NAMES this installer's generated .env defines, one per line.
#
# Printed by `render_env` below, which is also what WRITES `.env` — so the list cannot drift from
# what the installer actually does. A hand-maintained second copy is exactly the defect this function
# exists to avoid, and reading the file back (awk on "$0") does not work here: `$0` is the string
# "bash" when the installer is piped from curl, which is the documented install path.
installer_env_keys() {
  render_env | grep -oE '^[A-Z_][A-Z_0-9]*=' | tr -d '='
}

# Emits the generated .env to stdout. Values come from globals set by the caller; on an update the
# caller only needs the KEY NAMES, so values are read with `${VAR:-}`.
#
# MEASURED BUG THIS FIXES: `installer_env_keys` is called on the UPDATE path, where `.env` already
# exists and the generate branch is skipped — so `ENC_KEY` and `ADMIN_PASS` are never assigned. The
# template referenced them as `${ENC_KEY}`, and the script runs under `set -u`, so the installer died
# with:
#
#     /tmp/install-1.0.0.sh: line 54: ENC_KEY: unbound variable
#
# i.e. EVERY update aborted, in the step that was supposed to record the manifest. The comment above
# this function already said empty values were acceptable; the template simply did not honor it.
# `${VAR:-}` is what makes that true.
render_env() {
  cat <<EOF
# Database — change to an external host if you already run PostgreSQL elsewhere
DATABASE_URL=postgresql://ryasai:ryasai@db:5432/ryasai

# Internal container port matches standard Next.js (3000)
PORT=3000

# Unique host ports (avoids collisions with 80, 443, 3000, 8080, etc.)
APP_PORT=${APP_PORT:-}
WS_PORT=${WS_PORT:-}
CADDY_PORT=${CADDY_PORT:-}
WEB_PORT=${APP_PORT:-}

# Security
ENCRYPTION_SECRET_KEY=${ENC_KEY:-}
AUTH_DEMO_FALLBACK=false
DB_QUERY_LOG=false
WS_CORS_ORIGIN=http://localhost:${APP_PORT:-}

# Toggles
# COGNEE_SERVER_URL connects to the internal compose cognee sidecar
COGNEE_SERVER_URL=http://cognee:8000
CONTEXTUAL_RETRIEVAL=true
NEXT_PUBLIC_APP_VERSION=${INSTALLER_VERSION:-}
NEXT_PUBLIC_WS_PORT=${WS_PORT:-}

# Bootstrap admin. NOTE: nothing reads these — signup creates the org and the first admin.
# Kept only as a template for older deployments; the installer no longer presents them as logins.
ADMIN_EMAIL=admin@ryasai.local
ADMIN_INITIAL_PASSWORD=${ADMIN_PASS:-}

# License validation — central ryasai license server.
LICENSE_VALIDATOR_URL=https://license.ryasai.my.id
LICENSE_PRODUCT=ryasai-chatbot
LICENSE_SIGNING_PUBLIC_KEY=${LICENSE_PUBKEY_ARG:-}
LICENSE_GRACE_PERIOD_DAYS=7
LICENSE_REVALIDATION_INTERVAL_HOURS=24

# Data-source DB (optional, for Text-to-SQL on your own DB)
RELATIONAL_DB_URL=

# Private SearXNG for web_search. Empty = fall back to scraping DuckDuckGo.
SEARXNG_URL=
EOF
}

# --- Options ---------------------------------------------------------------
WITH_SEARXNG=false
LICENSE_PUBKEY_ARG="${LICENSE_SIGNING_PUBLIC_KEY:-}"
APP_PORT_ARG=""
APP_DIR_ARG=""
DEFAULT_APP_PORT=38180

while [ $# -gt 0 ]; do
  case "$1" in
    --with-searxng) WITH_SEARXNG=true; shift ;;
    --port)
      [ $# -ge 2 ] || fail "--port requires a port number (e.g. 38180)"
      APP_PORT_ARG="$2"; shift 2 ;;
    --dir)
      [ $# -ge 2 ] || fail "--dir requires a path (e.g. --dir /home/ubuntu/ryasai-chatbot)"
      APP_DIR_ARG="$2"; shift 2 ;;
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
      echo "  --dir <path>                    Deploy directory (default: /opt/ryasai-chatbot)."
      echo "                                  Point this at an install that lives elsewhere. Running"
      echo "                                  against the wrong directory creates a SECOND stack whose"
      echo "                                  freshly generated ENCRYPTION_SECRET_KEY cannot decrypt"
      echo "                                  the existing credentials."
      echo "  --with-searxng                  Run a private SearXNG for web_search (~256MB RAM)."
      echo "  --license-signing-public-key <hex>"
      echo "                                  Ed25519 public key (DER hex) for verifying license"
      echo "                                  responses. Falls back to \$LICENSE_SIGNING_PUBLIC_KEY."
      echo "                                  If neither is given, license verification stays"
      echo "                                  DISABLED and the app fails closed on licensing."
      exit 0 ;;
    *) fail "Unknown option: $1 (supported: --port <number>, --dir <path>, --with-searxng, --license-signing-public-key <hex>)" ;;
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

# Is this an UPDATE at the deploy dir? Resolved BEFORE the port check, because on an update the
# port is EXPECTED to be in use — by this install's own app container.
#
# MEASURED BUG THIS FIXES (2026-09-27, real deployment): the port check ran FIRST, saw the running
# app on 38180, and concluded "another service" held it:
#
#     WARN: Port 38180 is already in use by another service on this host.
#     ==> Automatically selected free unique port: 38181
#
# On a fresh install that is correct behaviour. On an UPDATE it silently moved the app to a different
# port — and because the customer's reverse proxy / SSH tunnel forwards to the OLD port, the site
# goes dark while every container reports healthy. The check now inspects the deploy dir first.
PRE_DETECT_DIR=""
for cand in "$APP_DIR_ARG" /opt/ryasai-chatbot /home/*/ryasai-chatbot /root/ryasai-chatbot /srv/ryasai-chatbot; do
  [ -n "$cand" ] || continue
  if [ -f "$cand/.env" ] && [ -f "$cand/docker-compose.prod.yml" ]; then PRE_DETECT_DIR="$cand"; break; fi
done
PRE_IS_UPDATE=false
[ -n "$PRE_DETECT_DIR" ] && PRE_IS_UPDATE=true

if is_port_in_use "$APP_PORT"; then
  if [ "$PRE_IS_UPDATE" = true ]; then
    # Expected: our own container. Keep the port — moving it would break the reverse proxy.
    info "Port $APP_PORT is in use — assumed to be the existing install at $PRE_DETECT_DIR (updating in place)."
  else
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
fi

WS_PORT=$(( APP_PORT + 3 ))
CADDY_PORT=$(( APP_PORT + 1 ))

# --- Deploy dir (NO SOURCE CODE CLONING) -----------------------------------
#
# APP_DIR defaults to /opt/ryasai-chatbot but is OVERRIDABLE, and that is not a convenience.
#
# MEASURED INCIDENT (2026-09-27). An existing deployment lived at /home/ubuntu/ryasai-chatbot. Running
# this installer against it produced a SECOND, EMPTY deployment in /opt/ryasai-chatbot instead of
# updating the real one — because the directory was hardcoded and nothing looked for an existing
# install anywhere else. That is bad on its own (the customer's data stays behind while a blank stack
# starts), and it got worse: the fresh `.env` contained a NEWLY GENERATED ENCRYPTION_SECRET_KEY, and
# `docker compose` in the new directory recreated the app container using it. AES-256-GCM configs
# (`LlmConfig.encryptedApiKey`, integrations, vector-store keys) are encrypted with that key, so the
# app would have failed to decrypt the customer's own credentials.
#
# Verified by attempting decryption of a real `LlmConfig.encryptedApiKey` with both keys:
#   /opt key  -> GAGAL (Unsupported state or unable to authenticate data)
#   /home key -> OK (apiKey recovered)
# which is why the wrong directory is a DATA problem, not a cosmetic one.
#
# Two defences now: `--dir` names the target explicitly, and an unset APP_DIR is probed for a likely
# existing deployment before defaulting, with the choice printed.
if [ -n "$APP_DIR_ARG" ]; then
  APP_DIR="$APP_DIR_ARG"
  info "Deploy directory (explicit): $APP_DIR"
else
  APP_DIR=/opt/ryasai-chatbot
  if [ ! -f "$APP_DIR/.env" ]; then
    # No install at the default path — look for one before creating a second stack.
    FOUND=""
    for cand in /home/ubuntu/ryasai-chatbot /home/*/ryasai-chatbot /root/ryasai-chatbot /srv/ryasai-chatbot /opt/ryasai; do
      if [ -f "$cand/.env" ] && [ -f "$cand/docker-compose.prod.yml" ]; then FOUND="$cand"; break; fi
    done
    if [ -n "$FOUND" ]; then
      warn "Found an existing install at $FOUND, but this installer defaults to $APP_DIR."
      warn "Continuing would create a SECOND deployment with a NEW ENCRYPTION_SECRET_KEY, and the"
      warn "app would then be unable to decrypt existing credentials (they are keyed to the old one)."
      warn "To update it instead, re-run with:  --dir $FOUND"
      fail "Refusing to run against $APP_DIR while an install exists at $FOUND."
    fi
  fi
fi
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
  render_env > .env
  chmod 600 .env
  warn "Generated admin password: $ADMIN_PASS  (saved to .env; NOT a login — see the end of this output)"
else
  info ".env already exists — keeping it."
  # Ensure APP_PORT line is set
  if ! grep -q '^APP_PORT=' .env 2>/dev/null; then
    printf '\nAPP_PORT=%s\n' "$APP_PORT" >> .env
  fi
fi

# Track license signing key
#
# MEASURED BUG THIS FIXES: the flag was set to true only when `--license-signing-public-key` was
# PASSED, so a working install that already had a key in `.env` reported
# "LICENSING NOT OPERATIONAL — ACTION REQUIRED" on every update. That warning is not cosmetic — it
# tells an operator their licensing is broken and names a fix they do not need. Found while updating
# a real deployment whose `.env` held a valid key, where it would have fired immediately.
#
# The value on disk is the only thing that matters, so read it from there first and treat the flag as
# a way to SET the key, not as the source of truth about whether one exists.
LICENSE_KEY_CONFIGURED=false
if grep -qE '^LICENSE_SIGNING_PUBLIC_KEY=.+' .env 2>/dev/null; then
  LICENSE_KEY_CONFIGURED=true
elif ! grep -q '^LICENSE_SIGNING_PUBLIC_KEY=' .env 2>/dev/null; then
  # No line at all: add an empty one so `--license-signing-public-key` has somewhere to write and the
  # key is visible to whoever provisions it later.
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

# --- Cognee sidecar config (.env.cognee) ------------------------------------
#
# A SEPARATE file, because cognee needs its own model credentials and they are not the app's.
#
# WHY IT CANNOT SHARE `.env`: the app stores its LLM/embedding config in the DATABASE
# (`LlmConfig`, encrypted with ENCRYPTION_SECRET_KEY) and reads it through the tenant's own row.
# Cognee is a separate process with no access to that row and no access to the key, so it needs a
# plaintext copy of a provider endpoint + key. Keeping that copy OUT of `.env` means:
#   * the app's config and the sidecar's config can be rotated independently;
#   * `.env` (which also carries ENCRYPTION_SECRET_KEY and the license key) is not the file an
#     operator has to hand to a memory-tuning change;
#   * a cognee credential cannot be accidentally exposed by anything that summarises `.env`.
#
# MEMORY IS OPT-IN. An empty skeleton is written when no key is supplied, and comments out every
# value. Cognee then starts, /health reports healthy, and every WRITE fails — documented here and in
# docs/RELEASE.md rather than papered over with a placeholder key that would fail differently.
#
# The embedding block IS pre-filled, because it works without customer input: it points at the
# bundled `local-embeddings` service. Only the chat LLM needs a decision.
COGNEE_ENV_FILE=".env.cognee"
if [ ! -f "$COGNEE_ENV_FILE" ]; then
  info "Writing $COGNEE_ENV_FILE (separate cognee credential file)..."
  cat > "$COGNEE_ENV_FILE" <<'COGNEEEOF'
# Cognee sidecar credentials — SEPARATE from .env, and read only by the `cognee` service.
#
# The app does NOT read this file. Cognee runs its own extraction pipeline and therefore needs its
# own chat LLM; it cannot borrow the app's config, which lives encrypted in the database.
#
# Leave LLM_API_KEY empty to run with MEMORY DISABLED. Cognee will start and report healthy, but
# every memory write fails — there is no partial mode.

# --- Chat LLM used for entity/relation extraction -----------------------------
# Any OpenAI-compatible endpoint. LLM_MODEL needs the `openai/` prefix: litellm reads the part
# before the slash as a PROVIDER, so a bare model id is treated as an unknown provider and the
# endpoint is never called — a failure that names the wrong cause.
#
# These names are cognee's OWN (`LLM_*`, not `COGNEE_LLM_*`): this file is passed straight to the
# sidecar, so the variable it reads is the variable to set. That is what makes the separation work —
# nothing in the compose file re-interprets them.
LLM_PROVIDER=openai
LLM_ENDPOINT=
LLM_MODEL=
LLM_API_KEY=

# --- Embeddings (pre-filled: the bundled local server needs no key) -----------
# 384-dim. This is shared with RAG's embedder, which is why the dimension must not change here
# alone: a mismatch stores no vectors and degrades retrieval silently.
#
# THE `openai/` PREFIX IS REQUIRED, and omitting it cost 30 seconds on every health check.
# MEASURED in this container, calling litellm exactly as the server does:
#
#     model="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
#       -> BadRequestError: LLM Provider NOT provided          (0.0s, provider unparsable)
#     model="openai/paraphrase-multilingual-MiniLM-L12-v2"
#       -> OK, dim=384 (0.7s)
#
# litellm reads the text BEFORE the slash as a PROVIDER NAME, so a bare model id is parsed as a
# provider called `sentence-transformers` and the request never leaves the process. The endpoint is
# up and answers a direct call in 0.055s, which is what makes this so misleading: the only symptom
# is `/health/detailed` reporting `embedding_service: degraded — connection test timed out after
# 30s`, and the AI Memory panel then takes 30.2s to render.
#
# NOT the same value as the `local-embeddings` service's EMBEDDING_MODEL, which is the HuggingFace
# id and must NOT be prefixed. They are separate variables that happen to share a name; copying one
# into the other is how this defect was introduced.
#
# EMBEDDING_API_KEY must be NON-EMPTY: litellm keys off PROVIDER, not ENDPOINT, so with provider
# `openai` and an empty key it ignores EMBEDDING_ENDPOINT and calls api.openai.com, failing every
# write with "No credentials for provider: openai" — a message pointing at OpenAI when the real
# problem is our own server never being contacted. The value is never validated.
EMBEDDING_PROVIDER=openai
EMBEDDING_ENDPOINT=http://local-embeddings:8081/v1
EMBEDDING_MODEL=openai/paraphrase-multilingual-MiniLM-L12-v2
EMBEDDING_DIMENSIONS=384
EMBEDDING_API_KEY=local-no-auth

# --- Outbound SSRF allow-list for the sidecar's own calls ---------------------
# `*` matches the shipped default. Narrow it to your gateway hostname if you prefer.
LLM_ALLOWED_HOSTS=*

# --- Latency: keep these OFF unless you have measured the cost ----------------
# MEASURED with the defaults: write 22-30s, search 24-95s — the cost was NOT retrieval
# ("Found 3 chunks from vector search" took 49 MILLISECONDS) but SessionTurnAnalysis calling the
# LLM and retrying on a schema-validation error. With these off: write 9s, search 0.21s.
# AUTO_FEEDBACK is the load-bearing one; IMPROVE_AUTO_ENABLED stops the post-remember improve()
# pass. USAGE_LOGGING is set in the compose file and is not a per-install choice.
AUTO_FEEDBACK=false
IMPROVE_AUTO_ENABLED=false
COGNEEEOF
  chmod 600 "$COGNEE_ENV_FILE"
  warn "Memory is configured OFF: $COGNEE_ENV_FILE has no LLM_API_KEY."
  warn "  Memory stays disabled until you set LLM_ENDPOINT, LLM_MODEL and"
  warn "  LLM_API_KEY in $APP_DIR/$COGNEE_ENV_FILE, then: docker compose up -d cognee"
else
  info "$COGNEE_ENV_FILE already exists — keeping it."
  # Ensure the file is never EMPTY. Compose refuses to start when a listed env_file is absent, and a
  # zero-byte file is the shape most likely to be produced by a failed edit; a comment keeps it valid.
  [ -s "$COGNEE_ENV_FILE" ] || printf '# cognee config (empty — memory disabled)\n' > "$COGNEE_ENV_FILE"
fi

# --- Fix an EMBEDDING_MODEL that is missing its provider prefix ---------------
#
# MEASURED DEFECT, and the reason the AI Memory page appeared to hang. An install whose .env.cognee
# carried the bare HuggingFace id:
#
#   EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
#
# litellm reads the text before the slash as a PROVIDER name, so that string is a provider called
# `sentence-transformers`. Verified inside the sidecar by calling litellm exactly as the server does:
#
#   bare id      -> BadRequestError: "LLM Provider NOT provided"   (0.0s)
#   openai/<id>  -> OK, dim=384                                    (0.7s)
#
# The visible symptom is completely misleading: `/health/detailed` takes 30.2s (its embedding probe
# retries until a 30s timeout) and then reports `embedding_service: degraded — connection test timed
# out`, while the embedding endpoint itself answers a direct call in 0.055s. The AI Memory card awaits
# that call, so the PAGE STALLS for the full 30s.
#
# Why this is safe to rewrite automatically, unlike every other setting here: the fix is mechanical,
# the value is not a secret or a customer choice, and leaving it produces a silent stall. It only
# touches values that contain a slash but no `openai/`-style prefix, so a correctly configured
# install is untouched and an already-correct custom provider is left alone.
if grep -qE '^EMBEDDING_MODEL=[^/]+/' "$COGNEE_ENV_FILE" 2>/dev/null; then
  BARE_MODEL="$(grep -E '^EMBEDDING_MODEL=' "$COGNEE_ENV_FILE" | head -1 | cut -d= -f2-)"
  case "$BARE_MODEL" in
    openai/*|anthropic/*|azure/*|ollama/*|gemini/*|bedrock/*|cohere/*|mistral/*|huggingface/*|vertex_ai/*|litellm_proxy/*) ;;
    *)
      warn "EMBEDDING_MODEL in $COGNEE_ENV_FILE has no provider prefix: $BARE_MODEL"
      warn "  litellm parses the text before '/' as a provider, so this never reaches the endpoint —"
      warn "  the symptom is a 30s stall on the AI Memory page, NOT a connection error."
      sed -i "s|^EMBEDDING_MODEL=.*|EMBEDDING_MODEL=openai/${BARE_MODEL#*/}|" "$COGNEE_ENV_FILE"
      info "  Rewrote it to: EMBEDDING_MODEL=openai/${BARE_MODEL#*/}"
      ;;
  esac
fi

# --- Migrate a pre-separation cognee config out of .env ----------------------
#
# Before .env.cognee existed, cognee's credentials were read from `.env` through
# `COGNEE_*` variables that compose interpolated. Those are now DEAD: the cognee service takes
# its config from .env.cognee only, so an install updating from an older release would keep a
# working-looking `.env` and silently lose its memory credentials.
#
# The values are COPIED, never moved or deleted. `.env` is the file holding the license key and
# ENCRYPTION_SECRET_KEY; editing it during an update is the exact operation that already caused one
# incident. Leaving the old lines costs nothing — nothing reads them — so they stay as a record.
if grep -qE '^COGNEE_(LLM|EMBEDDING)_' .env 2>/dev/null; then
  MIGRATED=0
  for pair in \
    "COGNEE_LLM_PROVIDER:LLM_PROVIDER" \
    "COGNEE_LLM_ENDPOINT:LLM_ENDPOINT" \
    "COGNEE_LLM_MODEL:LLM_MODEL" \
    "COGNEE_LLM_API_KEY:LLM_API_KEY" \
    "COGNEE_EMBEDDING_PROVIDER:EMBEDDING_PROVIDER" \
    "COGNEE_EMBEDDING_ENDPOINT:EMBEDDING_ENDPOINT" \
    "COGNEE_EMBEDDING_MODEL:EMBEDDING_MODEL" \
    "COGNEE_EMBEDDING_DIMENSIONS:EMBEDDING_DIMENSIONS" \
    "COGNEE_EMBEDDING_API_KEY:EMBEDDING_API_KEY" \
    "COGNEE_LLM_ALLOWED_HOSTS:LLM_ALLOWED_HOSTS" \
    "COGNEE_AUTO_FEEDBACK:AUTO_FEEDBACK" \
    "COGNEE_IMPROVE_AUTO:IMPROVE_AUTO_ENABLED"
  do
    SRC_KEY="${pair%%:*}"; DST_KEY="${pair##*:}"
    # Only when the destination is absent or empty: never clobber a value already set here.
    if grep -qE "^${DST_KEY}=.+" "$COGNEE_ENV_FILE" 2>/dev/null; then continue; fi
    # `|| true` IS REQUIRED, not defensive: the script runs under `set -euo pipefail`, and a grep
    # that matches nothing exits 1. Command substitution inherits that status, so the assignment
    # ABORTED THE WHOLE INSTALLER on the first key whose old variable was absent — measured on a real
    # deployment, which stopped here with EXIT=1 and no error message. Reading a possibly-absent
    # value must never be able to kill the script that is doing the reading.
    VAL="$(grep -E "^${SRC_KEY}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
    [ -n "$VAL" ] || continue
    if grep -qE "^${DST_KEY}=" "$COGNEE_ENV_FILE" 2>/dev/null; then
      sed -i "s|^${DST_KEY}=.*|${DST_KEY}=${VAL}|" "$COGNEE_ENV_FILE"
    else
      printf '%s=%s\n' "$DST_KEY" "$VAL" >> "$COGNEE_ENV_FILE"
    fi
    MIGRATED=$((MIGRATED+1))
  done
  if [ "$MIGRATED" -gt 0 ]; then
    info "Migrated $MIGRATED cognee setting(s) from .env to $COGNEE_ENV_FILE."
    warn "  The old COGNEE_* lines remain in .env but are NO LONGER READ — edit $COGNEE_ENV_FILE"
    warn "  from now on. (They are left in place because .env holds your license key and"
    warn "  ENCRYPTION_SECRET_KEY, and rewriting that file during an update is how data is lost.)"
  fi
fi

if [ "$IS_UPDATE" = true ] || [ -f "$COGNEE_ENV_FILE" ]; then
  # Report whether memory can actually write, so "configured" is never inferred from the container
  # being up. A running sidecar with no key is the exact state this file exists to make visible.
  if grep -qE '^LLM_API_KEY=.+' "$COGNEE_ENV_FILE" 2>/dev/null; then
    info "Memory credentials present in $COGNEE_ENV_FILE."
  else
    warn "Memory is OFF: $COGNEE_ENV_FILE has no LLM_API_KEY (the sidecar will report"
    warn "  healthy but cannot store anything). See docs/RELEASE.md section 5c."
  fi
fi

# --- Pre-update backup (UPDATE only) ---------------------------------------
if [ "$IS_UPDATE" = true ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  # Dump to a TEMP file first, and move it into place only on success.
  #
  # MEASURED DEFECT THIS FIXES: the original was `pg_dump > "$BACKUP_DIR/ryasai-$STAMP.sql"`, and the
  # shell CREATES a redirect target BEFORE running the command. A failed `pg_dump` therefore still
  # left a 0-byte file, and the `if` reported success for the redirect — so the installer printed
  # "DB backup saved" for a file containing nothing. Found on a real host:
  # `ryasai-20260927-051118.sql` was 0 bytes while the installer had called it a backup.
  #
  # A silently-empty backup is worse than no backup. It is the artifact an operator reaches for during
  # an incident, and they would restore nothing. The temp file also keeps a PARTIAL dump out of the
  # rotation, where it would look like a usable restore point.
  BACKUP_TMP="$BACKUP_DIR/.ryasai-$STAMP.sql.tmp"
  if docker compose -f docker-compose.prod.yml ps --status running --services db >/dev/null 2>&1 \
     && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U ryasai -d ryasai > "$BACKUP_TMP" 2>/dev/null \
     && [ -s "$BACKUP_TMP" ]; then
    mv "$BACKUP_TMP" "$BACKUP_DIR/ryasai-$STAMP.sql"
    info "DB backup saved -> $(du -h "$BACKUP_DIR/ryasai-$STAMP.sql" | cut -f1) $BACKUP_DIR/ryasai-$STAMP.sql"
  else
    rm -f "$BACKUP_TMP"
    warn "DB backup FAILED — continuing, but there is NO restore point for this update."
    warn "  Check that the db service is healthy, then re-run the update."
  fi
  # Delete 0-byte dumps left by EARLIER releases so the rotation cannot offer one as a restore point.
  # `-size 0` matches only those; a real dump is never empty.
  find "$BACKUP_DIR" -maxdepth 1 -name 'ryasai-*.sql' -size 0 -delete 2>/dev/null || true
  # Keep newest 5 dumps
  ls -1t "$BACKUP_DIR"/ryasai-*.sql 2>/dev/null | tail -n +6 | xargs -r rm -f || true

  # --- Environment drift check ----------------------------------------------
  #
  # WHY THIS EXISTS. `.env` is generated ONCE (the write above is guarded by `[ ! -f .env ]`) and
  # never rewritten, which is correct — it holds the customer's license key, secrets and port, and an
  # update that regenerated it would destroy all three. The cost is that a variable ADDED in a later
  # release never reaches an existing install: the app reads its default, and if the release expected
  # the operator to have set it, the feature is silently off.
  #
  # The comparison is against the MANIFEST the PREVIOUS installer wrote (`.install-manifest`), not
  # against anything fetched now: the running installer has no checkout to read `.env.example` from,
  # and comparing against its OWN list would report zero drift by construction. A manifest that does
  # not exist (an install predating this feature) is reported as unknown rather than as "no drift" —
  # silence would imply a clean comparison that never happened.
  #
  # This only REPORTS. It deliberately appends nothing: guessing a value a release needs is worse than
  # saying nothing, because a wrong value fails in ways that look like a product bug. The operator
  # decides.
  PREV_MANIFEST="$APP_DIR/.install-manifest"
  if [ -f "$PREV_MANIFEST" ]; then
    PREV_KEYS=$(grep -v '^#' "$PREV_MANIFEST" | grep -v '^$' | grep -v '^version=' | sort -u)
    ISSUE_KEYS=$(printf '%s\n' "$(installer_env_keys)" | sort -u)
    DRIFT=$(comm -13 <(printf '%s\n' "$PREV_KEYS") <(printf '%s\n' "$ISSUE_KEYS") | tr '\n' ' ')
    if [ -n "$DRIFT" ]; then
      warn "New settings this version documents that your .env does not set:"
      for v in $DRIFT; do warn "    - $v"; done
      warn "  They default to OFF/unset. Set any you need, then re-run this installer."
      warn "  Nothing was changed automatically — your .env is preserved as-is."
    else
      info "No new settings in this version."
    fi
    PREV_VER=$(grep -E '^version=' "$PREV_MANIFEST" | cut -d= -f2)
    info "Updating from ${PREV_VER:-an earlier version} -> $INSTALLER_VERSION"
  else
    warn "No install manifest found (pre-dates this installer) — cannot report env drift."
    warn "  Your .env is preserved. To see what this version adds:"
    warn "    https://github.com/ryasrk/ryasai-chatbot/blob/main/.env.example"
  fi

  # Record what THIS version expects, so the NEXT update can compare against it.
  {
    echo "# Written by install.sh — do not edit. Used to report env drift on update."
    echo "version=$INSTALLER_VERSION"
    installer_env_keys
  } > "$PREV_MANIFEST"
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
      # Point memory at the sidecar from the COMPOSE FILE, not only from .env.
      #
      # MEASURED GAP THIS CLOSES: this setting lived only in the generated .env, and .env is never
      # rewritten on update (it holds the license key, secrets and port). So an install created
      # before this variable existed — any deployment running 0.5.0 or earlier — would update to
      # 1.0.0 with `COGNEE_SERVER_URL` still unset, and 1.0.0 defines that as "memory is OFF"
      # (the in-process SDK is gone, so there is no fallback). The update would "succeed" and
      # silently ship a product with no cross-session memory. Setting it here makes the compose
      # authoritative for the sidecar wiring, which is where the sidecar itself is defined.
      #
      # `:-` keeps it overridable: an operator pointing at an EXTERNAL cognee sets the variable.
      - COGNEE_SERVER_URL=${COGNEE_SERVER_URL:-http://cognee:8000}
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
      # Same reasoning as `app` above: without this the worker keeps its own memory writes off on an
      # install whose .env predates the variable, so a scheduled run would embed and cognify
      # documents while never recording the conversation — a split brain between the two processes.
      - COGNEE_SERVER_URL=${COGNEE_SERVER_URL:-http://cognee:8000}
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
    # TWO env files, and this is the only arrangement in which a SEPARATE cognee config works.
    #
    # MEASURED PRECEDENCE (docker compose v5.5.1, tested directly rather than assumed):
    #   * `env_file: [a, b]`  -> b wins on conflicts; keys unique to either file survive.
    #   * `environment:`      -> OVERRIDES env_file, always.
    # So the previous `- LLM_API_KEY=${COGNEE_LLM_API_KEY:-}` line did not "default" anything. With
    # cognee's config in a file and no COGNEE_LLM_API_KEY exported in the shell, `${...:-}` resolves
    # EMPTY and the override BLANKS the file's value. Reproduced: an env file holding
    # `LLM_API_KEY=sk-real-key` still reached the container as `[]`.
    #
    # `.env.cognee` MUST EXIST: compose fails the entire `up` when a listed env_file is absent.
    # install.sh therefore always writes it, an empty skeleton when there is nothing to configure.
    # Verified by starting a stack whose .env.cognee contained only comments.
    env_file:
      - .env
      - .env.cognee
    environment:
      # STRUCTURAL ONLY — these are properties of this image and this compose topology, not
      # per-install choices, so they are hardcoded rather than routed through a variable. Each one
      # would otherwise be a `${VAR:-default}` line that SILENTLY OVERRIDES .env.cognee (see above).
      - SYSTEM_ROOT_DIRECTORY=/cognee-storage/system
      - DATA_ROOT_DIRECTORY=/cognee-storage/data
      - DB_PROVIDER=sqlite
      - GRAPH_DATABASE_PROVIDER=kuzu
      - VECTOR_DB_PROVIDER=lancedb
      - ENABLE_BACKEND_ACCESS_CONTROL=false
      - COGNEE_SKIP_CONNECTION_TEST=true
      - LITELLM_DROP_PARAMS=true
      # Not billable: the licence is flat, so nothing consumes usage rows.
      - USAGE_LOGGING=false
      # EVERYTHING ELSE — LLM_*, EMBEDDING_*, LLM_ALLOWED_HOSTS, AUTO_FEEDBACK, IMPROVE_AUTO_ENABLED —
      # lives in .env.cognee under cognee's own variable names. That is the separation: one file an
      # operator edits for memory, and a compose block that cannot contradict it.
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
      # WINDOW MEASURED, NOT GUESSED. The sidecar's server does not listen until its boot work is
      # done: ~125s with OPENAI_API_BASE set, and longer when the three LLM_* vars are also filled
      # (cognee validates them at startup). The previous `start_period: 90s` with `interval: 30s` ×
      # `retries: 3` reported the container UNHEALTHY at ~180s on a boot that was still running — so
      # a healthy sidecar read as broken, on every install, and the operator's first impression of
      # memory was a red status.
      #
      # An A/B on isolated containers established there is NO hang: at 120s NEITHER an LLM_* probe nor
      # its control had finished booting, and both answered 200 shortly after. The defect was always
      # this window, so it is widened once here rather than chased per deployment.
      interval: 60s
      timeout: 10s
      retries: 5
      start_period: 180s
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

# --- Restore the graph extension path the 1.6.0 image moved -----------------
#
# MEASURED BUG IN THE UPSTREAM 1.6.0 IMAGE, which makes memory unusable out of the box.
#
# The server loads a graph extension from
#   /app/.lbdb/extension/<ver>/linux_amd64/<ext>/<file>          (note the <ext> directory)
# 1.5.4 shipped exactly that:
#   /app/.lbdb/extension/0.19.0/linux_amd64/json/libjson.lbug_extension
# 1.6.0 moved the files AND flattened them, to a path the server never reads:
#   /app/cognee_db_workers/ladybug_extensions/v0.19.0/linux_amd64/libjson.lbug_extension
# so the old tree does not exist at all and every load fails:
#
#   GET /health   -> 503, permanently: {"status":"not ready","health":"unhealthy"}
#   POST /api/v1/remember -> {"error":"... Failed to load library:
#                            /app/.lbdb/extension/0.19.0/linux_amd64/json/libjson.lbug_extension
#                            which is needed by extension: json"}
#
# EVERY memory write fails. Verified both directions on real containers: 1.5.4 has the `json/`
# directory, 1.6.0 does not.
#
# The `<ext>` component is derived from the filename (`libjson.lbug_extension` -> `json`), because
# the image's own directory layout carries no such information and hardcoding `json` would break
# silently the moment a second extension is added. The version directory is likewise discovered
# rather than pinned (the image ships v0.12.0 through v0.20.0) — pinning "0.19.0" would stop working
# on any image bump, which is the "matched a constant, not the state" mistake this project has
# already paid for twice.
#
# FAIL-OPEN: a sidecar that refuses to boot is a total memory outage, so a failure here still starts
# the server and echoes a warning naming the exact error to look for.
if [ -d /app/cognee_db_workers/ladybug_extensions ]; then
  LINKED=0
  for ver in /app/cognee_db_workers/ladybug_extensions/*/; do
    v="$(basename "$ver")"
    # `$ver` already ends in a slash (the glob does that), so this is a plain join.
    src="${ver}linux_amd64"
    [ -d "$src" ] || continue
    for f in "$src"/*; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      # `libjson.lbug_extension` -> `json`; `libfoo_bar.lbug_extension` -> `foo_bar`.
      ext="$(printf '%s' "$base" | sed -n 's/^lib\(.*\)\.lbug_extension$/\1/p')"
      [ -n "$ext" ] || continue
      target="/app/.lbdb/extension/${v#v}/linux_amd64/$ext"
      mkdir -p "$target" 2>/dev/null || continue
      # Never overwrite a file the image already provides.
      if [ ! -e "$target/$base" ] && ln -sf "$f" "$target/$base" 2>/dev/null; then
        LINKED=$((LINKED+1))
      fi
    done
  done
  if [ "$LINKED" -gt 0 ]; then
    echo "[entrypoint] restored $LINKED graph extension file(s) to /app/.lbdb (1.6.0 moved them; without this every memory write fails)"
  else
    echo "[entrypoint] WARNING: could not restore graph extensions — memory writes may fail with" >&2
    echo "[entrypoint]          'Failed to load library ... libjson.lbug_extension'." >&2
  fi
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
# The loop used to end with an unconditional success banner: if all 60 attempts (180s) failed,
# it still printed "installed" and the access URL. On a customer's own hardware that is a support
# call with no diagnostic — they are told it worked and then find a blank page.
#
# Two stages, deliberately different endpoints:
#   1. liveness (/api/v1/health) — no dependency probe, so this only proves the process is up.
#   2. readiness (/api/health) — hits Postgres and returns 503 when the DB is unreachable, which
#      is the failure a fresh install actually hits (wrong DATABASE_URL, DB still migrating).
# Readiness is reported, not fatal: the app degrades gracefully without Redis and the operator
# may still be bringing up their database, so the installer warns and keeps the exit code clean.
APP_UP=false
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${APP_PORT}/api/v1/health" >/dev/null 2>&1; then APP_UP=true; break; fi
  sleep 3
done

if [ "$APP_UP" != true ]; then
  echo
  echo -e "${C_RED}ERROR:${C_NC} The app did NOT come up on 127.0.0.1:${APP_PORT} within 180 seconds." >&2
  echo
  echo "  Container status:"
  docker compose -f docker-compose.prod.yml ps || true
  echo
  echo "  Last 40 log lines:"
  docker compose -f docker-compose.prod.yml logs --tail=40 app || true
  echo
  echo "  Diagnose with:"
  echo "    docker compose -f docker-compose.prod.yml logs app"
  echo "    docker compose -f docker-compose.prod.yml ps"
  echo
  echo "  Common causes: DATABASE_URL unreachable from the container, port ${APP_PORT} already"
  echo "  in use, or the db service still initialising."
  exit 1
fi

if ! curl -sf "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
  echo
  warn "The app process is up but its DEPENDENCY CHECK reports not-ready (usually Postgres)."
  warn "Open http://127.0.0.1:${APP_PORT}/api/health for the per-dependency detail."
  warn "Setup will not work until the database is reachable."
fi

echo
echo "=============================================================="
echo "  ryasai Chatbot installed (Prebuilt Images Only)."
echo "=============================================================="
echo
echo "  Access (local):   http://127.0.0.1:${APP_PORT}"
echo
# These two lines used to read "Admin email / Admin password" and print values from .env. NO CODE
# reads ADMIN_EMAIL or ADMIN_INITIAL_PASSWORD — verified by grepping the whole tree: they appear only
# in install.sh, .env.example and docs, and POST /api/auth/signup creates the organization and the
# first admin from what the USER types. The old output therefore invited a customer to log in with an
# account that does not exist, and when that failed they would reasonably conclude the install was
# broken. The values are still generated and left in .env (harmless), but are no longer presented as
# credentials.
echo "  First run: register in the browser — there is no default account."
echo "             1. Open the URL above"
echo "             2. Sign up   (creates the organization + the first admin)"
echo "             3. Setup Wizard: LLM -> test -> documents -> data sources -> chat"
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
