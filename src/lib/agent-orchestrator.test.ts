import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { runAgentOrchestrator, type AgentOrchestratorEvent } from './agent-orchestrator'
import { toolCircuitBreaker } from './tool-circuit-breaker'
import type { LlmToolCall } from './llm-client-types'

// Mock LLM runtime config
mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => ({
    provider: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://mock:1234/v1',
    apiKey: 'mock-key',
    model: 'mock-model',
  }),
}))

// Mock cognee recall
mock.module('@/lib/cognee', () => ({
  recallContext: async () => '',
}))

// Mock web search
mock.module('@/lib/web-fetch', () => ({
  webSearch: async (query: string) => ({
    ok: true,
    results: [{ title: 'Result for ' + query, url: 'https://example.com/res', snippet: 'Sample snippet for ' + query }],
  }),
  fetchUrlForPlanner: async (url: string) => ({
    ok: true,
    content: 'Fetched content from ' + url,
  }),
}))

let llmResponses: Array<string | LlmToolCall[]> = []
let capturedMessages: unknown[][] = []

mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, messages: unknown[]) => {
    capturedMessages.push(messages)
    const next = llmResponses.shift()
    if (next === undefined) return 'Default fallback response'
    return next
  },
}))

describe('agent-orchestrator — Dynamic ReAct loop', () => {
  beforeEach(() => {
    llmResponses = []
    capturedMessages = []
    toolCircuitBreaker.reset()
  })

  test('direct conversational answer returns in round 1 without tool calls', async () => {
    llmResponses = ['Hello! How can I assist you with your data today?']

    const events: AgentOrchestratorEvent[] = []
    const result = await runAgentOrchestrator({
      question: 'Hello',
      userId: 'u1',
      onEvent: (ev) => events.push(ev),
    })

    expect(result.answer).toBe('Hello! How can I assist you with your data today?')
    expect(result.iterations).toBe(1)
    expect(result.toolRuns).toHaveLength(0)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })

  test('single tool call executes, observes, and synthesizes final answer', async () => {
    // Round 1: LLM decides to search the web
    // Round 2: LLM synthesizes answer from observation
    llmResponses = [
      [
        {
          id: 'call_1',
          name: 'web_search',
          arguments: JSON.stringify({ query: 'PT Sentosa quarterly revenue' }),
        },
      ],
      'Based on the search results, PT Sentosa reported 45 billion IDR in quarterly revenue.',
    ]

    const events: AgentOrchestratorEvent[] = []
    const result = await runAgentOrchestrator({
      question: 'What is PT Sentosa revenue?',
      userId: 'u1',
      onEvent: (ev) => events.push(ev),
    })

    expect(result.answer).toContain('45 billion IDR')
    expect(result.iterations).toBe(2)
    expect(result.toolRuns).toHaveLength(1)
    expect(result.toolRuns[0].type).toBe('CHAT') // web_search maps to CHAT
    expect(result.toolRuns[0].status).toBe('success')

    // Verify events were emitted properly
    expect(events.some((e) => e.type === 'tool_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_end')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })

  test('parallel tool calls are executed concurrently in one round', async () => {
    llmResponses = [
      [
        {
          id: 'call_search',
          name: 'web_search',
          arguments: JSON.stringify({ query: 'Next.js 16 features' }),
        },
        {
          id: 'call_fetch',
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://nextjs.org/docs' }),
        },
      ],
      'Here is the combined summary from both the search and the documentation page.',
    ]

    const result = await runAgentOrchestrator({
      question: 'Compare search and doc info for Next.js 16',
      userId: 'u1',
    })

    expect(result.iterations).toBe(2)
    expect(result.toolRuns).toHaveLength(2)
    expect(result.answer).toContain('combined summary')
  })

  test('circuit breaker blocks failing tool from crashing the orchestrator', async () => {
    // Trip circuit breaker on web_search
    toolCircuitBreaker.recordFailure('web_search', new Error('timeout 1'))
    toolCircuitBreaker.recordFailure('web_search', new Error('timeout 2'))
    toolCircuitBreaker.recordFailure('web_search', new Error('timeout 3'))
    expect(toolCircuitBreaker.isExecutionAllowed('web_search').allowed).toBe(false)

    llmResponses = [
      [
        {
          id: 'call_broken',
          name: 'web_search',
          arguments: JSON.stringify({ query: 'live stock price' }),
        },
      ],
      'I apologize, but web search is currently down due to repeated failures. I can provide general information instead.',
    ]

    const result = await runAgentOrchestrator({
      question: 'Search stock price',
      userId: 'u1',
    })

    expect(result.iterations).toBe(2)
    expect(result.answer).toContain('currently down')
  })

  test('round limit prevents infinite loops and returns graceful summary', async () => {
    // Model keeps requesting tools repeatedly
    llmResponses = [
      [{ id: 'c1', name: 'direct_chat', arguments: JSON.stringify({ message: 'ping 1' }) }],
      [{ id: 'c2', name: 'direct_chat', arguments: JSON.stringify({ message: 'ping 2' }) }],
      [{ id: 'c3', name: 'direct_chat', arguments: JSON.stringify({ message: 'ping 3' }) }],
      [{ id: 'c4', name: 'direct_chat', arguments: JSON.stringify({ message: 'ping 4' }) }],
    ]

    const result = await runAgentOrchestrator({
      question: 'Loop test',
      userId: 'u1',
      maxRounds: 3,
    })

    expect(result.iterations).toBe(3)
    expect(result.answer).toContain('reached the round limit')
  })
})
