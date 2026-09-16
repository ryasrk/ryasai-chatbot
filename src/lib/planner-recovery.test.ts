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
// Typed with its full argument list so `mock.calls` is a real tuple and the
// assertions below can index [0]/[1]/[2] without a cast.
const mockCallMcpTool = mock(
  async (
    _serverId: string,
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; error?: string }> => ({ ok: true, output: 'mcp-output' }),
)
const mockPluginFindFirst = mock(async (): Promise<unknown> => null)
const mockExecutePlugin = mock(async (): Promise<{ ok: boolean; output: string; error?: string; latencyMs: number }> => ({ ok: true, output: 'plugin-output', latencyMs: 10 }))
const mockToolRunCreate = mock(async (_a: unknown): Promise<unknown> => ({}))
const mockRateLimit = mock(async (): Promise<{ allowed: boolean; remaining?: number; limit?: number }> => ({ allowed: true }))
const org = { id: undefined as string | undefined }
// The admin branch of executeStep was the largest unexecuted region in planner.ts:
// its SUCCESS path needs executeAdminTool to return ok:true, which needs a live
// database. planner.test.ts deliberately does not mock this module because
// mock.module is process-global and leaks into admin-tools.test.ts; this file
// already exists to hold the mocks that planner.test.ts cannot, so the mock
// belongs here.
let adminImpl: (toolId: string, input: Record<string, string>, userId: string, isConfirmed: boolean) => Promise<unknown> =
  async () => ({ ok: true, output: 'admin-output' })
// mockReset() below strips the implementation, so the wrapper is re-installed in
// the same beforeEach. Without that the mock returns undefined, executeStep throws
// on result.confirmationRequired, and the throw is swallowed by self-correction —
// which made every admin test read 'mock-answer' and look like a chat branch.
const mockExecuteAdminTool = mock(async (toolId: string, input: Record<string, string>, userId: string, isConfirmed: boolean) =>
  adminImpl(toolId, input, userId, isConfirmed))


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
// NOTE (measured): Bun HOISTS `import` above top-level statements, so planner.ts
// binds `listMcpTools` before this factory is registered. A direct capture of
// `mockListMcpTools` therefore handed the module a DIFFERENT function identity
// and the mock never fired (call count stayed 0). Reading through a mutable
// holder that the factory closes over works, because the holder object exists
// from the start of the module body and only its CONTENTS change per test.
const mcpCatalogue: { tools: Array<{ serverId: string; toolName: string; inputSchema: Record<string, unknown> }> } = { tools: [] }

mock.module('@/lib/mcp-client', () => ({
  callMcpTool: mockCallMcpTool,
  // planner.ts reads each MCP tool's JSON schema to type-coerce step inputs.
  // An empty catalogue leaves every value as a string (the safe default).
  listMcpTools: async () => mcpCatalogue.tools,
}))
mock.module('@/lib/web-fetch', () => ({
  fetchUrlForPlanner: async () => ({ ok: true, content: 'page' }),
  webSearch: async () => ({ ok: true, results: [] }),
}))
mock.module('@/lib/tool-rate-limit', () => ({ checkToolRateLimit: mockRateLimit }))
mock.module('@/lib/admin-tools', () => ({ executeAdminTool: mockExecuteAdminTool }))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => org.id,
  enterWithOrg: () => {},
  bypassOrg: async (fn: () => Promise<unknown>) => fn(),
}))

import { executePlan } from '@/lib/planner'
import type { Plan, PlanStep } from '@/lib/planner'

async function runStep(step: Partial<PlanStep>, opts: { isAdmin?: boolean } = {}) {
  const plan: Plan = { steps: [{ id: 's1', tool: 'mcp:srv1:fs.read', input: {}, dependsOn: [], ...step } as PlanStep], needsSynthesis: false }
  return executePlan({ plan, userId: 'u1', isAdmin: opts.isAdmin ?? false })
}

