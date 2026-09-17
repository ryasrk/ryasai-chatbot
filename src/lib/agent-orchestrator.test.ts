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
    // Round 1: LLM decides to fetch a URL
    // Round 2: LLM synthesizes answer from observation
    //
    // Uses `web_fetch`, not `web_search`. This test is about the ReAct LOOP —
    // call, observe, synthesize — and `web_search` is now conditional: it is
    // omitted when no search backend is reachable (no SearXNG and the DuckDuckGo
    // fallback unreachable), so depending on it would make this test's subject
    // depend on the network. `web_fetch` is unconditional and exercises the same
    // loop.
    llmResponses = [
      [
        {
          id: 'call_1',
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://example.com/pt-sentosa' }),
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
    expect(result.toolRuns[0].type).toBe('CHAT') // web_fetch maps to CHAT
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
          id: 'call_rest',
          name: 'call_rest_api',
          arguments: JSON.stringify({ endpoint: 'nextjs-release-notes', params: {} }),
        },
        {
          id: 'call_fetch',
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://nextjs.org/docs' }),
        },
      ],
      'Here is the combined summary from both the API and the documentation page.',
    ]

    const result = await runAgentOrchestrator({
      question: 'Compare API and doc info for Next.js 16',
      userId: 'u1',
    })

    expect(result.iterations).toBe(2)
    expect(result.toolRuns).toHaveLength(2)
    expect(result.answer).toContain('combined summary')
  })

  test('circuit breaker blocks failing tool from crashing the orchestrator', async () => {
    // Trip circuit breaker on `rest`, chosen because it is UNCONDITIONAL. Using
    // `web_search` would make this test depend on whether a search backend is
    // reachable, which is now a deployment fact rather than a code fact.
    toolCircuitBreaker.recordFailure('rest', new Error('timeout 1'))
    toolCircuitBreaker.recordFailure('rest', new Error('timeout 2'))
    toolCircuitBreaker.recordFailure('rest', new Error('timeout 3'))
    expect(toolCircuitBreaker.isExecutionAllowed('rest').allowed).toBe(false)

    llmResponses = [
      [
        {
          id: 'call_broken',
          name: 'call_rest_api',
          arguments: JSON.stringify({ endpoint: 'live-stock-price', params: {} }),
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

  test('a PARTIAL failure in a parallel round preserves the successes', async () => {
    // Two tools in one round, one of which fails. The failing call must not
    // discard the successful observation — the model needs it to continue.
    mock.module('@/lib/web-fetch', () => ({
      webSearch: async () => ({ ok: false, results: [], error: 'search backend unreachable' }),
      fetchUrlForPlanner: async () => ({ ok: true, content: 'WIKI_BODY: Argentina won 4-2 on penalties.' }),
    }))

    llmResponses = [
      [
        { id: 'ok1', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://en.wikipedia.org/wiki/x' }) },
        { id: 'bad1', name: 'web_search', arguments: JSON.stringify({ query: 'anything' }) },
      ],
      'From the fetched page: Argentina won 4-2 on penalties.',
    ]

    const result = await runAgentOrchestrator({ question: 'who won?', userId: 'u1', maxRounds: 3 })

    const statuses = result.toolRuns.map((r) => r.status).sort()
    expect(statuses).toEqual(['error', 'success'])
    // The successful output must survive into the final answer's grounding.
    expect(result.answer).toContain('4-2')
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
    // The fallback must REPORT what the tools returned, not discard it. A bare
    // "reached the round limit" apology throws away work the user paid tokens
    // for — the same defect class as the empty-evidence disclaimer this repo
    // already fixed once.
    expect(result.answer).toContain('what the tools returned')
    expect(result.toolRuns.length).toBeGreaterThan(0)
  })

  test('round limit with ZERO successful tools says so plainly, without inventing content', async () => {
    // Every tool call targets a name that does not exist, so all runs fail.
    llmResponses = Array.from({ length: 4 }, (_, i) => [
      { id: `c${i}`, name: 'no_such_tool', arguments: '{}' },
    ])

    const result = await runAgentOrchestrator({
      question: 'Impossible',
      userId: 'u1',
      maxRounds: 2,
    })

    expect(result.answer).toContain('every tool I tried failed')
    // Must not fabricate an answer from nothing.
    expect(result.answer).not.toContain('what the tools returned')
  })
})
