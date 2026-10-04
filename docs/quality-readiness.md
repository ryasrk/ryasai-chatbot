# Quality readiness — 2026-10-04

This record separates implemented improvements from evidence still needed for a
9/10 assessment. A passing mock-provider suite establishes application behavior;
it does not establish real-model answer quality, capacity, or full accessibility.

## Executed evidence

The source was tested in an isolated checkout against a temporary PostgreSQL 16
cluster. Browser tests used a dedicated Redis database and mock LLM, license and
payment services. The existing development server and application database were
not used for resets or restore tests.

| Check | Observed result |
|---|---|
| Official per-file unit runner | 327 files; 8,023 passed, 0 failed, 71 skipped |
| TypeScript | No errors |
| ESLint, errors only | No errors |
| Standalone production build | Passed |
| Browser suite, development | 19 passed |
| Browser suite, production standalone | 19 passed |
| Merged coverage | 75.51% lines; 89.46% functions |
| Coverage floors | 212 modules passed; existing floors preserved |
| Scheduler Docker build | Passed; migration executed from the resulting image |
| Database migration | Fresh install, repeated deploy and matching legacy adoption passed |
| Incompatible legacy schema | Rejected before migration history was created |
| Populated compressed backup/restore | Organization, User, Document, Integration and ChatSession row counts matched |
| Live tenant probe | Missing context and foreign reads/writes rejected; own reads and explicit bypass worked |
| SDK under Node | Built Fetch handler returned HTTP 200 with the expected JSON |

Negative controls failed when tenant context rejection, lazy-query bypass,
corpus ownership, semantic-head retention, finite-score validation and baseline
index restrictions were deliberately broken. Each file was restored byte for
byte and its test passed again. The invariant suite passed independently.

## Domain assessment

| Domain | Improvements implemented | Remaining evidence for 9+ |
|---|---|---|
| Architecture and maintainability | Shared tenant context across Next bundles; shared quality gates and backup transport | Review complex connector, AI/tool and settings modules; measure coupling and regression risk before splitting them |
| Tenant security | Missing context fails closed; unique reads are scoped; foreign tenant predicates and writes rejected | Audit nested relation writes and raw SQL ownership; independent penetration testing |
| RAG retrieval | Tenant-local BM25 statistics; both retrieval heads retained; merged decomposition reranked once; endorsed single-document evidence can fill unused slots | At least 40 reviewed customer-corpus cases with an independent live judge; compare quality and latency against the previous ranking |
| Text-to-SQL | Live CI mode validates execution and result thresholds; all golden cases need expected results | Execute the reviewed set against the customer's schema and provider; test unsafe and ambiguous requests |
| Testing | Per-file coverage runner; DNS decisions tested without public network dependencies; meaningful diversity and transport regressions | Improve uncovered UI and critical branches; skipped integration tests remain unevaluated |
| Deployment and migrations | Pinned Bun images; reviewed baseline and versioned deploy; schema mismatch blocks legacy adoption | Rehearse upgrade and rollback using a representative customer database and the published release images |
| Data durability | Atomic private backups; failed dumps stop upgrades; transactional restore; separate-target validation | Automate periodic restore drills, retention and off-machine storage; measure recovery time and recovery point |
| API and SDK | Pre-auth API-key lookup uses explicit bypass; portable compiled SDK and Fetch adapter | Consumer compatibility matrix and webhook authentication deployment checks |
| Frontend and accessibility | Development and production user flows pass; responsive login image sizing | Keyboard/screen-reader and WCAG review across all screens, with customer task usability tests |
| Performance and scalability | Bounded retrieval candidate multiplier; no per-subquery rerank calls; bounded corpus-stat cache | Concurrent-user load test on target hardware, with p95/p99 latency and resource measurements |
| Observability and operations | Correct authenticated Prometheus setup; actionable migration/restore procedures | Alert delivery and dependency outage drills; validate operational dashboards with real workloads |
| Documentation and onboarding | Updated tenant rules, migration instructions, SDK installation and recovery procedures | Fresh-machine customer installation exercise and remaining stale documentation audit |

## Live evaluation setup

Use a dedicated eval organization with its own BYOK configuration, not the
customer's production rows. The live workflow needs `EVAL_DATABASE_URL`,
`EVAL_ORG_ID`, `EVAL_ENCRYPTION_SECRET_KEY`, independent `EVAL_JUDGE_*` settings
and repository variables `EVAL_RAG_GOLDEN_FILE` / `EVAL_SQL_GOLDEN_FILE`.

RAG CI mode requires at least 40 samples, no skipped judgements and an independent
judge. Default minimum scores are faithfulness 0.85 and relevance, context
precision and context recall 0.80. These are release thresholds, not observed
scores or automatic proof of a 9/10 rating.

SQL CI mode requires at least 40 cases with `expectedRowCount` and
`expectedFirstRowContains` on every case. Default minimum execution accuracy is
0.95 and result accuracy is 0.90. Empty sets, non-finite scores and invalid
thresholds cannot pass either gate. A live regression fails the scheduled/manual
workflow; the offline PR workflow remains separate.

The release record still needs a real-PDF ingestion/citation exercise with live
embedding and knowledge services. Mock-provider browser tests do not prove that
external cognify succeeds. A customer's embedding dimensions must also match
the configured vector column before semantic retrieval can be evaluated.
