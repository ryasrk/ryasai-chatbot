import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { z } from 'zod'
import { extractJson, chatWithSchema } from './constrained-output'

const mockChatOnce = mock(async () => '')

mock.module('@/lib/llm-client', () => ({
  chatOnce: mockChatOnce,
  chatStream: async function* () {},
}))

const MOCK_CFG = { id: 'c', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' } as const

const NameSchema = z.object({ name: z.string(), age: z.number().int().positive() })

beforeEach(() => {
  mockChatOnce.mockClear()
  mockChatOnce.mockImplementation(async () => '')
})

describe('extractJson', () => {
  test('parses plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  test('parses plain JSON array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  test('extracts JSON from surrounding text', () => {
    const raw = 'Here is the answer:\n{"name":"Alice","age":30}\nDone.'
    expect(extractJson(raw)).toEqual({ name: 'Alice', age: 30 })
  })

  test('extracts array from surrounding text', () => {
    const raw = 'Result: [{"x":1},{"x":2}] end'
    expect(extractJson(raw)).toEqual([{ x: 1 }, { x: 2 }])
  })

  test('throws when no JSON found', () => {
    expect(() => extractJson('no json here')).toThrow('No valid JSON found')
  })
})

describe('chatWithSchema', () => {
  test('succeeds on first try with valid JSON', async () => {
    mockChatOnce.mockImplementation(async () => JSON.stringify({ name: 'Alice', age: 25 }))
    const result = await chatWithSchema(MOCK_CFG as never, [{ role: 'user', content: 'test' }], NameSchema)
    expect(result).toEqual({ name: 'Alice', age: 25 })
    expect(mockChatOnce).toHaveBeenCalledTimes(1)
  })

  test('retries on Zod validation failure', async () => {
    mockChatOnce
      .mockImplementationOnce(async () => JSON.stringify({ name: 'Alice', age: -5 }))
      .mockImplementationOnce(async () => JSON.stringify({ name: 'Alice', age: 25 }))
    const result = await chatWithSchema(MOCK_CFG as never, [{ role: 'user', content: 'test' }], NameSchema, 2)
    expect(result).toEqual({ name: 'Alice', age: 25 })
    expect(mockChatOnce).toHaveBeenCalledTimes(2)
  })

  test('retries on JSON parse failure', async () => {
    mockChatOnce
      .mockImplementationOnce(async () => 'not json at all')
      .mockImplementationOnce(async () => JSON.stringify({ name: 'Bob', age: 30 }))
    const result = await chatWithSchema(MOCK_CFG as never, [{ role: 'user', content: 'test' }], NameSchema, 2)
    expect(result).toEqual({ name: 'Bob', age: 30 })
    expect(mockChatOnce).toHaveBeenCalledTimes(2)
  })

  test('throws after max retries exceeded', async () => {
    mockChatOnce.mockImplementation(async () => 'not json')
    await expect(chatWithSchema(MOCK_CFG as never, [{ role: 'user', content: 'test' }], NameSchema, 1)).rejects.toThrow(
      'chatWithSchema failed after 2 attempts',
    )
    expect(mockChatOnce).toHaveBeenCalledTimes(2)
  })

  test('succeeds with JSON embedded in prose', async () => {
    mockChatOnce.mockImplementation(async () => 'Sure! Here: {"name":"Carol","age":40} hope that helps')
    const result = await chatWithSchema(MOCK_CFG as never, [{ role: 'user', content: 'test' }], NameSchema)
    expect(result).toEqual({ name: 'Carol', age: 40 })
  })
})
