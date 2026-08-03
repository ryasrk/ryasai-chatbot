FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
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
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node node_modules/prisma/build/index.js generate
RUN node node_modules/.bin/next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
RUN cp -r node_modules/.prisma .next/standalone/node_modules/

FROM node:22-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
RUN groupadd -r nodejs && useradd -r -g nodejs nextjs \
    && mkdir -p db \
    && chown -R nextjs:nodejs /app
USER nextjs
EXPOSE 3000
VOLUME ["/app/db"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --accept-data-loss && node server.js"]
