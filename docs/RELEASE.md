# Release checklist

Run this before telling a customer to install. Every step is here because a product was once shipped
with it missing or unverified.

> **Why this file exists.** `src/lib/release-images.test.ts` can only prove the STATIC half of a
> release — that every image tag `install.sh` references is also a build target in
> `build-images.yml`. It cannot reach the registry, so it cannot prove the tag is actually
> *published*. On 2026-09-25 that gap shipped a product nobody could install: the `:embeddings`
> build step existed and the tag did not, so `docker compose pull` returned
> `...:embeddings: not found` and `install.sh` aborted. The static gates were all green.
> **The steps marked (registry) below are the ones no local test can do for you.**

---

## 1. Local gates

```bash
bunx tsc --noEmit          # 0 errors
bun run lint               # 0 errors
bun run test               # read the count it prints; 0 fail
bun test benchmark/        # golden set
bun test src/lib/invariants.test.ts
bun run build              # must produce .next/standalone/server.js
```

Both e2e modes are mandatory — they diverge in ways that are invisible in dev:

```bash
bun run e2e                # next dev
bun run e2e:prod           # .next/standalone/server.js with NODE_ENV=production
```

If a run fails after you interrupted a previous one, clear the document queue first: orphaned BullMQ
jobs make an uploaded document embed only partly, and the citation assertion then fails in a way that
looks like a retrieval bug.

```bash
redis-cli --scan --pattern 'bull:document-processing:*' | xargs -r redis-cli del
```

## 2. Version consistency

`NEXT_PUBLIC_APP_VERSION` is NOT substituted by the bundler — the Dockerfile declares no `ARG` — so
the **code fallback is what the customer's UI displays**. Keep the fallback equal to the release:

```bash
grep -oE '"version": *"[^"]+"' package.json
grep -E '^(APP_VERSION|NEXT_PUBLIC_APP_VERSION)=' .env.example
grep -oE 'APP_VERSION=[0-9.]+' install.sh
# The appVersion ASSIGNMENT, not just any version-like string: this file's own comment quotes the
# historical drifted values (0.4.0, 2.0.0, 0.5.0) to explain why they were unified, so a loose grep
# matches the prose and reports a mismatch that does not exist. A naive `grep -oE '[0-9]+\.[0-9]+\.'
# reported 0.4.0 here while the real value is 1.0.0.
grep -E "appVersion:.*'[0-9]+\.[0-9]+\.[0-9]+'" src/lib/public-config.ts
```

All four must agree. `CHANGELOG.md` must have a released heading, not `[Unreleased]`.

The same trap applies to the image check in step 3: `grep … ghcr.io/…:embeddings build-images.yml`
matches this file's own explanatory comments as well as the build step. Match the `tags:` line, or
strip comments — which is what `src/lib/release-images.test.ts` had to do after its negative control
passed vacuously.

## 3. Published artifacts — **(registry)**

**This is the step that shipped broken.** A tag being *referenced* is not the tag being *reachable*.

```bash
# Every image the generated compose pulls must resolve.
docker compose -f /tmp/ryasai-compose.prod.yml pull
echo "exit=$?"   # MUST be 0
```

To check a single tag directly:

```bash
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:app        >/dev/null && echo app:OK
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:scheduler  >/dev/null && echo scheduler:OK
docker manifest inspect ghcr.io/ryasrk/ryasai-chatbot:embeddings >/dev/null && echo embeddings:OK
```

If any is missing, publish it — all three are built by `.github/workflows/build-images.yml`, which
runs on a `main` push, a `v*.*.*` tag, **or** manually:

```bash
gh workflow run build-images.yml        # no code change needed
gh run watch                            # confirm all THREE build steps ran
```

Confirm the step list, not just the exit code: a run can succeed while a step is absent, which is
exactly what happened (steps 5, 6, then 8 — step 7 did not exist yet).

Tags NOT ours and therefore not built by us, but still required:
`cognee/cognee:1.6.0`, `pgvector/pgvector:pg16`, `redis:7-alpine`, `searxng/searxng:latest`.

## 4. External services — **(network)**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://license.ryasai.my.id/health          # 200
# A fabricated key must be REJECTED, not accepted:
curl -s -X POST https://license.ryasai.my.id/api/v1/license/validate \
  -H 'Content-Type: application/json' \
  -d '{"license_key":"TOTALLY-FAKE","machine_id":"m","product":"ryasai-chatbot"}'
# expect: {"valid":false,...} with a signature
```

A validator that accepts a fake key is worse than one that is down.

## 5. Fresh-install rehearsal — **(the only test that proves the product is sellable)**

On a clean host, or a clean Docker context:

```bash
curl -sSL https://ryasai.my.id/install.sh | bash
```

Then confirm, in order: the health wait passes, the signup flow creates an org, a document upload
reaches `embeddedChunkCount === chunkCount`, and a question about that document returns an answer
with a citation. Steps 1–4 verify components; this verifies the product.

## 6. What is deliberately NOT covered

- **Answer quality is not gated in CI.** `rag-eval` / `sql-eval` run via the manual `eval.yml`
  workflow. Numbers live in `docs/hasil-pengukuran.md`; re-measure rather than trusting a figure
  quoted in a document.
- **Retrieval quality** is measured by `benchmark/real-prose-arm.ts` against a real embedder, not by
  the e2e suite — the e2e mock embedder is a hashed bag of tokens and cannot rank honestly at the
  corpus sizes involved.
- **Migrations for existing installs** (e.g. a `vector(1536)` → `vector(384)` change) are documented
  in `prisma/schema.prisma` and `tools/local-embeddings/README.md`, not automated.
