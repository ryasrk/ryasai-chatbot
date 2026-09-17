/**
 * LLM client — shared transport utilities: usage logging, SSE parser, retry fetch.
 * Depends on: llm-client-types, external (observability, db, constants, llm-config).
 */
import type { LlmMessage, LlmUsage } from './llm-client-types'
import type { LlmRuntimeConfig } from '@/lib/llm-config'
import { traceLlmCall } from '@/lib/observability'
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { logSwallowed } from '@/lib/logger'
import {
  LLM_MAX_RETRIES,
  LLM_RETRY_BACKOFF_BASE_MS,
  LLM_TIMEOUT_MS,
} from '@/lib/constants'

function previewMessages(messages: LlmMessage[]): string {
  const m = messages[0]
  if (!m || m.content === null) return ''
  if (typeof m.content === 'string') return m.content.slice(0, 500)
  if (Array.isArray(m.content)) {
    const text = m.content.find((p) => p.type === 'text')
    return text ? text.text.slice(0, 500) : ''
  }
  return ''
}

interface TraceCtx {
  messages?: LlmMessage[]
  responsePreview?: string
  toolCalls?: Array<{ name: string; arguments: string }>
  error?: string
}

export function logLlmUsage(
  purpose: string,
  cfg: LlmRuntimeConfig,
  usage: LlmUsage | null,
  latencyMs?: number,
  traceCtx?: TraceCtx,
): void {
  traceLlmCall({
    purpose,
    provider: cfg.provider ?? 'OPENAI_COMPATIBLE',
    model: cfg.model,
    inputPreview: traceCtx?.messages ? previewMessages(traceCtx.messages) : '',
    outputPreview: traceCtx?.responsePreview ?? '',
    toolCalls: traceCtx?.toolCalls,
    usage: usage ?? undefined,
    latencyMs: latencyMs ?? 0,
    error: traceCtx?.error,
  })
  if (!usage || (usage.totalTokens === 0 && usage.promptTokens === 0)) return
  if (!db.llmUsageLog) return
  const provider = cfg.provider ?? 'OPENAI_COMPATIBLE'
  db.llmUsageLog
    .create({
      data: {
        organizationId: getOrgContext()!,
        purpose,
        provider,
        model: cfg.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        latencyMs: latencyMs ?? null,
      },
    })
    .catch(logSwallowed('llm-client: llmUsageLog.create'))
}

// ---------------------------------------------------------------------------
// Wire-format adapter: internal LlmMessage[] -> OpenAI's chat-completions shape.
// ---------------------------------------------------------------------------

/**
 * Re-shape an assistant message's `tool_calls` into the wire format.
 *
 * WHY THIS EXISTS (MEASURED, not theoretical). Our internal `LlmToolCall` is
 * `{ id, name, arguments }`, but the OpenAI spec — and every gateway that
 * validates against it — requires
 * `{ id, type: "function", function: { name, arguments } }`. Sending the flat
 * shape does not produce a clean 400: MEASURED against 9router with a
 * two-round tool conversation, the gateway answered `text/event-stream` with a
 * single `data: [DONE]` frame instead of JSON. `readCompletionBody` then found
 * no content-bearing chunk and rethrew `SyntaxError: Unexpected identifier
 * "data"`.
 *
 * The practical effect was that a ReAct loop could complete round 1 (a tool
 * request) but NEVER round 2 — the moment the assistant's tool_calls had to go
 * back on the wire, every subsequent call threw. A single-round tool call
 * looked fine, which is exactly why the unit tests (LLM mocked) never saw it.
 *
 * Verified both directions: with `type: "function"` present the same body
 * returns `application/json`; without it, `text/event-stream`.
 */
export function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (!m.tool_calls || m.tool_calls.length === 0) {
      return m as unknown as Record<string, unknown>
    }
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// SSE parser — splits a byte stream into raw `data:` payload strings.
// Handles both ReadableStream<Uint8Array> (fetch body) and AsyncIterable<Uint8Array>.
// ---------------------------------------------------------------------------

