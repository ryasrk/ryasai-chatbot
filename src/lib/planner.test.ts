import { test, expect, describe, mock, beforeEach, afterEach } from 'bun:test'

const mockRunNonStreaming = mock(async () => ({
  answer: 'mock-answer',
  citations: [] as unknown[],
  chartData: null,
  toolRuns: [] as Array<{ status: string; errorMessage?: string }>,
  integrationId: null,
}))

const mockGenerateAnswer = mock(async () => 'synthesized-answer')
const mockGenerateChat = mock(async () => 'fixed-question')
const mockPluginFindFirst = mock(async () => null) as unknown as ReturnType<typeof mock>
const mockExecutePlugin = mock(async () => ({ ok: true, output: 'plugin-output', error: null, latencyMs: 10 }))
const mockCallMcpTool = mock(async () => ({ ok: true, output: 'mcp-output', error: null }))

mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: mockRunNonStreaming,
}))
mock.module('@/lib/ai', () => ({
  generateAnswer: mockGenerateAnswer,
  generateChat: mockGenerateChat,
}))
mock.module('@/lib/cognee', () => ({
  recallContext: async () => null,
  rememberChatTurn: async () => undefined,
}))
mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => ({ id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }),
}))
mock.module('@/lib/db', () => ({
  db: { plugin: { findFirst: mockPluginFindFirst } },
}))
mock.module('@/lib/plugin-registry', () => ({
  executePlugin: mockExecutePlugin,
}))
mock.module('@/lib/mcp-client', () => ({
  callMcpTool: mockCallMcpTool,
}))
// ponytail: deliberately NOT mocking @/lib/admin-tools — bun's mock.module is
// process-global and leaks into admin-tools.test.ts. Per-step confirmation is
// covered by the isStepConfirmed unit tests below instead.

import { topoSort, parsePlanResponse, validatePlan, PlanValidationError, executePlan, planQueryWithTools, synthesizeAnswer, resolveStepInput, isStepConfirmed } from '@/lib/planner'
import type { PlanStep, Plan } from '@/lib/planner'
import type { ToolDef } from '@/lib/tool-registry'

const TOOLS: ToolDef[] = [
  { id: 'sql', description: 'Query DB', paramDescription: '{}', requiresDataSource: 'integration' },
  { id: 'rag', description: 'Search docs', paramDescription: '{}', requiresDataSource: 'document' },
  { id: 'chat', description: 'General chat', paramDescription: '{}', requiresDataSource: 'none' },
  { id: 'web_fetch', description: 'Fetch a URL', paramDescription: '{}', requiresDataSource: 'none' },
]

const originalFetch = global.fetch

