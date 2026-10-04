# Operations Runbook

Operational procedures for ryasai Chatbot — deploy, rollback, rotate secrets, restore backups, debug incidents.

---

## Deploy

### Docker (recommended)

```bash
cp .env.example .env
# Set: DATABASE_URL, ENCRYPTION_SECRET_KEY, AUTH_DEMO_FALLBACK=false
docker compose up -d
```

The app container runs `prisma db push` then `server.js` (Next.js standalone).

### Bare metal

```bash
bun install
bunx prisma db push --accept-data-loss
bunx prisma generate
bun run build                    # → .next/standalone/
node .next/standalone/server.js  # web server
bun run mini-services/scheduler/index.ts  # scheduler (separate process)
```

### Kubernetes (Helm)

> ⚠️ **NOT SUPPORTED / NOT PRODUCTION READY.** The `helm/` chart is stale and lags
> `docker-compose.yml` (no Postgres/Redis/migrate services, stale image repo, missing
> license/redis env). Do **not** use it for customer deployments — use `docker-compose.yml`
> or `install.sh`. See [`helm/README.md`](../helm/README.md). The command below is kept only
> as a record of the WIP and will not produce a working release today.

```bash
helm upgrade --install chatbot ./helm \
  --set image.tag=0.4.0 \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=chatbot.example.com'
```

### Verify deployment

```bash
curl https://chatbot.example.com/api/v1/health
# {"ok":true,"service":"ryasai","version":"0.4.0","time":"..."}

curl https://chatbot.example.com/api/health
# {"ok":true,"checks":{"db":{"ok":true},"redis":{"ok":true}}}
```

---

## Rollback

### Docker

```bash
# Pin to previous image tag
docker compose down
IMAGE_TAG=0.3.0 docker compose up -d
```

### Kubernetes (Helm)

> ⚠️ Not supported — see the warning above and [`helm/README.md`](../helm/README.md).

```bash
helm rollback chatbot 1   # rollback to previous revision
```

### Argo Rollouts (blue-green)

```bash
kubectl argo rollouts abort chatbot
kubectl argo rollouts undo chatbot
```

### Database rollback

If a migration was applied (`prisma db push`), roll back the schema manually. Always take a backup before deploying:

```bash
bun run scripts/backup.ts --compress
```

---

## Rotate Encryption Key

The `ENCRYPTION_SECRET_KEY` (AES-256-GCM) encrypts notification configs and database credentials. Rotation requires re-encrypting all stored secrets.

1. **Generate a new key:**
   ```bash
   openssl rand -hex 32
   ```

2. **Write a re-encryption script** that:
   - Reads all `NotificationConfig.encryptedConfig` rows with the OLD key
   - Decrypts each, re-encrypts with the NEW key
   - Updates the rows
   - Does the same for `Integration.encryptedConfig` and any other encrypted fields

3. **Process:**
   ```bash
   # Set BOTH keys during rotation
   export ENCRYPTION_SECRET_KEY=<OLD_KEY>
   export ENCRYPTION_SECRET_KEY_NEW=<NEW_KEY>
   bun run scripts/rotate-key.ts
   # After verification, update .env with only the new key and restart
   ```

4. **Verify:** Test a scheduled run with a notification channel and a database query via an integration.

5. **Restart the app** with only the new key set.

---

## Restore Backup

```bash
# Full restore (stops app, restores DB, validates)
bun run scripts/restore.ts --file=backups/ryasai-backup-<timestamp>.sql

# Compressed
bun run scripts/restore.ts --file=backups/ryasai-backup-<timestamp>.sql.gz

# Dry run (validates without modifying DB)
bun run scripts/restore.ts --file=backups/backup.sql --dry-run
```

Post-restore validation:
- User table has ≥ 1 row
- Document table exists
- Integration table exists
- ChatSession table exists

Automated nightly validation:
```bash
bun run scripts/validate-backup.ts
```

---

## Rotate API Keys

### Admin UI

Settings → Integration API → Create new key → Set `requestLimitPerMinute` and `dailyRequestLimit` → Copy key → Update external integration → Deactivate old key.

### API endpoint

```bash
# Create new key
curl -X POST https://chatbot.example.com/api/api-keys \
  -H "Authorization: Bearer <session>" \
  -d '{"name":"new-key","requestLimitPerMinute":60,"dailyRequestLimit":10000}'

# Deactivate old key
curl -X PATCH https://chatbot.example.com/api/api-keys/<old-id> \
  -H "Authorization: Bearer <session>" \
  -d '{"isActive":false}'
```

