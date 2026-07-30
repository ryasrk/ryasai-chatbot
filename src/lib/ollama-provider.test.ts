import { describe, expect, test, mock, afterEach } from 'bun:test'
import { getOllamaConfig, ollamaChat, ollamaEmbed } from './ollama-provider'

const originalFetch = global.fetch

function mockFetch(response: unknown, ok = true) {
  const f = mock(async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => response,
  } as Response))
  global.fetch = f as unknown as typeof fetch
  return f
}

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.OLLAMA_BASE_URL
  delete process.env.OLLAMA_MODEL
})

describe('getOllamaConfig', () => {
  test('returns null when OLLAMA_BASE_URL not set', () => {
    delete process.env.OLLAMA_BASE_URL
    expect(getOllamaConfig()).toBeNull()
  })

  test('returns config with defaults when base url set', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    delete process.env.OLLAMA_MODEL
    const cfg = getOllamaConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.baseUrl).toBe('http://localhost:11434')
    expect(cfg!.model).toBe('llama3.2')
  })

  test('strips trailing slash and uses custom model', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.local:11434/'
    process.env.OLLAMA_MODEL = 'mistral'
    const cfg = getOllamaConfig()
    expect(cfg!.baseUrl).toBe('http://ollama.local:11434')
    expect(cfg!.model).toBe('mistral')
  })
})

describe('ollamaChat', () => {
  test('returns null when not configured', async () => {
    delete process.env.OLLAMA_BASE_URL
    expect(await ollamaChat([{ role: 'user', content: 'hi' }])).toBeNull()
  })

  test('posts to /api/chat and returns message content', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    const f = mockFetch({ message: { content: 'hello there' } })
    const out = await ollamaChat([{ role: 'user', content: 'hi' }], { temperature: 0.5 })
    expect(out).toBe('hello there')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/chat')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('llama3.2')
    expect(body.stream).toBe(false)
    expect(body.options.temperature).toBe(0.5)
  })

  test('returns empty string when message content missing', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    mockFetch({})
    const out = await ollamaChat([{ role: 'user', content: 'hi' }])
    expect(out).toBe('')
  })

  test('throws on non-ok response', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    mockFetch({}, false)
    expect(ollamaChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Ollama chat failed/)
  })
})

describe('ollamaEmbed', () => {
  test('returns null when not configured', async () => {
    delete process.env.OLLAMA_BASE_URL
    expect(await ollamaEmbed(['hello'])).toBeNull()
  })

  test('posts each text to /api/embeddings and returns vector array', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    const f = mockFetch({ embedding: [0.1, 0.2, 0.3] })
    const out = await ollamaEmbed(['hello', 'world'])
    expect(out).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]])
    expect(f.mock.calls.length).toBe(2)
    const [url] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/embeddings')
  })

  test('returns empty array entry when embedding missing', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    mockFetch({})
    const out = await ollamaEmbed(['hello'])
    expect(out).toEqual([[]])
  })

  test('throws on non-ok response', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    mockFetch({}, false)
    expect(ollamaEmbed(['hello'])).rejects.toThrow(/Ollama embed failed/)
  })
})