function openaiToolCallResponse(args: string) {
  return Promise.resolve(new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_step', arguments: args } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }), { headers: { 'content-type': 'application/json' } }))
}

function openaiTextResponse(text: string) {
  return Promise.resolve(new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  }), { headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  mockRunNonStreaming.mockClear()
  mockGenerateAnswer.mockClear()
  mockGenerateChat.mockClear()
  mockPluginFindFirst.mockClear()
  mockExecutePlugin.mockClear()
  mockCallMcpTool.mockClear()
  mockRunNonStreaming.mockImplementation(async () => ({
    answer: 'mock-answer',
    citations: [],
    chartData: null,
    toolRuns: [],
    integrationId: null,
  }))
  mockGenerateAnswer.mockImplementation(async () => 'synthesized-answer')
  mockGenerateChat.mockImplementation(async () => 'fixed-question')
  global.fetch = mock(async () => openaiTextResponse('no tools')) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('topoSort', () => {
  test('linear deps → correct order', () => {
    const steps: PlanStep[] = [
      { id: 'c', tool: 'chat', input: {}, dependsOn: ['b'] },
      { id: 'b', tool: 'chat', input: {}, dependsOn: ['a'] },
      { id: 'a', tool: 'chat', input: {} },
    ]
    const sorted = topoSort(steps).map((s) => s.id)
    expect(sorted).toEqual(['a', 'b', 'c'])
  })

  test('circular deps → throws', () => {
    const steps: PlanStep[] = [
      { id: 'a', tool: 'chat', input: {}, dependsOn: ['b'] },
      { id: 'b', tool: 'chat', input: {}, dependsOn: ['a'] },
    ]
    expect(() => topoSort(steps)).toThrow()
  })

  test('no deps → original order preserved', () => {
    const steps: PlanStep[] = [
      { id: 'x', tool: 'chat', input: {} },
      { id: 'y', tool: 'sql', input: {} },
    ]
    expect(topoSort(steps).map((s) => s.id)).toEqual(['x', 'y'])
  })

  test('dangling dependsOn → throws', () => {
    const steps: PlanStep[] = [
      { id: 'a', tool: 'chat', input: {}, dependsOn: ['nonexistent'] },
    ]
    expect(() => topoSort(steps)).toThrow()
  })
})

describe('parsePlanResponse', () => {
  test('valid single-step plan', () => {
    const raw = JSON.stringify({
      steps: [{ id: 'step1', tool: 'chat', input: { message: 'hello' } }],
      needsSynthesis: false,
    })
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('chat')
    expect(plan.needsSynthesis).toBe(false)
  })

  test('valid multi-step plan with deps', () => {
    const raw = JSON.stringify({
      steps: [
        { id: 'step1', tool: 'sql', input: { question: 'sales data' } },
        { id: 'step2', tool: 'rag', input: { query: 'return policy' }, dependsOn: ['step1'] },
      ],
      needsSynthesis: true,
    })
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(2)
    expect(plan.needsSynthesis).toBe(true)
  })

  test('malformed JSON → fallback CHAT plan', () => {
    const plan = parsePlanResponse('not json at all', TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('chat')
  })

  test('code-fenced JSON → parsed correctly', () => {
    const raw = '```json\n{"steps":[{"id":"s1","tool":"chat","input":{}}],"needsSynthesis":false}\n```'
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].id).toBe('s1')
  })
})

describe('validatePlan', () => {
  test('tool not in registry → throws', () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'nonexistent', input: {} }],
      needsSynthesis: false,
    }
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })

  test('empty steps → throws', () => {
    const plan: Plan = { steps: [], needsSynthesis: false }
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })
})

describe('executePlan', () => {
  test('linear DAG (A→B→C) → all steps succeed in order', async () => {
    const plan: Plan = {
      steps: [
        { id: 'a', tool: 'chat', input: { message: 'q1' } },
        { id: 'b', tool: 'chat', input: { message: 'q2' }, dependsOn: ['a'] },
        { id: 'c', tool: 'chat', input: { message: 'q3' }, dependsOn: ['b'] },
      ],
      needsSynthesis: false,
    }
    const results = await executePlan({ plan, userId: 'u1' })
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.stepId)).toEqual(['a', 'b', 'c'])
  })

  test('error in one step → others still continue', async () => {
    mockRunNonStreaming.mockImplementationOnce(async () => ({
      answer: 'fail',
      citations: [],
      chartData: null,
      toolRuns: [{ status: 'error', errorMessage: 'SQL failed' }],
      integrationId: null,
    }))
    const plan: Plan = {
      steps: [
        { id: 's1', tool: 'sql', input: { question: 'bad' } },
        { id: 's2', tool: 'chat', input: { message: 'ok' } },
      ],
      needsSynthesis: false,
    }
    const results = await executePlan({ plan, userId: 'u1' })
    expect(results).toHaveLength(2)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('SQL failed')
    expect(results[1].ok).toBe(true)
  })

  test('plugin step → executes via executePlugin', async () => {
    mockPluginFindFirst.mockImplementationOnce(async () => ({
      id: 'p1',
      toolId: 'weather',
      manifestJson: '{}',
      isEnabled: true,
    }))
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'plugin:weather', input: { input: 'Jakarta' } }],
      needsSynthesis: false,
    }
    const results = await executePlan({ plan, userId: 'u1' })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    expect(results[0].output).toBe('plugin-output')
    expect(mockExecutePlugin).toHaveBeenCalledTimes(1)
  })

  test('plugin not found → step fails with error', async () => {
    mockPluginFindFirst.mockImplementationOnce(async () => null)
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'plugin:missing', input: {} }],
      needsSynthesis: false,
    }
    const results = await executePlan({ plan, userId: 'u1' })
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('not found')
  })

  test('mcp step → executes via callMcpTool', async () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'mcp:server1:toolA', input: { arg: '42' } }],
      needsSynthesis: false,
    }
    const results = await executePlan({ plan, userId: 'u1' })
    expect(results[0].ok).toBe(true)
    expect(results[0].output).toBe('mcp-output')
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1)
  })

  test('onStatus callback fires running→done for successful step', async () => {
    const statuses: Array<{ id: string; status: string }> = []
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'chat', input: { message: 'hi' } }],
      needsSynthesis: false,
    }
    await executePlan({
      plan,
      userId: 'u1',
      onStatus: (stepId, _tool, status) => statuses.push({ id: stepId, status }),
    })
    expect(statuses).toEqual([{ id: 's1', status: 'running' }, { id: 's1', status: 'done' }])
  })
})

