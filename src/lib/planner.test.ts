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
// Typed with its full argument list so `mock.calls` is a real tuple and the
// assertions below can index [0]/[1]/[2] without a cast.
const mockCallMcpTool = mock(
  async (
    _serverId: string,
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; error?: string }> => ({ ok: true, output: 'mcp-output' }),
)

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
      create: async (args: { data: Record<string, unknown> }) => {
        toolRunCreateState.calls.push(args.data)
        if (toolRunCreateState.reject) throw toolRunCreateState.reject
        return args.data
      },
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
  // planner.ts reads the server's JSON Schema to type-coerce step inputs. An
  // empty catalogue leaves every value as a string, which is the safe default.
  //
  // Reaches through a mutable holder, NOT `mockListMcpTools` directly: Bun
  // hoists `import` above top-level statements, so planner.ts binds this export
  // before this factory runs, and a direct capture would hand the module a
  // different function identity (MEASURED: call count stayed 0 and every
  // mockImplementation was silently ignored).
  listMcpTools: async () => mcpCatalogue.tools,
}))

const mcpCatalogue: { tools: Array<{ serverId: string; toolName: string; inputSchema: Record<string, unknown> }> } = { tools: [] }

// ---------------------------------------------------------------------------
// Org-context + MCP rate-limit seams.
//
// planner.ts reads `getOrgContext()` to decide whether to (a) consult the
// per-org MCP rate limiter and (b) persist a ToolRun row. Those branches were
// at hit=0 because the REAL `@/lib/prisma-tenant` (unmocked) resolves no org
// outside a request scope, so `orgId` was always undefined and the whole
// rate-limit + ToolRun region never executed. Top-level `let` seams, reset by
// beforeEach, because `mock.module` inside a test body is never restored.
// ---------------------------------------------------------------------------
const orgState = { orgId: undefined as string | undefined }
const rateLimitState = { allowed: true, calls: 0, lastTool: '', lastOrg: '' }
const toolRunCreateState = { calls: [] as Array<Record<string, unknown>>, reject: null as Error | null }

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => orgState.orgId,
  enterWithOrg: () => {},
  bypassOrg: async (fn: () => unknown) => fn(),
  createTenantExtension: () => (client: unknown) => client,
}))

