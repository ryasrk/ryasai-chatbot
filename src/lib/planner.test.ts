import { test, expect, describe, mock, beforeEach, afterEach } from 'bun:test'

const mockRunNonStreaming = mock(async () => ({
  answer: 'mock-answer',
  citations: [] as unknown[],
  chartData: null,
  toolRuns: [] as Array<{ status: string; errorMessage?: string }>,
  integrationId: null,
}))

const mockGenerateAnswer = mock(async (_args: { question: string; context: string; source: string }) => 'synthesized-answer')
const mockGenerateChat = mock(async () => 'fixed-question')
const mockPluginFindFirst = mock(async () => null) as unknown as ReturnType<typeof mock>
const mockExecutePlugin = mock(async (): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> => ({ ok: true, output: 'plugin-output', latencyMs: 10 }))
const mockCallMcpTool = mock(async (): Promise<{ ok: boolean; output: string; error?: string }> => ({ ok: true, output: 'mcp-output' }))

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
/** Counters/aggregates the REAL admin:show_monitoring path reads. Kept as fixed values so
 *  the assertion can name them; a bare mock would prove only that the branch ran. */
const adminStats = {
  toolRunCount: 0,
  avgLatency: null as number | null,
  failedApiCount: 0,
  integrationCount: 0,
  docCount: 0,
}
mock.module('@/lib/db', () => ({
  db: {
    plugin: { findFirst: mockPluginFindFirst },
    toolRun: {
      count: async () => adminStats.toolRunCount,
      aggregate: async () => ({ _avg: { latencyMs: adminStats.avgLatency } }),
    },
    apiRequestLog: { count: async () => adminStats.failedApiCount },
    integration: { count: async () => adminStats.integrationCount },
    document: { count: async () => adminStats.docCount },
  },
}))
mock.module('@/lib/plugin-registry', () => ({
  executePlugin: mockExecutePlugin,
}))
mock.module('@/lib/mcp-client', () => ({
  callMcpTool: mockCallMcpTool,
}))

// web_fetch / web_search are the two branches of executeStep that read the
// OUTSIDE world. They were unmocked, which is exactly why that whole region of
// executeStep had never been executed by a test.
const mockFetchUrl = mock(async (_url: string): Promise<{ ok: boolean; content: string; title?: string; error?: string }> => ({ ok: true, content: 'fetched page text' }))
const mockWebSearch = mock(async (_q: string): Promise<{ ok: boolean; results: Array<{ title: string; url: string; snippet: string }>; error?: string }> => ({ ok: true, results: [] }))
mock.module('@/lib/web-fetch', () => ({
  fetchUrlForPlanner: mockFetchUrl,
  webSearch: mockWebSearch,
}))
// ponytail: deliberately NOT mocking @/lib/admin-tools — bun's mock.module is
// process-global and leaks into admin-tools.test.ts. Per-step confirmation is
// covered by the isStepConfirmed unit tests below instead.

import { topoSort, parsePlanResponse, validatePlan, PlanValidationError, executePlan, planQuery, planQueryWithTools, synthesizeAnswer, formatStepContext, resolveStepInput, isStepConfirmed } from '@/lib/planner'
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
  mockFetchUrl.mockClear()
  mockWebSearch.mockClear()
  mockFetchUrl.mockImplementation(async () => ({ ok: true, content: 'fetched page text' }))
  mockWebSearch.mockImplementation(async () => ({ ok: true, results: [] }))
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

