# Operations Runbook — Deployment Safety

Procedures for the compose-first production deployment (`install.sh` →
`docker-compose.prod.yml` on the VPS). For first-time install see
`docs/DEPLOYMENT-DOCKER.md`; this doc covers **failure and recovery**.

## Backups

- **When**: every `install.sh` run in UPDATE mode takes a pre-update `pg_dump`
  BEFORE images are pulled or the schema is touched.
- **Where**: `/opt/ryasai-chatbot/backups/ryasai-<timestamp>.sql` on the VPS.
- **Retention**: newest 5 dumps; older ones are deleted automatically.
- Fresh installs skip the backup (no data yet). An update stops when its application database backup fails. Restore database health and retry before changing images or schema.

## Restore procedure (schema drift / bad migration)

The `migrate` one-shot runs `bun scripts/migrate.ts`, then Prisma's versioned
`migrate deploy`. Fresh databases apply the recorded migration. Existing installs
without migration history are adopted only when their schema matches the frozen
baseline; known runtime search indexes are preserved. A mismatch stops startup
through the `service_completed_successfully` gate.

Inspect the failure with `docker compose -f docker-compose.prod.yml logs migrate`.
Back up the database before reconciling a mismatch. Review schema changes and
ship a migration in `prisma/migrations`; do not use `db push --accept-data-loss`
as a production recovery shortcut. Development schema prototyping can still use
`db push`, but each released change needs a migration tested against both an
empty database and an upgraded install.

The backup validation command requires a separate empty database and retains its
restored data for inspection. Stop writers while validating row counts, since
concurrent writes can change the source after the dump's snapshot.

### Restoring from a dump

```bash
cd /opt/ryasai-chatbot
# pick the newest dump
RESTORE_FILE=$(find backups -maxdepth 1 -type f -name 'ryasai-[0-9]*.sql' | sort | tail -1)
test -n "$RESTORE_FILE" && test -s "$RESTORE_FILE"
# Stop writers before resetting the application database.
docker compose -f docker-compose.prod.yml stop app scheduler
docker compose -f docker-compose.prod.yml exec -T db psql -X -v ON_ERROR_STOP=1 -U ryasai -d ryasai \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose -f docker-compose.prod.yml exec -T db psql -X -v ON_ERROR_STOP=1 -U ryasai -d ryasai \
  < "$RESTORE_FILE"
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

docker compose -f docker-compose.prod.yml -f docker-compose.override.yml up -d --remove-orphans
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
