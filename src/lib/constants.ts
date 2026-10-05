/**
 * Centralized constants — single source of truth for magic numbers.
 * Extracted from guardrails, rag, middleware, llm-client, notifications.
 */

// Guardrails
export const SQL_MAX_LIMIT = 100
// SQL error-correction loop: how many regeneration attempts (with the DB
// error fed back to the LLM) after a failed execution or guardrail rejection.
export const SQL_REPAIR_ATTEMPTS = 2
/**
 * Minimum wall-clock time that must REMAIN before the SQL repair loop starts another attempt.
 *
 * WHY THE LOOP NEEDS IT (verified-valid weakness, external review #4, in its narrow form). Each attempt is one
 * `generateSql` (LLM_TIMEOUT_MS = 30s) plus one `executeQuery` (query_timeout = 30s), so a full attempt is
 * ~60s of budget. The chat route's overall deadline is 120s, and the loop counted only ATTEMPTS — never
 * elapsed time — so attempt 3 could begin at t=100s with the turn already doomed: the route would time out
 * while the loop was still working, and the answer the user got was a timeout instead of the failure the
 * branch had already diagnosed. Every individual call IS bounded; what was missing is a check that the
 * TOTAL has not run out.
 *
 * The floor is one attempt's worst case (60s), rounded down to a round number: with less than that left,
 * starting an attempt that cannot finish helps nobody. It is checked BEFORE an attempt begins, never
 * mid-call — a started attempt runs to its own timeout, so there is nothing to cancel mid-flight.
 */
export const SQL_REPAIR_MIN_REMAINING_MS = () => Number(process.env.SQL_REPAIR_MIN_REMAINING_MS ?? 60_000)
/**
 * The total wall-clock the SQL repair loop may spend across ALL attempts, measured from the branch's start.
 *
 * Sits below the chat route's CHAT_OVERALL_DEADLINE_MS (120s) on purpose: the answer synthesis still needs
 * its own share after the loop ends, and a loop that consumed the full deadline would leave nothing for the
 * reply the user actually reads.
 */
/*
 * A FUNCTION, not a const, and that is for the TESTS: the value is env-overridable precisely so a test can
 * drive the budget boundary, but a module-level const binds the env ONCE at import — a test that sets the
 * variable after import then measures nothing (MEASURED: the budget test passed with the value unset,
 * because the const held the default and no retry was ever refused). Reading it per CHECK makes the
 * override observable, which is the only reason the override exists.
 */
export const SQL_REPAIR_TOTAL_BUDGET_MS = () => Number(process.env.SQL_REPAIR_TOTAL_BUDGET_MS ?? 100_000)

// RAG
export const RAG_CHUNK_SIZE = 1400
export const RAG_CHUNK_OVERLAP = 180
// Per-document cap in the final top-K, for source diversity. 2 was aggressive:
// at the default topK=4 a long document that fully answers the question could
// only contribute two chunks. 3 keeps multi-source answers without starving the
// single-document case.
export const RAG_MAX_PER_DOCUMENT = 3
export const RAG_CACHE_TTL_MS = 60_000
// A 2.7 MB reference book produces 1,029 chunks; the old 500 cap discarded its tail.
// The upload probes one extra chunk and rejects larger documents before persistence.
export const RAG_MAX_CHUNKS_PER_UPLOAD = 2_000

/**
 * Character budget for the memory block injected into prompts.
 *
 * Memory was the ONLY uncapped context-injection path: `recallContext` merges up to three
 * strategies (topK 5/5/10) with an unbounded `join('\n')`, and that string is interpolated
 * into as many as six prompts per turn (LLM router, SQL gen, REST gen, answer, chat, and
 * their streaming variants). A rich dataset could therefore crowd out the actual question.
 * Matches `buildSourceGuidance()`'s 2000-char default so the two context sources are
 * budgeted alike.
 */
export const MEMORY_CONTEXT_MAX_CHARS = 2000