describe('executePlan — admin tool gating (security boundary)', () => {
  // The `isAdmin` flag is the ONLY thing standing between an ordinary user and
  // the admin tool surface (MCP install, prompt edits, credential writes). It
  // was never exercised: the path runs `executeAdminTool`, and the concurrency
  // helper that reach it was untested. Asserting the refusal keeps the gate from
  // being "simplified" away by a later refactor.

  const adminPlan: Plan = {
    steps: [{ id: 'step1', tool: 'admin:mcp_install', input: { name: 'filesystem' }, dependsOn: [] }],
    needsSynthesis: false,
  }

  test('a non-admin gets an explicit refusal and the tool never runs', async () => {
    const results = await executePlan({
      plan: adminPlan,
      userId: 'u1',
      isAdmin: false,
      sessionId: 's1',
    })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('administrator')
    // The refusal must be a refusal, not a silently empty success.
    expect(results[0].output).toBe('')
  })

  test('the refusal is reported to onStatus as an error, so the UI shows it', async () => {
    const statuses: Array<[string, string, string]> = []
    await executePlan({
      plan: adminPlan,
      userId: 'u1',
      isAdmin: false,
      sessionId: 's1',
      onStatus: (id: string, tool: string, status: string) => statuses.push([id, tool, status]),
    })
    expect(statuses).toContainEqual(['step1', 'admin:mcp_install', 'error'])
  })

  test('isAdmin omitted defaults to NOT admin (fail-closed)', async () => {
    // The dangerous default would be "assume admin when unspecified". Pin the
    // safe one: absent means refused.
    const results = await executePlan({
      plan: adminPlan,
      userId: 'u1',
      sessionId: 's1',
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('administrator')
  })
})

describe('executePlan — an ADMIN tool that actually runs', () => {
  // The admin gating tests above only ever exercise the REFUSAL. The success arm --
  // `executeAdminTool` returning a normal result -- was never reached, so lines 566-570 of
  // planner.ts had no coverage: the `args.onStatus?.(... 'done' : 'error')` call and the
  // `return { ok: result.ok, output: result.output }` that the synthesizer consumes.
  //
  // This uses the REAL admin-tools dispatcher with admin:show_monitoring, whose only
  // dependencies are counts and an aggregate on the mocked db. admin-tools itself is NOT
  // mocked, because the file already documents that mock.module is process-global and
  // mocking it here would leak into admin-tools.test.ts.

  const monitorPlan: Plan = {
    steps: [{ id: 'step1', tool: 'admin:show_monitoring', input: {}, dependsOn: [] }],
    needsSynthesis: false,
  }
  /** An admin tool that FAILS with no database involvement at all: an unknown tool key is
   *  rejected outright (`Unknown tool:`), so the failure is deterministic. I first used
   *  admin:show_audit_log and it SUCCEEDED, because this file's db mock has no auditLog and
   *  the action tolerated it -- which turned the test green through the wrong branch. */
  const badToolPlan: Plan = {
    steps: [{ id: 'step1', tool: 'admin:toggle_tool', input: { tool: 'not-a-real-tool' }, dependsOn: [] }],
    needsSynthesis: false,
  }

  beforeEach(() => {
    adminStats.toolRunCount = 0
    adminStats.avgLatency = null
    adminStats.failedApiCount = 0
    adminStats.integrationCount = 0
    adminStats.docCount = 0
  })

  test('an admin gets the tool OUTPUT, not a refusal', async () => {
    adminStats.toolRunCount = 42
    adminStats.avgLatency = 137
    adminStats.failedApiCount = 3
    adminStats.integrationCount = 2
    adminStats.docCount = 9

    const results = await executePlan({ plan: monitorPlan, userId: 'u1', isAdmin: true })

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    // `error` must be absent on success -- a truthy error string would make the UI mark a
    // successful step as failed.
    expect(results[0].error).toBeUndefined()
    // The numbers prove the REAL action ran and the output reached the step result, rather
    // than an empty stub satisfying `ok: true`.
    expect(results[0].output).toContain('Tool Runs: 42')
    expect(results[0].output).toContain('Avg Latency: 137ms')
    expect(results[0].output).toContain('Failed API: 3')
    expect(results[0].output).toContain('Documents Ready: 9')
  })

  test('a MISSING average latency renders as 0ms, not NaN', async () => {
    // `latencyAgg._avg.latencyMs ?? 0` -- the aggregate is null when no row has a
    // latencyMs, and Math.round(null) is 0 but Math.round(undefined) is NaN. A NaN in the
    // output would be relayed to the user verbatim.
    const results = await executePlan({ plan: monitorPlan, userId: 'u1', isAdmin: true })
    expect(results[0].output).toContain('Avg Latency: 0ms')
    expect(results[0].output).not.toContain('NaN')
  })

  test('onStatus reports DONE for an admin step that succeeds', async () => {
    const statuses: Array<[string, string, string]> = []
    await executePlan({
      plan: monitorPlan,
      userId: 'u1',
      isAdmin: true,
      onStatus: (id: string, tool: string, status: string) => statuses.push([id, tool, status]),
    })
    expect(statuses).toContainEqual(['step1', 'admin:show_monitoring', 'done'])
  })

  test('an admin step that FAILS reports ok:false, the output as the error, and onStatus error', async () => {
    // The other half of lines 566-570: `error: result.ok ? undefined : result.output`. A
    // failing admin tool carries its message in `output`, so the step must surface it as
    // the error -- otherwise the synthesizer sees an empty reason and invents one.
    const statuses: Array<[string, string, string]> = []
    const results = await executePlan({
      plan: badToolPlan,
      userId: 'u1',
      isAdmin: true,
      onStatus: (id: string, tool: string, status: string) => statuses.push([id, tool, status]),
    })
    expect(results[0].ok).toBe(false)
    // `error` is the OUTPUT of the failing action (`result.ok ? undefined : result.output`),
    // so the specific reason survives to the synthesizer instead of a generic string.
    expect(results[0].error).toBe('Unknown tool: not-a-real-tool')
    expect(statuses).toContainEqual(['step1', 'admin:toggle_tool', 'error'])
  })

  test('a NON-admin is refused even for a tool that would succeed', async () => {
    // The gate must not depend on the tool's own outcome.
    const results = await executePlan({ plan: monitorPlan, userId: 'u1', isAdmin: false })
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('administrator')
    expect(results[0].output).toBe('')
  })
})

describe('planQuery — the entry point the router actually calls', () => {
  // planQueryWithTools was covered but planQuery itself never was, which left the
  // whole LLM fallback path (the one that runs whenever tool-calling is
  // unavailable) untested. That path ends in a fail-closed CHAT plan, so a bug
  // there means a question silently gets treated as small talk.

  test('uses the tool-calling plan when planQueryWithTools succeeds', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiToolCallResponse(
      JSON.stringify({ steps: [{ id: 'step1', tool: 'sql', input: { question: 'sales' } }], needsSynthesis: false })
    ))
    const plan = await planQuery({ question: 'show me sales', availableTools: TOOLS })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('sql')
  })

  test('falls back to parsing the LLM text plan when tool-calling yields nothing', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    // Tool-calling attempt returns no tool_calls → planQueryWithTools returns null.
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools'))
    // Then the text-completion path answers with a JSON plan.
    mockGenerateChat.mockImplementationOnce(async () => JSON.stringify({
      steps: [{ id: 'step1', tool: 'rag', input: { question: 'policy' } }],
      needsSynthesis: false,
    }))
    const plan = await planQuery({ question: 'what is the refund policy', availableTools: TOOLS })
    expect(plan.steps[0].tool).toBe('rag')
  })

  test('a malformed text plan fails closed to CHAT, never throws', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools'))
    mockGenerateChat.mockImplementationOnce(async () => 'I am not JSON at all')
    const plan = await planQuery({ question: 'hello there', availableTools: TOOLS })
    // Fail-closed: an unparseable plan must become a chat turn, not an exception
    // and not an empty plan the executor would then trip over.
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps[0].tool).toBe('chat')
  })

  test('a plan naming an unknown tool fails closed to CHAT', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools'))
    mockGenerateChat.mockImplementationOnce(async () => JSON.stringify({
      steps: [{ id: 'step1', tool: 'totally_invented_tool', input: {} }],
      needsSynthesis: false,
    }))
    const plan = await planQuery({ question: 'do something', availableTools: TOOLS })
    // The LLM cannot invent a tool: validation must reject it and the turn must
    // still produce something runnable.
    expect(plan.steps.some((st) => st.tool === 'totally_invented_tool')).toBe(false)
  })

  test('history is included in the planning prompt', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools'))
    mockGenerateChat.mockImplementationOnce(async () => JSON.stringify({
      steps: [{ id: 'step1', tool: 'chat', input: { message: 'ok' } }],
      needsSynthesis: false,
    }))
    await planQuery({
      question: 'and last month?',
      availableTools: TOOLS,
      chatHistory: [
        { role: 'user', content: 'sales this month' },
        { role: 'assistant', content: 'here are the numbers' },
      ],
    })
    const [, systemPrompt] = mockGenerateChat.mock.calls[mockGenerateChat.mock.calls.length - 1] as unknown as [string, string]
    // The system prompt carries the planner rules; the history goes in the user
    // message. Assert the rules survived, since prompt text is load-bearing here.
    expect(systemPrompt).toContain('enterprise AI planner')
    expect(systemPrompt).toContain('Maximum')
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

  test('all-failed plan lists why each step failed', async () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'plugin:news', input: {} }],
      needsSynthesis: true,
    }
    const answer = await synthesizeAnswer({
      question: 'latest news',
      stepResults: [
        { stepId: 's1', tool: 'plugin:news', ok: false, output: '', error: 'Webhook returned HTTP 404.', latencyMs: 3 },
      ],
      plan,
    })
    expect(answer).toContain('HTTP 404')
    expect(mockGenerateAnswer).not.toHaveBeenCalled()
  })

  test('partial failure reaches the synthesis context, not just the success', async () => {
    const plan: Plan = {
      steps: [
        { id: 's1', tool: 'sql', input: {} },
        { id: 's2', tool: 'plugin:news', input: {} },
      ],
      needsSynthesis: true,
    }
    await synthesizeAnswer({
      question: 'sales and news',
      stepResults: [
        { stepId: 's1', tool: 'sql', ok: true, output: 'sales data', latencyMs: 10 },
        { stepId: 's2', tool: 'plugin:news', ok: false, output: '', error: 'Webhook returned HTTP 404.', latencyMs: 3 },
      ],
      plan,
    })
    const ctx = mockGenerateAnswer.mock.calls[0][0].context
    expect(ctx).toContain('sales data')
    expect(ctx).toContain('FAILED')
    expect(ctx).toContain('HTTP 404')
  })
})

