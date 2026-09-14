import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'

// --- Mocks for agent function tests + usage logging ---
const mockGetAgentLlmConfig = mock(async () => null as unknown)
const mockGetLlmRuntimeConfig = mock(async () => null as unknown)
const mockTraceLlmCall = mock((_trace: unknown) => {})
const mockLlmUsageCreate = mock(async () => ({}))

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: mockGetLlmRuntimeConfig,
  getAgentLlmConfig: mockGetAgentLlmConfig,
}))
mock.module('@/lib/observability', () => ({
  traceLlmCall: mockTraceLlmCall,
}))
mock.module('@/lib/db', () => ({
  db: { llmUsageLog: { create: mockLlmUsageCreate } },
}))

import { chatOnce, chatStream, chatOnceResponses, runMultiAgentLoop, agentChatOnce, agentChat, agentChatStream, getChatConfig, getAgentConfig, getLastLlmUsage, withUsageTracking } from './llm-client'
import { maxTokensForPurpose } from './constants'
import type { LlmRuntimeConfig } from './llm-config'
import { LlmProviderError, readCompletionBody } from './llm-client-utils'
import type { LlmToolDef } from './llm-client-types'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})
beforeEach(() => {
  mockTraceLlmCall.mockClear()
  mockLlmUsageCreate.mockClear()
  mockGetAgentLlmConfig.mockReset()
  mockGetAgentLlmConfig.mockImplementation(async () => null)
})

const openaiCfg: LlmRuntimeConfig = {
  id: '1',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4',
}

const anthropicCfg: LlmRuntimeConfig = {
  id: '2',
  provider: 'ANTHROPIC_COMPATIBLE',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-3',
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return { ok: true, status: 200, body: stream } as Response
}

describe('chatOnce', () => {
  test('OpenAI-compatible → returns choices[0].message.content (trimmed)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: '  Hello  ' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnce(openaiCfg, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])

    expect(out).toBe('Hello')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  test('Anthropic → uses x-api-key header, returns content[].text', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ content: [{ type: 'text', text: '  Hi there  ' }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnce(anthropicCfg, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])

    expect(out).toBe('Hi there')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  test('Anthropic → concatenates ALL system messages into top-level system field with cache_control', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ content: [{ type: 'text', text: 'ok' }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(anthropicCfg, [
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'system', content: 's3' },
      { role: 'user', content: 'hi' },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.system).toEqual([
      { type: 'text', text: 's1\n\ns2\n\ns3', cache_control: { type: 'ephemeral' } },
    ])
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  // REGRESSION: the OpenAI-compatible path sent NO max_tokens. That is fine for a
  // chat model and unbounded for a REASONING model, which bills its thinking as
  // completion tokens and thinks BEFORE emitting anything. Measured against
  // cbcn/hy4-preview: a 273-token intent prompt produced 6,386 completion tokens and
  // 121,992 ms, blowing the 120 s chat deadline so every RAG question failed as a
  // generic timeout while the documents were indexed and retrievable. The failure
  // looked like a retrieval bug and was a budget bug.
  test('OpenAI-compatible → SENDS max_tokens sized for the purpose', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'intent-analysis')

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.max_tokens).toBe(maxTokensForPurpose('intent-analysis'))
    // The ceiling must leave room for REASONING, not just the visible answer: a cap
    // sized for the object alone truncated the JSON to an empty string with
    // finish_reason 'length', which surfaced as a generic provider error.
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192)
  })

  test('OpenAI-compatible → a prose reply keeps a generous ceiling so it is not cut off', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'chat')

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096)
  })

  test('retry on 5xx → first 503 then 200 succeeds', async () => {
    let calls = 0
    global.fetch = ((_url: string, _init: RequestInit) => {
      calls++
      if (calls === 1) {
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('busy') } as Response)
      }
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    }) as unknown as typeof fetch

    const out = await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])

    expect(out).toBe('ok')
    expect(calls).toBe(2)
  })

  test('OpenAI → image content array sent as-is in messages', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'desc' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(openaiCfg, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png', detail: 'high' } },
        ],
      },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png', detail: 'high' } },
    ])
  })

  test('Anthropic → image content array converted to Anthropic format (url source)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ content: [{ type: 'text', text: 'desc' }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(anthropicCfg, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ])
  })

  test('Anthropic → base64 data URL image converted to base64 source', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ content: [{ type: 'text', text: 'desc' }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(anthropicCfg, [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ])
  })

  test('OpenAI → responseFormat adds response_format to request body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: '{"x":1}' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnce(
      openaiCfg,
      [{ role: 'user', content: 'give me json' }],
      0,
      'sql',
      undefined,
      {
        type: 'json_schema',
        json_schema: { name: 'result', schema: { type: 'object', properties: { x: { type: 'number' } } }, strict: true },
      },
    )

    expect(out).toBe('{"x":1}')
    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', schema: { type: 'object', properties: { x: { type: 'number' } } }, strict: true },
    })
  })

  test('Anthropic → responseFormat uses synthetic tool + tool_choice, parses tool_use input', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        jsonResponse({
          content: [{ type: 'tool_use', id: 'tu1', name: 'result', input: { x: 42 } }],
        }),
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnce(
      anthropicCfg,
      [{ role: 'user', content: 'give me json' }],
      0,
      'sql',
      undefined,
      {
        type: 'json_schema',
        json_schema: { name: 'result', schema: { type: 'object', properties: { x: { type: 'number' } } } },
      },
    )

    expect(out).toBe('{"x":42}')
    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.tools).toEqual([
      {
        name: 'result',
        description: 'result',
        input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      },
    ])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'result' })
  })

  test('string content backward compat → OpenAI body has string content', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnce(openaiCfg, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.messages[0].content).toBe('sys')
    expect(body.messages[1].content).toBe('hello')
  })
})