export async function* iterSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  const reader = 'getReader' in body ? body.getReader() : null
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6)
            if (data === '[DONE]') return
            yield data
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  } else {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6)
          if (data === '[DONE]') return
          yield data
        }
      }
    }
  }

  // flush decoder + process any remaining partial line
  buffer += decoder.decode()
  const tail = buffer.trim()

  // ponytail: NON-STREAM FALLBACK. A server that ignores `stream:true` and
  // answers with a plain JSON body produces ZERO `data:` lines — the caller
  // then yields no tokens and the user gets a silent EMPTY answer. That is
  // exactly what the e2e mock did (and any minimal OpenAI-compatible proxy
  // can). If nothing was yielded and the tail parses as JSON, yield it whole
  // so the standard chunk-parser handles it like a single completion.
  if (tail && !tail.startsWith('data: ')) {
    try {
      JSON.parse(tail)
      yield tail
      return
    } catch {
      // not JSON either — fall through to the plain-tail branch below
    }
  }
  if (tail.startsWith('data: ')) {
    const data = tail.slice(6)
    if (data && data !== '[DONE]') yield data
  }
}

// ---------------------------------------------------------------------------
// Fetch with retry on 5xx + network errors.
// ---------------------------------------------------------------------------

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      // A hung provider socket would otherwise block the whole retry ladder: without a
      // signal the request can sit open indefinitely and the backoff never runs. The
      // timeout is per ATTEMPT, so the total worst case is
      // (LLM_MAX_RETRIES + 1) * LLM_TIMEOUT_MS plus the backoff delays.
      const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS) })
      if (res.status >= 500 && attempt < LLM_MAX_RETRIES) {
        lastError = new Error(`LLM error (HTTP ${res.status}).`)
        await new Promise((r) => setTimeout(r, LLM_RETRY_BACKOFF_BASE_MS * 2 ** attempt))
        continue
      }
      return res
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < LLM_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, LLM_RETRY_BACKOFF_BASE_MS * 2 ** attempt))
        continue
      }
    }
  }
  throw lastError ?? new Error('LLM fetch failed.')
}