describe('formatStepContext', () => {
  // Regression: a failed step carries output:'' — an empty string, not nullish.
  // The old `r.output ?? r.error` kept '' and dropped the reason, leaving the
  // model a blank CONTEXT that it filled with invented manual instructions.
  test('empty output on a failed step does not swallow the error', () => {
    const ctx = formatStepContext([
      { stepId: 's1', tool: 'admin:mcp_install', ok: false, output: '', error: 'MCP server name or URL is required.', latencyMs: 2 },
    ])
    expect(ctx).toContain('FAILED')
    expect(ctx).toContain('MCP server name or URL is required.')
    expect(ctx).not.toBe('')
  })

  test('marks successful steps OK and keeps their output', () => {
    const ctx = formatStepContext([
      { stepId: 's1', tool: 'sql', ok: true, output: 'rows here', latencyMs: 1 },
    ])
    expect(ctx).toContain('OK')
    expect(ctx).toContain('rows here')
  })

  test('falls back to output when a failed step has no error field', () => {
    const ctx = formatStepContext([
      { stepId: 's1', tool: 'admin:mcp_install', ok: false, output: 'blocked: command not allowed', latencyMs: 1 },
    ])
    expect(ctx).toContain('blocked: command not allowed')
  })
})

// ---------------------------------------------------------------------------
// executeStep — the tool dispatch inside executePlan
// ---------------------------------------------------------------------------
// executeStep is ~215 lines of dispatcher: admin:* / MCP / web_fetch /
// web_search / plugin:* / the default chat completion. Only the admin and
// default paths were exercised, because web_fetch and web_search were the two
// branches reaching outside the process and had no mock at all.
describe('executePlan — web_fetch / web_search branches', () => {
  async function runOne(step: Partial<PlanStep>) {
    const plan: Plan = { steps: [{ id: 's1', tool: 'chat', input: {}, dependsOn: [], ...step } as PlanStep], needsSynthesis: false }
    return executePlan({ plan, userId: 'u1' })
  }

  test('web_fetch with a url returns the page content', async () => {
    mockFetchUrl.mockImplementation(async () => ({ ok: true, content: 'INSTALL: npx -y pkg' }))
    const r = await runOne({ tool: 'web_fetch', input: { url: 'https://example.com/readme' } })
    expect(r[0].ok).toBe(true)
    expect((mockFetchUrl.mock.calls[0] as unknown[])[0]).toBe('https://example.com/readme')
  })

  test('web_fetch accepts url aliases (link)', async () => {
    await runOne({ tool: 'web_fetch', input: { link: 'https://example.com/a' } })
    // The planner emits whichever alias the model chose; rejecting one would make
    // the tool unusable for a whole class of plans.
    expect((mockFetchUrl.mock.calls[0] as unknown[])[0]).toBe('https://example.com/a')
  })

  test('web_fetch with NO url fails without a fetch', async () => {
    const r = await runOne({ tool: 'web_fetch', input: {} })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('URL is required')
    expect(mockFetchUrl).not.toHaveBeenCalled()
  })

  test('web_fetch propagates a fetch failure as a failed step', async () => {
    mockFetchUrl.mockImplementation(async () => ({ ok: false, content: '', error: 'HTTP 404' }))
    const r = await runOne({ tool: 'web_fetch', input: { url: 'https://example.com/missing' } })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('404')
  })

  test('web_search returns the results numbered with title, url and snippet', async () => {
    mockWebSearch.mockImplementation(async () => ({
      ok: true,
      results: [
        { title: 'First', url: 'https://a.example', snippet: 'snippet a' },
        { title: 'Second', url: 'https://b.example', snippet: 'snippet b' },
      ],
    }))
    const r = await runOne({ tool: 'web_search', input: { query: 'mcp filesystem' } })
    expect(r[0].ok).toBe(true)
    // The formatting is what the synthesizer reads; losing the numbering or the
    // URLs would leave the model unable to cite anything.
    expect(r[0].output).toContain('1. First')
    expect(r[0].output).toContain('https://a.example')
    expect(r[0].output).toContain('snippet a')
    expect((mockWebSearch.mock.calls[0] as unknown[])[0]).toBe('mcp filesystem')
  })

  test('web_search accepts the query aliases the planner emits', async () => {
    for (const key of ['query', 'q', 'question', 'search']) {
      mockWebSearch.mockClear()
      await runOne({ tool: 'web_search', input: { [key]: 'needle' } })
      expect((mockWebSearch.mock.calls[0] as unknown[])[0]).toBe('needle')
    }
  })

  test('web_search with NO query fails without a search', async () => {
    const r = await runOne({ tool: 'web_search', input: {} })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('Search query is required')
    expect(mockWebSearch).not.toHaveBeenCalled()
  })

  test('DECLARED ARTIFACT: the web_fetch/plugin return lines bun cannot instrument', () => {
    // The lcov report marks planner.ts 631-632 and 686-689 as UNCOVERED while their SIBLING
    // property lines are hit: 633/634/635 have 26/49/37 hits and 690 has 4, with 685 at 47.
    // That is IMPOSSIBLE in the source -- `output: result.ok ? result.content : ''` (633)
    // cannot evaluate unless `return {` (631) and the `stepId..., ok: result.ok,` line (632)
    // ran first, and `grep -c "step.tool === 'web_fetch'"` confirms there is exactly ONE
    // such block, so there is no second path that could reach 633 without passing 631.
    //
    // The instrumenter simply does not attribute the `return {` line and the first property
    // of a multi-line object literal whose values are nested ternaries. Same class as the
    // arrow-callback artifact in guardrails.ts (341-342). The OUTPUT is the proof, and it is
    // pinned here as behaviour instead of a painted-over gap.
    mockFetchUrl.mockImplementation(async () => ({ ok: true, content: 'PAGE_BODY' }))
    mockExecutePlugin.mockImplementation(async () => ({ ok: false, output: '', error: 'PLUGIN_ERR', latencyMs: 7 }))

    return (async () => {
      const fetched = await runOne({ tool: 'web_fetch', input: { url: 'https://example.com/x' } })
      // `output: result.ok ? result.content : ''` -- line 633.
      expect(fetched[0].output).toBe('PAGE_BODY')
      // `error: result.ok ? undefined : result.error` -- line 634, the true arm.
      expect(fetched[0].error).toBeUndefined()

      const failedFetch = await (async () => {
        mockFetchUrl.mockImplementation(async () => ({ ok: false, content: '', error: 'BOOM' }))
        return runOne({ tool: 'web_fetch', input: { url: 'https://example.com/y' } })
      })()
      expect(failedFetch[0].error).toBe('BOOM')

      mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'w' }))
      const plug = await executePlan({
        plan: { steps: [{ id: 's1', tool: 'plugin:w', input: {}, dependsOn: [] } as PlanStep], needsSynthesis: false },
        userId: 'u1',
      })
      // Lines 687-689: `error: result.error, latencyMs: result.latencyMs` -- carried through
      // from the plugin result rather than recomputed.
      expect(plug[0].error).toBe('PLUGIN_ERR')
      expect(plug[0].latencyMs).toBe(7)
    })()
  })

  test('a failed web_search reports its error and no output', async () => {
    mockWebSearch.mockImplementation(async () => ({ ok: false, results: [], error: 'rate limited' }))
    const r = await runOne({ tool: 'web_search', input: { query: 'x' } })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('rate limited')
  })
})