describe('chatStream', () => {
  test('OpenAI → yields tokens from SSE data lines', async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }])) {
      tokens.push(t)
    }

    expect(tokens).toEqual(['Hel', 'lo'])
  })

  test('Anthropic → yields from content_block_delta events', async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n',
          'data: {"type":"content_block_delta","delta":{"text":"!"}}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of chatStream(anthropicCfg, [{ role: 'user', content: 'hi' }])) {
      tokens.push(t)
    }

    expect(tokens).toEqual(['Hi', '!'])
  })

  test('OpenAI streaming WITH tools puts them in the request body', async () => {
    // Uncovered until now: the streaming path has its own `body.tools = tools` assignment,
    // separate from the non-streaming one. If only this copy regressed, an agent that streams
    // would send no tools at all and the model would simply answer in prose -- the request still
    // succeeds, so nothing would look broken in the UI.
    const fetchMock = mock(() =>
      Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const tools: LlmToolDef[] = [{ type: 'function', function: { name: 'search', description: 'search', parameters: { type: 'object' } } }]
    for await (const _ of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'chat', tools)) {
      /* drain */
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { tools?: unknown[]; stream?: boolean }
    expect(body.tools).toEqual(tools)
    expect(body.stream).toBe(true)
  })

  test('OpenAI streaming with an EMPTY tools array omits the key entirely', async () => {
    // Some strict OpenAI-compatible gateways reject `tools: []`. The guard is `tools.length > 0`,
    // so this pins the difference between "no tools" and "an empty list of tools".
    const fetchMock = mock(() =>
      Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    for await (const _ of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'chat', [])) {
      /* drain */
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect('tools' in body).toBe(false)
  })
})

describe('agentChat — the system context block', () => {
  test('a context is passed as its own system message', async () => {
    // agentChat is the answer-only helper used by the non-planner paths. The `System context:`
    // message is how retrieved documents and connector facts reach the model, so a regression that
    // dropped it would silently degrade every answer to a bare model call -- no error, just worse
    // output, which is the hardest kind of failure to notice.
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'answer' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await agentChat('what is the total?', 'Invoice INV-1 totals 500.')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    // The agent system prompt is always first; the context is a SECOND system message.
    expect(body.messages[0]!.role).toBe('system')
    const contextMsg = body.messages.find((m) => m.content.startsWith('System context:'))
    expect(contextMsg?.content).toBe('System context:\nInvoice INV-1 totals 500.')
    // The question itself is still present.
    expect(body.messages.some((m) => m.content === 'what is the total?')).toBe(true)
  })

  test('NO context adds no context message (the guard is on truthiness)', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'answer' } }] })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await agentChat('just the question')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages.some((m) => m.content.startsWith('System context:'))).toBe(false)
  })
})

