# Upgrade evidence — 2026-10-04

The initial [repository audit](2026-10-04-repository-audit.md) remains a historical
assessment: its 6.9/10 mean describes the tree before these fixes. This record
does not certify every domain above 9/10.

## Implemented changes

- Backup and restore count bytes inside the pipeline, preserving the stream delivered to PostgreSQL.
- Pending and unknown license states fail closed. Administrators can activate a license while the install is locked. Product jobs now check the same lockdown predicate before embedding, graph or index work, including the Redis-down fallback. Locked jobs record an audit warning and a document error, then stop without consuming all retry attempts. License issuance and payment reconciliation remain available during lockdown. A real BullMQ probe configured three attempts and stopped after one with the document error and audit row persisted; see [worker evidence](2026-10-04-worker-license-evidence.json).
- Signed sessions carry an issue time and expire after seven days. Idle activity is scoped by session version, retained beyond the absolute lifetime, tolerates at most five seconds of signed-issuance and Redis activity clock skew, and missing Redis activity cannot revive an old session. Existing legacy cookies require a new login.
- Token-authenticated metrics requests reach the metrics handler, which retains its authentication checks.
- The integration test proxy bounds streamed request and response bytes and reports truncation and body-read failures.
- Integration context initialization rejects empty provider output and uses a scoped client-ID lookup. Three formerly orphaned routes now have adjacent behavioral tests.
- The braces dependency has local depth guards for parsing and public AST walkers. Frozen installation and both Dockerfiles include the patch. The upstream version remains affected by GHSA-vfj7-8cjw-p6xm; this is a local mitigation, not an upstream fixed release or a clean advisory scan.
- Image publishing depends on reusable CI; versioned tags additionally depend on the live evaluation workflow. GitHub publication has not been executed in this session.
- Raw vector-store metadata queries explicitly filter by authenticated organization; a negative control removing the predicate fails its test.
- Raw FTS upserts require tenant context and bind organization ownership on PostgreSQL updates and SQLite deletion/insertion. A real isolated PostgreSQL probe kept a foreign chunk unchanged and indexed it under its owning organization. Three SQLite in-memory behavioral tests verify foreign-entry protection, own-entry replacement without duplicates and missing-context refusal. PostgreSQL and SQLite evidence is recorded in [the ownership report](2026-10-04-fts-ownership-evidence.json). Removing ownership predicates caused failures on both backends.
- PostgreSQL FTS schema and GIN index are owned by schema deployment, eliminating runtime exclusive DDL. SQLite initialization shares concurrent work and remains retryable after failure. A fresh isolated PostgreSQL schema push created the column and index; negative controls removing either declaration or restoring runtime ALTER failed their guards.
- Document uploads preserve all accepted chunks up to 2,000 and reject overflow before persisting a document, chunks, audit event or job. The real book generated 1,029 chunks; the former 500-chunk cap silently discarded its tail. Ten upload tests cover retention, the exact limit and overflow; removing the overflow guard caused a failure. Full-book re-upload against the changed production artifact returned HTTP 201, retained all 1,029 chunks and persisted all 1,029 embeddingJson values. Cognee completion and one document-specific cited answer were subsequently verified; see the PDF evidence below.
- Cognee text batches containing a UTF-8 entry above 1 MiB use file uploads for all entries, preserving order. A direct server probe rejected a 1,048,577-byte raw field with HTTP 400; the corrected transport accepted the 1,138,868-byte book. The server schema supports the `data` upload field. A Unicode/order/content test and negative control cover the adapter. Background acceptance is not reported as completed ingestion.
- Cognee has an opt-in `COGNEE_SYSTEM_MESSAGE_MAX_CHARS` compatibility patch, disabled by default. It splits oversized instructions into bounded system messages without moving document content or changing its role. Four tests cover Unicode preservation, roles, disabled/short paths, idempotence, decorated syntax and unsupported adapter layouts. A wrong-role negative control failed. The isolated pinned sidecar booted with a 1,600-character limit applied to both adapter copies; its installed helper passed the Unicode/role round-trip.
- Document graph ingestion persists storage IDs and graph-run identity in `Document.cognifyPipelineJson`. Retries observe the saved run; completion requires that exact run and its own files to be ready. Concurrent reprocess requests use an atomic claim, queue failures release that claim, and status-write failures cannot report success. A new additive migration is required. Lost launch responses remain ambiguous and require operator inspection rather than duplicate graph launch.
- Memory admission and the Redis-down fallback reject locked organizations before writing. The memory worker rechecks entitlement at execution and fails locked jobs without exhausting retry attempts. Admission lookup failure drops optional memory without an unhandled rejection. A real BullMQ probe changed a queued job’s organization from valid to expired before execution; it failed after one of five configured attempts. See [memory evidence](2026-10-04-memory-license-evidence.json). Both gate removals failed focused negative controls and byte-identical restoration passed.
- Upload-triggered graph indexing and document/REST/integration source initialization check entitlement before provider or enrichment work. Graph indexing authorizes its chunk before extraction and relation persistence. Missing integrations stop before enrichment and client-ID reads use `findFirst`. Description-write and graph-relation failures do not produce successful initialization/indexing logs. A failed schema-description pass permits the independent business-profile pass. See [upload background evidence](2026-10-04-upload-background-evidence.json) for the configured expired-org probe and negative controls.
- Judge responses must be finite and in range. Invalid scores remain unjudged. CI rejects a self-judge before evaluation starts.
- SQL result accuracy includes failed executions in its denominator and writes evidence before failing its gate. Scalar result checks tolerate SQL aliases and numeric formatting without accepting different values.

