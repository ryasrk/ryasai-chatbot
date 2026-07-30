# Disaster Recovery

## Backup

### Manual backup
```bash
bun run scripts/backup.ts                    # → backups/ryasai-backup-<timestamp>.sql
bun run scripts/backup.ts --compress         # gzip compressed
bun run scripts/backup.ts --output=/mnt/s3   # custom output directory
```

### Automated backup (cron)
```bash
# crontab -e
0 2 * * * cd /opt/ryasai-chatbot && bun run scripts/backup.ts --compress >> /var/log/backup.log 2>&1
```

### CI integration
```yaml
# .github/workflows/backup.yml
name: Nightly Backup
on:
  schedule:
    - cron: '0 2 * * *'
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run scripts/backup.ts --compress
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - run: aws s3 sync backups/ s3://ryasai-backups/$(date +%Y/%m/%d)/
```

## Restore

```bash
# Full restore (stops the app, restores DB, validates)
bun run scripts/restore.ts --file=backups/ryasai-backup-2026-01-01T00-00-00.sql

# Dry run (validates file format without modifying DB)
bun run scripts/restore.ts --file=backups/backup.sql.gz --dry-run

# Compressed backup
bun run scripts/restore.ts --file=backups/ryasai-backup-2026-01-01T00-00-00.sql.gz
```

Validation checks after restore:
- User table exists with ≥1 row
- Document table exists
- Integration table exists
- ChatSession table exists

## Automated Backup Validation

The only way to trust a backup is to restore it. Run nightly:

```bash
# Requires a separate test database (BACKUP_TEST_DATABASE_URL)
bun run scripts/validate-backup.ts

# Or specify the test DB inline
bun run scripts/validate-backup.ts --restore-db=postgresql://user:pass@localhost:5432/ryasai_test
```

This script:
1. Creates a backup from the source DB
2. Restores it to a test DB
3. Validates row counts match (User, Document, Integration)
4. Cleans up the test DB
5. Exits 0 on success, 1 on failure

### CI integration
```yaml
# .github/workflows/backup-validation.yml
name: Backup Validation
on:
  schedule:
    - cron: '0 4 * * *'  # 2 hours after backup
jobs:
  validate:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: ryasai_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run scripts/validate-backup.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_TEST_DATABASE_URL: postgresql://test:test@localhost:5432/ryasai_test
```

## RPO/RTO

| Metric | Target | Method |
|--------|--------|--------|
| RPO (data loss) | ≤24h | Nightly backup at 02:00 |
| RTO (recovery time) | ≤30min | `psql` restore + app restart |
| Backup validation | 100% | Automated nightly restore test |

## Blue-Green Deployment (Argo Rollouts)

```bash
# Enable in Helm values
helm upgrade chatbot ./helm --set blueGreen.enabled=true

# Promote preview → active (when autoPromotion=false)
kubectl argo rollouts promote chatbot

# Rollback
kubectl argo rollouts abort chatbot
kubectl argo rollouts undo chatbot
```

Pre-promotion analysis: checks Prometheus for ≥99% success rate on `/api/v1/health` before swapping traffic.

## Canary Deployment (Flagger + Istio)

```bash
# Enable in Helm values
helm upgrade chatbot ./helm --set canary.enabled=true \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=chatbot.example.com'
```

Canary behavior:
- Shifts 10% → 50% traffic over 5 minutes (10% steps)
- Auto-rolls back if success rate < 99% or p95 > 500ms
- Runs load test webhook during canary
