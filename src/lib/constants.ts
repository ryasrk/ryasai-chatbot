/**
 * Centralized constants — single source of truth for magic numbers.
 * Extracted from guardrails, rag, middleware, llm-client, notifications.
 */

// Guardrails
export const SQL_MAX_LIMIT = 100
// SQL error-correction loop: how many regeneration attempts (with the DB
// error fed back to the LLM) after a failed execution or guardrail rejection.
export const SQL_REPAIR_ATTEMPTS = 2

// RAG
export const RAG_CHUNK_SIZE = 1400
export const RAG_CHUNK_OVERLAP = 180
// Per-document cap in the final top-K, for source diversity. 2 was aggressive:
// at the default topK=4 a long document that fully answers the question could
// only contribute two chunks. 3 keeps multi-source answers without starving the
// single-document case.
export const RAG_MAX_PER_DOCUMENT = 3
export const RAG_CACHE_TTL_MS = 60_000
export const RAG_MAX_CHUNKS_PER_UPLOAD = 500

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
export const RATE_LIMIT_LOGIN = 10
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
}

/** The ceiling for a purpose, falling back to the structured-step default. */
export function maxTokensForPurpose(purpose: string): number {
  return LLM_MAX_TOKENS_BY_PURPOSE[purpose] ?? 1024
}
export const LLM_STREAM_TIMEOUT_MS = 120_000
export const LLM_MAX_RETRIES = 3
export const LLM_RETRY_BACKOFF_BASE_MS = 500

// Session
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

// Notifications
export const NOTIFICATION_MAX_RETRIES = 3
export const NOTIFICATION_BACKOFF_BASE_MS = 2000
export const NOTIFICATION_TIMEOUT_MS = 15_000