describe('resolveStepInput', () => {
  const step: PlanStep = {
    id: 'step2',
    tool: 'admin:mcp_install',
    input: { name: 'ctx7', instructions: '{{step1}}' },
    dependsOn: ['step1'],
  }

  test('substitutes a prior step output into the placeholder', () => {
    const resolved = resolveStepInput(step, new Map([['step1', 'npx -y @upstash/context7-mcp']]))
    expect(resolved.input.instructions).toBe('npx -y @upstash/context7-mcp')
    expect(resolved.input.name).toBe('ctx7')
  })

  test('case-insensitive placeholder and whitespace tolerated', () => {
    const s: PlanStep = { id: 'step2', tool: 'chat', input: { message: 'got: {{ Step1 }}' } }
    expect(resolveStepInput(s, new Map([['step1', 'X']])).input.message).toBe('got: X')
  })

  test('missing/failed dependency resolves to empty, never the literal placeholder', () => {
    const resolved = resolveStepInput(step, new Map([['step9', 'unrelated']]))
    expect(resolved.input.instructions).toBe('')
  })

  test('truncates a huge output so it cannot blow the downstream input budget', () => {
    const resolved = resolveStepInput(step, new Map([['step1', 'a'.repeat(20_000)]]))
    expect(resolved.input.instructions.length).toBe(8_000)
  })

  test('returns the original step untouched when no placeholder is present', () => {
    const s: PlanStep = { id: 'step1', tool: 'chat', input: { message: 'plain' } }
    expect(resolveStepInput(s, new Map([['step1', 'X']]))).toBe(s)
  })
})

describe('executePlan — step data flow + per-step confirmation', () => {
  test('dependent step receives the prior step output', async () => {
    const asked: string[] = []
    ;(mockRunNonStreaming as unknown as ReturnType<typeof mock>).mockImplementation(
      async (a: { question: string }) => {
        asked.push(a.question)
        return { answer: 'mock-answer', citations: [], chartData: null, toolRuns: [], integrationId: null }
      },
    )
    const plan: Plan = {
      steps: [
        { id: 'step1', tool: 'chat', input: { message: 'hello' } },
        { id: 'step2', tool: 'chat', input: { message: 'saw: {{step1}}' }, dependsOn: ['step1'] },
      ],
      needsSynthesis: false,
    }
    await executePlan({ plan, userId: 'u1' })
    // step1's output ('mock-answer') must have reached step2's input
    expect(asked).toEqual(['hello', 'saw: mock-answer'])
  })

})

describe('isStepConfirmed', () => {
  const step = (input: Record<string, string>): PlanStep => ({ id: 'step1', tool: 'admin:set_prompt', input })

  test('accepts the confirm spellings the planner is told to emit', () => {
    expect(isStepConfirmed(step({ confirm: 'yes' }))).toBe(true)
    expect(isStepConfirmed(step({ confirm: 'true' }))).toBe(true)
    expect(isStepConfirmed(step({ confirmed: 'yes' }))).toBe(true)
  })

  test('an unconfirmed step is not confirmed by a sibling step', () => {
    // The regression this replaced: executePlan used steps.some(...), so a plan
    // pairing a confirmed install with an unconfirmed set_prompt ran both.
    const confirmed = step({ name: 'a', confirm: 'yes' })
    const sibling = step({ prompt: 'pwned' })
    expect(isStepConfirmed(confirmed)).toBe(true)
    expect(isStepConfirmed(sibling)).toBe(false)
  })

  test('no confirm key → false', () => {
    expect(isStepConfirmed(step({}))).toBe(false)
    expect(isStepConfirmed(step({ confirm: 'no' }))).toBe(false)
  })
})

