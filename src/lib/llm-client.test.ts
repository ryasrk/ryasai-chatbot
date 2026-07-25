import { describe, expect, test, mock, afterEach } from 'bun:test'
import { chatOnce, chatStream, chatOnceResponses, runMultiAgentLoop } from './llm-client'
import type { LlmRuntimeConfig } from './llm-config'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
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