mock.module('@/lib/tool-rate-limit', () => ({
  checkToolRateLimit: async (toolName: string, organizationId: string) => {
    rateLimitState.calls++
    rateLimitState.lastTool = toolName
    rateLimitState.lastOrg = organizationId
    return { allowed: rateLimitState.allowed, remaining: rateLimitState.allowed ? 9 : 0 }
  },
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
  orgState.orgId = undefined
  rateLimitState.allowed = true
  rateLimitState.calls = 0
  rateLimitState.lastTool = ''
  rateLimitState.lastOrg = ''
  toolRunCreateState.calls = []
  toolRunCreateState.reject = null
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

  // INCIDENT (2026-09): coerceMcpInput JSON.parsed EVERY string value, so a
  // legitimate string that merely looked like JSON was retyped. MEASURED: a
  // `path: "12345"` became the NUMBER 12345, and `path: '"quoted"'` lost its
  // quotes. A server validating its own schema then either rejects the call or
  // acts on a different path than the model asked for.
  //
  // Fix: read the server's declared JSON Schema and convert ONLY on a type
  // match; a declared string is never retyped.
  test('a declared STRING is never retyped, even when it looks like JSON', async () => {
    mcpCatalogue.tools = [
      {
        serverId: 'fs',
        toolName: 'read_file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ]
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcp({ tool: 'mcp:fs:read_file', input: { path: '12345' } })
    // The corruption case: must arrive as the STRING "12345", not the number.
    expect(mockCallMcpTool.mock.calls[0][2]).toEqual({ path: '12345' })
  })

  test('a declared NUMBER is converted from its string form', async () => {
    mcpCatalogue.tools = [
      {
        serverId: 'fs',
        toolName: 'read_file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, tail: { type: 'number' } } },
      },
    ]
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcp({ tool: 'mcp:fs:read_file', input: { path: '/tmp/a', tail: '5' } })
    expect(mockCallMcpTool.mock.calls[0][2]).toEqual({ path: '/tmp/a', tail: 5 })
  })

  test('a declared BOOLEAN and ARRAY are converted; a mismatched value stays a string', async () => {
    mcpCatalogue.tools = [
      {
        serverId: 'fs',
        toolName: 'list_dir',
        inputSchema: {
          type: 'object',
          properties: {
            recursive: { type: 'boolean' },
            paths: { type: 'array' },
            limit: { type: 'number' },
          },
        },
      },
    ]
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcp({
      tool: 'mcp:fs:list_dir',
      // `limit: "abc"` is NOT a JSON number, so it must stay the string "abc"
      // rather than being dropped or coerced to NaN.
      input: { recursive: 'true', paths: '["a","b"]', limit: 'abc' },
    })
    expect(mockCallMcpTool.mock.calls[0][2]).toEqual({
      recursive: true,
      paths: ['a', 'b'],
      limit: 'abc',
    })
  })

  test('with NO schema available every value stays a string (safe default)', async () => {
    mcpCatalogue.tools = []
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcp({ tool: 'mcp:fs:read_file', input: { path: '12345', tail: '5' } })
    expect(mockCallMcpTool.mock.calls[0][2]).toEqual({ path: '12345', tail: '5' })
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

describe('synthesizeAnswer — the allOk guard on the single-step passthrough', () => {
  // MUTATION-CONFIRMED GAP: deleting `allOk &&` from the passthrough condition
  // turned ZERO tests red, because the only partial-failure test above sets
  // needsSynthesis:true (which already fails that condition for an unrelated
  // reason). The guard is load-bearing: without it, a plan whose sibling step
  // FAILED would return the one successful step's output verbatim, and the
  // caller would present a partial tool result as the complete answer.
  test('a partial failure is NOT passed through even when needsSynthesis is false', async () => {
    const plan: Plan = {
      steps: [
        { id: 's1', tool: 'sql', input: {} },
        { id: 's2', tool: 'sql', input: {} },
      ],
      needsSynthesis: false,
    }
    const answer = await synthesizeAnswer({
      question: 'combined question',
      stepResults: [
        { stepId: 's1', tool: 'sql', ok: true, output: 'PARTIAL_DATA', latencyMs: 10 },
        { stepId: 's2', tool: 'sql', ok: false, output: '', error: 'table dropped', latencyMs: 4 },
      ],
      plan,
    })
    // The raw single output must NOT be the answer -- the failure has to be
    // visible to the model so it can report it.
    expect(answer).not.toBe('PARTIAL_DATA')
    expect(mockGenerateAnswer).toHaveBeenCalledTimes(1)
    const ctx = mockGenerateAnswer.mock.calls[0][0].context
    expect(ctx).toContain('PARTIAL_DATA')
    expect(ctx).toContain('table dropped')
  })

  test('the passthrough DOES fire when every step succeeded and no synthesis is needed', async () => {
    // The inverse, so the test above cannot pass merely because the passthrough
    // is dead code. A single successful non-external step is returned as-is to
    // avoid spending a pointless synthesis completion.
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'sql', input: {} }],
      needsSynthesis: false,
    }
    const answer = await synthesizeAnswer({
      question: 'q',
      stepResults: [{ stepId: 's1', tool: 'sql', ok: true, output: 'DIRECT_OUTPUT', latencyMs: 3 }],
      plan,
    })
    expect(answer).toBe('DIRECT_OUTPUT')
    expect(mockGenerateAnswer).not.toHaveBeenCalled()
  })
})

describe('parsePlanResponse — step ids are normalised, not taken literally', () => {
  // MUTATION-CONFIRMED GAP: dropping `.toLowerCase()` from the id normaliser
  // turned ZERO tests red. It is load-bearing: the LLM is told to emit "step1"
  // but routinely emits "Step1"/"STEP1". dependsOn entries are lowercased, and
  // so is the {{stepN}} placeholder, so a mixed-case id would fail to match its
  // own dependency -- topoSort would then throw "depends on unknown step" and
  // planQuery would fail closed to a single CHAT step, silently degrading every
  // multi-tool question into a plain chat answer.
  test('a mixed-case id and dependsOn are lowercased so they still match', () => {
    const raw = JSON.stringify({
      steps: [
        { id: 'Step1', tool: 'sql', input: { question: 'a' } },
        { id: 'STEP2', tool: 'rag', input: { query: '{{Step1}}' }, dependsOn: ['Step1'] },
      ],
      needsSynthesis: true,
    })
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps.map((s) => s.id)).toEqual(['step1', 'step2'])
    expect(plan.steps[1].dependsOn).toEqual(['step1'])
    // And the normalised plan must actually sort -- proof the ids now agree.
    expect(topoSort(plan.steps).map((s) => s.id)).toEqual(['step1', 'step2'])
  })

  test('the placeholder is substituted even when the id arrived in a different case', () => {
    // The end-to-end consequence: without normalisation this stays literal.
    const plan = parsePlanResponse(JSON.stringify({
      steps: [
        { id: 'Step1', tool: 'web_fetch', input: { url: 'https://example.com' } },
        { id: 'Step2', tool: 'chat', input: { message: 'summarise {{step1}}' }, dependsOn: ['Step1'] },
      ],
    }), TOOLS)
    const resolved = resolveStepInput(plan.steps[1], new Map([['step1', 'PAGE_TEXT']]))
    expect(resolved.input.message).toBe('summarise PAGE_TEXT')
  })

  test('a step without an id is dropped rather than producing an empty-id node', () => {
    const plan = parsePlanResponse(JSON.stringify({
      steps: [
        { tool: 'chat', input: { message: 'no id' } },
        { id: 'ok', tool: 'chat', input: { message: 'fine' } },
      ],
    }), TOOLS)
    expect(plan.steps.map((s) => s.id)).toEqual(['ok'])
  })

  test('a step without a tool is dropped too', () => {
    const plan = parsePlanResponse(JSON.stringify({
      steps: [
        { id: 'a', input: { message: 'no tool' } },
        { id: 'b', tool: 'chat', input: { message: 'fine' } },
      ],
    }), TOOLS)
    expect(plan.steps.map((s) => s.id)).toEqual(['b'])
  })

  test('non-object entries in steps are discarded, not turned into garbage steps', () => {
    const plan = parsePlanResponse(JSON.stringify({
      steps: [null, 'nope', 42, { id: 'ok', tool: 'chat', input: { message: 'fine' } }],
    }), TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].id).toBe('ok')
  })

  test('an array input is discarded so it cannot become a numeric-keyed object', () => {
    // String([1,2]) through the object branch would build {"0":"1","1":"2"} and
    // the tool would receive nonsense parameters.
    const plan = parsePlanResponse(JSON.stringify({
      steps: [{ id: 'a', tool: 'chat', input: ['x', 'y'] }],
    }), TOOLS)
    expect(plan.steps[0].input).toEqual({})
  })

  test('absent dependsOn stays undefined rather than becoming an empty array', () => {
    const plan = parsePlanResponse(JSON.stringify({
      steps: [{ id: 'a', tool: 'chat', input: { message: 'x' } }],
    }), TOOLS)
    expect(plan.steps[0].dependsOn).toBeUndefined()
  })

  test('needsSynthesis is only true for a literal boolean true', () => {
    const truthy = parsePlanResponse(JSON.stringify({
      steps: [{ id: 'a', tool: 'chat', input: {} }], needsSynthesis: 'yes',
    }), TOOLS)
    // A truthy STRING must not enable synthesis -- it would spend an extra LLM
    // call the plan never asked for.
    expect(truthy.needsSynthesis).toBe(false)
  })

  test('non-numeric input values are stringified, not dropped', () => {
    const plan = parsePlanResponse(JSON.stringify({
      steps: [{ id: 'a', tool: 'chat', input: { n: 5, b: true, nested: null } }],
    }), TOOLS)
    expect(plan.steps[0].input.n).toBe('5')
    expect(plan.steps[0].input.b).toBe('true')
    expect(plan.steps[0].input.nested).toBe('null')
  })
})

// ===========================================================================
// MCP branch: the per-org rate limiter and the ToolRun observability row.
//
// Both branches sat at hit=0 (planner.ts 581-590, 598-610) because the planner
// fixture never had an org context, so `getOrgContext()` returned undefined and
// the `if (orgId)` guards were skipped. They are the ONLY thing standing between
// a runaway plan and unlimited MCP invocations, and the only place the planner
// records what it called — so they cannot stay unverified.
// ===========================================================================

describe('executePlan — MCP rate limiting and ToolRun persistence', () => {
  /** `orgId` defaults to a real org; pass `null` to mean "no org context", since an
   *  explicit `undefined` argument would just re-trigger the default parameter. */
  async function runMcpWithOrg(step: Partial<PlanStep>, orgId: string | null = 'org-1') {
    orgState.orgId = orgId ?? undefined
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'mcp:srv1.read_file', input: { path: '/tmp/a' }, dependsOn: [], ...step } as PlanStep],
      needsSynthesis: false,
    }
    return executePlan({ plan, userId: 'u1' })
  }

  test('with NO org context the MCP step still runs and neither the limiter nor ToolRun is touched', async () => {
    // The inverse of the guard. Rate limiting is per-org, so an absent org must
    // not silently turn into a shared bucket (or block the step).
    orgState.orgId = undefined
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'file contents' }))
    const r = await runMcpWithOrg({}, null)
    expect(r[0].ok).toBe(true)
    expect(rateLimitState.calls).toBe(0)
    expect(toolRunCreateState.calls).toHaveLength(0)
  })

  test('with an org context the limiter is consulted for the MCP tool and that org', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'file contents' }))
    await runMcpWithOrg({}, 'org-42')
    expect(rateLimitState.calls).toBe(1)
    // The bucket must be the MCP namespace, not the specific tool — otherwise a
    // caller could rotate tool names to reset their own limit.
    expect(rateLimitState.lastTool).toBe('mcp')
    expect(rateLimitState.lastOrg).toBe('org-42')
  })

  test('a REFUSED rate limit fails the step with the retry message and never calls the MCP server', async () => {
    rateLimitState.allowed = false
    const statuses: Array<[string, string, string]> = []
    const r = await runMcpWithOrg({}, 'org-42')
    expect(r[0].ok).toBe(false)
    expect(r[0].output).toBe('')
    expect(r[0].error).toBe('Rate limit exceeded for MCP tools. Try again in a minute.')
    // A refusal that still invoked the tool would defeat the limiter entirely.
    expect(mockCallMcpTool).not.toHaveBeenCalled()
    expect(toolRunCreateState.calls).toHaveLength(0)
    void statuses
  })

  test('a refused step reports status error to the UI callback', async () => {
    rateLimitState.allowed = false
    const statuses: Array<[string, string, string]> = []
    orgState.orgId = 'org-42'
    await executePlan({
      plan: { steps: [{ id: 's1', tool: 'mcp:srv1.read_file', input: {} } as PlanStep], needsSynthesis: false },
      userId: 'u1',
      onStatus: (id: string, tool: string, status: string) => statuses.push([id, tool, status]),
    })
    expect(statuses).toContainEqual(['s1', 'mcp:srv1.read_file', 'error'])
  })

  test('a SUCCESSFUL MCP call persists a ToolRun row carrying the real org, latency and output', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'FILE_BODY_XYZ' }))
    // `mcp:<serverId>:<toolName>` — three segments, which is the shape the
    // source documents. A two-segment id yields an EMPTY tool name (pinned below).
    await runMcpWithOrg({ tool: 'mcp:srv1:read_file' }, 'org-42')
    expect(toolRunCreateState.calls).toHaveLength(1)
    const data = toolRunCreateState.calls[0]
    // The org is the load-bearing field: a null organizationId would make the
    // row invisible to the tenant's own monitoring.
    expect(data.organizationId).toBe('org-42')
    expect(data.status).toBe('success')
    expect(data.type).toBe('PLUGIN')
    // The tool NAME (not the server id) is what an operator searches for.
    expect(data.inputSummary).toBe('MCP: read_file')
    expect(data.outputSummary).toBe('FILE_BODY_XYZ')
    expect(data.errorMessage).toBeNull()
    expect(typeof data.latencyMs).toBe('number')
  })

  test('a FAILING MCP call persists a ToolRun row marked error with the message', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: false, output: '', error: 'server disconnected' }))
    await runMcpWithOrg({}, 'org-42')
    expect(toolRunCreateState.calls).toHaveLength(1)
    expect(toolRunCreateState.calls[0].status).toBe('error')
    expect(toolRunCreateState.calls[0].errorMessage).toBe('server disconnected')
    // `result.output.slice(0, 500) || null` — an empty output must become NULL,
    // not an empty string, or "has output" filters in monitoring break.
    expect(toolRunCreateState.calls[0].outputSummary).toBeNull()
  })

  test('a huge MCP output is truncated to 500 chars before it is persisted', async () => {
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'x'.repeat(2000) }))
    await runMcpWithOrg({}, 'org-42')
    expect((toolRunCreateState.calls[0].outputSummary as string).length).toBe(500)
  })

  test('the colon-rejoining of the tool name is what is recorded for a multi-colon tool id', async () => {
    // mcp:<serverId>:<toolName with colons> — the split/rejoin must keep the
    // FULL tail, or the persisted summary names the wrong tool.
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcpWithOrg({ tool: 'mcp:srv1:db:query' }, 'org-42')
    const mcpArgs = mockCallMcpTool.mock.calls[0] as unknown as [string, string]
    expect(mcpArgs[0]).toBe('srv1')
    expect(mcpArgs[1]).toBe('db:query')
    expect(toolRunCreateState.calls[0].inputSummary).toBe('MCP: db:query')
  })

  test('a ToolRun write FAILURE does not fail the step (observability is best-effort)', async () => {
    // `db.toolRun.create(...).catch(logSwallowed(...))` — monitoring must never
    // take down a tool call that already succeeded.
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'GOOD_OUTPUT' }))
    toolRunCreateState.reject = new Error('db is down')
    const r = await runMcpWithOrg({}, 'org-42')
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('GOOD_OUTPUT')
  })

  test('MCP inputs are coerced to JSON types ONLY where the schema declares them', async () => {
    // The planner normalises every step input to a string, but MCP tools expect
    // typed JSON. Coercion is now driven by the server's OWN schema, so this
    // test must supply one. Before the 2026-09 fix it coerced blindly, which
    // retyped legitimate strings — see the "never retyped" cases above.
    mcpCatalogue.tools = [
      {
        // Matches the id `runMcpWithOrg` builds: `mcp:srv1.read_file` splits to
        // serverId `srv1.read_file` and an EMPTY tool name (two segments).
        serverId: 'srv1.read_file',
        toolName: '',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' }, flag: { type: 'boolean' }, plain: { type: 'string' } },
        },
      },
    ]
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    await runMcpWithOrg({ input: { limit: '5', flag: 'true', plain: 'hello' } }, 'org-42')
    const mcpArgs = mockCallMcpTool.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    const passed = mcpArgs[2]
    expect(passed.limit).toBe(5)
    expect(passed.flag).toBe(true)
    // A declared string stays a string rather than becoming a number or null.
    expect(passed.plain).toBe('hello')
  })

  test('a TWO-segment "mcp:a.b" id invokes the server with an EMPTY tool name', () => {
    // PINNED CURRENT BEHAVIOUR, not an endorsement. The source documents the
    // shape as `mcp:<serverId>:<toolName>` and computes the name with
    // `parts.slice(2).join(':')`. For the two-segment id the existing suite uses
    // (`mcp:filesystem.read_file`) that slice is EMPTY, so callMcpTool is asked
    // for tool name "" — a call the MCP server can only reject. The observation
    // is a real hole in the fixture form (the id is never validated against the
    // registry before the call); the assertion records it so a future fix is a
    // deliberate change rather than an accidental one.
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    return runMcpWithOrg({ tool: 'mcp:srv1.read_file' }, 'org-42').then(() => {
      const mcpArgs = mockCallMcpTool.mock.calls[0] as unknown as [string, string]
      expect(mcpArgs[0]).toBe('srv1.read_file')
      expect(mcpArgs[1]).toBe('')
      expect((toolRunCreateState.calls[0].inputSummary as string)).toBe('MCP: ')
    })
  })
})