---

## Rotate LLM API Keys

LLM provider keys are stored in `LlmConfig` rows (encrypted).

1. **Via admin UI:** Settings → LLM Configuration → edit provider → update API key → save.

2. **Via API:**
   ```bash
   curl -X PATCH https://chatbot.example.com/api/llm-config/<id> \
     -H "Authorization: Bearer <session>" \
     -d '{"apiKey":"sk-new-..."}'
   ```

3. **Verify:** Send a test chat message and check `GET /api/traces` for successful LLM calls.

---

## Debug RAG Quality

### Run the RAG benchmark

```bash
bun run benchmark/rag-eval.ts
```

This evaluates 540 questions across 5 databases and outputs RAGAS metrics:
- Faithfulness
- Answer Relevance
- Context Precision
- Context Recall

Scores are posted to Langfuse if configured (`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`).

### Check Langfuse traces

1. Open Langfuse UI (cloud.langfuse.com or self-hosted).
2. Filter by trace name (e.g. "query", "rerank") to find low-scoring traces.
3. Cross-reference RAGAS scores (posted via `postLangfuseScore`) with trace inputs/outputs.

### Tune RAG

- **Contextual Retrieval:** Set `CONTEXTUAL_RETRIEVAL=true` to prepend LLM-generated document summaries to chunks before embedding.
- **LLM Reranker:** Set `RAG_LLM_RERANK=true` to enable 0-10 scoring reranker (filters chunks scoring < 3).
- **Chunk size/overlap:** Adjust `RAG_CHUNK_SIZE` and `RAG_CHUNK_OVERLAP` in `src/lib/constants.ts`.
- **Max chunks per upload:** 2,000 (`RAG_MAX_CHUNKS_PER_UPLOAD` in `src/lib/constants.ts`). Larger documents are rejected before persistence; split them into smaller files.

### Check the in-memory trace buffer

```bash
curl https://chatbot.example.com/api/traces?limit=50 \
  -H "Authorization: Bearer <session>"
```

---

## Common Incidents

### OOM (Out of Memory)

**Symptoms:** Container restarts, `OOMKilled` exit code, high memory in metrics.

**Diagnosis:**
```bash
kubectl describe pod <pod-name> | grep -A5 "Last State"
docker inspect <container> | grep OOMKills
```

**Mitigation:**
- Increase memory limit in Helm values or docker-compose.yml
- Check for unbounded in-memory caches (RAG cache, trace ring buffer, rate limit buckets)
- Split documents exceeding the chunk limit before uploading them
- Check for memory leaks in long-running scheduler process

**Prevention:** Set memory limits, monitor `container_memory_usage_bytes` in Prometheus.

### DB Connection Exhaustion

**Symptoms:** `PrismaClientInitializationError`, `too many connections`, 503 on `/api/health`.

**Diagnosis:**
```sql
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';
SELECT count(*) FROM pg_stat_activity;
```

**Mitigation:**
- Restart the app process (releases connections)
- Reduce Prisma connection pool: set `connection_limit` in `DATABASE_URL` (e.g. `?connection_limit=5`)
- Add PgBouncer in transaction pooling mode
- Check for long-running queries: `SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;`

**Prevention:** Use PgBouncer, set connection limits, monitor `pg_stat_activity`.

### LLM Timeout Cascade

**Symptoms:** Chat responses hang, `LLM_TIMEOUT_MS` errors in traces, rate limit 429s.

**Diagnosis:**
```bash
curl https://chatbot.example.com/api/traces?limit=50 | jq '.[] | select(.error != null)'
```

**Mitigation:**
- Check LLM provider status page
- Verify LLM API key is valid (`GET /api/llm-config`)
- Reduce `LLM_TIMEOUT_MS` if provider is degraded (faster fail → faster retry)
- Enable fallback LLM config if available
- Check rate limits: LLM provider may be throttling (429s → backoff)

**Prevention:** Set `LLM_MAX_RETRIES=3`, `LLM_RETRY_BACKOFF_BASE_MS=500`, monitor `llm_errors_total` and `llm_duration_seconds` metrics.

### Redis Unavailable

**Symptoms:** Rate limiting falls back to in-memory (per-instance), cache misses, BullMQ jobs stall.