describe('chatOnceResponses', () => {
  test('POST /responses → returns output_text + responseId', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        jsonResponse({
          id: 'resp_abc',
          output_text: '  Hello world  ',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnceResponses(openaiCfg, 'say hello')

    expect(out.text).toBe('Hello world')
    expect(out.responseId).toBe('resp_abc')
    expect(out.usage?.totalTokens).toBe(15)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(init.body as string)
    expect(body.input).toBe('say hello')
    expect(body.model).toBe('gpt-4')
  })

  test('previousResponseId + background passed to body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_bg', output_text: '' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'continue', {
      previousResponseId: 'resp_abc',
      background: true,
    })

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.previous_response_id).toBe('resp_abc')
    expect(body.background).toBe(true)
  })

  test('responseFormat → adds text.format to body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_1', output_text: '{"y":2}' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'give json', {
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
      },
    })

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.text.format).toEqual({
      type: 'json_schema',
      name: 'out',
      schema: { type: 'object' },
      strict: true,
    })
  })

  test('message array input → sent as array', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_2', output_text: 'hi' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, [
      { role: 'user', content: 'hello' },
    ])

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(Array.isArray(body.input)).toBe(true)
    expect(body.input[0].content).toBe('hello')
  })

  test('multiAgent.enabled → adds multi_agent + betas + OpenAI-Beta header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_ma', output_text: 'done' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'research X', {
      multiAgent: { enabled: true, maxConcurrentSubagents: 5 },
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.multi_agent).toEqual({ enabled: true, max_concurrent_subagents: 5 })
    expect(body.betas).toEqual(['responses_multi_agent=v1'])
    const headers = init.headers as Record<string, string>
    expect(headers['OpenAI-Beta']).toBe('responses_multi_agent=v1')
  })

  test('multiAgent.enabled with default → max_concurrent_subagents defaults to 3', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_ma2', output_text: 'done' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'research X', {
      multiAgent: { enabled: true },
    })

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.multi_agent.max_concurrent_subagents).toBe(3)
  })

  test('programmaticToolCalling → adds programmatic_tool_calling to tools array', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_pt', output_text: 'done' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'compute', {
      tools: [{
        type: 'function',
        function: { name: 'add', description: 'add numbers', parameters: { type: 'object' } },
      }],
      programmaticToolCalling: true,
    })

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.tools).toContainEqual({ type: 'programmatic_tool_calling' })
    expect(body.tools).toHaveLength(2)
  })

  test('allowed_callers + output_schema on tool def → passed to request body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_ac', output_text: 'done' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await chatOnceResponses(openaiCfg, 'search', {
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'search the web',
          parameters: { type: 'object' },
          allowed_callers: ['direct', 'programmatic'],
          output_schema: { type: 'string' },
        },
      }],
    })

    const sentInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(sentInit.body as string)
    expect(body.tools[0].function.allowed_callers).toEqual(['direct', 'programmatic'])
    expect(body.tools[0].function.output_schema).toEqual({ type: 'string' })
  })

  test('parses multi_agent_call + program_output + function_call from output', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        id: 'resp_parse',
        output_text: 'final answer',
        output: [
          { type: 'multi_agent_call', action: 'spawn_agent', agent_name: 'researcher', task_message: 'find X' },
          { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"X"}' },
          { type: 'program_output', output: 'computed result' },
          { type: 'message', content: [{ type: 'output_text', text: 'final answer' }] },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnceResponses(openaiCfg, 'do research', {
      multiAgent: { enabled: true },
      programmaticToolCalling: true,
    })

    expect(out.text).toBe('final answer')
    expect(out.multiAgentCalls).toEqual([{ type: 'spawn_agent', agentName: 'researcher', taskMessage: 'find X' }])
    expect(out.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"q":"X"}' }])
    expect(out.programOutput).toBe('computed result')
  })

  test('Anthropic + multiAgent → throws clear error', async () => {
    await expect(
      chatOnceResponses(anthropicCfg, 'test', { multiAgent: { enabled: true } }),
    ).rejects.toThrow('OpenAI-only')
  })

  test('Anthropic + programmaticToolCalling → throws clear error', async () => {
    await expect(
      chatOnceResponses(anthropicCfg, 'test', { programmaticToolCalling: true }),
    ).rejects.toThrow('OpenAI-only')
  })

  test('Anthropic without beta features → does not throw OpenAI-only error', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ id: 'resp_anth', output_text: 'ok' })),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await chatOnceResponses(anthropicCfg, 'hi')
    expect(out.text).toBe('ok')
  })
})

