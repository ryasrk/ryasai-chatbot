import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// runMultiStepDag — the multi-step planner bridge.
//
// tool-router-agentic.ts was 68% functions with `runMultiStepDag` (50 lines, an
// exported production entrypoint) never executed by a test. It is the function
// that turns a plan into ToolRun rows, and it carries two specifics worth
// pinning: it offers NO admin tools (context 'chat'), and it filters `mcp:` steps
// out of the persisted rows because the planner already writes those at
// invocation time — persisting them here would duplicate them.
//
// Separate file: the existing tool-router-agentic.test.ts does not mock
// '@/lib/planner' or '@/lib/tool-registry', and adding them would change the
// module graph that file was written against.
// ---------------------------------------------------------------------------
const state = {
  tools: [] as any[],
  plan: null as any,
  results: [] as any[],
  synthesized: 'synthesized answer',
  getToolsCalls: [] as any[],
  planCalls: [] as any[],
  executeCalls: [] as any[],
}

mock.module('@/lib/tool-registry', () => ({
  getAvailableTools: async (q: string, ctx: string) => {
    state.getToolsCalls.push({ q, ctx })
    return state.tools
  },
}))
mock.module('@/lib/planner', () => ({
  planQuery: async (a: any) => {
    state.planCalls.push(a)
    return state.plan
  },
  executePlan: async (a: any) => {
    state.executeCalls.push(a)
    return state.results
  },
  synthesizeAnswer: async () => state.synthesized,
}))
mock.module('@/lib/alignment-check', () => ({
  isAlignmentCheckEnabled: () => false,
  checkAlignment: async () => ({ risk: 'low', reason: 'fine' }),
}))
mock.module('@/lib/intent-pipeline', () => ({
  evaluateAnswerConfidence: async () => ({ confident: false, confidence: 0.1, reason: 'x' }),
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))

import { runMultiStepDag } from '@/lib/tool-router-agentic'

const step = (over: Record<string, unknown> = {}) => ({
  stepId: 's1', tool: 'sql', ok: true, output: 'rows', latencyMs: 12, ...over,
})

beforeEach(() => {
  state.tools = [{ id: 'sql', description: 'query the database' }]
  state.plan = { steps: [{ id: 's1', tool: 'sql', input: {}, dependsOn: [] }], needsSynthesis: true }
  state.results = [step()]
  state.synthesized = 'synthesized answer'
  state.getToolsCalls = []
  state.planCalls = []
  state.executeCalls = []
})

describe('runMultiStepDag', () => {
  test('no available tools short-circuits to null without planning', async () => {
    state.tools = []
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    // Returning null is the caller's signal to use the single-tool path; asking
    // the LLM to plan with zero tools would just waste a call.
    expect(r).toBeNull()
    expect(state.planCalls).toHaveLength(0)
  })

  test('tools are listed in the CHAT context, never admin', async () => {
    await runMultiStepDag({ question: 'q', userId: 'u1' })
    expect(state.getToolsCalls[0].ctx).toBe('chat')
  })

  test('a single chat step with no synthesis is NOT a multi-step plan', async () => {
    state.plan = { steps: [{ id: 's1', tool: 'chat', input: {}, dependsOn: [] }], needsSynthesis: false }
    const r = await runMultiStepDag({ question: 'hi', userId: 'u1' })
    // This is exactly what a plain single-tool turn looks like; running the DAG
    // machinery would add latency and a needless synthesis call.
    expect(r).toBeNull()
    expect(state.executeCalls).toHaveLength(0)
  })

  test('a single chat step WITH synthesis still runs', async () => {
    state.plan = { steps: [{ id: 's1', tool: 'chat', input: {}, dependsOn: [] }], needsSynthesis: true }
    const r = await runMultiStepDag({ question: 'hi', userId: 'u1' })
    expect(r).not.toBeNull()
    expect(state.executeCalls).toHaveLength(1)
  })

  test('executePlan is called with isAdmin FALSE', async () => {
    await runMultiStepDag({ question: 'q', userId: 'u1' })
    // Admin tools must never be reachable through the chat DAG.
    expect(state.executeCalls[0].isAdmin).toBe(false)
  })

  test('a successful step becomes a success ToolRun with mapped type', async () => {
    const r = await runMultiStepDag({ question: 'revenue?', userId: 'u1' })
    expect(r?.answer).toBe('synthesized answer')
    expect(r?.toolRuns).toHaveLength(1)
    expect(r?.toolRuns[0].type).toBe('SQL')
    expect(r?.toolRuns[0].status).toBe('success')
    expect(r?.toolRuns[0].latencyMs).toBe(12)
  })

  test('a FAILED step becomes an error ToolRun carrying its message', async () => {
    state.results = [step({ ok: false, error: 'syntax error near FROM' })]
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    expect(r?.toolRuns[0].status).toBe('error')
    // The reason must survive into the row; a bare "error" is not diagnosable.
    expect(r?.toolRuns[0].errorMessage).toContain('syntax error')
  })

  test('mcp: steps are FILTERED OUT (the planner already persisted them)', async () => {
    state.results = [
      step({ stepId: 'a', tool: 'mcp:filesystem', output: 'file list' }),
      step({ stepId: 'b', tool: 'sql', output: 'rows' }),
    ]
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    // Persisting again here is the documented duplication this filter prevents.
    expect(r?.toolRuns).toHaveLength(1)
    expect(r?.toolRuns[0].type).toBe('SQL')
  })

  test('a plan where EVERY step is mcp: yields no tool runs, but still answers', async () => {
    state.results = [step({ tool: 'mcp:filesystem' }), step({ tool: 'mcp:github' })]
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    expect(r?.toolRuns).toHaveLength(0)
    expect(r?.answer).toBe('synthesized answer')
  })

  test('input/output summaries are present so the run is auditable', async () => {
    const r = await runMultiStepDag({ question: 'total revenue by region', userId: 'u1' })
    expect(r?.toolRuns[0].inputSummary).toBeTruthy()
    expect(r?.toolRuns[0].outputSummary).toBeTruthy()
  })

  test('citations and chartData are empty — the DAG adds none of its own', async () => {
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    expect(r?.citations).toEqual([])
    expect(r?.chartData).toBeNull()
  })

  test('web_fetch and web_search steps map to CANONICAL run types, not raw uppercase', async () => {
    state.results = [step({ stepId: 'a', tool: 'web_fetch' }), step({ stepId: 'b', tool: 'web_search' })]
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    // Regression: the old raw toUpperCase() cast wrote invalid literals that
    // metrics queries filter out, making those runs invisible.
    const types = r!.toolRuns.map((t) => t.type)
    expect(types).not.toContain('WEB_FETCH' as any)
    expect(types).not.toContain('WEB_SEARCH' as any)
    for (const t of types) expect(['RAG', 'SQL', 'REST_API', 'CHAT', 'PLUGIN']).toContain(t)
  })

  test('a THROW mid-plan returns null instead of failing the turn', async () => {
    state.plan = null // planQuery returning null would throw on plan.steps
    const r = await runMultiStepDag({ question: 'q', userId: 'u1' })
    // The caller falls back to the single-tool path; a DAG failure must not
    // kill a chat turn that could still be answered.
    expect(r).toBeNull()
  })

  test('sessionId and chatHistory are forwarded to the planner', async () => {
    const history = [{ role: 'user' as const, content: 'earlier' }]
    await runMultiStepDag({ question: 'q', userId: 'u1', sessionId: 'sess-1', chatHistory: history })
    expect(state.planCalls[0].sessionId).toBe('sess-1')
    expect(state.planCalls[0].chatHistory).toEqual(history)
  })
})