export function readErrorBody(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

/**
 * Read a chat-completion body even when the provider answered with an SSE stream
 * despite `stream` not being requested.
 *
 * This is not a hypothetical. OpenAI-compatible gateways routinely ignore the
 * `stream` field, or default it ON, and reply with `text/event-stream` to a plain
 * request. MEASURED against 9router: a POST with NO `stream` key at all comes back
 * as `data: {...}\n\ndata: {...}`. The old code called `res.json()` on that body and
 * threw `SyntaxError: Unexpected token 'd', "data: {"id"... is not valid JSON`,
 * which surfaced to the user as a generic "Something went wrong while generating a
 * response" and made every call to such a gateway fail.
 *
 * Strategy, in order:
 *   1. a real JSON body -> return it (the normal case, unchanged);
 *   2. otherwise, if the text looks like SSE, take the LAST chunk that carries
 *      content, because a streamed completion's final content-bearing chunk is the
 *      completed message for the non-streaming view of the same call;
 *   3. otherwise rethrow the original parse error, so a genuinely malformed body
 *      still fails loudly rather than being silently coerced.
 *
 * The body is read as TEXT once and then parsed: `res.json()` would consume the
 * stream, and calling it after `res.text()` throws `Body already used`.
 */
export async function readCompletionBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (parseError) {
    const chunks: Array<Record<string, unknown>> = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const payload = trimmed.slice(6)
      if (payload === '[DONE]') continue
      try { chunks.push(JSON.parse(payload) as Record<string, unknown>) } catch { /* skip malformed line */ }
    }
    if (chunks.length === 0) throw parseError
    // CONCATENATE every content-bearing chunk. Returning only the last one was wrong:
    // a streamed reply is delivered in FRAGMENTS, so keeping the final content chunk
    // yields a TRUNCATED tail, not the message. MEASURED after fixing the
    // message-vs-delta field mismatch: a 66-character reply came back as the final
    // fragment ``daftar memerlukan query agregasi data terstruktur dari database."}``,
    // which parsed as neither JSON nor a usable answer. Joining the fragments rebuilds
    // the complete message.
    const pieces: string[] = []
    let lastChunk: Record<string, unknown> | null = null
    let sawContent = false
    // Tool calls arrive in FRAGMENTS too, on `delta.tool_calls`, and a tool-call
    // reply carries NO content at all. MEASURED: against a Gemini model on this
    // gateway the body was SSE with the call split across deltas —
    //   delta.tool_calls[0].function.name/arguments
    // — and the old code collected only `content`, so `tool_calls` came back
    // `undefined` while `finish_reason` still said "tool_calls". The model was
    // calling correctly and we were discarding it, then reporting "no tool needed".
    // Only reproduced on a STREAMING provider: a non-streamed JSON body (the
    // default provider here) keeps tool_calls intact through JSON.parse, so the
    // defect stayed invisible.
    const toolCallParts = new Map<number, { id?: string; type?: string; name?: string; args: string }>()
    for (const c of chunks) {
      const choice = (c.choices as Array<{ delta?: { content?: unknown; tool_calls?: unknown }; message?: { content?: unknown; tool_calls?: unknown } }> | undefined)?.[0]
      const deltaToolCalls = (choice?.delta as { tool_calls?: unknown } | undefined)?.tool_calls
      const messageToolCalls = (choice?.message as { tool_calls?: unknown } | undefined)?.tool_calls
      for (const list of [deltaToolCalls, messageToolCalls]) {
        if (!Array.isArray(list)) continue
        for (const raw of list) {
          const tc = raw as { id?: string; index?: number; type?: string; function?: { name?: string; arguments?: string } }
          // `index` is the join key the OpenAI streaming format mandates; falling
          // back to 0 keeps providers that omit it working for the single-call case.
          const key = typeof tc.index === 'number' ? tc.index : 0
          const prev = toolCallParts.get(key) ?? { args: '' }
          // `arguments` is a PARTIAL json string, so it is appended, never replaced.
          if (typeof tc.function?.arguments === 'string') prev.args += tc.function.arguments
          if (tc.id) prev.id = tc.id
          if (tc.type) prev.type = tc.type
          if (tc.function?.name) prev.name = tc.function.name
          toolCallParts.set(key, prev)
        }
      }
      const delta = choice?.delta?.content
      const message = choice?.message?.content
      // `message.content` on a NON-streamed body is the whole answer, so it wins over
      // any accumulated fragments and must not be concatenated with them.
      if (typeof message === 'string') {
        pieces.length = 0
        pieces.push(message)
        sawContent = true
        lastChunk = c
        break
      }
      if (typeof delta === 'string') {
        pieces.push(delta)
        sawContent = true
        lastChunk = c
      }
    }
    if (!sawContent) {
      // No content, but a complete tool call is the WHOLE point of the response.
      // Returning the trailing metadata chunk instead was the defect: it carries
      // `delta: {}` and a finish_reason, so every caller saw an empty reply.
      if (toolCallParts.size > 0) {
        const tail = (chunks[chunks.length - 1] ?? {}) as Record<string, unknown>
        const tailChoices = (tail.choices as Array<Record<string, unknown>> | undefined) ?? [{}]
        return {
          ...tail,
          choices: [{
            ...tailChoices[0],
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [...toolCallParts.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([index, tc]) => ({
                  id: tc.id ?? `call_${index}`,
                  type: tc.type ?? 'function',
                  function: { name: tc.name ?? '', arguments: tc.args },
                })),
            },
          }],
        }
      }
      return chunks[chunks.length - 1]
    }
    // Rebuild a body shaped like a non-streamed reply so every caller reads one shape:
    // `choices[0].message.content` holds the joined text, and the trailing metadata of
    // the last chunk (usage, finish_reason, model) is preserved.
    // Metadata comes from the LAST chunk seen, not the last CONTENT chunk: a streamed
    // reply puts `usage` and the terminal `finish_reason` on a trailer that carries no
    // text. Using the last content chunk instead silently dropped BOTH, which would
    // zero out token accounting -- `chatOnce` reads `data.usage` for promptTokens and
    // completionTokens. Verified by test rather than assumed.
    const base = (chunks[chunks.length - 1] ?? lastChunk) as Record<string, unknown>
    const baseChoices = (base.choices as Array<Record<string, unknown>> | undefined) ?? [{}]
    const contentChoice = (lastChunk?.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}
    return {
      ...base,
      choices: [
        {
          ...baseChoices[0],
          ...contentChoice,
          message: { content: pieces.join('') },
        },
      ],
    }
  }
}

/**
 * Strip credential-shaped substrings out of an upstream provider body before it goes into an Error
 * message. The message is NOT user-facing (the typed error deliberately carries only a category +
 * hint), but it IS persisted: `logLlmUsage` stores `e.message` in `LlmUsageLog`, the observability
 * ring buffer keeps it for `GET /api/traces`, and `ApiLog.errorMessage` keeps it too. A BYOK provider
 * frequently echoes the submitted key in a 401 body, so an unredacted message puts the CUSTOMER's
 * secret into a trace buffer, a log line, and any bug report or OTel export that carries them.
 *
 * Pattern-based rather than value-based on purpose: the raw body arrives BEFORE we know which key was
 * used, so there is nothing to compare against. Known provider key shapes are matched, plus any
 * `sk-`/`key-` style token and any `Authorization: Bearer <token>` echo.
 */
