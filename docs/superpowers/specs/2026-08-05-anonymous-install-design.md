# Anonymous install.sh (No Git Clone, Docker Pull Only) — Design

Date: 2026-08-05
Status: Approved (brainstorming complete)

## Problem

The current `install.sh` (`curl -sSL https://ryasai.my.id/install.sh | bash`) clones the full ryasai-chatbot repo to `/opt/ryasai-chatbot` on the client's VPS via `git clone --depth 1 https://github.com/ryasrk/ryasai-chatbot.git`. This exposes the entire codebase (source, history, Dockerfiles, prisma schema) to the client. The compose file it generates also carries `build:` directives and a `--build` fallback, meaning the client could rebuild from the cloned source. Goal: ship an installer that delivers only running containers — never the source.

## Goal

Rewrite `install.sh` so it never clones the repo, never builds from source, and pulls only prebuilt images via a pull-through registry proxy at `registry.ryasai.my.id`. After install, `/opt/ryasai-chatbot` contains only `.env` + `docker-compose.prod.yml` (+ optional `searxng/`) — no `.git`, no source code, no Dockerfiles.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Repo visibility | `github.com/ryasrk/ryasai-chatbot` is now PRIVATE |
| Client image access | Pull-through proxy at `registry.ryasai.my.id` (registry:2 image) — client pulls without a GitHub token |
| Proxy host | `registry.ryasai.my.id` (sibling to `license.ryasai.my.id`, behind Caddy auto-TLS) |
| Implementation approach | A — install.sh generates `.env` + compose inline (existing pattern), images point at the proxy, all `build:`/`--build`/`git` removed |
| Files on client VPS | `.env`, `docker-compose.prod.yml`, optional `searxng/` only |

## install.sh Changes

### Removed
- `REPO_URL=...` and the entire clone/pull block (lines 72, 76-89): no `git clone`, no `git pull`, no `git fetch/reset`.
- `build:` directives in the generated `docker-compose.prod.yml` for both `app` (line 195) and `scheduler` (lines 214-216).
- Fresh-install `--build` fallback (lines 340-341): a pull failure no longer falls back to building from source — it stops with guidance.

### Changed
- **Image references** in the generated compose point at the proxy, not GHCR directly:
  - `ghcr.io/ryasrk/ryasai-chatbot:app` → `registry.ryasai.my.id/ryasrk/ryasai-chatbot:app`
  - `ghcr.io/ryasrk/ryasai-chatbot:scheduler` → `registry.ryasai.my.id/ryasrk/ryasai-chatbot:scheduler`
  - (Path `ryasrk/ryasai-chatbot` is preserved because the registry proxy mirrors the upstream GHCR path.)
- **Update detection**: `[ -d "$APP_DIR/.git" ] || [ -f "$APP_DIR/.env" ]` becomes `[ -f "$APP_DIR/.env" ]` (no `.git` to check). `IS_UPDATE=true` now means "an existing install" via `.env` presence.
- **Update flow**: re-running `install.sh` re-generates `docker-compose.prod.yml` and re-pulls images. `.env` is preserved (existing logic). No git operations.
- **Pull-failure behavior** (both fresh and update): no build fallback. If `docker compose pull` fails, stop with actionable guidance ("check registry.ryasai.my.id reachability / disk / network; re-run install.sh"). The running stack (on update) stays on the old image.
- **Swap safety net**: keep it (pulling a large image can still OOM a 1GB box), but update the comment — it now guards the pull, not a build.

### Unchanged (kept)
- Prereqs (Docker + Compose plugin install)
- `.env` generation (ENCRYPTION_SECRET_KEY, admin password, license config) — fully inline, no source needed
- SearXNG optional block
- Disk guard + Docker prune
- Health check loop + success banner

### Result on client VPS
`/opt/ryasai-chatbot/` contains only:
- `.env` (generated secrets + config)
- `docker-compose.prod.yml` (generated)
- `searxng/settings.yml` (only if `--with-searxng`)

No `.git`, no `src/`, no `Dockerfile`, no `prisma/`, no `package.json`. The codebase never touches the client.

## Registry Proxy `registry.ryasai.my.id`