/**
 * Cap on the text handed to cognee's WRITE path per chat turn.
 *
 * WHY THIS EXISTS. `rememberChatTurn` used to serialise the full user message and the full
 * assistant reply with no bound. Long answers are normal (a document-grounded RAG answer is
 * routinely several thousand characters), and the write path runs cognee's graph extraction
 * over whatever it is given.
 *
 * WHAT THIS IS NOT: a latency fix. I added it expecting one — reasoning from an isolation
 * showing the extraction call returns an empty string for a long schema-bearing prompt — and
 * then measured five consecutive writes: short 47.8s, long 92.1s, short 124.8s, long 41.0s,
 * short 168.3s. The LONG writes were faster. Payload size is not the driver (see
 * docs/cognee-http-migration.md for the table and the retry counters that agree).
 *
 * WHAT IT IS: a bound on what one turn contributes to a graph. A document-grounded answer is
 * routinely thousands of characters, and without a cap a single turn becomes an unbounded
 * extraction job on the write path. 4000 chars keeps a turn's substance — both messages plus
 * the tool summary — and truncation is MARKED, because stored memory is read back verbatim
 * into future prompts and a reader must be able to tell a clipped turn from a short one.
 */
export const MEMORY_WRITE_MAX_CHARS = 4000

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 60_000
export const RATE_LIMIT_DEFAULT = 60
// ponytail: env-overridable so batch/benchmark runs can lift the ceiling. This is a
// SECOND limiter, independent of CHAT_RATE_LIMIT_PER_MIN in llm-budget.ts: that one is
// per-ORGANIZATION and lives in the route handler; this one is per-IP in the middleware.
// So raising only the handler's limit does nothing for a batched run -- measured on an
// 800-question benchmark: CHAT_RATE_LIMIT_PER_MIN was raised and requests still came
// back HTTP 429 with EMPTY answers, because they never reached the handler. That run
// produced 196/200 "failures" that were pure throttling. Defaults to 30 (unchanged).
export const RATE_LIMIT_CHAT = Number(process.env.RATE_LIMIT_CHAT_PER_MIN ?? '') || 30
// Failed sign-in attempts, counted per NORMALIZED ACCOUNT and per CLIENT ADDRESS, never per request.
// Per request is what the middleware used to do, and it refused the 11th CORRECT password in a minute
// because it could not tell a guess from a sign-in (measured, see src/lib/login-throttle.ts).
export const RATE_LIMIT_LOGIN = 10
// The address axis is deliberately LOOSER than the account axis: an office behind one NAT address shares
// it, and the account axis is the tight brute-force bound. It still caps spraying across many accounts,
// which is the case the account axis cannot see.
export const RATE_LIMIT_LOGIN_PER_IP = 30
export const RATE_LIMIT_AGENT = 20
export const RATE_LIMIT_UPLOAD = 20

// LLM
// ponytail: LLM_TIMEOUT_MS is env-overridable because reasoning models changed
// the arithmetic. Measured against the 2026-09 eval gateway: "reply OK" took
// 2.1s standalone but 6.5s through the real transport, and a RAGAS judge prompt
// took 6.4s — so four concurrent judge calls blew the fixed 30s ceiling and
// every eval run died as `DOMException TimeoutError` with an empty stack, which
// reads as a harness bug rather than a too-tight timeout. A model that thinks
// for tens of seconds is now normal, so the ceiling must be tunable per
// deployment. The DEFAULT stays 30s: most providers are fast, and a long default
// would let one hung request hold a slot.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000)