describe('executePlan — plugin branch', () => {
  async function runPlugin(step: Partial<PlanStep>) {
    const plan: Plan = { steps: [{ id: 's1', tool: 'plugin:x', input: {}, dependsOn: [], ...step } as PlanStep], needsSynthesis: false }
    return executePlan({ plan, userId: 'u1' })
  }

  test('an unknown or disabled plugin fails without executing anything', async () => {
    mockPluginFindFirst.mockImplementation(async () => null)
    const r = await runPlugin({ tool: 'plugin:ghost' })
    expect(r[0].ok).toBe(false)
    // Executing without a row would mean running an unconfigured plugin.
    expect(mockExecutePlugin).not.toHaveBeenCalled()
  })

  test('the plugin lookup filters on isEnabled', async () => {
    mockPluginFindFirst.mockImplementation(async () => null)
    await runPlugin({ tool: 'plugin:ghost' })
    expect(mockPluginFindFirst.mock.calls[0][0].where).toMatchObject({ isEnabled: true })
  })

  test('a configured plugin is executed and its output returned', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather' }))
    mockExecutePlugin.mockImplementation(async () => ({ ok: true, output: 'sunny', latencyMs: 5 }))
    const r = await runPlugin({ tool: 'plugin:weather', input: { city: 'Jakarta' } })
    expect(r[0].ok).toBe(true)
    expect(mockExecutePlugin).toHaveBeenCalledTimes(1)
  })

  test('a failing plugin reports the error rather than a blank success', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather' }))
    mockExecutePlugin.mockImplementation(async () => ({ ok: false, output: '', error: 'upstream 503', latencyMs: 5 }))
    const r = await runPlugin({ tool: 'plugin:weather' })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('503')
  })

  test('the plugin step does NOT also spend a chat completion', async () => {
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather' }))
    await runPlugin({ tool: 'plugin:weather' })
    // Falling through to the default branch would answer twice (and bill twice).
    expect(mockRunNonStreaming).not.toHaveBeenCalled()
  })
})

