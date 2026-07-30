import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockChatOnce = mock(async () => '')
const mockGetRoleLlmConfig = mock(async (): Promise<unknown> => null)

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: mockGetRoleLlmConfig,
  getLlmRuntimeConfig: mockGetRoleLlmConfig,
}))

import { selfCritique } from './reflexion'

const MOCK_CONFIG = { id: 'c', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }

beforeEach(() => {
  mockChatOnce.mockClear()
  mockGetRoleLlmConfig.mockClear()
  mockChatOnce.mockImplementation(async () => '')
  mockGetRoleLlmConfig.mockImplementation(async () => null)
})

describe('selfCritique', () => {
  test('returns no revision when answer is empty', async () => {
    const result = await selfCritique('q', '', 'evidence')
    expect(result.needsRevision).toBe(false)
    expect(result.revisedAnswer).toBe('')
    expect(mockChatOnce).not.toHaveBeenCalled()
  })

  test('returns no revision when no LLM configured', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => null)
    const result = await selfCritique('q', 'an answer', 'evidence')
    expect(result.needsRevision).toBe(false)
    expect(result.revisedAnswer).toBe('an answer')
  })

  test('parses needsRevision=true and uses revisedAnswer', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({
        critique: 'missing the date',
        revisedAnswer: 'The policy was updated in 2024 and allows 12 days.',
        needsRevision: true,
      }),
    )
    const result = await selfCritique('what is the leave policy', 'It allows 12 days.', 'evidence here')
    expect(result.needsRevision).toBe(true)
    expect(result.critique).toBe('missing the date')
    expect(result.revisedAnswer).toBe('The policy was updated in 2024 and allows 12 days.')
  })

  test('parses needsRevision=false keeping original answer', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ critique: 'answer is complete', revisedAnswer: 'original', needsRevision: false }),
    )
    const result = await selfCritique('q', 'original answer', 'evidence')
    expect(result.needsRevision).toBe(false)
    expect(result.revisedAnswer).toBe('original')
  })

  test('handles markdown-fenced JSON', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      '```json\n{"critique":"x","revisedAnswer":"fixed","needsRevision":true}\n```',
    )
    const result = await selfCritique('q', 'orig', 'evidence')
    expect(result.needsRevision).toBe(true)
    expect(result.revisedAnswer).toBe('fixed')
  })

  test('falls back to no revision on LLM error', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => { throw new Error('boom') })
    const result = await selfCritique('q', 'orig', 'evidence')
    expect(result.needsRevision).toBe(false)
    expect(result.revisedAnswer).toBe('orig')
  })

  test('falls back to no revision on malformed JSON', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => 'not json')
    const result = await selfCritique('q', 'orig', 'evidence')
    expect(result.needsRevision).toBe(false)
    expect(result.revisedAnswer).toBe('orig')
  })
})