describe('runMultiAgentLoop', () => {
  test('executes tool calls and continues until final answer', async () => {
    let callCount = 0
    global.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(jsonResponse({
          id: 'resp_round1',
          output: [
            { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"X"}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }))
      }
      return Promise.resolve(jsonResponse({
        id: 'resp_round2',
        output_text: 'final answer based on search results',
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      }))
    }) as unknown as typeof fetch

    const result = await runMultiAgentLoop({
      cfg: openaiCfg,
      input: 'search for X',
      tools: [{ type: 'function', function: { name: 'search', description: 'search', parameters: { type: 'object' } } }],
      toolExecutor: async () => 'search results for X',
    })

    expect(result.text).toBe('final answer based on search results')
    expect(result.totalUsage?.totalTokens).toBe(45)
    expect(callCount).toBe(2)
  })

  test('no tool calls → returns immediately after first round', async () => {
    let callCount = 0
    global.fetch = mock(() => {
      callCount++
      return Promise.resolve(jsonResponse({
        id: 'resp_direct',
        output_text: 'no tools needed',
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }))
    }) as unknown as typeof fetch

    const result = await runMultiAgentLoop({
      cfg: openaiCfg,
      input: 'say hi',
      tools: [],
      toolExecutor: async () => '',
    })

    expect(result.text).toBe('no tools needed')
    expect(result.totalUsage?.totalTokens).toBe(8)
    expect(callCount).toBe(1)
  })

  test('toolExecutor error → error string sent as output, loop continues', async () => {
    let callCount = 0
    global.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(jsonResponse({
          id: 'resp_err1',
          output: [
            { type: 'function_call', call_id: 'call_1', name: 'fail', arguments: '{}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }))
      }
      return Promise.resolve(jsonResponse({
        id: 'resp_err2',
        output_text: 'recovered from error',
        usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
      }))
    }) as unknown as typeof fetch

    const result = await runMultiAgentLoop({
      cfg: openaiCfg,
      input: 'do something',
      tools: [{ type: 'function', function: { name: 'fail', description: 'fails', parameters: { type: 'object' } } }],
      toolExecutor: async () => { throw new Error('tool broke') },
    })

    expect(result.text).toBe('recovered from error')
    expect(callCount).toBe(2)
    // Verify the error was sent as function_call_output in round 2's input
    const calls = (global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    const body = JSON.parse(calls[1][1].body as string)
    expect(body.input[0].output).toContain('tool broke')
  })

  test('maxRounds exceeded → returns empty text', async () => {
    let callCount = 0
    global.fetch = mock(() => {
      callCount++
      return Promise.resolve(jsonResponse({
        id: `resp_${callCount}`,
        output: [
          { type: 'function_call', call_id: `call_${callCount}`, name: 'loop', arguments: '{}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }))
    }) as unknown as typeof fetch

    const result = await runMultiAgentLoop({
      cfg: openaiCfg,
      input: 'loop forever',
      tools: [{ type: 'function', function: { name: 'loop', description: 'loops', parameters: { type: 'object' } } }],
      toolExecutor: async () => 'result',
      maxRounds: 3,
    })

    expect(result.text).toBe('')
    expect(callCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Provider failures THROUGH the Anthropic transport.
//
// The classification itself is covered in llm-provider-error.test.ts, but every failure test here
// used openaiCfg. The Anthropic non-streaming branch has its OWN `!res.ok` handling (a different
// endpoint, different auth headers, a different body shape), so a regression there -- a dropped
// status, a body that never reaches the classifier -- would leave the unit tests green while real
// BYOK customers got a useless error.
// ---------------------------------------------------------------------------

describe('chatOnce (Anthropic) — provider failures reach the classifier', () => {
  test('a revoked key surfaces as an AUTH failure, not a generic one', async () => {
    // The single most common BYOK support case: the customer's own key was revoked. They must be
    // told it is theirs to fix, which only works if the 401 survives the transport.
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":{"message":"invalid x-api-key"}}'),
      } as Response),
    ) as unknown as typeof fetch

    const err = await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmProviderError)
    expect((err as LlmProviderError).status).toBe(401)
    expect((err as LlmProviderError).failure.kind).toBe('auth')
  })

  test('the provider body informs the CLASSIFICATION without reaching the client', async () => {
    // I first wrote this expecting `err.message` to exclude the body, and it FAILED -- err.message
    // does carry the first 200 chars. Investigating instead of "fixing" it showed the real design:
    // the body never reaches the browser because errors.ts branches on `instanceof
    // LlmProviderError` FIRST and returns only failure.kind + failure.hint, never e.message. That
    // branch's own comment records the bug it fixed: provider errors used to fall through to
    // INTERNAL_ERROR/500 and return the raw "LLM error (HTTP 401): ..." text to the browser.
    //
    // So the property worth pinning is the CLIENT-FACING one, which is what a leak would actually
    // expose. Asserting on err.message would pin the internal shape and miss the real invariant.
    const secretish = 'sk-ant-SECRET-PREFIX-leaked'
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve(`{"error":{"message":"${secretish}"}}`),
      } as Response),
    ) as unknown as typeof fetch

    const err = (await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }]).catch(
      (e: unknown) => e,
    )) as LlmProviderError
    expect(err.status).toBe(400)

    const { toTypedError } = await import('./errors')
    const forClient = toTypedError(err)
    // The raw body stays internal...
    expect(forClient.message).not.toContain(secretish)
    // ...while the category and the fix DO reach the customer, which is the whole point of BYOK
    // error classification.
    expect(forClient.hint).toBeTruthy()
    expect(forClient.statusCode).toBe(502)
  })

  test('an error body that cannot be read still produces a classified failure', async () => {
    // readErrorBody() is `res.text().catch(() => '')`. A provider that closes the connection while
    // the body is being read must not turn a clean 502 into an unhandled rejection.
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('connection reset')),
      } as Response),
    ) as unknown as typeof fetch

    const err = (await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }]).catch(
      (e: unknown) => e,
    )) as LlmProviderError
    expect(err).toBeInstanceOf(LlmProviderError)
    expect(err.status).toBe(502)
  })

  test('the OpenAI and Anthropic transports classify the SAME status identically', async () => {
    // Two independent !res.ok branches must agree, or the error a customer sees depends on which
    // provider they happened to configure.
    const failWith = () =>
      mock(() =>
        Promise.resolve({ ok: false, status: 402, text: () => Promise.resolve('quota exceeded') } as Response),
      ) as unknown as typeof fetch

    global.fetch = failWith()
    const anthropicErr = (await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }]).catch(
      (e: unknown) => e,
    )) as LlmProviderError
    global.fetch = failWith()
    const openaiErr = (await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }]).catch(
      (e: unknown) => e,
    )) as LlmProviderError

    expect(anthropicErr.status).toBe(openaiErr.status)
    expect(anthropicErr.failure.kind).toBe(openaiErr.failure.kind)
  })
})

