import { describe, expect, test, mock, afterEach } from 'bun:test'
import { chatOnce, chatStream } from './llm-client'
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
