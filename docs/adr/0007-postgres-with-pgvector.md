# ADR 0007: Postgres with pgvector

**Status:** Accepted  
**Date:** 2026-07-30

## Context

The assistant needs both relational data (users, documents, chat history, audit logs, configurations) and vector similarity search (semantic retrieval for RAG). Using two separate databases (e.g., Postgres for relational + Pinecone for vectors) introduces sync complexity, dual-write failures, and operational overhead. Enterprise self-hosted deployments prefer fewer moving parts.

## Decision

Use PostgreSQL 16 as the single database, with the `pgvector` extension for vector storage and similarity search, and `pg_trgm` for trigram fuzzy matching. Store embeddings in the `DocumentChunk.embedding` column (`Unsupported("vector(1536)")`). All relational data, vectors, and FTS indexes live in one database with ACID transactions.

## Consequences

- **Positive:** Single database to operate and back up. ACID transactions across relational and vector data. No sync lag between DB and vector store. Enterprise-friendly (Postgres is already in their stack). External vector stores (Qdrant/Milvus) supported as optional scale-out.
- **Negative:** pgvector HNSW index build time on large corpora. Single DB is a scalability ceiling for very large deployments (mitigated by optional external vector store support).

## Alternatives

- **Postgres + Pinecone:** Rejected — dual-write sync complexity, cloud dependency, cost.
- **SQLite + external vectors:** Rejected — SQLite lacks concurrent write performance for production. No native vector support.
- **Dedicated vector DB only (Milvus):** Rejected — loses relational ACID guarantees for chat history and audit logs.
