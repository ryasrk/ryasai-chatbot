/**
 * Unified LLM transport — OpenAI-compatible + Anthropic native.
 * Shared by user-facing chat (ai.ts) and agent wrappers (below).
 * No business logic here; only the transport layer.
 *
 * Split files:
 *   - llm-client-types.ts     — shared types and interfaces (leaf)
 *   - llm-client-utils.ts     — usage logging, SSE parser, retry fetch
 *   - llm-client-anthropic.ts — Anthropic-native request builder
 *   - llm-client-openai.ts    — OpenAI Responses API (multi-agent loop)
 */
import type { LlmMessage, LlmToolDef, LlmResponseFormat, LlmToolCall, LlmUsage, AgentChatMessage } from './llm-client-types'
import type { LlmRuntimeConfig } from '@/lib/llm-config'
import { getLlmRuntimeConfig, getAgentLlmConfig } from '@/lib/llm-config'
import { logLlmUsage, iterSseStream, fetchWithRetry, readErrorBody, readCompletionBody, LlmProviderError } from './llm-client-utils'

// Single construction point for provider failures so every transport throws the
// same classified error shape.
function providerError(status: number, body: string, stream?: 'stream'): LlmProviderError {
  return new LlmProviderError(status, body, stream === 'stream')
}
import { buildAnthropicBody } from './llm-client-anthropic'
import {
  LLM_TIMEOUT_MS,
  LLM_STREAM_TIMEOUT_MS,
  maxTokensForPurpose,
} from '@/lib/constants'

export * from './llm-client-types'
export * from './llm-client-openai'

// ---------------------------------------------------------------------------
// Usage tracking — AsyncLocalStorage for per-request isolation.
// ponytail: avoids changing chatOnce return type (string | LlmToolCall[]) which
// would break 15+ callers. getLastLlmUsage() returns the usage from the current
// async context, or undefined if no call was made.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks'

const _usageStorage = new AsyncLocalStorage<{ promptTokens: number; completionTokens: number } | undefined>()

export function getLastLlmUsage(): { promptTokens: number; completionTokens: number } | undefined {
  return _usageStorage.getStore()
}

/** Run fn in an isolated usage context. Returns fn's result. */
export function withUsageTracking<T>(fn: () => Promise<T>): Promise<T> {
  return _usageStorage.run(undefined, fn)
}

// ---------------------------------------------------------------------------
// Public transport: chatOnce + chatStream
// ---------------------------------------------------------------------------

