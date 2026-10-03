# ryasai — Enterprise AI Assistant

[![CI](https://github.com/ryasrk/ryasai-chatbot/actions/workflows/ci.yml/badge.svg)](https://github.com/ryasrk/ryasai-chatbot/actions/workflows/ci.yml)
[![Build Images](https://github.com/ryasrk/ryasai-chatbot/actions/workflows/build-images.yml/badge.svg)](https://github.com/ryasrk/ryasai-chatbot/actions/workflows/build-images.yml)
![License](https://img.shields.io/badge/license-Proprietary-red)
![Version](https://img.shields.io/badge/version-2.1.0-blue)

An AI assistant for enterprises that runs **on your own hardware**. Staff ask questions in plain language and it
answers from your data — your databases, your documents and your internal APIs — with sources they can check.

It is installed once, per customer, inside your network. Nothing is sent to a vendor cloud.

---

## What it does

**Answers from your own systems.** Ask *"How many employees are in the IT department?"* and it queries the database.
Ask *"What is the refund procedure?"* and it reads your policy documents. Ask for a customer's order history and it
calls your internal API. You do not have to say which — it works that out and tells you what it used.

**Shows its sources.** Every answer names where it came from: which table and query, which document, which endpoint.
When it cannot find something it says so rather than guessing, and it separates *"I did not find this in what I
searched"* from *"this does not exist"* — because those are different claims and only one of them is safe to make.

**Reports numbers with the rows behind them.** Figures are shown with the population they were measured from, so a
number can be traced instead of trusted. If a result was truncated, it says so rather than reporting a total it
cannot see.

**Keeps organisations separate.** One installation can host several organisations and they cannot see each other's
data. This is enforced where the data is read, not by convention, so a new feature cannot quietly bypass it.

**Runs scheduled work.** Reports that run on their own schedule, with a history of every run and export to JSON or CSV.

**Connects what you already have.** PostgreSQL, MySQL, SQL Server and ClickHouse — including managed variants
(Supabase, Neon, PlanetScale, TiDB, CockroachDB) because a connection string is what those providers give you.
Internal REST APIs can be whitelisted so the assistant is allowed to call them. A private web search is available as
an optional component.

---

## How it is deployed

| | |
|---|---|
| **Where it runs** | Your own servers, one installation per customer |
| **Who pays for AI usage** | You do, directly to the provider you choose |
| **How it is licensed** | A signed licence key, bound to the machine it runs on |
| **What we can see** | Nothing. Your data and your provider credentials stay inside your network |

### You bring your own AI provider

The assistant does not bundle an AI model that you are billed for. You configure your own chat endpoint and API key
in **Settings → AI Configuration**, and your usage is billed to you by that provider. We never see the key, and a
copied deployment does not silently keep working because the licence is bound to the machine.

A self-contained embedding model is included, so document search works without a second vendor and without an
additional key.

### Installing

One command, on a clean Linux host with Docker:

```bash
curl -sSL https://ryasai.my.id/install.sh | bash
```

It pulls prebuilt images, generates the configuration, backs up any existing database, and starts every service.
**The customer host never clones this repository and never builds from source.**

| Flag | Effect |
|------|--------|
| `--port <number>` | Port for the web interface (default `38180`, advances automatically if taken) |
| `--with-searxng` | Adds a private web-search service (about 256 MB RAM) |
| `--dir <path>` | Installation directory |

**Updating** an existing installation uses the same command. It detects the previous install, keeps your settings,
backs up the database first, and reports anything the new version expects that your configuration does not yet set.
Your `.env` is never rewritten — it holds your licence key and secrets — so the installer tells you what to add by
hand rather than regenerating it.

### Hardware

| Tier | Workload | CPU | RAM | Storage |
|---|---|---|---|---|
| **Minimum** | 1–5 concurrent users, under 5,000 documents | 1 vCPU | 2 GB | 20 GB |
| **Recommended** | 10–50 concurrent users, tens of thousands of documents | 2 vCPU | 4 GB | 40–50 GB |
| **High scale** | High concurrency, hundreds of thousands of documents | 4 vCPU | 8 GB | 80–100 GB |

The whole system idles at roughly 750 MB and peaks around 2 GB, so a small VPS is enough to evaluate it. Full
per-service figures are in [docs/RELEASE.md](./docs/RELEASE.md).

---

## What you get

**Chat** with a source picker, so a question can be aimed at one database or at your documents when you already know
where the answer lives — and automatic routing when you do not.

**Knowledge** for uploading documents, seeing how each one was processed, and confirming that search is working. If
part of document search is degraded, the interface says which part and what to do, rather than showing a healthy
badge over a broken component.

**Data Sources** for connecting databases and REST APIs, with a connection test, a view of the reflected schema, and
per-source instructions that shape how questions about that source are answered.

**Prompt & Tools** where an administrator can adjust behaviour — the assistant's instructions, the rules used to
generate SQL, and which tools are enabled — without a redeployment.

**Monitoring** of audit events, usage and health, for whoever has to answer *"what has it been doing?"*.

**Access control** with administrator, analyst and viewer roles, so read-only staff can use the assistant without
being able to change how it is configured.

---

## For developers

Local setup:

```bash
bun install
cp .env.example .env          # set DATABASE_URL and ENCRYPTION_SECRET_KEY (both required)
bunx prisma db push           # apply the schema (PostgreSQL 16 + pgvector)
bash start.sh                 # starts the app and the scheduler
```

Then register at `http://localhost:3000` exactly as a customer would. `start.sh` deliberately creates **no** account —
the sign-up flow owns organisation creation, so there is no seeded "default admin".

Common commands:

```bash
bun run dev            # development server
bun run test           # unit tests
bun run e2e            # end-to-end tests (development)
bun run e2e:prod       # end-to-end tests against the production build
bunx tsc --noEmit      # type check
bun run lint           # linter
```

Run **both** end-to-end modes before shipping: the development server and the production build have historically
diverged in ways that only appear in the shipped artefact.

Stack, in brief: Next.js, React, TypeScript, PostgreSQL with `pgvector`, Bun, Tailwind. The full design is in
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Reference

| | |
|---|---|
| **Version** | 2.1.0 |
| **Release history** | [CHANGELOG.md](./CHANGELOG.md) |
| **Architecture** | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| **Organisation isolation** | [MULTI-TENANT-GUIDE.md](./MULTI-TENANT-GUIDE.md) |
| **Security** | [SECURITY.md](./SECURITY.md) · [docs/threat-model.md](./docs/threat-model.md) |
| **Contributing** | [CONTRIBUTING.md](./CONTRIBUTING.md) — branch policy and release process |
| **Release checklist** | [docs/RELEASE.md](./docs/RELEASE.md) |
| **HTTP API** | [openapi.yaml](./openapi.yaml) — an OpenAI-compatible endpoint for programmatic use |

**On answer quality.** It is not claimed here, because it depends on your data and your model provider. Two harnesses
exist to measure it on your own corpus rather than on ours — a question-set generator that builds a set from your
documents, and an evaluation runner that scores retrieval and answers. Run them against your data before trusting any
number, including ours.

**On what is verified automatically.** Type checking, linting, around 280 test files (7,200+ individual tests) and
an end-to-end suite run on every change. Both the development server and the production build are exercised, because
those two environments have diverged before in ways that only surfaced once the product was shipped.

Counts are deliberately given as round numbers with the command to check them, rather than as exact figures copied
from one run: `find src -name '*.test.ts' | wc -l` and `bun run test` are the sources of truth. This file has already
carried a stale count twice, and a reader who checks a number and finds it wrong stops trusting the ones they cannot
check.

---

*Copyright © ryasai. Proprietary software; see [LICENSE](./LICENSE).*