describe('planQueryWithTools', () => {
  test('LLM returns tool_call → single-step plan built from arguments', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiToolCallResponse(
      JSON.stringify({ steps: [{ id: 'step1', tool: 'sql', input: { question: 'sales' } }], needsSynthesis: false })
    ))
    const plan = await planQueryWithTools({
      question: 'show me sales',
      availableTools: TOOLS,
    })
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(1)
    expect(plan!.steps[0].tool).toBe('sql')
    expect(plan!.steps[0].input.question).toBe('sales')
  })

  // The whole point of the steps[] schema: the function-calling planner must be
  // able to express web_fetch → admin:mcp_install. The old one-step-only shape
  // made this plan impossible, which silently disabled install-from-URL.
  test('LLM returns multi-step tool_call → dependent plan preserved', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiToolCallResponse(
      JSON.stringify({
        steps: [
          { id: 'step1', tool: 'web_fetch', input: { url: 'https://example.com' } },
          { id: 'step2', tool: 'chat', input: { message: '{{step1}}' }, dependsOn: ['step1'] },
        ],
        needsSynthesis: true,
      })
    ))
    const plan = await planQueryWithTools({ question: 'read it', availableTools: TOOLS })
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(2)
    expect(plan!.steps[1].dependsOn).toEqual(['step1'])
    expect(plan!.needsSynthesis).toBe(true)
  })

  test('LLM returns empty tool_calls → null (fallback)', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools needed'))
    const plan = await planQueryWithTools({
      question: 'hello',
      availableTools: TOOLS,
    })
    expect(plan).toBeNull()
  })

  test('LLM returns unknown tool id → null', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiToolCallResponse(
      JSON.stringify({ tool: 'nonexistent', input: {} })
    ))
    const plan = await planQueryWithTools({
      question: 'test',
      availableTools: TOOLS,
    })
    expect(plan).toBeNull()
  })
})

describe('synthesizeAnswer', () => {
  test('all steps successful + needsSynthesis → calls generateAnswer', async () => {
    const plan: Plan = {
      steps: [
        { id: 's1', tool: 'sql', input: {} },
        { id: 's2', tool: 'rag', input: {} },
      ],
      needsSynthesis: true,
    }
    const answer = await synthesizeAnswer({
      question: 'compare sales with policy',
      stepResults: [
        { stepId: 's1', tool: 'sql', ok: true, output: 'sales data', latencyMs: 10 },
        { stepId: 's2', tool: 'rag', ok: true, output: 'policy text', latencyMs: 5 },
      ],
      plan,
    })
    expect(answer).toBe('synthesized-answer')
    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1)
  })

  test('no successful steps → fixed failure message', async () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'sql', input: {} }],
      needsSynthesis: true,
    }
    const answer = await synthesizeAnswer({
      question: 'q',
      stepResults: [
        { stepId: 's1', tool: 'sql', ok: false, output: '', error: 'failed', latencyMs: 1 },
      ],
      plan,
    })
    expect(answer).toContain('no steps completed')
    expect(mockGenerateAnswer).not.toHaveBeenCalled()
  })

  test('single successful step + no synthesis + no external → returns output directly', async () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'chat', input: {} }],
      needsSynthesis: false,
    }
    const answer = await synthesizeAnswer({
      question: 'hi',
      stepResults: [
        { stepId: 's1', tool: 'chat', ok: true, output: 'direct-output', latencyMs: 1 },
      ],
      plan,
    })
    expect(answer).toBe('direct-output')
    expect(mockGenerateAnswer).not.toHaveBeenCalled()
  })

  test('plugin step (external) + no synthesis → still calls generateAnswer', async () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'plugin:weather', input: {} }],
      needsSynthesis: false,
    }
    const answer = await synthesizeAnswer({
      question: 'weather?',
      stepResults: [
        { stepId: 's1', tool: 'plugin:weather', ok: true, output: 'sunny 30C', latencyMs: 1 },
      ],
      plan,
    })
    expect(answer).toBe('synthesized-answer')
    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1)
  })
})