beforeEach(() => {
  org.id = undefined
  mcpCatalogue.tools = []
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
  adminImpl = async () => ({ ok: true, output: 'admin-output' })
  mockExecuteAdminTool.mockReset()
  mockExecuteAdminTool.mockImplementation(async (toolId: string, input: Record<string, string>, userId: string, isConfirmed: boolean) =>
    adminImpl(toolId, input, userId, isConfirmed))
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

// ---------------------------------------------------------------------------
// executeStep — the admin:* branch
//
// This was the single largest unexecuted region in planner.ts (lines 552-570):
// the SUCCESS path, the confirmation gate, and the failure reporting had never
// run. Only the "caller is not an admin" refusal below it was covered.
// ---------------------------------------------------------------------------

describe('executeStep — admin tools', () => {
  test('a non-admin caller never reaches executeAdminTool', async () => {
    // Defense-in-depth against prompt injection: a plan that leaks an admin:* step
    // must be stopped before the tool is invoked at all.
    const r = await runStep({ tool: 'admin:show_monitoring' })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('administrator')
    expect(mockExecuteAdminTool).not.toHaveBeenCalled()
  })

  test('an admin success is reported ok with the tool output', async () => {
    adminImpl = async () => ({ ok: true, output: 'monitoring-output' })
    const r = await runStep({ tool: 'admin:show_monitoring' }, { isAdmin: true })
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('monitoring-output')
    // No error field on success — the UI keys "Failed" off it.
    expect(r[0].error).toBeUndefined()
  })

  test('the caller identity and confirmation flag are forwarded, not defaulted', async () => {
    await runStep({ tool: 'admin:show_monitoring', input: {} }, { isAdmin: true })
    const call = mockExecuteAdminTool.mock.calls.at(-1) as unknown as [string, Record<string, string>, string, boolean]
    expect(call[0]).toBe('admin:show_monitoring')
    expect(call[2]).toBe('u1')
    // isConfirmed must come from the step, never be hardcoded true.
    expect(call[3]).toBe(false)
  })

  test('confirmationRequired is NOT an error — it passes through as done', async () => {
    adminImpl = async () => ({
      ok: false,
      output: '',
      confirmationRequired: { action: 'TOGGLE_DOCUMENT', message: 'Are you sure you want to disable "Leave Policy"?' },
    })
    const statuses: Array<[string, string, string]> = []
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'admin:toggle_document', input: {}, dependsOn: [] } as PlanStep],
      needsSynthesis: false,
    }
    const r = await executePlan({ plan, userId: 'u1', isAdmin: true, onStatus: (a, b, c) => statuses.push([a, b, c]) })

    // A gate is not a failure: marking it ok keeps the UI from showing "Failed" and
    // lets the synthesizer relay the question to the user.
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toContain('Are you sure')
    expect(statuses.some(([, , s]) => s === 'error')).toBe(false)
  })

  test('an admin failure reports the output as the error reason', async () => {
    adminImpl = async () => ({ ok: false, output: 'Document "Nope" not found.' })
    const r = await runStep({ tool: 'admin:toggle_document', input: { document: 'Nope' } }, { isAdmin: true })
    expect(r[0].ok).toBe(false)
    // The reason must survive to the caller; an empty error leaves the synthesizer
    // to invent one.
    expect(r[0].error).toBe('Document "Nope" not found.')
    expect(r[0].output).toBe('Document "Nope" not found.')
  })

  test('a THROWN admin error does not take down the plan — it is self-corrected', async () => {
    adminImpl = async () => { throw new Error('database is down') }
    const r = await runStep({ tool: 'admin:show_monitoring' }, { isAdmin: true })
    // MEASURED: executeStep catches it and selfCorrect() retries through the LLM,
    // so the plan SURVIVES with a result rather than rejecting. Asserting ok:false
    // would have asserted against the recovery path working.
    expect(r).toHaveLength(1)
    expect(mockGenerateChat).toHaveBeenCalled()
    expect(r[0].ok).toBe(true)
    expect(r[0].output).toBe('mock-answer')
  })

  test('a thrown admin error that self-correction CANNOT fix fails the step', async () => {
    adminImpl = async () => { throw new Error('database is down') }
    // An unchanged reformulation is rejected, so no retry happens and the original
    // error is what the caller sees.
    mockGenerateChat.mockImplementation((async (p: string) => {
      const m = p.match(/Original question: "(.*)" failed/)
      return m ? m[1] : p
    }) as unknown as () => Promise<string>)
    const r = await runStep({ tool: 'admin:show_monitoring', input: { q: 'same' } }, { isAdmin: true })
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('database is down')
  })
})

describe('executeStep — the MCP tool name is everything after the server id', () => {
  // MUTATION-CONFIRMED GAP: replacing `parts.slice(2).join(':')` with `parts[2]`
  // turned ZERO tests red. The module-level comment claims toolName "may
  // theoretically contain colons", and it does: MCP tool names are namespaced,
  // so `mcp:<serverId>:filesystem:read_file` is a real shape. Truncating at
  // parts[2] would ask the server for a tool called "filesystem" -- a name that
  // does not exist -- and every namespaced MCP tool would fail at runtime while
  // the plan still reported a clean, tool-shaped step.
  test('a namespaced tool name keeps every colon-separated segment', async () => {
    const r = await runStep({ tool: 'mcp:srv1:filesystem:read_file', input: {} })
    expect(r[0].ok).toBe(true)
    const [serverId, toolName] = mockCallMcpTool.mock.calls.at(-1) as unknown as [string, string]
    expect(serverId).toBe('srv1')
    expect(toolName).toBe('filesystem:read_file')
  })

  test('a single-segment tool name is passed through unchanged', async () => {
    await runStep({ tool: 'mcp:srv1:list', input: {} })
    const [serverId, toolName] = mockCallMcpTool.mock.calls.at(-1) as unknown as [string, string]
    expect(serverId).toBe('srv1')
    expect(toolName).toBe('list')
  })

  test('an empty tool name is still forwarded, so the server reports its own error', async () => {
    // 'mcp:srv1:' is malformed. Passing '' lets the MCP server return a precise
    // "unknown tool" instead of the planner inventing a reason.
    await runStep({ tool: 'mcp:srv1:', input: {} })
    const [, toolName] = mockCallMcpTool.mock.calls.at(-1) as unknown as [string, string]
    expect(toolName).toBe('')
  })

  test('MCP inputs are re-typed from JSON so numbers and booleans reach the server typed', async () => {
    // The planner normalises all step inputs to STRINGS (stringifyEntries).
    // coerceMcpInput converts them back — but now ONLY for keys whose DECLARED
    // JSON Schema type matches, so a legitimate string can never be retyped.
    // A schema is therefore required for coercion to happen at all.
    mcpCatalogue.tools = [
      {
        // Matches the id this test passes: `mcp:srv1:search` → serverId `srv1`,
        // toolName `search` (the step override below replaces runStep's default).
        serverId: 'srv1',
        toolName: 'search',
        inputSchema: {
          type: 'object',
          properties: {
            max_results: { type: 'number' },
            exact: { type: 'boolean' },
            q: { type: 'string' },
          },
        },
      },
    ]
    await runStep({ tool: 'mcp:srv1:search', input: { max_results: '5', exact: 'true', q: 'plain text' } })
    const [, , args] = mockCallMcpTool.mock.calls.at(-1) as unknown as [string, string, Record<string, unknown>]
    expect(args.max_results).toBe(5)
    expect(args.exact).toBe(true)
    // A declared string stays a string rather than being coerced to NaN/undefined.
    expect(args.q).toBe('plain text')
  })
})