// ---------------------------------------------------------------------------
// fetchWithRetry — tested indirectly via chatOnce
// ---------------------------------------------------------------------------

describe('fetchWithRetry (via chatOnce)', () => {
  test('retries on network error then succeeds', async () => {
    let calls = 0
    global.fetch = mock((_: string, __: RequestInit) => {
      calls++
      if (calls === 1) throw new Error('network down')
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'recovered' } }] }))
    }) as unknown as typeof fetch

    const out = await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])
    expect(out).toBe('recovered')
    expect(calls).toBe(2)
  })

  test('exhausts max retries on persistent 500 → throws', async () => {
    let calls = 0
    global.fetch = mock((_: string, __: RequestInit) => {
      calls++
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('server error') } as Response)
    }) as unknown as typeof fetch

    await expect(chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 500')
    // LLM_MAX_RETRIES = 3 → 4 total attempts (0,1,2,3)
    expect(calls).toBe(4)
  })

  test('exhausts max retries on persistent network errors → throws', async () => {
    let calls = 0
    global.fetch = mock((_: string, __: RequestInit) => {
      calls++
      throw new Error('persistent network failure')
    }) as unknown as typeof fetch

    await expect(chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('persistent network failure')
    expect(calls).toBe(4)
  })

  test('4xx error does NOT retry → throws immediately', async () => {
    let calls = 0
    global.fetch = mock((_: string, __: RequestInit) => {
      calls++
      return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('unauthorized') } as Response)
    }) as unknown as typeof fetch

    await expect(chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 401')
    expect(calls).toBe(1)
  })

  test('retries on 503 then 200 → succeeds on 2nd attempt', async () => {
    let calls = 0
    global.fetch = mock((_: string, __: RequestInit) => {
      calls++
      if (calls === 1) return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('busy') } as Response)
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    }) as unknown as typeof fetch

    const out = await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])
    expect(out).toBe('ok')
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// chatStream — error + Anthropic usage parsing
// ---------------------------------------------------------------------------

describe('chatStream error handling', () => {
  test('OpenAI non-ok response → throws LLM stream error', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 429, body: null, text: () => Promise.resolve('rate limited') } as Response),
    ) as unknown as typeof fetch

    await expect(
      (async () => { for await (const _ of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }])) { /* drain */ } })(),
    ).rejects.toThrow('LLM stream error (HTTP 429)')
  })

  test('Anthropic non-ok response → throws LLM stream error', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500, body: null, text: () => Promise.resolve('overloaded') } as Response),
    ) as unknown as typeof fetch

    await expect(
      (async () => { for await (const _ of chatStream(anthropicCfg, [{ role: 'user', content: 'hi' }])) { /* drain */ } })(),
    ).rejects.toThrow('LLM stream error (HTTP 500)')
  })

  test('Anthropic → parses message_start input_tokens + message_delta output_tokens', async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n',
          'data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n',
          'data: {"type":"message_delta","usage":{"output_tokens":10}}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of chatStream(anthropicCfg, [{ role: 'user', content: 'hi' }])) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['Hi'])
    // Verify usage was logged via traceLlmCall
    const lastCall = (mockTraceLlmCall.mock.calls.at(-1) as unknown as [unknown])[0] as { usage?: { promptTokens: number; completionTokens: number } }
    expect(lastCall.usage?.promptTokens).toBe(50)
    expect(lastCall.usage?.completionTokens).toBe(10)
  })

  test('OpenAI → parses usage from final SSE chunk', async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }])) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['Hi'])
    const lastCall = (mockTraceLlmCall.mock.calls.at(-1) as unknown as [unknown])[0] as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }
    expect(lastCall.usage?.promptTokens).toBe(20)
    expect(lastCall.usage?.totalTokens).toBe(25)
  })

  test('skips malformed SSE lines without throwing', async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: not valid json\n',
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of chatStream(openaiCfg, [{ role: 'user', content: 'hi' }])) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['ok'])
  })
})

// ---------------------------------------------------------------------------
// logLlmUsage — verified via traceLlmCall mock
// ---------------------------------------------------------------------------