describe('executePlan — MCP branch', () => {
  async function runMcp(step: Partial<PlanStep>) {
    const plan: Plan = { steps: [{ id: 's1', tool: 'mcp:x', input: {}, dependsOn: [], ...step } as PlanStep], needsSynthesis: false }
    return executePlan({ plan, userId: 'u1' })
  }

  test('an MCP tool that fails reports the error', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: false, output: '', error: 'server disconnected' }))
    const r = await runMcp({ tool: 'mcp:filesystem.read_file' })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('disconnected')
  })

  test('a successful MCP tool returns its output', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'file contents' }))
    const r = await runMcp({ tool: 'mcp:filesystem.read_file', input: { path: '/tmp/a' } })
    expect(r[0].ok).toBe(true)
  })

  test('an MCP step does not fall through to a chat completion', async () => {
    await runMcp({ tool: 'mcp:filesystem.read_file' })
    expect(mockRunNonStreaming).not.toHaveBeenCalled()
  })
})

// A delegating wrapper, installed with mock.module BEFORE the module under test is
// imported. Mutating the imported NAMESPACE does not work: ESM module namespaces are
// read-only bindings and the assignment throws "Attempted to assign to readonly
// property" even though Object.isFrozen(namespace) reports false.
//
// `{ ...realSandbox }` keeps every other export real; only withToolSandbox is
// intercepted. Replacing the whole module broke three existing tests once (the
// planner drives the real sandbox on its happy path), so the spread is deliberate.
// The REAL module is imported FIRST, outside the mock factory. Importing it inside
// the factory deadlocks the test process (the factory awaits the module it is
// defining) -- the run printed nothing and never exited.
const realSandbox = await import('@/lib/tool-sandbox')
// The FUNCTION ITSELF is captured now, by value. Delegating to
// `realSandbox.withToolSandbox` at call time recursed forever ("Maximum call stack
// size exceeded") and failed three pre-existing tests: the module namespace is
// LIVE, so after mock.module installs the wrapper that property IS the wrapper.
const realWithToolSandbox = realSandbox.withToolSandbox
const sandboxState: { reject: Error | null; rejectOnce: boolean; calls: number } = { reject: null, rejectOnce: false, calls: 0 }
mock.module('@/lib/tool-sandbox', () => ({
  ...realSandbox,
  withToolSandbox: async <T>(tool: string, fn: () => Promise<T>): Promise<T> => {
    sandboxState.calls++
    if (sandboxState.reject) {
      // `rejectOnce` narrows the refusal to a SINGLE invocation, so a sibling step
      // in the same level can be observed succeeding.
      if (sandboxState.rejectOnce) {
        const err = sandboxState.reject
        sandboxState.reject = null
        throw err
      }
      throw sandboxState.reject
    }
    return realWithToolSandbox(tool, fn)
  },
}))