/**
 * Output ceiling for the OpenAI-compatible path, per PURPOSE.
 *
 * MEASURED, and the reason this exists: the app sent no `max_tokens` at all, which
 * is fine for an ordinary chat model but unbounded for a REASONING model, because
 * those bill their thinking as completion tokens. Against `cbcn/hy4-preview`:
 *
 *   intent-analysis, prompt 273 tokens -> 6,386 completion tokens, 121,992 ms
 *   a one-word factual answer         ->   364 reasoning tokens,    8,034 ms
 *
 * The 273-token input was never the problem; the model simply generated thousands
 * of tokens of internal reasoning to emit a small JSON object. That single call
 * blew the 120 s chat deadline, so EVERY RAG question failed with a generic
 * "Stream timed out" while the documents were indexed and retrievable. The failure
 * looked like a retrieval bug and was a budget bug.
 *
 * Capping is effective, not cosmetic: the same request went from 24,869 ms with no
 * cap to 5,640 ms with `max_tokens: 200` (finish_reason `length`).
 *
 * The caps are per purpose because the purposes genuinely differ. Structured steps
 * (intent, routing, SQL, titles) emit a small object, so a tight ceiling costs
 * nothing and bounds the worst case. `chat` is user-facing prose and keeps a
 * generous ceiling so a real answer is never cut off mid-sentence; a truncated
 * answer is a worse failure than a slow one.
 *
 * Only applied to the OpenAI-compatible path. The Anthropic path has its own
 * MAX_TOKENS_ANTHROPIC, and the Responses API path has its own.
 */
export const LLM_MAX_TOKENS_BY_PURPOSE: Record<string, number> = {
  // Reasoning models bill their THINKING against this same budget, and they think
  // before they emit anything. A cap sized for the visible answer therefore
  // truncates the output to nothing: MEASURED, an intent prompt under
  // `max_tokens: 512` returned `finish_reason: "length"` with 512 completion
  // tokens and an EMPTY content, because every token went to reasoning. The caller
  // then failed to parse the JSON, retried, and stalled to the 120 s chat deadline.
  //
  // So the ceilings below are per-purpose HEADROOM, not answer sizes: structured
  // steps need room for thinking plus a small object. They are still far below the
  // thousands of tokens an uncapped reasoning model will happily generate, which is
  // what the cap exists to stop.
  // MEASURED reasoning-token spread for the SAME intent call, which is why these are
  // headroom rather than answer sizes: 142, 1,764 and 4,096 tokens across three runs.
  // At `max_tokens: 4096` one run hit the cap EXACTLY after 109 s and returned no
  // parseable output, while the 1,764-token run finished in 41 s with valid JSON.
  // The distribution is long-tailed, so a tight cap does not fail gracefully -- it
  // fails as unparseable JSON, which surfaces as a generic provider error.
  //
  // 16,384 is set well above every observed run so the cap stops a runaway model
  // without truncating a normal one. It is NOT a guarantee: a reasoning model with
  // an unusually long chain can still hit it, and the honest failure mode then is a
  // truncated JSON that the caller retries. The real bound on latency is
  // LLM_TIMEOUT_MS, not this.
  'intent-analysis': 16_384,
  router: 8192,
  'route-query': 8192,
  sql: 8192,
  'generate-sql': 8192,
  title: 4096,
  summary: 8192,
  reflection: 8192,
  // The ReAct orchestrator and the JSON planner both pass purpose 'agent'.
  // Without these entries their calls fell through to the 1024 default, which is
  // a structured-step ceiling — too small for a turn that must reason AND emit
  // tool calls, and the reason an agent round could truncate mid-call.
  agent: 8192,
  planner: 8192,
  chat: Number(process.env.LLM_MAX_TOKENS_CHAT ?? 8192),
  // The retrieval and graph purposes fell through to the old 1024 default. MEASURED on the 2026-10-04 live eval
  // (reasoning model, LlmUsageLog): `kg-extract` stopped at the cap on 3,665 of 3,823 calls, `rag-rerank` on 1,102
  // of 1,504 and `synthesis` on 297 of 757. A capped reasoning call returns EMPTY content, so the reranker silently
  // fell back to fused order after four attempts (logged "EMPTY completion" 51 times in ~180 questions), graph
  // extraction stored nothing, and multi-step answers came back blank. A direct probe of the production rerank
  // prompt with 24 candidates: 1 of 6 empty at 1024, 0 of 6 at 8192, longest run 1,776 tokens.
  'rag-rerank': 8192,
  'kg-extract': 8192,
  synthesis: 8192,
  'schema-description': 8192,
  'confidence-evaluation': 4096,
  'query-rewrite': 4096,
  'contextual-retrieval': 4096,
  'source-init': 4096,
  'alignment-check': 4096,
  // A short JSON list, but from the same reasoning model: headroom, not answer size (see above).
  'rag-decompose': 8192,
}

