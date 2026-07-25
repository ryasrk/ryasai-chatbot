/**
 * Unified LLM transport — OpenAI-compatible + Anthropic native.
 * Shared by user-facing chat (ai.ts) and agent wrappers (below).
 * No business logic here; only the transport layer.
 */
import { getLlmRuntimeConfig, getAgentLlmConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { db } from '@/lib/db'

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmImageContent {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface LlmTextContent {
  type: 'text'
  text: string
}

export type LlmContentPart = LlmTextContent | LlmImageContent

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[] | null
  tool_calls?: LlmToolCall[]
  tool_call_id?: string
  name?: string
}

export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmToolResult {
  id: string
  name: string
  result: string
  isError?: boolean
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmResponseFormat {
  type: 'json_schema'
  json_schema: {
    name: string
    description?: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

const MAX_TOKENS_ANTHROPIC = 4096
const LLM_TIMEOUT_MS = 60000
const STREAM_TIMEOUT_MS = 120000
const MAX_RETRIES = 1
const RETRY_BACKOFF_MS = 1000

function logLlmUsage(
  purpose: string,
  cfg: LlmRuntimeConfig,
  usage: LlmUsage | null,
  latencyMs?: number,
): void {
  if (!usage || (usage.totalTokens === 0 && usage.promptTokens === 0)) return
  if (!db.llmUsageLog) return
  const provider = cfg.provider ?? 'OPENAI_COMPATIBLE'
  db.llmUsageLog
    .create({
      data: {
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

function toAnthropicContent(
  content: string | LlmContentPart[] | null,
): string | Array<Record<string, unknown>> {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = part.image_url.url
    const m = url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/)
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
    }
    return { type: 'image', source: { type: 'url', url } }
  })
}

function buildAnthropicBody(
  messages: LlmMessage[],
  temperature: number,
  stream: boolean = false,
  tools?: LlmToolDef[],
  responseFormat?: LlmResponseFormat,
): Record<string, unknown> {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const body: Record<string, unknown> = {
    max_tokens: MAX_TOKENS_ANTHROPIC,
    temperature,
    messages: nonSystem.map((m) => ({
      role: m.role,
      content: toAnthropicContent(m.content),
    })),
  }
  if (systemParts.length > 0) {
    body.system = [
      {
        type: 'text',
        text: systemParts.join('\n\n'),
        cache_control: { type: 'ephemeral' },
      },
    ]
  }
  if (stream) body.stream = true
  if (responseFormat) {
    // ponytail: Anthropic has no native structured output — synthesize a tool
    // with the schema as input_schema, force tool_choice, parse tool_use input.
    const synthTool = {
      name: responseFormat.json_schema.name,
      description: responseFormat.json_schema.description ?? responseFormat.json_schema.name,
      input_schema: responseFormat.json_schema.schema,
    }
    body.tools = [synthTool]
    body.tool_choice = { type: 'tool', name: responseFormat.json_schema.name }
  } else if (tools && tools.length > 0) {
    const anthropicTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
      cache_control?: { type: string }
    }> = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))
    anthropicTools[anthropicTools.length - 1].cache_control = { type: 'ephemeral' }
    body.tools = anthropicTools
  }
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
      throw new Error(`LLM error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const usageData = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    }
    if (responseFormat) {
      const toolUse = data.content?.find((c) => c.type === 'tool_use')
      const structured = toolUse ? JSON.stringify(toolUse.input ?? {}) : (data.content?.find((c) => c.type === 'text')?.text ?? '')
      logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
      return structured
    }
    const toolUseBlocks = data.content?.filter((c) => c.type === 'tool_use')
    if (toolUseBlocks && toolUseBlocks.length > 0) {
      const toolCalls: LlmToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        arguments: JSON.stringify(b.input ?? {}),
      }))
      logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
      return toolCalls
    }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
    return text.trim()
  }

  // OpenAI-compatible — no max_tokens, let provider default apply
  // ponytail: OpenAI prompt caching is automatic, no code change needed.
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature }
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
    throw new Error(`LLM error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      }
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const choice = data.choices?.[0]
  const usageData = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  }
  if (responseFormat) {
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
    return (choice?.message?.content ?? '').trim()
  }
  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const toolCalls: LlmToolCall[] = choice.message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
    logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
    return toolCalls
  }
  logLlmUsage(purpose, cfg, usageData, Date.now() - t0)
  return (choice?.message?.content ?? '').trim()
}

/** Streaming completion. Yields token strings. */
// ponytail: streaming tool calls not supported — text only, add when needed.
export async function* chatStream(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  temperature: number = 0,
  purpose: string = 'chat',
  tools?: LlmToolDef[],
): AsyncGenerator<string, void, unknown> {
  const t0 = Date.now()
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE') {
    const body = buildAnthropicBody(messages, temperature, true, tools)
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
    let inputTokens = 0
    let outputTokens = 0
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
          yield parsed.delta.text
        }
      } catch { /* skip malformed */ }
    }
    logLlmUsage(purpose, cfg, {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    }, Date.now() - t0)
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
  let usage: LlmUsage | null = null
  for await (const chunk of iterSseStream(res.body)) {
    try {
      const parsed = JSON.parse(chunk) as {
        choices?: Array<{ delta?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0,
        }
      }
      const token = parsed.choices?.[0]?.delta?.content
      if (token) yield token
    } catch { /* skip malformed */ }
  }
  logLlmUsage(purpose, cfg, usage, Date.now() - t0)
}

// ---------------------------------------------------------------------------
// OpenAI Responses API — opt-in alternative to Chat Completions.
// ponytail: OpenAI-specific. Chat Completions remains the default for all
// providers. Use this only when you need conversation state (previous_response_id)
// or background mode. Anthropic has no equivalent.
// ---------------------------------------------------------------------------

export async function chatOnceResponses(
  cfg: LlmRuntimeConfig,
  input: LlmMessage[] | string,
  options?: {
    temperature?: number
    purpose?: string
    tools?: LlmToolDef[]
    responseFormat?: LlmResponseFormat
    previousResponseId?: string
    background?: boolean
  },
): Promise<{ text: string; responseId: string; usage?: LlmUsage }> {
  const t0 = Date.now()
  const purpose = options?.purpose ?? 'chat'
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: typeof input === 'string' ? input : input,
    temperature: options?.temperature ?? 0,
  }
  if (options?.previousResponseId) {
    body.previous_response_id = options.previousResponseId
  }
  if (options?.background) {
    body.background = true
  }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools
  }
  if (options?.responseFormat) {
    body.text = {
      format: {
        type: 'json_schema',
        name: options.responseFormat.json_schema.name,
        schema: options.responseFormat.json_schema.schema,
        ...(options.responseFormat.json_schema.strict !== undefined
          ? { strict: options.responseFormat.json_schema.strict }
          : {}),
      },
    }
  }
  const res = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
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
    throw new Error(`LLM Responses API error (HTTP ${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    id?: string
    output_text?: string
    output?: Array<{
      type?: string
      content?: Array<{ type?: string; text?: string }>
      text?: string
    }>
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  }
  const text =
    data.output_text ??
    data.output?.find((o) => o.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text ??
    ''
  const usage: LlmUsage | undefined = data.usage
    ? {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      }
    : undefined
  logLlmUsage(purpose, cfg, usage ?? null, Date.now() - t0)
  return { text: text.trim(), responseId: data.id ?? '', usage }
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

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
    throw new Error('Agent LLM belum dikonfigurasi. Set LLM config dengan purpose=agent di Settings.')
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
    messages.push({ role: 'system', content: `Konteks sistem:\n${context}` })
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