export function redactProviderBody(body: string): string {
  return body
    .replace(/\b(sk|pk|rk|api|key|token)-[A-Za-z0-9_\-]{8,}/gi, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_SECRET]')
}

/**
 * Why a BYOK provider call failed, from the CUSTOMER's point of view.
 *
 * ryasai is bring-your-own-key: the credential we send belongs to the customer,
 * so a 401/402/404 is never an operator misconfiguration — it is something the
 * CUSTOMER must fix in their own provider account. We cannot fix it for them,
 * so the only useful thing we can do is say precisely what is wrong.
 *
 * Classified because the raw body must NOT reach the browser (it can echo the
 * key prefix and provider internals), yet the CATEGORY is exactly what the user
 * needs. Previously every one of these collapsed into a single status and the
 * user was told their provider was "not configured" — actively misleading when
 * the URL and model are already correct and only the key is dead.
 */
/**
 * An Error that carries the classified provider failure, so callers can show
 * the user actionable guidance WITHOUT receiving the raw provider body.
 * `message` is unchanged in shape (`LLM error (HTTP 401): ...`) because existing
 * code and tests match on that prefix — the classification rides alongside it
 * rather than replacing it.
 */
export class LlmProviderError extends Error {
  readonly status: number
  readonly failure: ProviderFailure
  constructor(status: number, body: string, stream = false) {
    const { failure } = { failure: classifyProviderFailure(status, body) }
    // Redact BEFORE the slice: a key that straddles the 200-char boundary would otherwise leave a
    // fragment behind, and the classification above already ran on the raw body where it is useful.
    super(`LLM ${stream ? 'stream ' : ''}error (HTTP ${status}): ${redactProviderBody(body).slice(0, 200)}`)
    this.name = 'LlmProviderError'
    this.status = status
    this.failure = failure
  }
}

export type ProviderFailureKind =
  | 'auth'          // key rejected/revoked/typo'd      -> check the key
  | 'quota'         // out of credit / rate limited     -> top up or wait
  | 'model_missing' // model id does not exist here     -> pick another model
  | 'model_unsupported' // model exists but rejects our request shape (tools/vision)
  | 'unreachable'   // network/DNS/TLS/timeout          -> check the base URL
  | 'unknown'

export interface ProviderFailure {
  kind: ProviderFailureKind
  hint: string
}

export function classifyProviderFailure(status: number | null, body: string): ProviderFailure {
  // Provider error strings are not standardised, so match on both the HTTP
  // status and the well-known machine codes OpenAI-compatible providers emit.
  const text = body.toLowerCase()

  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key|authentication|unauthorized|api key/.test(text)) {
    return {
      kind: 'auth',
      hint: 'Your AI provider rejected the API key. Re-enter it in Settings > AI Configuration — it may be revoked, expired, or pasted with a trailing space.',
    }
  }
  if (status === 402 || /insufficient_quota|insufficient credits|exceeded your current quota|billing|payment required|out of credit/.test(text)) {
    return {
      kind: 'quota',
      hint: 'Your AI provider account is out of credit or over its quota. Add credit with your provider — this is billed by them, not by us.',
    }
  }
  if (status === 429 || /rate_limit|too many requests/.test(text)) {
    return {
      kind: 'quota',
      hint: 'Your AI provider is rate-limiting this key. Wait a moment, or raise the limit on your provider account.',
    }
  }
  if (/does not exist|not found|unknown model|invalid model|no such model/.test(text) || (status === 404 && /model/.test(text))) {
    return {
      kind: 'model_missing',
      hint: 'Your AI provider does not offer the configured model. Pick a model your provider actually serves in Settings > AI Configuration.',
    }
  }
  if (/does not support|unsupported|not supported/.test(text)) {
    return {
      kind: 'model_unsupported',
      hint: 'The configured model does not support the feature being used (for example tool calling). Choose a more capable model in Settings > AI Configuration.',
    }
  }
  if (status === null || /econnrefused|enotfound|fetch failed|network|timed? ?out|abort/.test(text)) {
    return {
      kind: 'unreachable',
      hint: 'Could not reach your AI provider. Check the base URL in Settings > AI Configuration and that the host is reachable from this server.',
    }
  }
  return { kind: 'unknown', hint: 'Your AI provider returned an unexpected error. Check your provider dashboard for details.' }
}