Pull-through cache using the official `registry:2` image, deployed on the same VPS that hosts `license.ryasai.my.id` (or a sibling server you control).

```yaml
# registry-proxy.yml — deploy on YOUR server (not the client's)
services:
  registry-proxy:
    image: registry:2
    ports:
      - "127.0.0.1:5000:5000"               # Caddy terminates TLS → 127.0.0.1:5000
    environment:
      REGISTRY_PROXY_REMOTEURL: https://ghcr.io
      REGISTRY_PROXY_USERNAME: ryasrk        # GitHub username
      REGISTRY_PROXY_PASSWORD: ${GHCR_PAT}   # PAT with read:packages, in server .env
      REGISTRY_CACHE_BLOBDESCRIPTOR: "true"
    volumes:
      - registry-cache:/var/lib/registry
    restart: unless-stopped
volumes:
  registry-cache:
```

**How it works:**
1. Client runs `docker pull registry.ryasai.my.id/ryasrk/ryasai-chatbot:app`.
2. The proxy (behind Caddy at `registry.ryasai.my.id`) fetches `ghcr.io/ryasrk/ryasai-chatbot:app` using the PAT stored in YOUR server's `.env`, caches the blobs locally, and serves them to the client.
3. The client never sees the GHCR PAT and never touches GitHub directly.
4. Subsequent pulls (same tag) are served from the proxy cache — fast and low-bandwidth for repeat installs.

**Server prerequisites (yours):**
- Caddy (or Nginx) fronting `registry:2` with auto-TLS for `registry.ryasai.my.id` → `127.0.0.1:5000`. Same pattern as `license.ryasai.my.id`.
- `.env` on the registry server with `GHCR_PAT=<personal access token, read:packages>`.
- DNS `registry.ryasai.my.id` → your registry VPS.

**Image path note:** the proxy mirrors the upstream path, so client images are `registry.ryasai.my.id/ryasrk/ryasai-chatbot:app` (with the `ryasrk/` segment). This is functional and the client doesn't care about the path. A cleaner `registry.ryasai.my.id/ryasai-chatbot:app` (no `ryasrk/`) would require CI to re-tag and push to a second registry — out of scope for now.

## Testing

- **Shellcheck** `install.sh` — zero errors (bash syntax validation).
- **Manual smoke test on a clean VPS** (no prior install, no repo checkout):
  - Run `curl -sSL https://ryasai.my.id/install.sh | bash`.
  - Assert `/opt/ryasai-chatbot` contains ONLY `.env` + `docker-compose.prod.yml` (no `.git`, no source files).
  - Assert `docker compose -f /opt/ryasai-chatbot/docker-compose.prod.yml config` shows no `build:` key on any service.
  - Assert `docker compose pull` resolves `registry.ryasai.my.id/ryasrk/ryasai-chatbot:app` (not `ghcr.io` directly).
  - Assert services come up (migrate → app + scheduler + redis + db) and `http://localhost:3000/api/v1/health` responds.
- **Registry proxy verification (your server):**
  - Deploy `registry-proxy.yml` + Caddy.
  - From the client VPS: `docker pull registry.ryasai.my.id/ryasrk/ryasai-chatbot:app` succeeds; proxy cache populates.
- **Update path:** re-run `install.sh` on an existing install → compose re-generates, images re-pull, `.env` preserved, data volumes untouched, services restart on the new image.

No unit tests — `install.sh` and the compose are declarative; a clean-VPS smoke run is the authoritative verification.

## Out of Scope

- CI re-tagging images to `registry.ryasai.my.id/ryasai-chatbot:app` (no `ryasrk/` path) — would need `build-images.yml` pushing to two registries; can follow.
- Migration path for existing client installs that already cloned the repo — needs a separate uninstall/cleanup instruction.
- Private Docker Hub / ECR / GCR alternatives — the `registry:2` proxy is sufficient.
- TLS certificate management for `registry.ryasai.my.id` — assumed Caddy auto-TLS (same as `license.ryasai.my.id`).
- Authentication on the proxy itself — left open (anonymous pull). If you later want to gate client access, add a registry htpasswd; install.sh would then need to `docker login` with a client token. Not needed now since the VPS is the client's own.
