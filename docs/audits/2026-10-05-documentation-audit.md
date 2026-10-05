# Repository documentation audit — 2026-10-05

Baseline: `7a76c24` on `dev`. The working tree was clean; after `git fetch origin`, the branch
was 32 commits ahead of `origin/dev`. This audit adds documentation corrections and a
supporting README guard change. It does not change application behavior or cut a release.

## Scope and findings

Repository inspection covered package scripts, CI, Docker/installer startup, production
migration entrypoints, tenant APIs, BYOK configuration and production retrieval ranking.
A Markdown link scan covered the repository; the official per-file unit suite, typecheck
and lint were executed. This is a documentation-conformance audit, not an exhaustive
security certification or a production-readiness verdict.

| Finding | Code evidence | Correction |
|---------|---------------|------------|
| No-egress promise conflicts with hosted BYOK and central licensing | `src/lib/llm-client.ts`, `src/lib/license-client.ts` | README discloses configured-provider inference and licence requests |
| Included local embedder confused with automatic semantic readiness | `docker-compose.yml`, `install.sh`, `src/lib/embeddings.ts` | Document per-org endpoint/model/key setup and non-empty local placeholder keys |
| Production setup recommends destructive schema push or SQLite | `scripts/migrate.ts`, `prisma/schema.prisma`, `docker-compose.yml`, `Dockerfile` | Use reviewed migrations, PostgreSQL and separate migration service; mark old SQLite migration guide historical |
| Tenant examples call a nonexistent callback overload and treat context as an object | `src/lib/prisma-tenant.ts` | Use `enterWithOrg(orgId)` and `requireOrgContext()`; clarify raw SQL, nested relations and client-ID rules |
| Guides describe hosted SaaS, obsolete SSO target and old plan behavior | `src/lib/sso.ts`, `src/lib/plan-gating.ts`, `src/lib/license-client.ts` | Describe on-prem multi-org deployment, explicit SSO target and flat entitlement with legacy gates |
| Architecture describes RRF as production ranking and rerank as off | `src/lib/rag-retrieval.ts`, `src/lib/rag-ranking.ts` | Describe lexical-first, balanced candidate pools and default reranking; link detailed reference |
| Health and rollback examples disagree with actual startup/image configuration | `Dockerfile`, `src/lib/health-status.ts`, `docker-compose.yml` | Separate readiness/liveness, remove ineffective `IMAGE_TAG` rollback and document schema compatibility |
| Three repo links are broken | Markdown link scan | Replace stale onboarding anchor and incorrect root-relative tenant links |
| Instruction budget guard fails | Initial official unit run, `src/lib/coverage-floor-consistency.test.ts` | Shorten duplicated business/BYOK prose; preserve security invariants and guard |
| README tests pin false no-egress wording and stale test counts | `src/lib/readme-claims.test.ts` | Require accurate data-flow disclosure and the official count command; negative-control both |

The Helm chart remains unsupported. Its README now distinguishes corrected tenant terminology
from the deployment gaps that remain. Historical release results and old design records are
not current validation; the main architecture page no longer presents illustrative latency,
quality or test totals as a readiness guarantee.

## Executed validation

| Command/check | Observed result | Exit |
|---------------|-----------------|-----:|
| `bun run test` (baseline) | 351/351 files · 8280 pass · 1 fail · 71 skip; combined instruction budget failure | 1 |
| `bun run test` (final code/guard state) | 351/351 files · 8281 pass · 0 fail · 71 skip | 0 |
| `bunx tsc --noEmit --incremental false` | No errors | 0 |
| `bun run lint` | 0 errors, 172 warnings | 0 |
| README negative controls | Each planted violation failed; each byte-identical restoration passed | 0 for control procedure |

Final unit results precede the last prose-only corrections to deployment/architecture; those
corrections do not change source or test behavior. Final `git diff --check` exited 0. The final link scan finds only the skill-example placeholder
described below and exits 1; all other scanned local links resolve.
The instruction files total 63,847 characters by the guard metric and 65,319 UTF-8
bytes, below 65,536 in both measurements. The existing guard was observed failing before
compression and passing in the final official suite; its implementation was not weakened.

Evidence: [negative controls](./2026-10-05-documentation-negative-controls.json) and
[link scan](./2026-10-05-documentation-links.json).
Each control runs `bun test src/lib/readme-claims.test.ts`, restores the original README
bytes in a `finally` block, and repeats the test. The final README SHA-256 is recorded.

## Limits and remaining work

- 71 skipped unit cases are not executed proof. Integration tests, coverage remeasurement,
  E2E dev/prod, build, real PDF ingestion, live AI/provider evaluations, fresh-host install,
  backup/restore drills and load/pentest were not executed in this session.
- Link scanning leaves the intentional image-link placeholder in
  `.github/skills/impeccable/reference/document.md`; it is a skill example, not a product link.
  Repeated-heading diagnostics were not treated as missing files or proof of broken navigation.
- Detailed historical plans and measurements retain their original context. This change
  corrects current entry documentation and selected conflicting references; it does not
  certify every sentence in historical archives or every API/schema example.
- Pushing `dev` also publishes the 32 pre-existing local commits. No force push, `main`
  promotion, release tag or deployment is part of this task.
