import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// runStreamingChatCompletion — the routing decision.
//
// tool-router.ts decides WHICH tool answers a question (SQL / RAG / REST /
// PLUGIN / CONTEXTUAL_CHAT / plain chat) and was at 58.6% lines with that whole
// dispatcher body (36 lines) uncovered. The existing tool-router.test.ts covers
// only pure helpers (chart building, SQL error sanitizing, summaries) — it never
// calls the router itself, so every routing branch was unverified. A wrong
// decision here is user-visible: the wrong tool answers, or a clarification is
// demanded forever.
//
// Separate file: this replaces stream-preparers and tool-router-agentic, which
// would change the module graph the existing file was written against.
// ---------------------------------------------------------------------------
const state = {
  docCount: 0,
  intCount: 0,
  restEndpoints: [] as any[],
  intNames: [] as any[],
  schemaRows: [] as any[],
  docRows: [] as any[],
  toolRuns: [] as any[],
  intent: null as any,
  routeResult: null as any,
  smartRouteResult: null as any,
  kwIntegration: null as any,
  semanticIntegration: null as any,
  rewritten: null as any,
  memoryContext: '',
  promptSettings: null as any,
  branchCalls: [] as string[],
  contextualContext: '',
  routeSeen: null as any,
}

mock.module('@/lib/db', () => ({
  db: {
    document: {
      count: async () => state.docCount,
      findMany: async () => state.docRows,
    },
    integration: {
      count: async () => state.intCount,
      findMany: async () => state.intNames,
      findFirst: async () => null,
    },
    integrationSchema: { findMany: async () => state.schemaRows },
    restApiEndpoint: { findMany: async () => state.restEndpoints },
    toolRun: { findMany: async () => state.toolRuns },
    appConfig: { findFirst: async () => null },
    llmConfig: { findFirst: async () => null },
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))
// Measured from the import list: tool-router.ts imports only routeQuery (and a
// re-export of parseRestCallJson) from '@/lib/ai'. analyzeIntent/rewriteQuery live
// in '@/lib/intent-pipeline'.
mock.module('@/lib/ai', () => ({
  // Measured: with chatHistory present the router uses routeQuery (the LLM
  // rewrite path), NOT smartRoute. Observing only smartRoute would have made
  // these assertions look for an argument that never arrives.
  routeQuery: async (a: any) => { state.routeSeen = a; return state.routeResult },
  parseRestCallJson: () => null,
}))
mock.module('@/lib/intent-pipeline', () => ({
  analyzeIntent: async () => state.intent,
  // Echo the input when no override is set, so a test about what was PASSED to
  // the rewriter (e.g. the wrapper stripped) is actually measurable — a fixed
  // string hid the very thing under test.
  rewriteQuery: async (a: any) => (state.rewritten ?? a.question),
}))
// The SELECTOR is the router now. It reads the same `state.smartRouteResult`
// the tests already set, mapping the decision back to a tool id, so each test
// keeps expressing "the router decided SQL" without being rewritten.
mock.module('@/lib/tool-selector', () => ({
  selectToolWithLlm: async (a: { question: string }) => {
    // `routeSeen` is what the rewrite assertions inspect; the SELECTOR is now the
    // component that sees the question, so it is the one that must record it.
    state.routeSeen = { question: a.question }
    const r = state.smartRouteResult
    if (!r) return null
    const toolId =
      r.decision === 'SQL' ? 'sql'
      : r.decision === 'RAG' ? 'rag'
      : r.decision === 'REST' ? 'rest'
      : r.decision === 'PLUGIN' ? 'web_search'
      : null
    return {
      toolId,
      decision: r.decision,
      args: {},
      integrationId: r.integrationId,
      reason: 'test stub',
      llmUsed: true,
    }
  },
}))

mock.module('@/lib/smart-router', () => ({
  // routeQuery is NOT here — it is imported from '@/lib/ai'.
  pickBestIntegrationByKeywords: async () => state.kwIntegration,
  pickBestIntegration: async () => state.semanticIntegration,
  tokenize: (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean),
}))
// The branch preparers are the ROUTING TARGETS; each records that it was chosen.
mock.module('@/lib/stream-preparers', () => {
  const mark = (name: string) => async () => {
    state.branchCalls.push(name)
    return { stream: (async function* () { yield name })(), toolRuns: [], citations: [], chartData: null }
  }
  return {
    prepareChatStream: mark('CHAT'),
    prepareSqlStream: mark('SQL'),
    prepareRagStream: mark('RAG'),
    prepareRestStream: mark('REST'),
    preparePluginStream: mark('PLUGIN'),
    prepareContextualChatStream: mark('CONTEXTUAL_CHAT'),
  }
})
mock.module('@/lib/tool-router-agentic', () => ({
  runStreamingAgenticLoop: async () => {
    state.branchCalls.push('AGENTIC')
    return { stream: (async function* () { yield 'agentic' })(), toolRuns: [], citations: [], chartData: null }
  },
}))
mock.module('@/lib/prompt-settings', () => ({
  getPromptSettings: async () => state.promptSettings,
}))
// recallContext comes from '@/lib/cognee' (the KB/memory facade), not from
// cognee-memory directly.
mock.module('@/lib/cognee', () => ({
  recallContext: async () => state.memoryContext,
  rememberChatTurn: async () => undefined,
}))
// stripSessionWrapper lives in tool-utils, which tool-router re-exports; the REAL
// implementation is used so the wrapper-stripping assertion tests real behaviour.
mock.module('@/lib/llm-client', () => ({
  withUsageTracking: async (fn: any) => fn(),
}))

import { runStreamingChatCompletion } from '@/lib/tool-router'

const defaultSettings = () => ({
  systemPrompt: '',
  tools: { sql: true, rag: true, restApi: true, plugins: true },
})

beforeEach(() => {
  state.docCount = 0
  state.intCount = 0
  state.restEndpoints = []
  state.intNames = []
  state.schemaRows = []
  state.docRows = []
  state.toolRuns = []
  state.intent = { needsClarification: false, needsRetrieval: true }
  state.routeResult = { decision: 'CHAT' }
  state.smartRouteResult = { decision: 'CHAT' }
  state.kwIntegration = null
  state.semanticIntegration = null
  state.rewritten = null
  state.memoryContext = ''
  state.promptSettings = defaultSettings()
  state.branchCalls = []
  state.contextualContext = ''
})

describe('runStreamingChatCompletion — clarification and plain chat', () => {
  test('a clarification question is streamed back and no tool is routed', async () => {
    state.intent = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: true }
    const r = await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    const out: string[] = []
    for await (const c of r.stream) out.push(c)
    expect(out.join('')).toBe('Which database?')
    // Asking is not an answer: no branch may run.
    expect(state.branchCalls).toEqual([])
  })

  test('skipClarification suppresses the question and routes instead', async () => {
    state.intent = { needsClarification: true, clarificationQuestion: 'Which database?', needsRetrieval: false }
    await runStreamingChatCompletion({ question: 'q', userId: 'u1', skipClarification: true })
    // Without the flag the turn would dead-end in a question the caller asked us
    // not to ask (the API path sets it when the user already chose a source).
    expect(state.branchCalls).toEqual(['CHAT'])
  })

  test('needsRetrieval false answers as plain chat', async () => {
    state.intent = { needsClarification: false, needsRetrieval: false }
    await runStreamingChatCompletion({ question: 'hello', userId: 'u1' })
    expect(state.branchCalls).toEqual(['CHAT'])
  })

  test('a clarification with NO question text does not stream undefined', async () => {
    // The guard requires BOTH flags; without a question there is nothing to ask.
    state.intent = { needsClarification: true, clarificationQuestion: '', needsRetrieval: false }
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    expect(state.branchCalls).toEqual(['CHAT'])
  })
})

describe('runStreamingChatCompletion — decision dispatches to the right branch', () => {
  const routeTo = async (decision: string) => {
    state.smartRouteResult = { decision }
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    return state.branchCalls[0]
  }

  test('SQL routes to the SQL branch when a DB exists', async () => {
    state.intCount = 1
    state.kwIntegration = 'int-1'
    expect(await routeTo('SQL')).toBe('SQL')
  })

  test('RAG routes to the RAG branch when documents exist', async () => {
    state.docCount = 3
    expect(await routeTo('RAG')).toBe('RAG')
  })

  test('REST routes to the REST branch when endpoints exist', async () => {
    state.restEndpoints = [{ method: 'GET', path: '/x', description: 'd' }]
    expect(await routeTo('REST')).toBe('REST')
  })

  test('PLUGIN routes to the plugin branch', async () => {
    expect(await routeTo('PLUGIN')).toBe('PLUGIN')
  })

  test('CONTEXTUAL_CHAT with prior tool runs routes to the contextual branch', async () => {
    // The SELECTOR decides this now; `routeQuery` is only the fallback when the
    // selector cannot run. Setting routeResult would leave the selector's own
    // default in charge and the branch under test would never be reached.
    state.smartRouteResult = { decision: 'CONTEXTUAL_CHAT' }
    state.toolRuns = [{ type: 'SQL', inputSummary: 'in', outputSummary: 'out' }]
    await runStreamingChatCompletion({
      question: 'q', userId: 'u1', sessionId: 's1',
      chatHistory: [{ role: 'user', content: 'earlier' }],
    })
    expect(state.branchCalls[0]).toBe('CONTEXTUAL_CHAT')
  })

  test('CONTEXTUAL_CHAT with NO prior tool runs degrades to plain chat', async () => {
    state.smartRouteResult = { decision: 'CONTEXTUAL_CHAT' }
    state.toolRuns = []
    await runStreamingChatCompletion({
      question: 'q', userId: 'u1', sessionId: 's1',
      chatHistory: [{ role: 'user', content: 'earlier' }],
    })
    // There is no context to prepend, so the contextual branch would add nothing.
    expect(state.branchCalls[0]).toBe('CHAT')
  })

  test('agentic mode is used when multi-step DAG AND history are both present', async () => {
    state.intent = { needsClarification: false, needsRetrieval: true }
    await runStreamingChatCompletion({
      question: 'q', userId: 'u1', allowMultiStepDag: true,
      chatHistory: [{ role: 'user', content: 'earlier' }],
    })
    expect(state.branchCalls).toEqual(['AGENTIC'])
  })

  test('agentic mode is NOT used without history', async () => {
    state.intent = { needsClarification: false, needsRetrieval: false }
    await runStreamingChatCompletion({ question: 'q', userId: 'u1', allowMultiStepDag: true })
    // The agentic loop needs conversation context to decompose; without it the
    // single-shot path must be used.
    expect(state.branchCalls).toEqual(['CHAT'])
  })
})

describe('runStreamingChatCompletion — a disabled tool cannot be routed to', () => {
  const routeWith = async (decision: string, tools: Record<string, boolean>) => {
    state.smartRouteResult = { decision }
    state.promptSettings = { systemPrompt: '', tools: { sql: true, rag: true, restApi: true, ...tools } }
    state.intCount = 1
    state.docCount = 3
    state.restEndpoints = [{ method: 'GET', path: '/x', description: 'd' }]
    state.kwIntegration = 'int-1'
    await runStreamingChatCompletion({ question: 'q', userId: 'u1' })
    return state.branchCalls[0]
  }

  test('SQL disabled by settings falls back to chat', async () => {
    // Routing to a disabled tool would produce an answer the admin turned off.
    expect(await routeWith('SQL', { sql: false })).toBe('CHAT')
  })

  test('RAG disabled by settings falls back to chat', async () => {
    expect(await routeWith('RAG', { rag: false, sql: false, restApi: false })).toBe('CHAT')
  })

  test('REST disabled by settings falls back to chat', async () => {
    expect(await routeWith('REST', { restApi: false, sql: false, rag: false })).toBe('CHAT')
  })

  test('an ENABLED tool still routes (the guard must not block everything)', async () => {
    expect(await routeWith('RAG', { rag: true })).toBe('RAG')
  })
})

describe('runStreamingChatCompletion — query rewriting', () => {
  test('with history the REWRITTEN question is what gets routed', async () => {
    state.rewritten = 'the rewritten standalone question'
    state.smartRouteResult = { decision: 'CHAT' }
    await runStreamingChatCompletion({
      question: 'and what about that one',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'sales by region' }],
    })
    // A follow-up ("and what about that one") is meaningless on its own; the
    // rewritten standalone question is what the router must receive.
    expect(state.routeSeen?.question).toBe('the rewritten standalone question')
  })

  test("the session meta-wrapper is stripped before ANY routing work", async () => {
    state.rewritten = null
    state.smartRouteResult = { decision: 'CHAT' }
    await runStreamingChatCompletion({
      question: '[Session started: 2024-01-01] what is revenue',
      userId: 'u1',
      chatHistory: [{ role: 'user', content: 'x' }],
    })
    // A wrapper timestamp leaking into the routing query would end up in the
    // prompt and in the recall query.
    expect(state.routeSeen?.question).toBe('what is revenue')
  })
})
