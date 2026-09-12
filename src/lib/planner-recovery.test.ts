/**
 * Tests for the planner's FAILURE and RECOVERY paths.
 *
 * Why a separate file: planner.test.ts covers the happy branches well but never
 * reaches the G10 self-correction path (selfCorrect had zero test references), the
 * MCP per-org rate limit, or "plugin not found". Those branches live inside
 * executeStep's catch block and its early returns. This file mocks
 * @/lib/tool-rate-limit and the toolRun table, which planner.test.ts intentionally
 * does not, so the rate-limit and persistence branches can run.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockRunNonStreaming = mock(async (): Promise<unknown> => ({
  answer: 'mock-answer', citations: [], chartData: null, toolRuns: [] as Array<{ status: string; errorMessage?: string }>,
}))
const mockGenerateChat = mock(async (): Promise<string> => 'reformulated question')
const mockCallMcpTool = mock(async (): Promise<{ ok: boolean; output: string; error?: string }> => ({ ok: true, output: 'mcp-output' }))
const mockPluginFindFirst = mock(async (): Promise<unknown> => null)
const mockExecutePlugin = mock(async (): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> => ({ ok: true, output: 'plugin-output', latencyMs: 10 }))
const mockToolRunCreate = mock(async (_a: unknown): Promise<unknown> => ({}))
const mockRateLimit = mock(async (): Promise<{ allowed: boolean; remaining?: number; limit?: number }> => ({ allowed: true }))
const org = { id: undefined as string | undefined }

mock.module('@/lib/tool-router', () => ({ runNonStreamingChatCompletion: mockRunNonStreaming, runStreamingChatCompletion: mockRunNonStreaming }))
mock.module('@/lib/ai', () => ({ generateAnswer: async () => 'synthesized', generateChat: mockGenerateChat }))
mock.module('@/lib/cognee', () => ({ recallContext: async () => null, rememberChatTurn: async () => undefined }))
mock.module('@/lib/llm-config', () => ({ getLlmRuntimeConfig: async () => ({ id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }) }))
mock.module('@/lib/db', () => ({
  db: {
    plugin: { findFirst: mockPluginFindFirst },
    toolRun: { create: mockToolRunCreate },
  },
}))
mock.module('@/lib/plugin-registry', () => ({ executePlugin: mockExecutePlugin }))
mock.module('@/lib/mcp-client', () => ({ callMcpTool: mockCallMcpTool }))
mock.module('@/lib/web-fetch', () => ({
  fetchUrlForPlanner: async () => ({ ok: true, content: 'page' }),
  webSearch: async () => ({ ok: true, results: [] }),
}))
mock.module('@/lib/tool-rate-limit', () => ({ checkToolRateLimit: mockRateLimit }))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => org.id,
  enterWithOrg: () => {},
  bypassOrg: async (fn: () => Promise<unknown>) => fn(),
}))

import { executePlan } from '@/lib/planner'
import type { Plan, PlanStep } from '@/lib/planner'

async function runStep(step: Partial<PlanStep>) {
  const plan: Plan = { steps: [{ id: 's1', tool: 'mcp:srv1:fs.read', input: {}, dependsOn: [], ...step } as PlanStep], needsSynthesis: false }
  return executePlan({ plan, userId: 'u1' })
}

beforeEach(() => {
  org.id = undefined
  mockRunNonStreaming.mockReset()
  mockRunNonStreaming.mockImplementation(async () => ({ answer: 'mock-answer', citations: [], chartData: null, toolRuns: [] }))
  mockGenerateChat.mockReset()
  mockGenerateChat.mockImplementation(async () => 'reformulated question')
  mockCallMcpTool.mockReset()
  mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'mcp-output' }))
  mockPluginFindFirst.mockReset()
  mockPluginFindFirst.mockImplementation(async () => null)
  mockExecutePlugin.mockReset()
  mockExecutePlugin.mockImplementation(async () => ({ ok: true, output: 'plugin-output', latencyMs: 10 }))
  mockToolRunCreate.mockReset()
  mockToolRunCreate.mockImplementation(async () => ({}))
  mockRateLimit.mockReset()
  mockRateLimit.mockImplementation(async () => ({ allowed: true }))
})

describe('executeStep — MCP rate limit (per-org, before the call)', () => {
  test('a denied rate limit fails the step WITHOUT calling the MCP server', async () => {
    org.id = 'org-1'
    mockRateLimit.mockImplementation(async () => ({ allowed: false }))
    const r = await runStep({ tool: 'mcp:srv1:fs.read' })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('Rate limit exceeded')
    // The whole point of a rate limit is that the work is NOT done.
    expect(mockCallMcpTool).not.toHaveBeenCalled()
  })

  test('the limit is checked for the mcp scope only', async () => {
    org.id = 'org-1'
    await runStep({ tool: 'mcp:srv1:fs.read' })
    expect(mockRateLimit.mock.calls.length).toBeGreaterThan(0)
    const firstCall = mockRateLimit.mock.calls.at(-1) as unknown as [string, string]
    expect(firstCall[0]).toBe('mcp')
    expect(firstCall[1]).toBe('org-1')
  })

  test('with NO org context the limit is skipped and the call proceeds', async () => {
    org.id = undefined
    const r = await runStep({ tool: 'mcp:srv1:fs.read' })
    expect(mockRateLimit).not.toHaveBeenCalled()
    expect(r[0].ok).toBe(true)
  })

  test('an MCP invocation persists a ToolRun row scoped to the org', async () => {
    org.id = 'org-1'
    await runStep({ tool: 'mcp:srv1:fs.read_file', input: { path: '/x' } })
    // MCP observability depends on this row; without it a tool call leaves no trace.
    expect(mockToolRunCreate).toHaveBeenCalled()
    const data = (mockToolRunCreate.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data.organizationId).toBe('org-1')
    expect(data.type).toBe('PLUGIN')
    expect(data.status).toBe('success')
    expect(String(data.inputSummary)).toContain('fs.read_file')
  })

  test('a FAILED MCP call persists status error and the message', async () => {
    org.id = 'org-1'
    mockCallMcpTool.mockImplementation(async () => ({ ok: false, output: '', error: 'dead server' }))
    await runStep({ tool: 'mcp:srv1:fs.read' })
    const data = (mockToolRunCreate.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data.status).toBe('error')
    expect(data.errorMessage).toBe('dead server')
  })

  test('a failing ToolRun write does NOT fail the step (logging must not break the turn)', async () => {
    org.id = 'org-1'
    mockToolRunCreate.mockImplementation(async () => { throw new Error('db down') })
    const r = await runStep({ tool: 'mcp:srv1:fs.read' })
    expect(r[0].ok).toBe(true)
  })
})

describe('executeStep — plugin lookup', () => {
  test('a plugin that is missing or disabled fails with a named reason', async () => {
    mockPluginFindFirst.mockImplementation(async () => null)
    const r = await runStep({ tool: 'plugin:weather' })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('weather')
    expect(r[0].error).toContain('not found')
    // An unknown plugin must not be executed anyway.
    expect(mockExecutePlugin).not.toHaveBeenCalled()
  })

  test('the lookup requires the plugin to be ENABLED', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    await runStep({ tool: 'plugin:weather' })
    const where = (mockPluginFindFirst.mock.calls.at(-1) as unknown as [{ where: Record<string, unknown> }])[0].where
    // A disabled plugin is not a tool the user is allowed to invoke.
    expect(where).toEqual({ toolId: 'weather', isEnabled: true })
  })

  test('an enabled plugin executes and returns its output', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    const r = await runStep({ tool: 'plugin:weather', input: { city: 'Jakarta' } })
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('plugin-output')
    const pluginArgs = mockExecutePlugin.mock.calls.at(-1) as unknown as [{ plugin: { id: string } }]
    expect(pluginArgs[0]).toMatchObject({ plugin: { id: 'p1' } })
  })
})

describe('executeStep — self-correction (G10) after a thrown error', () => {
  test('a thrown plugin error is retried ONCE with a reformulated question', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED 127.0.0.1:9999') })
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'what is the weather' } })
    // The retry is a full chat completion driven by the REFORMULATED question.
    expect(mockGenerateChat).toHaveBeenCalled()
    const prompt = (mockGenerateChat.mock.calls.at(-1) as unknown as [string])[0]
    expect(prompt).toContain('ECONNREFUSED 127.0.0.1:9999')
    expect(prompt).toContain('what is the weather')
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('mock-answer')
  })

  test('an UNCHANGED reformulation is NOT retried (it would re-run the same failure)', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('boom') })
    // generateChat echoes the original question verbatim.
    mockGenerateChat.mockImplementation((async (p: string) => {
      const m = p.match(/Original question: "(.*)" failed/)
      return m ? m[1] : p
    }) as unknown as () => Promise<string>)
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'same question' } })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('boom')
  })

  test('an EMPTY reformulation is NOT retried', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('boom') })
    mockGenerateChat.mockImplementation(async () => '   ')
    const r = await runStep({ tool: 'plugin:weather' })
    expect(r[0].ok).toBe(false)
  })

  test('a failure during the retry itself is swallowed and the ORIGINAL error survives', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('original failure') })
    mockGenerateChat.mockImplementation(async () => { throw new Error('llm unavailable') })
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'q' } })
    // A broken correction path must not replace the real reason with its own.
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('original failure')
    expect(r[0].error).not.toContain('llm unavailable')
  })

  test('the retry reads the question from any of the accepted input keys', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('x') })
    await runStep({ tool: 'plugin:weather', input: { query: 'from-query-key' } })
    const prompt = (mockGenerateChat.mock.calls.at(-1) as unknown as [string])[0]
    expect(prompt).toContain('from-query-key')
  })

  test('a step whose retry succeeds is reported ok, not failed', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('transient') })
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'q' } })
    expect(r[0].ok).toBe(true)
    expect(r[0].error).toBeUndefined()
  })

  test('the recovery path makes exactly ONE extra completion, never a loop', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('first') })
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'q' } })
    // Bounded recovery: one retry completion for the whole step.
    expect(mockRunNonStreaming.mock.calls.length).toBe(1)
    expect(r[0].ok).toBe(true)
  })

  test('a retry whose answer is EMPTY counts as no recovery, and the step fails', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather', isEnabled: true }))
    mockExecutePlugin.mockImplementationOnce(async () => { throw new Error('first') })
    // selfCorrect returns the completion's ANSWER, and an empty answer is falsy —
    // so `if (!corrected)` sends the step down the failure branch. Measured: with
    // answer:'' the step was ok:false while the retry call itself did happen.
    mockRunNonStreaming.mockImplementation(async () => ({ answer: '', citations: [], chartData: null, toolRuns: [] }))
    const r = await runStep({ tool: 'plugin:weather', input: { question: 'q' } })
    expect(mockRunNonStreaming).toHaveBeenCalledTimes(1)
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('first')
  })
})

describe('executeStep — a chat step whose tool runs failed', () => {
  test('a failed nested tool run fails the step and carries the tool error', async () => {
    mockRunNonStreaming.mockImplementation(async () => ({
      answer: 'partial answer', citations: [], chartData: null,
      toolRuns: [{ status: 'error', errorMessage: 'SQL timeout' }],
    }))
    const r = await runStep({ tool: 'unknown-tool', input: { question: 'q' } })
    expect(r[0].ok).toBe(false)
    // The nested tool error is more useful than a generic "failed".
    expect(r[0].error).toBe('SQL timeout')
    // The answer so far is preserved as output so the synthesizer can use it.
    expect(r[0].output).toBe('partial answer')
  })

  test('ALL failed nested runs (not just one) trigger the failure path', async () => {
    mockRunNonStreaming.mockImplementation(async () => ({
      answer: 'a', citations: [], chartData: null,
      toolRuns: [{ status: 'blocked', errorMessage: 'guardrail' }, { status: 'error', errorMessage: 'second' }],
    }))
    const r = await runStep({ tool: 'unknown-tool', input: { question: 'q' } })
    expect(r[0].ok).toBe(false)
  })

  test('a failed run with NO errorMessage falls back to a generic reason', async () => {
    mockRunNonStreaming.mockImplementation(async () => ({
      answer: 'a', citations: [], chartData: null, toolRuns: [{ status: 'error' }],
    }))
    const r = await runStep({ tool: 'unknown-tool', input: { question: 'q' } })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toBe('Tool execution failed')
  })

  test('a successful chat step reports the answer', async () => {
    mockRunNonStreaming.mockImplementation(async () => ({
      answer: 'the answer', citations: [], chartData: null, toolRuns: [{ status: 'success' }],
    }))
    const r = await runStep({ tool: 'unknown-tool', input: { question: 'q' } })
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('the answer')
  })
})
