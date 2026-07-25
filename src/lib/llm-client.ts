/**
 * Unified LLM transport — OpenAI-compatible + Anthropic native.
 * Shared by user-facing chat (ai.ts) and agent (agent-llm.ts).
 * No business logic here; only the transport layer.
 */
import { getLlmRuntimeConfig, getAgentLlmConfig, type LlmRuntimeConfig } from '@/lib/llm-config'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const MAX_TOKENS_ANTHROPIC = 4096
const LLM_TIMEOUT_MS = 60000
const STREAM_TIMEOUT_MS = 120000
const MAX_RETRIES = 1
const RETRY_BACKOFF_MS = 1000

// ---------------------------------------------------------------------------
// SSE parser — splits a byte stream into raw `data:` payload strings.
// Handles both ReadableStream<Uint8Array> (fetch body) and AsyncIterable<Uint8Array>.
// ---------------------------------------------------------------------------

async function* iterSseStream(
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
  if (tail.startsWith('data: ')) {
    const data = tail.slice(6)
    if (data && data !== '[DONE]') yield data
  }
}

// ---------------------------------------------------------------------------
// Anthropic request builder — concatenates ALL system messages.
// (Fixes the bug where only the first system message was kept, dropping
// memory context, chat history, and prompt prefixes on Anthropic.)
// ---------------------------------------------------------------------------

function buildAnthropicBody(
  messages: LlmMessage[],
  temperature: number,
  stream: boolean = false,
): Record<string, unknown> {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const body: Record<string, unknown> = {
    max_tokens: MAX_TOKENS_ANTHROPIC,
    temperature,
    messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
  }
  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n')
  }
  if (stream) body.stream = true
  return body
}

// ---------------------------------------------------------------------------
// Fetch with retry on 5xx + network errors.
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        lastError = new Error(`LLM error (HTTP ${res.status}).`)
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      return res
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
    }
  }
  throw lastError ?? new Error('LLM fetch failed.')
}

function readErrorBody(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

// ---------------------------------------------------------------------------
// Public transport: chatOnce + chatStream
// ---------------------------------------------------------------------------

/** Non-streaming completion. Returns trimmed content. */
export async function chatOnce(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number = 0,
): Promise<string> {
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE') {
    const body = buildAnthropicBody(messages, temperature)
    body.model = cfg.model
    const res = await fetchWithRetry(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
    if (!res.ok) {
      const errText = await readErrorBody(res)
      throw new Error(`LLM error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    return text.trim()
  }

  // OpenAI-compatible — no max_tokens, let provider default apply
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature }
  const res = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const errText = await readErrorBody(res)
    throw new Error(`LLM error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

/** Streaming completion. Yields token strings. */
export async function* chatStream(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number = 0,
): AsyncGenerator<string, void, unknown> {
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE') {
    const body = buildAnthropicBody(messages, temperature, true)
    body.model = cfg.model
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    })
    if (!res.ok || !res.body) {
      const errText = await readErrorBody(res)
      throw new Error(`LLM stream error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
    }
    for await (const chunk of iterSseStream(res.body)) {
      try {
        const parsed = JSON.parse(chunk) as {
          type?: string
          delta?: { type?: string; text?: string }
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield parsed.delta.text
        }
      } catch { /* skip malformed */ }
    }
    return
  }

  // OpenAI-compatible
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature, stream: true }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) {
    const errText = await readErrorBody(res)
    throw new Error(`LLM stream error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
  }
  for await (const chunk of iterSseStream(res.body)) {
    try {
      const parsed = JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: string } }> }
      const token = parsed.choices?.[0]?.delta?.content
      if (token) yield token
    } catch { /* skip malformed */ }
  }
}

// ---------------------------------------------------------------------------
// Config helpers — single entry point for transport consumers.
// ---------------------------------------------------------------------------

/** Get the user-facing chat LLM config (purpose='chat', falls back to any). */
export async function getChatConfig(): Promise<LlmRuntimeConfig | null> {
  return getLlmRuntimeConfig()
}

/** Get the agent LLM config (purpose='agent', falls back to chat). */
export async function getAgentConfig(): Promise<LlmRuntimeConfig | null> {
  return getAgentLlmConfig()
}