/** Non-streaming completion. Returns trimmed content, or tool_calls when tools are provided. */
export async function chatOnce(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature?: number,
  purpose?: string,
): Promise<string>
export async function chatOnce(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number | undefined,
  purpose: string | undefined,
  tools: LlmToolDef[],
  responseFormat?: LlmResponseFormat,
): Promise<string | LlmToolCall[]>
export async function chatOnce(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number | undefined,
  purpose: string | undefined,
  tools: undefined,
  responseFormat: LlmResponseFormat,
): Promise<string>
export async function chatOnce(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number = 0,
  purpose: string = 'chat',
  tools?: LlmToolDef[],
  responseFormat?: LlmResponseFormat,
): Promise<string | LlmToolCall[]> {
  const t0 = Date.now()
  try {
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE') {
    const body = buildAnthropicBody(messages, temperature, false, tools, responseFormat)
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
      throw providerError(res.status, errText)
    }
    // readCompletionBody: a gateway may reply with SSE to a non-streaming request.
    const data = (await readCompletionBody(res)) as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const usageData = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    }
    _usageStorage.enterWith({ promptTokens: usageData.promptTokens, completionTokens: usageData.completionTokens })
    if (responseFormat) {
      const toolUse = data.content?.find((c) => c.type === 'tool_use')
      const structured = toolUse ? JSON.stringify(toolUse.input ?? {}) : (data.content?.find((c) => c.type === 'text')?.text ?? '')
      logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: structured.slice(0, 500) })
      return structured
    }
    const toolUseBlocks = data.content?.filter((c) => c.type === 'tool_use')
    if (toolUseBlocks && toolUseBlocks.length > 0) {
      const toolCalls: LlmToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        arguments: JSON.stringify(b.input ?? {}),
      }))
      logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: toolCalls.map((tc) => tc.name).join(', ').slice(0, 500), toolCalls })
      return toolCalls
    }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: text.slice(0, 500) })
    return text.trim()
  }

  // OpenAI-compatible.
  // ponytail: OpenAI prompt caching is automatic, no code change needed.
  //
  // A ceiling IS sent, contrary to the previous comment. "Let the provider default
  // apply" is unbounded for a reasoning model, which bills its thinking as
  // completion tokens: MEASURED, a 273-token intent prompt produced 6,386 completion
  // tokens and 121,992 ms, blowing the 120 s chat deadline so every RAG question
  // failed as a generic timeout. See LLM_MAX_TOKENS_BY_PURPOSE for the measurement.
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokensForPurpose(purpose),
  }
  if (tools && tools.length > 0) {
    body.tools = tools
  }
  if (responseFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: responseFormat.json_schema.name,
        ...(responseFormat.json_schema.description ? { description: responseFormat.json_schema.description } : {}),
        schema: responseFormat.json_schema.schema,
        ...(responseFormat.json_schema.strict !== undefined ? { strict: responseFormat.json_schema.strict } : {}),
      },
    }
  }
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
    throw providerError(res.status, errText)
  }
  // readCompletionBody: see llm-client-utils for why res.json() is not safe here.
  //
  // `delta` is read alongside `message` because that helper can legitimately hand back
  // a STREAMED chunk when the gateway answers `text/event-stream` to a request that
  // never asked to stream. Such a chunk puts the text in `choices[0].delta.content`,
  // not `choices[0].message.content`. Reading only `message` therefore yielded
  // `undefined` -> '' for EVERY call to such a gateway, and the empty string is not an
  // error anywhere downstream: it silently became an empty answer, or in the intent
  // stage an unparseable reply that fell back to a wrong route. MEASURED: a direct
  // request to the gateway returned valid JSON while `chatOnce` returned '' for the
  // same prompt.
  const data = (await readCompletionBody(res)) as {
    choices?: Array<{
      message?: {
        content?: string
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      }
      delta?: { content?: string }
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const choice = data.choices?.[0]
  // The streamed shape carries the text under `delta`; a streamed reply can also be
  // delivered in fragments on separate chunks, and readCompletionBody keeps only the
  // last content-bearing one, so this reads whichever field the chunk actually used.
  const choiceContent = choice?.message?.content ?? choice?.delta?.content ?? ''
  const usageData = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  }
  _usageStorage.enterWith({ promptTokens: usageData.promptTokens, completionTokens: usageData.completionTokens })
  if (responseFormat) {
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: choiceContent.slice(0, 500) })
    return choiceContent.trim()
  }
  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const toolCalls: LlmToolCall[] = choice.message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: toolCalls.map((tc) => tc.name).join(', ').slice(0, 500), toolCalls })
    return toolCalls
  }
  logLlmUsage(purpose, cfg, usageData, Date.now() - t0, { messages, responsePreview: choiceContent.slice(0, 500) })
  return choiceContent.trim()
  } catch (e) {
    logLlmUsage(purpose, cfg, null, Date.now() - t0, { messages, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/** Streaming completion. Yields token strings. */
// ponytail: streaming tool calls not supported — text only, add when needed.
export async function* chatStream(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number = 0,
  purpose: string = 'chat',
  tools?: LlmToolDef[],
  /**
   * Receives the provider's token counts once the stream ends.
   *
   * A generator cannot return a value alongside its yields, and this one is typed
   * AsyncGenerator<string, void>, so the counts were computed, passed to
   * logLlmUsage, and then dropped -- every streamed turn reported `usage: undefined`
   * and the chat route's `done` frame always omitted usage. Callers that care pass a
   * sink; the parameter is optional so existing callers are unaffected.
   */
  onUsage?: (usage: LlmUsage) => void,
): AsyncGenerator<string, void, unknown> {
  const t0 = Date.now()
  try {
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE') {
    const body = buildAnthropicBody(messages, temperature, true, tools)
    body.model = cfg.model
    const res = await fetchWithRetry(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_STREAM_TIMEOUT_MS),
    })
    if (!res.ok || !res.body) {
      const errText = await readErrorBody(res)
      throw providerError(res.status, errText, 'stream')
    }
    let inputTokens = 0
    let outputTokens = 0
    let streamOutput = ''
    for await (const chunk of iterSseStream(res.body)) {
      try {
        const parsed = JSON.parse(chunk) as {
          type?: string
          delta?: { type?: string; text?: string }
          message?: { usage?: { input_tokens?: number } }
          usage?: { output_tokens?: number }
        }
        if (parsed.type === 'message_start' && parsed.message?.usage?.input_tokens) {
          inputTokens = parsed.message.usage.input_tokens
        }
        if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
          outputTokens = parsed.usage.output_tokens
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          streamOutput += parsed.delta.text
          yield parsed.delta.text
        }
      } catch (e) { console.warn('[llm] malformed SSE chunk:', e) }
    }
    const anthropicUsage: LlmUsage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    }
    logLlmUsage(purpose, cfg, anthropicUsage, Date.now() - t0, { messages, responsePreview: streamOutput.slice(0, 500) })
    onUsage?.(anthropicUsage)
    return
  }

  // OpenAI-compatible
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (tools && tools.length > 0) {
    body.tools = tools
  }
  const res = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_STREAM_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) {
    const errText = await readErrorBody(res)
    throw providerError(res.status, errText, 'stream')
  }
  let usage: LlmUsage | null = null
  let streamOutput = ''
  for await (const chunk of iterSseStream(res.body)) {
    try {
      const parsed = JSON.parse(chunk) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0,
        }
      }
      // delta.content = real SSE token; message.content = non-stream fallback
      // (iterSseStream yields a whole-JSON body when the server ignored
      // stream:true — without this the token would be silently dropped).
      const token = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content
      if (token) { streamOutput += token; yield token }
    } catch (e) { console.warn('[llm] malformed SSE chunk:', e) }
  }
  logLlmUsage(purpose, cfg, usage, Date.now() - t0, { messages, responsePreview: streamOutput.slice(0, 500) })
  // The gateway emits `usage` on EVERY chat.completion.chunk when include_usage is set,
  // so the loop above overwrites `usage` with the latest (last) chunk's totals -- which
  // is the whole-turn figure. Surfacing it here is what makes avg tokens/task and
  // tokens/sec measurable at all.
  if (usage) onUsage?.(usage)
  } catch (e) {
    logLlmUsage(purpose, cfg, null, Date.now() - t0, { messages, error: e instanceof Error ? e.message : String(e) })
    throw e
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

const AGENT_SYSTEM_PROMPT =
  'You are ryasai Agent — an internal AI assistant dedicated to system configuration and operations. ' +
  'You are NOT a user-facing chatbot. Your job: help admins manage system configuration, ' +
  'execute admin actions, check system status, and provide technical guidance. ' +
  'Answer clearly and technically. ' +
  'If the user asks for an action you cannot perform directly, explain the manual steps. ' +
  'You have access to: database integrations, documents, API keys, audit logs, ' +
  'routing scores, system prompt, tool toggles, plugins, schedules, monitoring metrics. ' +
  'When the user refers to prior conversation or data, use the conversation history to answer. ' +
  'Do not say data is unavailable if it was discussed in prior conversation history.'

export async function agentChatOnce(
  messages: AgentChatMessage[],
  temperature: number = 0,
): Promise<string> {
  const cfg = await getAgentConfig()
  if (!cfg) {
    throw new Error('Agent LLM is not configured. Set LLM config with purpose=agent in Settings.')
  }
  return chatOnce(cfg, messages as LlmMessage[], temperature)
}

export async function agentChat(
  question: string,
  context?: string,
): Promise<string> {
  const messages: AgentChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ]
  if (context) {
    messages.push({ role: 'system', content: `System context:\n${context}` })
  }
  messages.push({ role: 'user', content: question })
  return agentChatOnce(messages)
}

export async function* agentChatStream(
  question: string,
  context?: string,
  chatHistory?: AgentChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const cfg = await getAgentConfig()
  if (!cfg) {
    yield 'Agent LLM is not configured. Set LLM config with purpose=agent in Settings.'
    return
  }
  const messages: AgentChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ]
  if (context) {
    messages.push({ role: 'system', content: `System context:\n${context}` })
  }
  if (chatHistory && chatHistory.length > 0) {
    const historyText = chatHistory
      .slice(-10)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
      .join('\n')
    messages.push({ role: 'system', content: `Prior conversation history:\n${historyText}` })
  }
  messages.push({ role: 'user', content: question })
  yield* chatStream(cfg, messages as LlmMessage[], 0)
}
