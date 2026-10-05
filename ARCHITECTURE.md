# Ryasai Chatbot — Architecture

## Deployment and data flow

ryasai runs on-prem per customer. One installation can host multiple isolated organizations.
The signed machine-bound licence is validated against our central License Validator.
Customers supply their chat endpoints and keys. Hosted AI providers receive the prompts and
evidence sent for inference; app storage remains in the customer's deployment. There is no
per-token billing by ryasai.

The standard Docker stack includes a local embedding service. Each org must configure its
embedding endpoint, model and key in Settings; OpenAI-compatible local endpoints still need
a non-empty placeholder key. A hosted embedder is also supported.

Stack: Next.js 16, React 19, TypeScript 5, Prisma 6, PostgreSQL 16 with pgvector/pg_trgm,
Bun 1.4.2 and Tailwind 4. The Docker builder uses Node 22; the shipped server uses Bun.

## Service boundaries

| Service | Responsibility |
|---------|----------------|
| `app` | Next.js standalone web/API server; instrumentation starts document processing |
| `scheduler` | Separate scheduled-job worker |
| `migrate` | Runs `scripts/migrate.ts` before app/scheduler startup |
| `db` | Application PostgreSQL database and separate `cognee_db` |
| `redis` | Queues and shared runtime state |
| `local-embeddings` | Local embedding endpoint |
| `cognee-db-init` | Creates the Cognee database before sidecar startup |
| `cognee` | Pinned HTTP memory/graph backend; graph state persists separately |

Production migrations use reviewed SQL through `bun run db:deploy`. `prisma db push` is for
development prototypes. The application image runs `bun server.js` without the Prisma CLI.
`/api/v1/health` is dependency-free liveness. `/api/health` checks dependencies, returns 503
for database failure and reports optional failures under `degraded`/`checks`.

See [Deployment](./docs/deployment.md), [Operations](./docs/operations.md),
[Build and deploy reference](./docs/build-and-deploy-reference.md) and
[Cognee HTTP migration](./docs/cognee-http-migration.md).

## Tenant isolation and authorization

`Organization` is the tenant root. Organization-owned models carry `organizationId`.
Authenticated routes must enter the org context in their own frame:

```typescript
const user = await getActiveUser()
enterWithOrg(user.organizationId)
const docs = await db.document.findMany()
```

`enterWithOrg` takes one string and returns `void`. `getOrgContext()` returns a string or
`undefined`; `requireOrgContext()` throws when missing. The Prisma extension scopes supported
operations, including unique reads, and rejects absent context or explicit foreign tenant IDs.
Client-supplied IDs still use `findFirst` or `findFirstOrThrow`.

Raw SQL and nested relation operations need explicit ownership checks:

```typescript
const orgId = requireOrgContext()
const chunks = await db.$queryRaw`
  SELECT id, content FROM "DocumentChunk"
  WHERE "organizationId" = ${orgId}
`
```

Model membership is defined by `ORG_SCOPED_MODELS` and `ORG_SCOPE_EXCEPTIONS` in
[prisma-tenant.ts](./src/lib/prisma-tenant.ts). `bypassOrg(fn)` permits deliberate pre-auth or
cross-org work; it does not authorize the caller. RBAC uses `admin`, `analyst` and `viewer`.
Data-access policies further restrict tables/columns and document roles. The scheduler
consults the same licence-lockdown predicate as authenticated requests.

See [Tenant quick reference](./MULTI-TENANT-GUIDE.md), [ADR 0009](./docs/adr/0009-tenant-isolation-application-level.md),
[ADR 0014](./docs/adr/0014-per-role-data-access.md) and [Threat model](./docs/threat-model.md).

## Retrieval and answer generation

The shared RAG pipeline in `src/lib/pipelines/rag-pipeline.ts` owns evidence collection,
source guidance, untrusted-context wrapping, citations and audit side effects for both
streaming and non-streaming transports.

`src/lib/rag-retrieval.ts` combines independent vector and lexical candidate searches with
knowledge-graph candidates. BM25 ranking uses tenant-local corpus statistics when populated, otherwise candidate-pool statistics. Production
fusion calls `lexicalFirst` in `src/lib/rag-ranking.ts`: lexical order is preserved and
additional semantic/graph candidates can contribute. With reranking enabled, candidate-pool
balancing reserves capacity for semantic candidates before the final rerank. RRF remains a
utility and benchmark comparison; its presence does not mean production retrieval uses it.

Reranking is enabled by default and can be deferred until candidate pools are merged.
Reflection and evidence-sufficiency checks guide additional retrieval and answer generation.
Missing embeddings can leave lexical retrieval available, but semantic coverage must be
checked separately. A document's ready state does not prove every retrieval backend is ready.

Document upload extracts text, chunks it and schedules background processing. Parsers keep
PDF/DOCX/XLSX extraction lossless-or-empty; image-only PDFs produce placeholders instead of
raw-byte noise. Verify embeddings and `cognifyStatus` separately from upload acceptance.
Cognee uses the pinned HTTP server and org-specific client state; the removed TypeScript
bindings are not a fallback backend.

See [AI/RAG reference](./docs/architecture-reference.md), [Retrieval integration plan](./docs/retrieval-production-integration-plan.md),
[Latency reference](./docs/latency-reference.md) and [Current architecture/RAG evidence](./docs/audits/2026-10-05-architecture-rag-evidence.md).

## Text-to-SQL and external tools

`src/lib/pipelines/sql-pipeline.ts` is shared across streaming and non-streaming SQL paths.
It owns schema loading, source instructions, repair, guardrails, concurrency and audit/history
effects. SQL safety combines parsing, dangerous-function checks, access policies and database
read-only constraints. Connector drivers load through static import literals so tracing can
include them in standalone images. REST and MCP integrations have their own authorization
and tool-boundary checks; inspect the relevant executor before changing their behavior.

See [AI/RAG reference](./docs/architecture-reference.md), [ADR 0013](./docs/adr/0013-parsed-sql-guard-and-one-pipeline.md)
and [ADR 0010](./docs/adr/0010-mcp-plugin-isolation-namespaces.md).

## Validation and limits

Use `bun run test` for the per-file unit suite; combining files in one Bun test process can
leak mocks. CI also runs typecheck, lint, coverage and its gate, then browser tests in dev and
against a built production artifact. A configured workflow is not a successful run.

Retrieval quality, provider compatibility, latency and load capacity depend on the deployment
and corpus. Measure them with the repository's evaluation and load harnesses; illustrative
numbers are not production guarantees. Current audit results and untested areas are in the
[Documentation audit](./docs/audits/2026-10-05-documentation-audit.md) and
[Quality readiness](./docs/quality-readiness.md).
