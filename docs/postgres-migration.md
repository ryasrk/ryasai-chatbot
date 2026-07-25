# PostgreSQL Migration Guide

This guide covers migrating ryasai Chatbot from SQLite to PostgreSQL for production deployments.

## When to Migrate

- **SQLite is fine for**: single-tenant demo, development, < 10K document chunks, < 5 concurrent users
- **Migrate to Postgres when**: multi-tenant scale, > 10K chunks, concurrent users, pgvector needed for embeddings, cognee Postgres backend

## Prerequisites

- PostgreSQL 14+ with `pgvector` extension
- `pgloader` (optional, for data migration) or manual export/import

## Step 1 — Install Postgres + pgvector

```bash
# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector  # or build from source

# Create database + user
sudo -u postgres psql -c "CREATE USER ryasai WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE ryasai OWNER ryasai;"
sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d ryasai -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"  # for similarity search
```

## Step 2 — Update Prisma Datasource

Edit `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Update `.env`:

```
DATABASE_URL="postgresql://ryasai:yourpassword@localhost:5432/ryasai?schema=public"
```

## Step 3 — Apply Schema

```bash
bunx prisma migrate dev --name init
# or for existing data: bunx prisma db push
bunx prisma generate
```

## Step 4 — Adapt Raw SQL (3 files need changes)

### 4a. `src/lib/connectors.ts` — Schema Reflection

SQLite uses `PRAGMA table_info()`. Postgres uses `information_schema`:

```sql
-- Replace PRAGMA table_info(t) with:
SELECT
  c.column_name AS name,
  c.data_type AS type,
  CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
  CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS pk
FROM information_schema.columns c
LEFT JOIN (
  SELECT ku.column_name, ku.table_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage ku
    ON tc.constraint_name = ku.constraint_name
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON pk.column_name = c.column_name AND pk.table_name = c.table_name
WHERE c.table_name = $1
ORDER BY c.ordinal_position;
```

Also replace `AUTOINCREMENT` in demo seed SQL with `GENERATED ALWAYS AS IDENTITY` or `SERIAL`.

### 4b. `src/lib/rag-fts.ts` — Full-Text Search

SQLite FTS5 → PostgreSQL `tsvector`:

```sql
-- Replace FTS5 virtual table with:
ALTER TABLE "DocumentChunk" ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content || ' ' || coalesce(keywords, ''))) STORED;
CREATE INDEX DocumentChunk_tsv_idx ON "DocumentChunk" USING GIN(tsv);

-- Replace bm25() search with:
SELECT chunkId, ts_rank(tsv, plainto_tsquery('simple', $1)) AS rank
FROM "DocumentChunk"
WHERE tsv @@ plainto_tsquery('simple', $1)
ORDER BY rank DESC
LIMIT $2;
```

### 4c. `src/lib/embeddings.ts` — Vector Search (optional but recommended)

Move `DocumentChunk.embeddingJson` (currently JSON string in SQLite) to a `pgvector` column:

```sql
ALTER TABLE "DocumentChunk" ADD COLUMN embedding vector(1024);  -- BGE-M3 dimension
CREATE INDEX DocumentChunk_embedding_idx
  ON "DocumentChunk" USING ivfflat(embedding vector_cosine_ops)
  WITH (lists = 100);
```

Update `rag.ts` retrieval to use `<=>` (cosine distance) instead of JS cosine:

```sql
SELECT id, 1 - (embedding <=> $1) AS similarity
FROM "DocumentChunk"
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1
LIMIT $2;
```

## Step 5 — Data Migration

### Option A: pgloader (automated)

```bash
# install
sudo apt install pgloader

# run
pgloader ./db/custom.db postgresql://ryasai:yourpassword@localhost:5432/ryasai
```

### Option B: Manual export/import

```bash
# Export from SQLite
sqlite3 db/custom.db ".dump" > dump.sql

# Adapt SQL syntax (PRAGMA, AUTOINCREMENT, etc.)
# Import to Postgres
psql "postgresql://ryasai:yourpassword@localhost:5432/ryasai" < dump_adapted.sql

# Re-seed demo data
bun run scripts/seed.ts
```

### Option C: Fresh start (simplest)

```bash
# Just apply schema + re-seed
bunx prisma migrate dev --name init
bun run scripts/seed.ts
```

## Step 6 — Cognee Postgres Backend (optional)

If using cognee memory layer, configure it for Postgres:

```env
COGNEE_ENABLED=true
COGNEE_DB_PROVIDER=postgres
COGNEE_VECTOR_DB_PROVIDER=pgvector
COGNEE_GRAPH_DATABASE_PROVIDER=postgres
COGNEE_CACHE_BACKEND=postgres
```

This gives cognee a single-Postgres backend for graph + vectors + sessions.

## Step 7 — Verify

```bash
bunx tsc --noEmit          # 0 errors
bun run lint               # 0 errors
bun run test               # all pass
bun run dev                # smoke test: login, create integration, upload doc, chat
bun run e2e                # 4 Playwright specs
```

## Migration Checklist

- [ ] Postgres + pgvector installed
- [ ] `prisma/schema.prisma` datasource changed to `postgresql`
- [ ] `.env` `DATABASE_URL` updated
- [ ] `prisma migrate dev` or `db push` applied
- [ ] `connectors.ts` PRAGMA → information_schema
- [ ] `rag-fts.ts` FTS5 → tsvector
- [ ] `embeddings.ts` JSON → pgvector column (optional but recommended)
- [ ] Data migrated (pgloader or re-seed)
- [ ] Cognee Postgres backend configured (if cognee enabled)
- [ ] All tests pass
- [ ] E2E smoke test green