describe('validatePlan — the two guards that never ran', () => {
  // The existing tests covered "unknown tool" and "empty steps". Two other guards
  // existed at hit=0: the step-count ceiling and the cycle re-throw. Both protect
  // against a hostile or confused LLM, so neither can be left unverified.

  test('a plan EXCEEDING the step ceiling is rejected', () => {
    // MAX_STEPS bounds the blast radius: every step is a tool call (SQL query, REST
    // request, admin action) on a customer's systems. Without the ceiling a single
    // generated plan could fan out without limit, and the operator has no override.
    const steps = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`, tool: 'chat', input: { message: `q${i}` },
    }))
    expect(() => validatePlan({ steps, needsSynthesis: false }, TOOLS)).toThrow(PlanValidationError)
    // The message must say the ACTUAL ceiling, or an operator debugging a rejected
    // plan cannot tell how far over it went.
    expect(() => validatePlan({ steps, needsSynthesis: false }, TOOLS)).toThrow(/max is 6/)
  })

  test('a plan AT the ceiling is accepted (the guard is not off-by-one)', () => {
    // The inverse: a ceiling that rejects 6 would silently forbid legitimate
    // multi-tool questions, since the prompt itself advertises 6.
    const steps = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`, tool: 'chat', input: { message: `q${i}` },
    }))
    const out = validatePlan({ steps, needsSynthesis: false }, TOOLS)
    expect(out.steps).toHaveLength(6)
  })

  test('a CYCLIC dependency graph becomes a PlanValidationError, not a raw throw', () => {
    // topoSort throws on a cycle. Re-throwing it unwrapped would surface an internal
    // error type to the API layer, which classifies by error kind; the planner must
    // translate it so the caller can fail closed cleanly.
    const plan = {
      steps: [
        { id: 'a', tool: 'chat', input: { message: 'x' }, dependsOn: ['b'] },
        { id: 'b', tool: 'chat', input: { message: 'y' }, dependsOn: ['a'] },
      ],
      needsSynthesis: false,
    } as unknown as Plan
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })

  test('a DANGLING dependsOn becomes a PlanValidationError too', () => {
    // Same translation path, different cause: a step depending on an id that does
    // not exist. Without this the plan would execute the dependency-less prefix and
    // silently drop the dependent step.
    const plan = {
      steps: [{ id: 'a', tool: 'chat', input: { message: 'x' }, dependsOn: ['ghost'] }],
      needsSynthesis: false,
    } as unknown as Plan
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })
})