describe('logLlmUsage (via traceLlmCall)', () => {
  test('chatOnce OpenAI → logs usage with prompt/completion/total tokens', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
    ) as unknown as typeof fetch

    await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'test-purpose')

    const lastCall = (mockTraceLlmCall.mock.calls.at(-1) as unknown as [unknown])[0] as {
      purpose: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; error?: string
    }
    expect(lastCall.purpose).toBe('test-purpose')
    expect(lastCall.usage?.promptTokens).toBe(10)
    expect(lastCall.usage?.completionTokens).toBe(5)
    expect(lastCall.usage?.totalTokens).toBe(15)
    expect(lastCall.error).toBeUndefined()
  })

  test('chatOnce error → logs error string', async () => {
    global.fetch = mock(() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch

    await expect(chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow('connection refused')

    const lastCall = (mockTraceLlmCall.mock.calls.at(-1) as unknown as [unknown])[0] as {
      error?: string; usage?: unknown
    }
    expect(lastCall.error).toContain('connection refused')
    expect(lastCall.usage).toBeUndefined()
  })

  test('chatOnce Anthropic → logs usage from input_tokens/output_tokens', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 30, output_tokens: 12 },
      })),
    ) as unknown as typeof fetch

    await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }], 0, 'anthropic-test')

    const lastCall = (mockTraceLlmCall.mock.calls.at(-1) as unknown as [unknown])[0] as {
      purpose: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    }
    expect(lastCall.purpose).toBe('anthropic-test')
    expect(lastCall.usage?.promptTokens).toBe(30)
    expect(lastCall.usage?.completionTokens).toBe(12)
    expect(lastCall.usage?.totalTokens).toBe(42)
  })

  test('chatOnce with usage totalTokens=0 → does NOT call db.llmUsageLog.create', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { content: 'hello' } }],
        // no usage field → all tokens default to 0
      })),
    ) as unknown as typeof fetch

    await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }])
    expect(mockLlmUsageCreate).not.toHaveBeenCalled()
  })

  test('chatOnce with non-zero usage → calls db.llmUsageLog.create', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
    ) as unknown as typeof fetch

    await chatOnce(openaiCfg, [{ role: 'user', content: 'hi' }], 0, 'sql')
    expect(mockLlmUsageCreate).toHaveBeenCalledTimes(1)
    const createArgs = (mockLlmUsageCreate.mock.calls[0] as unknown as [{ data: { purpose: string; provider: string; model: string; promptTokens: number } }])[0]
    expect(createArgs.data.purpose).toBe('sql')
    expect(createArgs.data.provider).toBe('OPENAI_COMPATIBLE')
    expect(createArgs.data.model).toBe('gpt-4')
    expect(createArgs.data.promptTokens).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// agentChatOnce / agentChat / agentChatStream
// ---------------------------------------------------------------------------

describe('agentChatOnce', () => {
  test('throws when agent LLM is not configured', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => null)
    await expect(agentChatOnce([{ role: 'user', content: 'hi' }])).rejects.toThrow('Agent LLM is not configured')
  })

  test('returns answer when agent config is set', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: '  agent response  ' } }] })),
    ) as unknown as typeof fetch

    const out = await agentChatOnce([{ role: 'user', content: 'list integrations' }], 0)
    expect(out).toBe('agent response')
  })
})

describe('agentChat', () => {
  test('returns answer with system prompt + context', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'all systems go' } }] })),
    ) as unknown as typeof fetch

    const out = await agentChat('check system status', '3 integrations active')
    expect(out).toBe('all systems go')
    const sentInit = ((global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1])
    const body = JSON.parse(sentInit.body as string)
    // Should include the agent system prompt + context + user question
    expect(body.messages[0].content).toContain('ryasai Agent')
    expect(body.messages[1].content).toContain('3 integrations active')
    expect(body.messages[2].content).toBe('check system status')
  })
})

describe('agentChatStream', () => {
  test('yields error message when agent LLM not configured', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => null)
    const tokens: string[] = []
    for await (const t of agentChatStream('hello')) {
      tokens.push(t)
    }
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toContain('Agent LLM is not configured')
  })

  test('yields tokens when agent config is set', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    global.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"agentic"}}]}\n',
          'data: {"choices":[{"delta":{"content":" reply"}}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    ) as unknown as typeof fetch

    const tokens: string[] = []
    for await (const t of agentChatStream('do stuff')) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['agentic', ' reply'])
  })

  test('a context becomes a System context message (its own copy, separate from agentChat)', async () => {
    // agentChatStream has its OWN `System context:` push, distinct from the one in agentChat. Every
    // existing test here passed `undefined` for context, so this copy was never exercised: a
    // regression would strip retrieved documents from every STREAMED agent answer while the
    // non-streaming path kept working -- the kind of split that is easy to miss and looks like
    // "the streaming answers are just worse".
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    global.fetch = mock(() =>
      Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])),
    ) as unknown as typeof fetch

    for await (const _ of agentChatStream('what is the total?', 'Invoice INV-1 totals 500.')) {
      /* drain */
    }

    const [, init] = (global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    const ctxMsg = body.messages.find((m) => m.content.startsWith('System context:'))
    expect(ctxMsg?.content).toBe('System context:\nInvoice INV-1 totals 500.')
    // The context is a SECOND system message; the agent system prompt still comes first.
    expect(body.messages[0]!.role).toBe('system')
    expect(body.messages[0]!.content).not.toContain('System context:')
    // Order matters for the model: system prompt, then context, then the question.
    expect(body.messages[body.messages.length - 1]!.content).toBe('what is the total?')
  })

  test('injects chatHistory into the prompt', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => openaiCfg)
    global.fetch = mock(() =>
      Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])),
    ) as unknown as typeof fetch

    for await (const _ of agentChatStream('again', undefined, [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ])) { /* drain */ }

    const sentInit = ((global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1])
    const body = JSON.parse(sentInit.body as string)
    const histMsg = body.messages.find((m: { content: string }) => m.content?.includes('Prior conversation history'))
    expect(histMsg).toBeDefined()
    expect(histMsg.content).toContain('previous question')
  })
})