## Executed evidence and scope

The PostgreSQL/Redis runtime and browser checkout were isolated under `/tmp`;
the application database was not reset. Original BYOK configuration was read
and copied into an isolated evaluation organization with a separate encryption
key. Provider credentials are excluded from these artifacts.

| Check | Observation | Limit |
|---|---|---|
| Official unit runner | 342 files; 8,130 passed, 0 failed, 71 skipped | Includes durable pipeline identity/readiness, reprocess claims, completion-write failures and worker retries; 71 integration/conditional tests remain skipped |
| Compressed real PostgreSQL restore | Organization, User, Document, Integration and ChatSession each restored three rows; ordered full-row digests matched | Synthetic populated fixture, not a customer recovery drill |
| Standalone build | Updated upload-background-gate application source built successfully in the isolated checkout | No release image published |
| Browser suites | Updated upload-background-gate artifact passed 19 development and 19 production tests | A previous rerun failed 2 login tests because signed issuance was 225 ms ahead of its reader; the bounded 5-second correction preceded these passing runs |
| Fresh merged coverage | 76.14% lines; 89.53% functions; zero failed test files | All 213 preceding module floors pass; new background-license floor 95% passes at 100%; FTS measures 70.52% against 69% required |
| Focused FTS coverage | Earlier focused run hit all 124 records; simplified FTS suites passed | Focused results do not replace the merged coverage gate |
| Live SQL evaluation | 40/40 execution, row-count and first-row scalar checks passed; mean 2,613.25 ms | Synthetic employee schema; no unsafe-request or customer-schema claim |
| Original live RAG evaluation | 40 questions, independent model judge, zero missing judgements; faithfulness/relevance/recall 1.0; legacy context density 0.28875 | Cold initialization emitted a deadlock warning; two embedding retrieval calls were rejected by local-host configuration |

The SQL results are preserved in [the machine-readable report](2026-10-04-sql-live-results.json).
The rank-aware RAG results are preserved in [the current report](2026-10-04-rag-chunk-precision-results.json).
The original RAG results are preserved in [the density baseline](2026-10-04-rag-density-baseline.json).
Both corpora are synthetic policy/business fixtures, not customer acceptance datasets.

## Metric definition correction

The old RAG evaluator called a scalar judgement over combined context
“context precision.” That measures context density and does not implement the
[RAGAS Context Precision definition](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/).
The current evaluator preserves that density score as a separate diagnostic
and calculates rank-aware average precision from binary per-chunk usefulness
judgements against the reference answer.

The definition requires ordered chunk judgements, precision at each relevant
rank, division by the number of relevant retrieved chunks, and failure of the
assessment when a chunk cannot be judged. Tests cover the official relevant-first
and irrelevant-first examples, multiple relevant ranks, no useful evidence,
and invalid partial judgements. The new 40-case independent live evaluation passed
all four thresholds with averages of 1.0 and zero missing judgements; its mean
latency was 11,663.775 ms. No embedding-host rejection or DDL deadlock warning
appeared in this invocation. Scores from the two
definitions must not be presented as a retrieval improvement.

The first graph success-log negative control survived: the logger spy had been installed after the graph module was loaded, so its assertion was vacuous. The corrected fixture installs the logger before importing the graph module and preserves dependency exports. Removing the return then failed the intended success-log assertion; byte-identical restoration passed all 29 focused tests.

Negative controls failed when the exact graph-run filter, own-file readiness check or atomic reprocess claim was removed, and when completion-write errors were swallowed. Restored focused suites passed. Fresh empty-database `bun run db:deploy` applied the frozen baseline and additive pipeline-state migration; the nullable text column and both completed migration records were inspected. This is not a customer upgrade or rollback drill.

Negative controls also failed for strict zero-skew issuance and for removal of the maximum future-issuance bound. Negative controls failed for the restored license allowance, missing metrics
middleware path, idle-expiry bypass, client-ID unique lookup, braces parser
depth guard, removed release dependencies, unconditional FTS DDL, fabricated
judge scores, SQL denominator bias and rank-insensitive context precision.
Modified files were restored byte-identical and the focused tests passed again.