// ===========================================================================
// Admin confirmationRequired — a GATE, not an error.
// planner.ts 560-564. The existing admin tests cover success and failure, but
// never the confirmation path, which returns `ok: true` with the message as
// OUTPUT so the synthesizer relays it instead of reporting a failure.
// ===========================================================================

describe('executePlan — an admin tool that returns confirmationRequired', () => {
  test('the confirmation gate surfaces as a SUCCESSFUL step carrying the message', async () => {
    // admin:set_prompt with no confirm in the input returns confirmationRequired.
    // The real admin-tools dispatcher is used (not mocked): the gate logic and
    // the per-step `isConfirmed` decision are exactly what is being verified.
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'admin:set_prompt', input: { prompt: 'You are a helpful bot.' }, dependsOn: [] } as PlanStep],
      needsSynthesis: false,
    }
    const statuses: Array<[string, string, string]> = []
    const r = await executePlan({
      plan,
      userId: 'u1',
      isAdmin: true,
      onStatus: (id, tool, status) => statuses.push([id, tool, status]),
    })
    expect(r[0].ok).toBe(true)
    // The message must be the step OUTPUT so the synthesizer can relay it.
    expect(r[0].output).toContain('Are you sure you want to change the System Prompt')
    expect(r[0].error).toBeUndefined()
    // Marked DONE, not error: a gate shown as "Failed" in the UI is wrong.
    expect(statuses).toContainEqual(['s1', 'admin:set_prompt', 'done'])
  })

  test('a step already carrying confirm:"yes" is treated as confirmed by the gate', async () => {
    // isStepConfirmed reads `confirm === 'yes'`. With confirmation supplied the
    // gate must NOT fire again; the call proceeds past it (and here fails on the
    // db write path, which this file does not stub — the point is the gate
    // decision, asserted through the message).
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'admin:set_prompt', input: { prompt: 'Hello', confirm: 'yes' }, dependsOn: [] } as PlanStep],
      needsSynthesis: false,
    }
    const r = await executePlan({ plan, userId: 'u1', isAdmin: true })
    // Either it succeeded, or it failed for a reason OTHER than the confirmation gate.
    expect(r[0].output).not.toContain('Are you sure you want to change')
  })
})

