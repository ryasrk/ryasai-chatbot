FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# ponytail: builder runs `next build` under REAL node (node:22-slim), not
# bun's node-compat wrapper. oven/bun's `node` is a bun shim, and Turbopack
# breaks there: "Failed to load external module jsdom-...: Cannot find module
# '../data/patch.json'" during page-data collection. Host node passes; this
# was the exact failure on 1GB VPS installs. oven/bun is kept for `deps` only.
FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# node:22-slim has no OpenSSL, so Prisma would default to openssl-1.1.x and
# copy a 1.1.x engine while the client pins 3.0.x -> runtime "engine not
# found". Installing OpenSSL makes it detect 3.0.x consistently with the bun
# prod runtime and the scheduler image.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN rm -rf node_modules/.prisma && node node_modules/prisma/build/index.js generate
RUN node node_modules/.bin/next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
RUN cp -r node_modules/.prisma .next/standalone/node_modules/

# prod runs under Bun (oven/bun:1-slim) instead of node — lower RSS on small
# VPSes. The next build above runs under real node in the `builder` stage, so
# the bun node-compat bug never applies here. Schema is applied by the
# `migrate` one-shot service in compose (scheduler image ships the full prisma
# CLI); the app image only needs the traced @prisma/client, so no CLI is kept.
FROM oven/bun:1.4.2-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Docker sets HOSTNAME, and Next's standalone server binds to it (eth0 IP),
# which breaks the in-container localhost healthcheck. Bind all interfaces.
ENV HOSTNAME=0.0.0.0

# MCP runtimes. ALLOWED_MCP_CMDS in admin-tools.ts permits npx/uvx/node/python,
# and the stock bun image has none of them — every stdio MCP server died with
# ENOENT here. Node comes from the official image rather than apt so it matches
# the builder's major; uv ships /uv and /uvx as static binaries.
#
# Adds ~230 MB uncompressed, in two independent halves — drop either if the
# image has to stay small, and MCP servers of that kind simply stop being
# installable (the others keep working):
#   Node  ~139 MB -> npx / node servers
#   uv+py  ~90 MB -> uvx / python servers
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/prisma ./prisma
# ponytail: `useradd -r` alone leaves nextjs with no home, so every package
# runner (bunx, npx, uvx) fails the moment it tries to write its download cache.
# Give it a real HOME and export it — MCP servers are fetched on first spawn.
RUN groupadd -r nodejs && useradd -r -g nodejs -m -d /home/nextjs nextjs \
    && mkdir -p db \
    && chown -R nextjs:nodejs /app /home/nextjs
ENV HOME=/home/nextjs
USER nextjs
EXPOSE 3000
VOLUME ["/app/db"]
# Probes the DEEP endpoint, matching docker-compose.yml and the generated prod compose.
#
# MEASURED DEFECT this fixes: this probed /api/v1/health, which touches NO dependency and returns
# 200 unconditionally — so the image reported `healthy` with Postgres gone, and an orchestrator would
# never restart a broken container. /api/v1/health is still the LVENESS endpoint (a public probe that
# must stay dependency-free); readiness is what a restart decision needs, and that is /api/health.
#
# The generous start-period/retries are deliberate: a transient blip must not restart-loop the
# container, and only `db` is critical — redis, the validator, cognee and the embeddings service are
# all optional by design and are REPORTED rather than fatal (see CRITICAL_CHECKS in health-status.ts).
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD bun -e "try { const r = await fetch('http://localhost:3000/api/health'); if (!r.ok) console.error('unhealthy:', (await r.text()).slice(0, 400)); process.exit(r.ok ? 0 : 1) } catch (e) { console.error('unreachable:', (e && e.message) || e); process.exit(1) }"
CMD ["bun", "server.js"]