/**
 * The default for a purpose with no entry. It was 1024, sized for a small JSON answer, and every purpose added later
 * without an entry inherited a cap a reasoning model can spend entirely on thinking (see the measurement above). 4096
 * is still a bound — it stops a runaway model — but no longer the failure mode of an unlisted purpose.
 */
export const LLM_DEFAULT_MAX_TOKENS = 4096

/** The ceiling for a purpose, falling back to `LLM_DEFAULT_MAX_TOKENS`. */
export function maxTokensForPurpose(purpose: string): number {
  return LLM_MAX_TOKENS_BY_PURPOSE[purpose] ?? LLM_DEFAULT_MAX_TOKENS
}
export const LLM_STREAM_TIMEOUT_MS = 120_000
export const LLM_MAX_RETRIES = 3
// ponytail: LLM_RETRY_BACKOFF_BASE_MS is env-overridable because the retry ladder is
// WALL CLOCK THE HARNESS PAYS AND PRODUCTION DOES NOT. Exhausting it sleeps
// (1+2+4) x base = 3500 ms at the default, and MEASURED, 11 tests in
// `src/lib/ai.test.ts` wait it out in full (3501-3523 ms each, 38.66 s of that
// file's 38.84 s), which made the whole suite's wall time 39.99 s -- one file's
// timer, not a parallel-work limit: raising the runner's concurrency 8 -> 16 -> 32
// moved the total by under 0.8 s. The two runners now inject a small base into the
// child environment so a unit run measures assertions rather than patience.
//
// The DEFAULT STAYS 500. It is the production retry policy -- it spaces retries so a
// struggling provider is not hammered -- and no test asserts the DURATION (the
// assertions are attempt COUNTS, e.g. `toHaveBeenCalledTimes(3)`), so shortening it
// for a test run is assertion-neutral while shortening it by default would change
// every install's timing.
export const LLM_RETRY_BACKOFF_BASE_MS = Number(process.env.LLM_RETRY_BACKOFF_BASE_MS ?? 500)

// Session
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000
// Bounded tolerance for distributed session issuance and activity clocks.
export const SESSION_CLOCK_SKEW_MS = 5_000

// Notifications
export const NOTIFICATION_MAX_RETRIES = 3
export const NOTIFICATION_BACKOFF_BASE_MS = 2000
export const NOTIFICATION_TIMEOUT_MS = 15_000

/**
 * THE embedding dimension for this product, in one place.
 *
 * WHY 384 AND NOT A CONFIGURED CHOICE: it is what the shipped stack actually produces and stores. `pgvector`'s
 * column is `vector(384)` in `prisma/schema.prisma`, the packaged embedding model
 * (`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, served by the `local-embeddings` sidecar) returns
 * 384 values, and both the development and production databases hold 384-dimensional rows. A different number in the
 * APPLICATION was therefore never a setting — it was a disagreement with the data.
 *
 * MEASURED CONSEQUENCE of that disagreement: retrieval only compares a chunk whose `embeddingModel` matches the
 * query's, so the default 1536 produced `semanticSimilarity: 0` on every result while search silently fell back to
 * lexical-only. The failure was invisible because nothing errored; the vector store panel even displayed "1536"
 * beside 384-dimensional data.
 *
 * So this is the source of truth for the dimension, and a deployment that genuinely runs a different embedder must
 * change BOTH this and the schema's `vector(N)` — they are one fact, not two settings. `DEFAULT_VECTOR_SIZE` in
 * `vector-stores.ts` and the provider presets both read from here rather than repeating a literal.
 */
export const EMBEDDING_DIMENSIONS = 384

/**
 * The packaged embedding model's identifier.
 *
 * Kept beside the dimension because the two are a pair: retrieval refuses to compare vectors produced by different
 * models, so a deployment that changes one must change the other, and `local-embeddings` is what serves both.
 */
export const DEFAULT_EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