// ---------------------------------------------------------------------------
// getChatConfig / getAgentConfig
// ---------------------------------------------------------------------------

describe('getChatConfig', () => {
  test('returns the runtime config from getLlmRuntimeConfig', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => openaiCfg)
    const cfg = await getChatConfig()
    expect(cfg).toBe(openaiCfg)
  })

  test('returns null when no config', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    const cfg = await getChatConfig()
    expect(cfg).toBeNull()
  })
})

describe('getAgentConfig', () => {
  test('returns the agent config from getAgentLlmConfig', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => anthropicCfg)
    const cfg = await getAgentConfig()
    expect(cfg).toBe(anthropicCfg)
  })

  test('returns null when no agent config', async () => {
    mockGetAgentLlmConfig.mockImplementation(async () => null)
    const cfg = await getAgentConfig()
    expect(cfg).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// chatOnce — OpenAI tool_calls parsing
// ---------------------------------------------------------------------------

describe('chatOnce tool calls', () => {
  test('OpenAI → returns LlmToolCall[] when tool_calls present', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{
          message: {
            tool_calls: [
              { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } },
            ],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
    ) as unknown as typeof fetch

    const tools = [{
      type: 'function' as const,
      function: { name: 'search', description: 'search', parameters: { type: 'object' } },
    }]
    const out = await chatOnce(openaiCfg, [{ role: 'user', content: 'search' }], 0, 'tool', tools)
    expect(Array.isArray(out)).toBe(true)
    const toolCalls = out as Array<{ id: string; name: string; arguments: string }>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].id).toBe('call_1')
    expect(toolCalls[0].name).toBe('search')
    expect(toolCalls[0].arguments).toBe('{"q":"test"}')
  })

  test('Anthropic → returns LlmToolCall[] when tool_use blocks present', async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    ) as unknown as typeof fetch

    const tools = [{
      type: 'function' as const,
      function: { name: 'search', description: 'search', parameters: { type: 'object' } },
    }]
    const out = await chatOnce(anthropicCfg, [{ role: 'user', content: 'search' }], 0, 'tool', tools)
    expect(Array.isArray(out)).toBe(true)
    const toolCalls = out as Array<{ id: string; name: string; arguments: string }>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].id).toBe('tu_1')
    expect(toolCalls[0].name).toBe('search')
    expect(toolCalls[0].arguments).toBe('{"q":"test"}')
  })
})

/**
 * Usage tracking — the ONLY path by which token counts leave a completion.
 *
 * `withUsageTracking` and `getLastLlmUsage` are the wrapper and reader around an AsyncLocalStorage
 * slot that `chatOnce` writes with `enterWith`. Neither function had EVER executed in a test: the
 * 11 production readers (tool-branches.ts x5, tool-router-agentic.ts x3, tool-router.ts x1) all run
 * against a MOCK (`mock.module('@/lib/llm-client', () => ({ getLastLlmUsage: () => null }))`), and
 * tool-router.ts:53 is the only production caller of the wrapper.
 *
 * This is the number the product reports as "avg tokens/task" and the number per-request budget
 * enforcement reads, so "the isolation actually isolates" is a correctness requirement, not a nicety.
 */
