/**
 * LLM client — shared transport utilities: usage logging, SSE parser, retry fetch.
 * Depends on: llm-client-types, external (observability, db, constants, llm-config).
 */
import type { LlmMessage, LlmUsage } from './llm-client-types'
import type { LlmRuntimeConfig } from '@/lib/llm-config'
import { traceLlmCall } from '@/lib/observability'
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import {
  LLM_MAX_RETRIES,
  LLM_RETRY_BACKOFF_BASE_MS,
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
    .catch(() => {})
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
      const res = await fetch(url, init)
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
