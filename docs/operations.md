# Operations Runbook — Deployment Safety

Procedures for the compose-first production deployment (`install.sh` →
`docker-compose.prod.yml` on the VPS). For first-time install see
`docs/DEPLOYMENT-DOCKER.md`; this doc covers **failure and recovery**.

## Backups

- **When**: every `install.sh` run in UPDATE mode takes a pre-update `pg_dump`
  BEFORE images are pulled or the schema is touched.
- **Where**: `/opt/ryasai-chatbot/backups/ryasai-<timestamp>.sql` on the VPS.
- **Retention**: newest 5 dumps; older ones are deleted automatically.
- Fresh installs skip the backup (no data yet). Backup failure is non-fatal
  (warns) so a stopped DB can't wedge the installer — but check the warning.

## Restore procedure (schema drift / bad migration)

The `migrate` one-shot runs `prisma db push` WITHOUT `--accept-data-loss`.
Schema drift that would drop data fails the migrate job loudly and `app` /
`scheduler` never start (`service_completed_successfully` gate). That is
deliberate: an operator decides, not the deploy script.

1. SSH to the VPS and inspect the failure:
   ```bash
   docker compose -f docker-compose.prod.yml logs migrate
   ```
2. Decide:
   - **Safe to proceed** (drift is intentional): edit nothing here — apply the
     schema change manually with `prisma db push --accept-data-loss` ONLY after
     confirming a fresh backup exists:
     ```bash
     docker compose -f docker-compose.prod.yml exec -T db \
       pg_dump -U ryasai -d ryasai > backups/manual-$(date +%Y%m%d-%H%M%S).sql
     ```
   - **Roll back instead**: continue below.

### Restoring from a dump

```bash
cd /opt/ryasai-chatbot
# pick the newest dump
ls -1t backups/ryasai-*.sql | head -1
docker compose -f docker-compose.prod.yml exec -T db psql -U ryasai -d postgres \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose -f docker-compose.prod.yml exec -T db psql -U ryasai -d ryasai \
  < "$(ls -1t backups/ryasai-*.sql | head -1)"
```

Then re-pin the app to the previous image tag (below) so code matches schema.

## Rollback to a previous release

Images are tagged per component (`app`, `scheduler`) on GHCR; every push to
`main` overwrites them. Pin an older digest/tag with a compose override:

```bash
# find the previous image digest
docker image ls ghcr.io/ryasrk/ryasai-chatbot --digests | head -5

cat > docker-compose.override.yml <<'EOF'
services:
  app:
    image: ghcr.io/ryasrk/ryasai-chatbot:app@sha256:<previous-digest>
  scheduler:
    image: ghcr.io/ryasrk/ryasai-chatbot:scheduler@sha256:<previous-digest>
EOF

docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

Delete the override file when you're ready to follow `main` again.
If the failed release also migrated the schema, restore the newest dump FIRST
(above) — old code + new schema is only safe if the migration was additive.

## License signing key provisioning

`LICENSE_SIGNING_PUBLIC_KEY` (Ed25519 SPKI DER hex) verifies signed responses
from the central License-Validator. It is **never** baked into `install.sh`:

```bash
bash install.sh --license-signing-public-key <hex>
# or: export LICENSE_SIGNING_PUBLIC_KEY=<hex> before installing
```

Without it, licensing **fails closed**: signup/license activation will not
work, and the installer prints a prominent post-install warning. Re-run the
installer (it preserves data) after obtaining the key from the license server
operator.

## Health endpoints

| Endpoint          | Auth      | Use                                            |
|-------------------|-----------|------------------------------------------------|
| `/api/v1/health`  | public    | Liveness probe (no DB hit) — compose healthcheck |
| `/api/health`     | public*   | Readiness detail: `db` (critical), `redis` + `validator` (informational), sanitized errors |

\* anonymous-safe by design: error strings are truncated to their error class;
raw driver errors never leak. The License-Validator probe is informational —
it never flips `/api/health` to 503. Midtrans has no cheap GET probe; checkout
health is observed through billing logs instead.

Boot-time env policy: missing `DATABASE_URL` / `ENCRYPTION_SECRET_KEY` aborts
startup (exit 1) with a single fatal block; optional vars (Redis, Midtrans,
license issuance keys) print ONE consolidated degradation warning and boot
continues.