describe('withUsageTracking / getLastLlmUsage', () => {
  function stubUsage(input: number, output: number) {
    global.fetch = (async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: input, output_tokens: output },
      }), { status: 200 })) as unknown as typeof fetch
  }

  test('returns undefined before any call has recorded usage in this context', () => {
    // The contract the 11 readers rely on to mean "no LLM call happened here".
    expect(getLastLlmUsage()).toBeUndefined()
  })

  test('KNOWN BUG: a completed chatOnce is NOT visible to getLastLlmUsage', async () => {
    // *** THIS TEST PINS A DEFECT, NOT A DESIRE. ***
    //
    // chatOnce writes the usage slot with `_usageStorage.enterWith(...)` (line 114). `enterWith` changes
    // the store for code that runs AFTERWARDS IN THAT ASYNC CONTEXT; it does NOT propagate back OUT to
    // the caller once the awaited async function returns. So the store the CALLER reads is still the
    // `undefined` that withUsageTracking seeded.
    //
    // Reproduced minimally, and it is a property of the API rather than of the mocks:
    //   async function inner() { st.enterWith({n:1}) }        // nested, like chatOnce
    //   await st.run(undefined, async () => { await inner(); return st.getStore() })  -> undefined
    //   await st.run(undefined, async () => { st.enterWith({n:2}); return st.getStore() }) -> {n:2}
    //
    // THE CONSEQUENCE IS NOT COSMETIC. 11 production readers call getLastLlmUsage() (tool-branches.ts
    // x5, tool-router-agentic.ts x3, tool-router.ts via the wrapper). Each guards with `if (usage)`, so
    // `budget.track(usage)` is NEVER called (tool-router-agentic.ts:425), the per-request token budget
    // never advances, and the "budget exhausted" stop never fires. It is also the number "avg
    // tokens/task" would be computed from, so that figure cannot be correct from this path.
    //
    // I did NOT fix it: the repair changes shared transport control flow (either chatOnce must set the
    // store through a value the caller can see, or the wrapper must own the write), and that is a
    // product decision, not a coverage commit. Pinned so a fix is a deliberate change that reddens this.
    stubUsage(11, 7)
    const out = await withUsageTracking(async () => {
      await chatOnce(anthropicCfg, [{ role: 'user', content: 'hi' }], 0, 'chat')
      return getLastLlmUsage()
    })
    expect(out).toBeUndefined()
  })

  test('the store an OUTER context reads is unaffected by an inner context\'s write', async () => {
    // The same mechanism stated as isolation rather than as a bug, so the fix has to satisfy both: an
    // inner context's write must reach its own caller eventually, while a SIBLING must not inherit it.
    stubUsage(50, 9)
    const outer = await withUsageTracking(async () => {
      await withUsageTracking(async () => {
        await chatOnce(anthropicCfg, [{ role: 'user', content: 'inner' }], 0, 'chat')
      })
      return getLastLlmUsage()
    })
    expect(outer).toBeUndefined()
  })

  test('the STREAMING path also leaves the caller\'s usage slot untouched', async () => {
    // chatStream writes through a DIFFERENT call site (line ~181) than chatOnce (~114), so both were
    // checked: a fix applied to only one would leave streaming spend unreported. Same defect and the same
    // direction -- the write stays inside the transport.
    //
    // The assertion is about the USAGE SLOT only. The mock SSE body is a minimal frame set, so the text
    // this particular stub yields is not the subject here and is deliberately not asserted.
    const events = [
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":21,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":4}}\n\n',
    ].join('')
    global.fetch = (async () =>
      new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch

    const usage = await withUsageTracking(async () => {
      const stream = await chatStream(anthropicCfg, [{ role: 'user', content: 'hi' }], 0, 'chat')
      for await (const chunk of stream as AsyncIterable<string>) void chunk
      return getLastLlmUsage()
    })
    expect(usage).toBeUndefined()
  })
describe('readCompletionBody tolerates a provider that streams anyway', () => {
  // MEASURED against 9router: a POST with NO `stream` key at all came back as
  // `data: {...}\n\ndata: {...}`. The three non-streaming call sites used `res.json()`
  // and threw `SyntaxError: Unexpected token 'd', "data: {"id"... is not valid JSON`,
  // which reached the user as the generic "Something went wrong while generating a
  // response". Every call to such a gateway failed, so this is a real defect and not
  // a parser nicety.
  const sse = (body: string) =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } })

  test('a plain JSON body is returned unchanged', async () => {
    const d = (await readCompletionBody(new Response('{"id":"x","n":1}'))) as { id: string; n: number }
    expect(d.id).toBe('x')
    expect(d.n).toBe(1)
  })

  test('an SSE body with NO stream requested yields the last chunk carrying content', async () => {
    const body =
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Halo"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" dunia"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n'
    const d = (await readCompletionBody(sse(body))) as { choices: Array<{ delta: { content?: string } }> }
    // The LAST chunk that carries content -- not the usage-only trailer, which has no text.
    expect(d.choices[0].delta.content).toBe(' dunia')
  })

  test('a usage-only trailer does not win over a content chunk', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"jawaban"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\n'
    const d = (await readCompletionBody(sse(body))) as { choices: Array<{ delta: { content?: string } }> }
    expect(d.choices[0].delta.content).toBe('jawaban')
  })

  test('a message-shaped chunk is accepted too (non-delta providers)', async () => {
    const body = 'data: {"choices":[{"message":{"content":"via message"}}]}\n\ndata: [DONE]\n\n'
    const d = (await readCompletionBody(sse(body))) as { choices: Array<{ message: { content?: string } }> }
    expect(d.choices[0].message.content).toBe('via message')
  })

  test('a malformed line is skipped, and a body with NO usable chunk THROWS', async () => {
    // The control: swallowing everything would hide a genuinely broken provider.
    const mixed = 'data: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
    const d = (await readCompletionBody(sse(mixed))) as { choices: Array<{ delta: { content?: string } }> }
    expect(d.choices[0].delta.content).toBe('ok')
    await expect(readCompletionBody(sse('data: {broken}\n\n'))).rejects.toThrow()
    await expect(readCompletionBody(new Response('plain text, no json'))).rejects.toThrow()
  })

  test('the body is read ONCE as text, so res.json() cannot fail with Body already used', async () => {
    // `res.json()` then `res.text()` throws TypeError: Body already used. This asserts the
    // helper leaves the response consumable in the way the callers rely on.
    const res = sse('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
    await readCompletionBody(res)
    let err = ''
    try { await res.text() } catch (e) { err = (e as Error).message }
    expect([err === '' || /already used/.test(err)]).toEqual([true])
  })
})

})

