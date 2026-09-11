# ⚠️ ryasai-chatbot Helm chart — NOT PRODUCTION READY

> **This chart is stale and lags the supported deployment path. Do not point customers or
> operators at it.** It is kept in the repo only as an unfinished work-in-progress; it has not
> been reconciled with `docker-compose.yml` and is not covered by CI or the install flow.

## Use this instead (the supported route)

Docker Compose is the first-class deployment path:

- **One-liner installer:** `install.sh` (`curl -sSL https://ryasai.my.id/install.sh | bash`,
  add `--with-searxng` for a private SearXNG backing the `web_search` tool). It generates a
  `docker-compose.prod.yml` and is the only route the project supports for customers.
- **`docker-compose.yml`** — shorthand equivalent for operators who prefer to run compose
  directly: app + scheduler + redis + a `pgvector/pgvector:pg16` database, with a `migrate`
  one-shot (the scheduler image ships the Prisma CLI) that must complete before `app`/`scheduler` start.

See also `docs/deployment.md`, `docs/DEPLOYMENT-DOCKER.md`, and `docs/runbook.md`.

## How far this chart has diverged (verified 2026-09)

These are concrete, load-bearing differences — not cosmetic lag. Anything here can silently
produce a broken or unsafe release:

| Area | `docker-compose.yml` (supported) | `helm/` (this chart) |
|------|----------------------------------|----------------------|
| Image repository | `ghcr.io/ryasrk/ryasai-chatbot` with tags `:app` and `:scheduler` | `ghcr.io/ryasai/chatbot` with a single `:0.4.0` tag — **wrong registry/namespace and no scheduler tag** |
| Postgres | `pgvector/pgvector:pg16` service, tuning + healthcheck | **no Postgres template at all** — assumes an external DB, undocumented |
| Redis | `redis:7-alpine` service with memory cap + healthcheck | **no Redis template** — scheduler (BullMQ) requires Redis to run |
| Schema migration | dedicated `migrate` one-shot service gating `app`/`scheduler` start | **absent** — nothing applies the schema before the app boots |
| Scheduler | separate `:scheduler` image/container with its own env | template exists but reuses the single web image; no migration gate |
| License env | `LICENSE_VALIDATOR_URL` + `LICENSE_PRODUCT` set explicitly | **not in `values.yaml`** — license validation will fail in-cluster |
| Redis env | `REDIS_URL=redis://redis:6379` | **not in `values.yaml`** |
| `DATABASE_URL` | built into compose per service | a `secret.DATABASE_URL` value with no in-cluster default or guidance |

The chart also still describes the app as "Single-tenant" (`Chart.yaml`, `values.yaml`), which
contradicts the multi-tenant code (`organizationId` on every model — see `AGENTS.md` →
"Multi-Tenancy" and `src/lib/prisma-tenant.ts`).

## Status

- **Not reconciled with compose.** A full reconciliation is out of scope and deliberately not
  attempted here; the risk of shipping a half-correct chart is higher than pointing operators at
  the path that is actually tested.
- **Not exercised by CI.** No workflow installs or lints this chart.
- Only revisit if/when Kubernetes becomes a supported deployment target, and only together with a
  real reconciliation against `docker-compose.yml` plus CI coverage.

`AGENTS.md` records the same guidance: *"`helm/` chart lags docker-compose — don't point customers
at it until reconciled."*