## Evidence still needed for the requested 9+ assessment

1. Extend coverage beyond the passing existing module floors; merged coverage is 76.14% lines and 89.53% functions.
2. Expand the passing independent live RAG fixture evaluation beyond the synthetic corpus.
3. Extend real-book validation beyond one question. The full book now has 1,029 chunks, 1,029 embeddings, completed graph status and a successful five-fact answer with four document citations. The existing run was resumed without another upload or graph launch; broader independently judged quality remains due.
4. Evaluate reviewed customer RAG/SQL cases, including ambiguous and unsafe SQL requests.
5. Measure concurrency, p95/p99 latency and resource use; exercise dependency outages and alert delivery.
6. Complete keyboard/accessibility review and a fresh customer installation/upgrade/rollback rehearsal.
7. Review raw SQL and nested relation ownership boundaries and complex modules; a passing unit suite alone does not certify those surfaces. The worker license gate covers dispatched product jobs and their synchronous fallback. The memory worker and its admission/inline fallback now check entitlement as well. Upload-triggered chunk graph extraction and source initialization now check entitlement too. A complete inventory of any other processes that execute org work remains due; these entrypoint tests do not certify every asynchronous path.

The upgrade goal remains active. Existing floors and quality thresholds have
not been reduced to produce a passing result. The latest tenant-scoped FTS upsert passes the merged floor; the earlier failing measurements remain historical observations.

The full-book pipeline `13f2a8a2-390a-46bb-aa53-e81920a6e849` completed after the isolated sidecar's role-preserving 1,600-character system-message patch. The new durable-pipeline source resumed that exact run with verified file IDs, without another upload or graph launch. PostgreSQL reports `cognifyStatus=completed`, `status=ready`, 1,029 chunks and 1,029 non-null embeddings. A document-specific HTTP chat probe returned all five expected facts and four `DOCUMENT` citation records from the book, in 34,889 ms. Citation metadata is present; inline numeric markers are absent. The question was rerun on the isolated standalone artifact containing the durable-pipeline changes, before the subsequent worker license gate. The new source performed the resume of the existing full-book run. Earlier raw-field and graph-schema failures remain historical failures, not evidence of readiness. See [PDF evidence](2026-10-04-pdf-ingestion-evidence.json) and the [role-preserving split probe](2026-10-04-graph-system-split-probe.json). The customer sidecar and application database were not reset.

## Provisional domain reassessment

These are engineering judgements based on the evidence above, not certifications. The initial audit remains unchanged as a historical baseline. The newest changes have a successful isolated production build and unit/type/lint checks. The updated upload-background-gate development and production browser suites each pass all 19 tests. The build, focused tests, official unit runner and configured expired-org probe pass. Fresh merged coverage and all 214 floors pass.

| Domain | Current /10 | Main remaining constraint |
|---|---:|---|
| Architecture and maintainability | 7.5 | Complex modules and manual ownership boundaries need further review |
| Tenant isolation and authorization | 8.3 | Raw SQL and nested relation ownership sweep remains incomplete |
| Authentication and sessions | 8.8 | Fixes and browser evidence exist; independent security review remains due |
| License and BYOK | 8.5 | Fail-closed fixes tested; outage and lifecycle drills remain due |
| RAG and answer quality | 8.3 | Synthetic independent evaluation and one real-book cited answer passed; broader customer quality remains due |
| Text-to-SQL and connectors | 8.5 | Synthetic scalar checks passed; ambiguous/unsafe and customer-schema cases remain due |
| Ingestion and knowledge lifecycle | 8.2 | Whole-book completion and citations verified; durable retries need outage drills and ambiguous-launch reconciliation |
| Database, migrations and durability | 8.5 | Populated isolated restore matched; customer upgrade/rollback rehearsal remains due |
| Deployment and supply chain | 8.0 | Release gates strengthened; advisory still present and image not published/verified |
| Testing and quality gates | 8.5 | Unit runner, artifact checks and existing coverage floors pass; integration/conditional skips remain |
| Frontend, UX and accessibility | 7.0 | Earlier browser suites passed; keyboard/screen-reader audit remains due |
| Performance and scalability | 6.5 | Bounded proxy fixed; concurrent load and p95/p99 evidence remain due |
| Observability and operations | 7.0 | Metrics routing fixed; alert delivery and outage drills remain due |
| API, integrations and SDK | 8.0 | Proxy behavior improved; consumer compatibility matrix remains due |
| Documentation and onboarding | 7.5 | Runbook upload limit corrected; fresh installation rehearsal remains due |

Unweighted provisional mean: **7.9/10** (119.1 / 15 = 7.94, rounded to one decimal). No domain is certified above 9/10 by this record.