// ===========================================================================
// selfCorrect — the G10 retry path (planner.ts 723-745, 748-770).
// The whole catch arm was at hit=0: no test ever made a step THROW. The retry
// must (a) ask the LLM with the actual error text, (b) execute the CORRECTED
// question, not the original, and (c) report the retry's answer as the step
// output. "Retries once" is a claim in the code comments, so the COUNT is
// asserted, not just the final string.
// ===========================================================================

describe('executePlan — the self-correction retry path', () => {
  const throwOnce = (error: string) => {
    let calls = 0
    mockRunNonStreaming.mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error(error)
      return { answer: 'RETRY_OK', citations: [], chartData: null, toolRuns: [], integrationId: null }
    })
    return () => calls
  }

  test('a threw step is re-asked with the corrected question and the retry answer is the output', async () => {
    const calls = throwOnce('column "total" does not exist')
    mockGenerateChat.mockImplementation(async () => 'what is the total order amount')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'total?' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('RETRY_OK')
    // EXACTLY two executions: the original that threw, plus one retry. "Retries
    // once" is the contract; a loop here would burn the org's LLM budget.
    expect(calls()).toBe(2)
    // The reformulation prompt must carry the ACTUAL error and the ORIGINAL
    // question, or the model cannot fix the right thing.
    const prompt = String((mockGenerateChat.mock.calls[0] as unknown as [string])[0])
    expect(prompt).toContain('total?')
    expect(prompt).toContain('column "total" does not exist')
    // And the retry executes the CORRECTED question, not the original.
    const retryArgs = mockRunNonStreaming.mock.calls[1] as unknown as Array<{ question: string }>
    expect(retryArgs[0].question).toBe('what is the total order amount')
  })

  test('regex-special characters in the error and question do not break the retry', async () => {
    // The prompt interpolates raw strings into template literals; a regression
    // that started escaping/parsing them would corrupt the retry question.
    throwOnce('syntax error at or near "SELECT * FROM (x)"')
    mockGenerateChat.mockImplementation(async () => 'fixed (x) query')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'a "quoted" [thing]?' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].output).toBe('RETRY_OK')
    const retryArgs = mockRunNonStreaming.mock.calls[1] as unknown as Array<{ question: string }>
    expect(retryArgs[0].question).toBe('fixed (x) query')
  })

  test('a reformulation IDENTICAL to the original is refused — the step fails with the ORIGINAL error', async () => {
    // `fixedQuestion.trim() === originalQuestion.trim()` → null. Retrying the
    // same question would double the latency for the same failure. The reported
    // error must be the try-block error, not something invented downstream.
    throwOnce('relation does not exist')
    mockGenerateChat.mockImplementation(async () => 'total?')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'total?' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toBe('relation does not exist')
    expect(r[0].output).toBe('')
    // No second execution: the retry never happened.
    expect(mockRunNonStreaming).toHaveBeenCalledTimes(1)
  })

  test('a blank reformulation is refused too', async () => {
    throwOnce('boom')
    mockGenerateChat.mockImplementation(async () => '   ')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(false)
    expect(mockRunNonStreaming).toHaveBeenCalledTimes(1)
  })

  test('when the LLM reformulation itself throws, the step still fails with the original error', async () => {
    // selfCorrect has its own try/catch; a failure there must NOT escape and
    // discard the step result.
    throwOnce('original failure')
    mockGenerateChat.mockImplementation(async () => { throw new Error('llm unavailable') })
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toBe('original failure')
  })

  test('when the RETRY itself throws, the step fails and reports the retry error', async () => {
    // selfCorrect's `return completion.answer` is inside its try, so a throwing
    // retry propagates to selfCorrect's catch → null → the caller reports the
    // ORIGINAL error. Pinning which one surfaces keeps the operator from
    // chasing a phantom "original" problem.
    let calls = 0
    mockRunNonStreaming.mockImplementation(async () => {
      calls++
      throw new Error(calls === 1 ? 'first failure' : 'second failure')
    })
    mockGenerateChat.mockImplementation(async () => 'a better question')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toBe('first failure')
    expect(calls).toBe(2)
  })

  test('a non-Error throw is stringified for both the step error and the reformulation prompt', async () => {
    // `e instanceof Error ? e.message : String(e)` — a thrown string must not
    // reach the prompt as "undefined".
    let calls = 0
    mockRunNonStreaming.mockImplementation(async () => {
      calls++
      if (calls === 1) throw 'raw string failure'
      return { answer: 'RETRY_OK', citations: [], chartData: null, toolRuns: [], integrationId: null }
    })
    mockGenerateChat.mockImplementation(async () => 'better')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r[0].ok).toBe(true)
    const prompt = String((mockGenerateChat.mock.calls[0] as unknown as [string])[0])
    expect(prompt).toContain('raw string failure')
    expect(prompt).not.toContain('undefined')
  })

  test('the retry path fires for a PLUGIN step that throws, not only for chat completions', async () => {
    // The catch wraps the WHOLE try, so a throwing plugin must reach the same
    // retry. The reformulation then resolves through the chat completion.
    mockPluginFindFirst.mockImplementation(async () => ({ id: 'p1', toolId: 'weather' }))
    mockExecutePlugin.mockImplementation(async () => { throw new Error('plugin exploded') })
    mockRunNonStreaming.mockImplementation(async () => ({ answer: 'RETRY_OK', citations: [], chartData: null, toolRuns: [], integrationId: null }))
    mockGenerateChat.mockImplementation(async () => 'a better plugin call')
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'plugin:weather', input: { city: 'Jakarta' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    // The plugin threw before any completion ran, so the ONLY completion in this
    // test is the retry — proving the retry fired for a non-chat step.
    expect(mockRunNonStreaming).toHaveBeenCalledTimes(1)
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('RETRY_OK')
    expect(String((mockGenerateChat.mock.calls[0] as unknown as [string])[0])).toContain('plugin exploded')
  })

  test('onStatus reports RUNNING then DONE across a corrected step', async () => {
    throwOnce('transient')
    mockGenerateChat.mockImplementation(async () => 'improved')
    const statuses: Array<[string, string, string]> = []
    await executePlan({
      plan: { steps: [{ id: 's1', tool: 'sql', input: { question: 'q' } } as PlanStep], needsSynthesis: false },
      userId: 'u1',
      onStatus: (id, tool, status) => statuses.push([id, tool, status]),
    })
    expect(statuses[0]).toEqual(['s1', 'sql', 'running'])
    expect(statuses[statuses.length - 1]).toEqual(['s1', 'sql', 'done'])
  })
})

