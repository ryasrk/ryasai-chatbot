/**
 * LLM client — OpenAI Responses API (opt-in alternative to Chat Completions).
 * Depends on: llm-client-types, llm-client-utils, external (llm-config, constants).
 */
import type {
  LlmMessage,
  LlmToolDef,
  LlmUsage,
  LlmToolCall,
  LlmResponsesOptions,
  LlmResponsesResult,
  LlmMultiAgentCall,
} from './llm-client-types'
import type { LlmRuntimeConfig } from '@/lib/llm-config'
import { logLlmUsage, fetchWithRetry, readErrorBody } from './llm-client-utils'
import { LLM_TIMEOUT_MS } from '@/lib/constants'

// ---------------------------------------------------------------------------
// OpenAI Responses API — opt-in alternative to Chat Completions.
// ponytail: OpenAI-specific. Chat Completions remains the default for all
// providers. Use this only when you need conversation state (previous_response_id)
// or background mode. Anthropic has no equivalent.
// ---------------------------------------------------------------------------

export async function chatOnceResponses(
  cfg: LlmRuntimeConfig,
  input: LlmMessage[] | string,
  options?: LlmResponsesOptions,
): Promise<LlmResponsesResult> {
  const t0 = Date.now()
  const purpose = options?.purpose ?? 'chat'
  try {
  if (cfg.provider === 'ANTHROPIC_COMPATIBLE' && (options?.multiAgent?.enabled || options?.programmaticToolCalling)) {
    throw new Error('Multi-agent and programmatic tool calling are OpenAI-only features (not supported by Anthropic).')
  }
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
  const tools: unknown[] = []
  if (options?.tools && options.tools.length > 0) {
    for (const t of options.tools) {
      const fn: Record<string, unknown> = {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }
      if (t.function.allowed_callers) fn.allowed_callers = t.function.allowed_callers
      if (t.function.output_schema) fn.output_schema = t.function.output_schema
      if (t.function.strict !== undefined) fn.strict = t.function.strict
      tools.push({ type: 'function', function: fn })
    }
  }
  if (options?.programmaticToolCalling) {
    tools.push({ type: 'programmatic_tool_calling' })
  }
  if (tools.length > 0) {
    body.tools = tools
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  }
  if (options?.multiAgent?.enabled) {
    body.multi_agent = {
      enabled: true,
      max_concurrent_subagents: options.multiAgent.maxConcurrentSubagents ?? 3,
    }
    body.betas = ['responses_multi_agent=v1']
    headers['OpenAI-Beta'] = 'responses_multi_agent=v1'
  }
  const res = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
    method: 'POST',
    headers,
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
      action?: string
      agent_name?: string
      task_message?: string
      call_id?: string
      name?: string
      arguments?: string
      output?: string
      result?: string
    }>
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  }
  const multiAgentCalls: LlmMultiAgentCall[] = []
  const toolCalls: LlmToolCall[] = []
  let programOutput: string | undefined
  for (const item of data.output ?? []) {
    const itemType = item.type
    if (itemType === 'multi_agent_call') {
      multiAgentCalls.push({
        type: item.action ?? itemType,
        agentName: item.agent_name,
        taskMessage: item.task_message,
      })
    } else if (itemType === 'program_output') {
      programOutput = item.output ?? item.text ?? item.result
    } else if (itemType === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? '',
        name: item.name ?? '',
        arguments: item.arguments ?? '',
      })
    }
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
  const result: LlmResponsesResult = {
    text: text.trim(),
    responseId: data.id ?? '',
    usage,
  }
  if (toolCalls.length > 0) result.toolCalls = toolCalls
  if (multiAgentCalls.length > 0) result.multiAgentCalls = multiAgentCalls
  if (programOutput !== undefined) result.programOutput = programOutput
  logLlmUsage(purpose, cfg, usage ?? null, Date.now() - t0, {
    messages: typeof input === 'string' ? undefined : input,
    responsePreview: text.slice(0, 500),
    toolCalls: toolCalls.length > 0 ? toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })) : undefined,
  })
  return result
  } catch (e) {
    logLlmUsage(purpose, cfg, null, Date.now() - t0, {
      messages: typeof input === 'string' ? undefined : input,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

// ponytail: simplified HTTP loop — WebSocket mode would be more efficient
// but requires more infrastructure. Each round is a separate HTTP request.
export async function runMultiAgentLoop(args: {
  cfg: LlmRuntimeConfig
  input: LlmMessage[] | string
  tools: LlmToolDef[]
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>
  maxRounds?: number
  purpose?: string
}): Promise<{ text: string; totalUsage?: LlmUsage }> {
  const maxRounds = args.maxRounds ?? 10
  let responseId: string | undefined
  let totalUsage: LlmUsage | undefined
  let currentInput: LlmMessage[] | string = args.input

  for (let round = 0; round < maxRounds; round++) {
    const result = await chatOnceResponses(args.cfg, currentInput, {
      purpose: args.purpose,
      tools: args.tools,
      multiAgent: { enabled: true },
      previousResponseId: responseId,
    })
    if (result.usage) {
      totalUsage = totalUsage
        ? {
            promptTokens: totalUsage.promptTokens + result.usage.promptTokens,
            completionTokens: totalUsage.completionTokens + result.usage.completionTokens,
            totalTokens: totalUsage.totalTokens + result.usage.totalTokens,
          }
        : result.usage
    }
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { text: result.text, totalUsage }
    }
    const outputs = await Promise.all(
      result.toolCalls.map(async (tc) => {
        try {
          const parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>
          const output = await args.toolExecutor(tc.name, parsedArgs)
          return { id: tc.id, output }
        } catch (e) {
          return { id: tc.id, output: `Error: ${e instanceof Error ? e.message : String(e)}` }
        }
      }),
    )
    // ponytail: Responses API input items (function_call_output), cast to LlmMessage[] —
    // a proper union type would cover both message items and function call outputs.
    currentInput = outputs.map((o) => ({
      type: 'function_call_output',
      call_id: o.id,
      output: o.output,
    })) as unknown as LlmMessage[]
    responseId = result.responseId
  }
  return { text: '', totalUsage }
}