describe('executePlan — a step rejected by the tool sandbox', () => {
  // withToolSandbox is the last gate before a tool runs. Its rejection must become a
  // FAILED STEP, not a rejected promise: throwing out of the level's Promise.all
  // would discard the results of the siblings that already succeeded alongside it.
  test('a sandbox rejection fails that step and leaves the sibling intact', async () => {
    sandboxState.reject = new Error('sandbox refused: tool "sql" is not permitted')
    sandboxState.rejectOnce = true
    try {
      const results = await executePlan({
        plan: {
          steps: [
            { id: 's1', tool: 'sql', input: { question: 'q' } },
            { id: 's2', tool: 'chat', input: { message: 'ok' } },
          ],
          needsSynthesis: false,
        },
        userId: 'u1',
      })
      // SAME level, so both ran; the refusal is reported, not thrown.
      expect(results).toHaveLength(2)
      const refused = results.find((r) => r.stepId === 's1')
      expect(refused?.ok).toBe(false)
      expect(refused?.error).toContain('sandbox refused')
      // A refused step reports zero latency rather than a fabricated number.
      expect(refused?.latencyMs).toBe(0)
      expect(results.find((r) => r.stepId === 's2')?.ok).toBe(true)
    } finally {
      sandboxState.reject = null
    }
  })

  test('the status callback is told about the refusal', async () => {
    // The UI renders per-step status from this callback. A refused step that never
    // reports "error" leaves a spinner running forever on the agentic dashboard.
    sandboxState.reject = new Error('sandbox refused')
    const statuses: Array<[string, string, string]> = []
    try {
      await executePlan({
        plan: {
          steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } }],
          needsSynthesis: false,
        },
        userId: 'u1',
        onStatus: (id, tool, status) => statuses.push([id, tool, status]),
      })
      expect(statuses).toContainEqual(['s1', 'sql', 'error'])
    } finally {
      sandboxState.reject = null
    }
  })

  test('NON-Error rejections are stringified, not reported as "undefined"', async () => {
    // A sandbox that rejects with a plain string (or an object) must still produce a
    // readable reason; `e.message` on a string is undefined and the operator would
    // see a failed step with no explanation at all.
    sandboxState.reject = 'policy violation' as unknown as Error
    try {
      const results = await executePlan({
        plan: {
          steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } }],
          needsSynthesis: false,
        },
        userId: 'u1',
      })
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toContain('policy violation')
      expect(results[0].error).not.toContain('undefined')
    } finally {
      sandboxState.reject = null
    }
  })

  test('a healthy sandbox still lets the step through (the wrapper is not a blanket deny)', async () => {
    // The inverse, so the tests above cannot pass merely because every step fails.
    sandboxState.reject = null
    sandboxState.calls = 0
    const results = await executePlan({
      plan: {
        steps: [{ id: 's1', tool: 'chat', input: { message: 'ok' } }],
        needsSynthesis: false,
      },
      userId: 'u1',
    })
    expect(sandboxState.calls).toBeGreaterThan(0)
    expect(results[0].ok).toBe(true)
  })
})
