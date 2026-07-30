# Glossary

## Retrieval & RAG

- **RAG (Retrieval-Augmented Generation)** — Pattern where an LLM answer is grounded in retrieved documents, reducing hallucinations by providing source context.
- **GraphRAG** — Retrieval that traverses an entity-relation knowledge graph to answer multi-hop questions ("who reports to the person who approved SOP-42?").
- **Hybrid RAG** — Combining multiple retrieval signals (lexical + semantic + FTS + vector + graph) for better recall than any single method.
- **FTS (Full-Text Search)** — Keyword-based search using inverted indexes (FTS5 in SQLite, tsvector in Postgres). Catches exact matches that semantic search misses.
- **pgvector** — PostgreSQL extension for storing and searching vector embeddings. Enables semantic similarity search inside the relational database.
- **Contextual Retrieval** — Prepending an LLM-generated document summary to each chunk before embedding, giving chunks document-level context. Reduces retrieval failures by ~49%.
- **HyDE (Hypothetical Document Embedding)** — Generating a hypothetical answer to a query, then embedding that answer (not the query) for retrieval. Improves semantic match quality.
- **Parent-document chunking** — Splitting documents into small chunks for retrieval but returning the surrounding larger "parent" chunk for context.

## Agentic & Planning

- **Agentic loop** — Iterative pattern: route → execute → evaluate → repeat, where the LLM decides the next step based on intermediate results.
- **Confidence-gated** — Stopping the agentic loop when an LLM confidence evaluator scores the answer above a threshold (max 3 iterations as a hard bound).
- **DAG planner** — Multi-step execution planner that builds a Directed Acyclic Graph of tool steps with dependencies, then executes parallelizable steps concurrently.
- **Reflexion** — Self-correction pattern where the agent reflects on a failed step, generates a critique, and retries with the feedback incorporated.

## Security

- **SQL AST guardrails** — Validating generated SQL by parsing it into an Abstract Syntax Tree and enforcing structural rules (SELECT-only, LIMIT cap, mutation block). Bypass-resistant vs regex filtering.
- **Fail-closed auth** — Rejecting requests on any authentication error or missing config, rather than letting users through (fail-open). Default posture: deny unless explicitly allowed.
- **SSRF blocklist** — Blocking outbound requests to internal IP ranges (RFC1918, 169.254.x.x link-local, CGNAT 100.64/10, ULA fc00::/7) to prevent Server-Side Request Forgery.
- **AES-256-GCM** — Authenticated encryption standard (256-bit key, Galois/Counter Mode). Encrypts data and provides an integrity tag to detect tampering. Used for all stored credentials.
- **Session version** — Counter on the User model incremented on re-login; old session cookies with a stale version are rejected (session fixation defense).
- **HMAC (Hash-based Message Authentication Code)** — Cryptographic signature proving a message was not tampered with and originated from someone with the shared secret. Used for webhook verification and session tokens.

## Identity & Access

- **RBAC (Role-Based Access Control)** — Permission model where users are assigned roles (admin/analyst/viewer) and access is granted based on role, not individual identity.
- **OIDC (OpenID Connect)** — Identity layer on top of OAuth 2.0 that provides authentication (who the user is) via ID tokens. Used for enterprise SSO.
- **SSO (Single Sign-On)** — Logging in once to an identity provider and accessing multiple applications without re-authenticating. Implemented via OIDC.

## AI Infrastructure & Eval

- **Cognee** — Memory + knowledge graph framework. Provides chat-turn remember/recall and entity-relation extraction (cognify) for GraphRAG.
- **LightRAG** — Dual-level retrieval framework (local chunk-level + global entity-level) that inspires the GraphRAG implementation.
- **RAGAS** — Automated RAG evaluation framework measuring faithfulness, answer relevancy, and context precision/recall.
- **DeepEval** — LLM evaluation framework with CI integration for regression-testing RAG pipelines against quality thresholds.
- **Langfuse** — Open-source LLM observability platform for tracing, cost tracking, and evaluation scoring.

## Integrations & Protocols

- **MCP (Model Context Protocol)** — Standardized protocol for connecting LLMs to external tool servers. Supports stdio, SSE, and HTTP transports.
- **Plugin** — Registered external tool (webhook-based) with a Zod-validated manifest. Executed by the plugin-registry when the router selects it.
- **Webhook** — HTTP callback mechanism. Incoming: external systems trigger queries via signed POST. Outgoing: the assistant sends notifications (webhook/email/Telegram) on scheduled run completion.

## Pipeline Components

- **Intent analyzer** — LLM call that decides whether retrieval is needed, whether clarification is needed, and which tool category to route to.
- **Query rewriter** — Rewrites follow-up questions into standalone queries using conversation history ("what about last quarter?" → "Show Q3 revenue").
- **Smart router** — Self-adjusting load balancer that picks the best integration for a SQL query based on schema match, performance, latency, and circuit breaker state.
- **Semantic scoring** — Combining keyword overlap (40%) and embedding similarity (60%) to rank retrieval candidates.

## Cost & Safety Controls

- **Token budget** — Hard limit on total LLM tokens consumed during an agentic run, preventing cost amplification from runaway loops.
- **Constrained output** — Forcing LLM responses to match a schema (JSON/Zod) with automatic retry on parse failure.
- **Alignment check** — Optional safety layer that evaluates whether an agentic action is safe before execution (HTTP or LLM-based, configurable via env).