**Diagnosis:**
```bash
redis-cli ping
# or
curl https://chatbot.example.com/api/health | jq '.checks.redis'
```

**Mitigation:**
- App degrades gracefully (in-memory rate limiting, cache fallback)
- Restart Redis: `docker compose restart redis` or `kubectl rollout restart deployment/redis`
- Check Redis memory: `redis-cli INFO memory`
- Clear BullMQ stuck jobs: `redis-cli --scan --pattern 'bull:document-processing:*' | xargs redis-cli del`

**Prevention:** Monitor Redis memory and connection count, set maxmemory policy.

### Cognee Graph Extraction Fails With Provider Schema Errors

Check the pipeline activity status as well as the document's `cognifyStatus`.
A healthy sidecar or an accepted background request does not mean that a graph
is searchable. Inspect server-side validation errors without copying provider
bodies or credentials into client responses.

Some compatible endpoints discard system messages above a measured size limit.
Cognee's graph instruction plus JSON schema can exceed that limit. Compare the
same small extraction with an intact system message and bounded system parts
before enabling compatibility. For a measured 2,000-character endpoint ceiling,
set `COGNEE_SYSTEM_MESSAGE_MAX_CHARS=1600` in the deployment `.env`, wait for
active pipelines to finish, and recreate the Cognee service:

```bash
docker compose up -d --force-recreate cognee
```

The opt-in patch preserves every character and keeps all instruction parts in
the system role. Document content stays in the user role. The default `0` leaves
message shape unchanged. An enabled patch refuses to boot if the pinned adapter
layout is unsupported. Reprocess the failed document, confirm graph completion,
and verify a cited answer before treating the issue as resolved. Reset the value
to `0` and recreate the sidecar to disable splitting.

### Document Graph Retry After a Timeout

Deploy the additive `Document.cognifyPipelineJson` migration with `bun run db:deploy`
before starting the updated application. Document ingestion persists the stored
file IDs and accepted graph-run ID. A retry observes that run without uploading
again. The graph wait has a 30-minute overall deadline; completion requires the
exact run and every stored file to report readiness.

A timed-out run can still be processing upstream. Use the document reprocess
endpoint to resume observation. A confirmed failed run clears its state before a
new attempt. Reprocessing claims the document atomically; a concurrent request
receives HTTP 409. If the launch response was lost, the saved state is marked
`launching` with no run ID. Inspect the tenant dataset's sidecar activity and
reconcile its identity before retrying; do not clear this state blindly or launch
a second graph pipeline. Never restart a sidecar solely because the app timed out.

### Background Work Blocked by a License

Document embedding, graph processing, index rebuilds and memory writes require
an active entitlement at execution time. A job queued before expiry can therefore
be blocked when a worker picks it up. Validator unreachability within the recorded
grace period remains allowed. License issuance and payment reconciliation remain
available while the install is locked.

Blocked document jobs persist a document error and a `BACKGROUND_JOB_BLOCKED`
audit warning. Blocked memory jobs fail immediately and remain in BullMQ's failed
history, with their reason in worker logs. These failures do not exhaust automatic
retry attempts. Activate or renew the license before reprocessing documents.
Memory admission drops optional writes when entitlement cannot be verified,
including during a database outage; the chat answer remains independent of that
memory write.

### Scheduler Not Running

**Symptoms:** Scheduled runs not executing, `lastRunAt` stuck in the past.

**Diagnosis:**
```bash
# Check scheduler process
pm2 status | grep scheduler
# or
kubectl get pods | grep scheduler

# Check due runs
psql $DATABASE_URL -c "SELECT id, name, \"lastRunAt\" FROM \"ScheduledRun\" WHERE \"isActive\" = true;"

# Check BullMQ repeatable jobs
redis-cli --scan --pattern 'bull:scheduled-runs:*'
```

**Mitigation:**
- Restart scheduler process
- Verify `DATABASE_URL` and `REDIS_URL` are correct in scheduler environment
- Re-sync schedules: the scheduler calls `syncAllSchedules()` on startup — restarting re-creates all BullMQ repeatable jobs
- Manually trigger: `POST /api/schedules/{id}/run`


> **Nothing reads `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.** They appear only in `install.sh`, `.env.example` and docs; `POST /api/auth/signup` creates the organization and the first admin from what the USER types in the browser. There is no default login — register through the UI. The installer still writes the values to `.env` for older deployments, but no longer presents them as credentials.