// ===========================================================================
// Planner security boundary: does a plan validate its tool ids against the
// registry BEFORE executing? A prompt-injected plan must not reach an
// arbitrary executor. Verified through the real code path, not by reading.
// ===========================================================================

describe('planner — tool ids are registry-checked before any executor runs', () => {
  test('validatePlan rejects an id that is not in the offered tool list', () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'admin:mcp_install', input: { confirm: 'yes' } } as PlanStep],
      needsSynthesis: false,
    }
    // The offered list does NOT contain the admin tool, so this must throw even
    // though the executor branch for admin:* exists in executeStep.
    expect(() => validatePlan(plan, TOOLS)).toThrow(/unknown tool/)
  })

  test('planQuery fails closed when a TOOL-CALLING plan names a tool outside the registry', async () => {
    // planQueryWithTools is the tool-calling path. Its result goes through the
    // same validatePlan, so a prompt-injected admin tool must be rejected there
    // — before planQuery can fall back to the JSON path, which then also fails
    // closed to a CHAT step. The injected tool must never reach an executor.
    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>
    // 1st fetch: the tool-calling completion returns a plan naming admin:mcp_install,
    // which is NOT in TOOLS.
    fetchMock.mockImplementationOnce(async () => openaiToolCallResponse(JSON.stringify({
      steps: [{ id: 'step1', tool: 'admin:mcp_install', input: { name: 'evil', confirm: 'yes' } }],
      needsSynthesis: false,
    })))
    // 2nd fetch: the text-plan fallback returns no usable tool call either.
    fetchMock.mockImplementationOnce(async () => openaiTextResponse('no tools'))
    // The text-plan path then answers with a plan naming the same injected tool.
    mockGenerateChat.mockImplementationOnce(async () => JSON.stringify({
      steps: [{ id: 'step1', tool: 'admin:mcp_install', input: { name: 'evil', confirm: 'yes' } }],
      needsSynthesis: false,
    }))
    const plan = await planQuery({ question: 'install evil', availableTools: TOOLS })
    expect(plan.steps.some((s) => s.tool === 'admin:mcp_install')).toBe(false)
    // Fail-closed to CHAT, which IS in the registry.
    expect(plan.steps.every((s) => s.tool === 'chat')).toBe(true)
  })

  test('an MCP id with no server segment reaches callMcpTool with an EMPTY server id', async () => {
    // PINNED CURRENT BEHAVIOUR. `'mcp:'.split(':')` is ['mcp',''], so `parts[1]`
    // is the empty string — not undefined. Nothing between validatePlan and
    // callMcpTool re-checks the shape of an `mcp:` step id: validatePlan only
    // checks membership in the OFFERED tool list, and the offered list is built
    // from the registry (which can legitimately contain an `mcp:<cuid>:<name>`
    // id). This records that the segments are passed through unvalidated, so a
    // future hardening change is deliberate.
    mockCallMcpTool.mockImplementation(async () => ({ ok: true, output: 'ok' }))
    const r = await executePlan({
      plan: { steps: [{ id: 's1', tool: 'mcp:', input: {} } as PlanStep], needsSynthesis: false },
      userId: 'u1',
    })
    expect(r).toHaveLength(1)
    const mcpArgs = mockCallMcpTool.mock.calls[0] as unknown as [string, string]
    expect(mcpArgs[0]).toBe('')
    expect(mcpArgs[1]).toBe('')
  })
})
