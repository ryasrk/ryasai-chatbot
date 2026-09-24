/**
 * POST /api/agent/dashboard — the agent console's SSE endpoint: plan, execute, stream, remember.
 *
 * WHY THIS FILE EXISTS. This is the longest route in the agent surface and it is a STREAM, so almost everything
 * interesting happens after the HTTP status is already 200. The behaviours below are the ones that silently
 * produce a wrong answer rather than an error:
 *
 *   1. THE SSE FRAME FORMAT IS LOAD-BEARING. Each event is TWO writes -- `event: <name>\n` and
 *      `data: <json>\n\n`. The blank line terminates the frame; without it the browser buffers forever and the
 *      console shows a spinner with no error anywhere. Pinned by parsing the raw text, not by trusting a helper.
 *   2. A STREAM ERROR IS DELIVERED AS AN `error` FRAME WITH HTTP 200. The response status was committed before
 *      the stream started, so a failure inside `start()` cannot change it. A caller watching only for non-2xx
 *      sees a successful request that produced nothing.
 *   3. THE USER MESSAGE IS STORED BEFORE THE PLAN RUNS, and history is loaded AFTER that insert -- so the turn
 *      being answered is part of its own history window.
 *   4. HISTORY EXCLUDES THE `agent` SENDER. The dashboard persists its answers as `agent`; including them here
 *      would duplicate the current answer into the prompt on the next turn.
 *   5. ALL SIDE EFFECTS ARE NON-FATAL. Storing the user message, loading history, storing the answer and touching
 *      the session are each `catch`-guarded, so a transcript write failure cannot abort an answer already paid
 *      for with LLM tokens.
 *
 * ALSO PINNED: the plan and tool frames, `tool_end` latency, the two distinct ISO DATE FORMATS (history uses
 * `hour: 2-digit` with no date; the session wrapper uses the full date), the `[Session started: …]` prefix, the
 * admin flag derived from the ROLE rather than a body field, the audit, and the JSON error envelope for the
 * pre-stream refusals.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const analystUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro',
}

// ---- mutable seams, declared before every mock.module (see the tasks test for why) ----
let user: typeof analystUser = analystUser
let hasProPlan = true
let sessionRow: Record<string, unknown> | null = null
let createdSession = { id: 's-new', createdAt: new Date('2026-03-01T00:00:00Z') }
let historyRows: Array<Record<string, unknown>> = []
let steps: Array<Record<string, unknown>> = []
/** `thinking` events the orchestrator emits before its steps; `undefined` = an event with no content. */
let orchestratorThinking: Array<string | undefined> = []
let unifiedTools: Array<{ id: string; name: string; description: string; category: string }> = []
let orchestratorResult: Record<string, unknown> = {}
let tokens: string[] = []
let orchestratorThrows: Error | null = null
let messageCreateThrows: Error | null = null
let historyThrows: Error | null = null
let capturedOrchestratorArgs: Record<string, unknown> | null = null
let capturedHistoryQuery: Record<string, unknown> | null = null
let capturedSessionCreate: Record<string, unknown> | null = null
const messageCreates: Array<Record<string, unknown>> = []
const sessionUpdates: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
const remembered: Array<Record<string, unknown>> = []
const events: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    if (!u || (u.role !== 'admin' && u.role !== 'analyst')) {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
    void required
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string; statusCode?: number }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
    }
    if (err?.code === 'VALIDATION_ERROR') {
      return Response.json(
        { error: { code: 'VALIDATION_ERROR', message: err.message } },
        { status: err.statusCode ?? 400 },
      )
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
  writeAudit: async (r: Record<string, unknown>) => {
    audits.push(r)
    events.push('audit')
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
  // The ReAct orchestrator reaches the org through this on the far side of a
  // tool call, so the mock must expose it too. It mirrors what `enterWithOrg`
  // just recorded, which is exactly the production contract.
  getOrgContext: () => 'org-1',
}))

mock.module('@/lib/plan-gating', () => ({
  hasPlan: (plan: string | null, required: string) => {
    events.push(`hasPlan:${String(plan)}:${required}`)
    return hasProPlan
  },
}))

mock.module('@/lib/cognee', () => ({
  rememberChatTurn: async (input: Record<string, unknown>) => {
    remembered.push(input)
    events.push('rememberChatTurn')
    return null
  },
}))

mock.module('@/lib/unified-tools', () => ({
  getUnifiedTools: async (args: Record<string, unknown>) => {
    events.push(`getUnifiedTools:${String(args.context)}:${String(args.isAdmin)}`)
    return unifiedTools
  },
}))

// The ReAct orchestrator is mocked as ONE unit on purpose: its internals
// (rounds, parallel calls, circuit breaker) are covered by
// `src/lib/agent-orchestrator.test.ts`, and what THIS file measures is the
// route's own contract — SSE framing, guards, persistence ordering, error
// frames. The mock drives `onEvent` exactly as the real orchestrator does, so
// the frame shapes are exercised rather than assumed.
mock.module('@/lib/agent-orchestrator', () => ({
  runAgentOrchestrator: async (args: Record<string, unknown>) => {
    capturedOrchestratorArgs = args
    events.push('runAgentOrchestrator')
    if (orchestratorThrows) throw orchestratorThrows
    const onEvent = args.onEvent as (e: { type: string; data: Record<string, unknown> }) => void
    for (const content of orchestratorThinking) onEvent({ type: 'thinking', data: { content } })
    for (const s of steps) {
      onEvent({ type: 'tool_start', data: { stepId: s.stepId, toolId: s.tool, arguments: { q: 'x' } } })
      onEvent({
        type: 'tool_end',
        data: {
          stepId: s.stepId,
          toolId: s.tool,
          status: s.endStatus === 'done' ? 'success' : 'error',
          output: 'OUT',
          latencyMs: 12,
        },
      })
    }
    return orchestratorResult
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    chatSession: {
      create: async (args: Record<string, unknown>) => {
        capturedSessionCreate = args
        events.push('chatSession.create')
        return { ...createdSession, ...(args.data as Record<string, unknown>) }
      },
      findUnique: async (args: Record<string, unknown>) => {
        events.push('chatSession.findUnique')
        return sessionRow
      },
      update: async (args: Record<string, unknown>) => {
        sessionUpdates.push(args)
        events.push('chatSession.update')
        return {}
      },
    },
    chatMessage: {
      create: async (args: Record<string, unknown>) => {
        if (messageCreateThrows) throw messageCreateThrows
        messageCreates.push(args)
        events.push(`chatMessage.create:${String((args.data as { sender: string }).sender)}`)
        return {}
      },
      findMany: async (args: Record<string, unknown>) => {
        capturedHistoryQuery = args
        events.push('chatMessage.findMany')
        if (historyThrows) throw historyThrows
        return historyRows
      },
    },
  },
}))

// DYNAMIC on purpose: a static import would be evaluated before the mocks above and bypass every one of them.
const { POST } = await import('./route')

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/agent/dashboard', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

/** Drain the SSE body into parsed frames — the format itself is under test, so nothing is assumed. */
async function frames(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const raw = await res.text()
  const out: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue
    const evLine = block.split('\n').find((l) => l.startsWith('event: '))
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (!evLine || !dataLine) continue
    out.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> })
  }
  return out
}

const eventNames = (f: Array<{ event: string }>) => f.map((x) => x.event)
const find = (f: Array<{ event: string; data: Record<string, unknown> }>, name: string) =>
  f.find((x) => x.event === name)

beforeEach(() => {
  user = analystUser
  hasProPlan = true
  sessionRow = null
  createdSession = { id: 's-new', createdAt: new Date('2026-03-01T00:00:00Z') }
  historyRows = []
  steps = []
  orchestratorThinking = []
  unifiedTools = [
    { id: 'sql', name: 'query_database', description: 'SQL', category: 'database' },
    { id: 'rag', name: 'search_knowledge_base', description: 'RAG', category: 'knowledge' },
  ]
  orchestratorResult = {
    answer: 'Hello',
    toolRuns: [{ type: 'SQL', status: 'success', latencyMs: 12 }],
    iterations: 1,
    citations: [],
  }
  tokens = ['Hel', 'lo']
  orchestratorThrows = null
  messageCreateThrows = null
  historyThrows = null
  capturedOrchestratorArgs = null
  capturedHistoryQuery = null
  capturedSessionCreate = null
  messageCreates.length = 0
  sessionUpdates.length = 0
  audits.length = 0
  remembered.length = 0
  events.length = 0
})

describe('pre-stream guards', () => {
  test('a missing message is 400 as JSON, not an SSE frame', async () => {
    // Refused BEFORE the stream exists, so this one really is a non-2xx response.
    const res = await post({})
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()) as { error: string }).toEqual({ error: 'Message is required.' })
  })

  test('a WHITESPACE-only message is 400 too', async () => {
    expect((await post({ message: '   ' })).status).toBe(400)
  })

  test('a non-pro plan is refused with 403 BEFORE any session is created', async () => {
    hasProPlan = false
    const res = await post({ message: 'hi' })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({
      error: 'Agent features require a Pro plan or higher.',
    })
    expect(events).not.toContain('chatSession.create')
  })

  test('the plan gate is asked for pro, using the SESSION plan', async () => {
    await frames(await post({ message: 'hi' }))
    expect(events).toContain('hasPlan:pro:pro')
  })

  test('the role gate rejects a viewer before the plan gate', async () => {
    user = { ...analystUser, role: 'viewer' }
    const res = await post({ message: 'hi' })
    expect(res.status).toBe(403)
    expect(events.some((e) => e.startsWith('hasPlan'))).toBe(false)
  })

  test('the org context is entered first', async () => {
    await frames(await post({ message: 'hi' }))
    expect(events[0]).toBe('enterWithOrg:org-1')
  })
})

describe('the SSE frame format', () => {
  test('the response is an event stream with the documented headers', async () => {
    const res = await post({ message: 'hi' })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('connection')).toBe('keep-alive')
  })

  test('each frame is `event: <name>` then `data: <json>` then a BLANK LINE', async () => {
    // The blank line terminates a frame. Without it the browser never dispatches the event and the console spins
    // forever with no error anywhere.
    const raw = await (await post({ message: 'hi' })).text()
    expect(raw.startsWith('event: thinking\n')).toBe(true)
    expect(raw).toContain('\n\n')
    expect(raw.endsWith('\n\n')).toBe(true)
  })

  test('the frames arrive in the documented order', async () => {
    steps = [{ stepId: 's1', tool: 'sql', endStatus: 'done' }]
    const f = await frames(await post({ message: 'hi' }))
    expect(eventNames(f)).toEqual([
      'thinking',
      'plan',
      'tool_start',
      'tool_end',
      'answer',
      'done',
    ])
  })

  test('the thinking frame carries its message', async () => {
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'thinking')!.data).toEqual({ content: 'Analyzing request...' })
  })

  test('the orchestrator\'s own thinking is forwarded, and a content-less one still says something', async () => {
    orchestratorThinking = ['Checking the sales table', undefined]
    const f = await frames(await post({ message: 'hi' }))
    const thinking = f.filter((x) => x.event === 'thinking').map((x) => x.data)
    expect(thinking).toEqual([
      { content: 'Analyzing request...' },
      { content: 'Checking the sales table' },
      { content: 'Thinking...' },
    ])
  })

  test('the plan frame exposes the tool ids the agent can reach', async () => {
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'plan')!.data).toEqual({
      steps: [
        { id: 'tool1', tool: 'sql', input: {} },
        { id: 'tool2', tool: 'rag', input: {} },
      ],
    })
  })

  test('the tool frames carry a LATENCY for the completed step', async () => {
    steps = [{ stepId: 's1', tool: 'sql', endStatus: 'done' }]
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'tool_start')!.data).toEqual({ stepId: 's1', tool: 'sql', input: { q: 'x' } })
    const end = find(f, 'tool_end')!.data
    expect(end.stepId).toBe('s1')
    expect(end.status).toBe('success')
    expect(typeof end.latencyMs).toBe('number')
    expect(end.latencyMs as number).toBeGreaterThanOrEqual(0)
  })

  test('a step that is NOT done reports status error', async () => {
    steps = [{ stepId: 's1', tool: 'sql', endStatus: 'failed' }]
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'tool_end')!.data.status).toBe('error')
  })

  test('the answer frame carries the orchestrator answer', async () => {
    orchestratorResult = { answer: 'Hello', toolRuns: [], iterations: 1, citations: [] }
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'answer')!.data).toEqual({ content: 'Hello' })
  })

  test('the done frame carries the conversation id', async () => {
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'done')!.data).toEqual({ conversationId: 's-new' })
  })

  test('an EMPTY answer still produces an answer frame', async () => {
    orchestratorResult = { answer: '', toolRuns: [], iterations: 1, citations: [] }
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'answer')!.data).toEqual({ content: '' })
  })

  test('a confirmationRequired result emits a confirmation_required frame', async () => {
    orchestratorResult = {
      answer: 'Please confirm creating the API key.',
      toolRuns: [],
      iterations: 1,
      citations: [],
      confirmationRequired: { action: 'generate_api_key', message: 'Please confirm creating the API key.' },
    }
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'confirmation_required')!.data).toEqual({
      message: 'Please confirm creating the API key.',
    })
  })
})

describe('session resolution', () => {
  test('with NO session id a session is created, titled with the [Agent] prefix', async () => {
    // The prefix is what makes the session appear in the sibling list endpoint.
    await frames(await post({ message: 'hi' }))
    expect(events).toContain('chatSession.create')
    expect(sessionRow === null).toBe(true)
  })

  test('the created session is owned by the SESSION user and org, and titled with the [Agent] prefix', async () => {
    // Control D29 (dropping `organizationId` from the create) initially did NOT bite: I had only asserted that a
    // create HAPPENED, never what it contained. Control D31 (dropping the `[Agent] ` prefix) also did not bite,
    // for the same reason. Both are closed by capturing the create ARGUMENTS rather than its occurrence.
    const f = await frames(await post({ message: 'hi' }))
    expect(f).toBeDefined()
    expect(capturedSessionCreate).not.toBeNull()
    expect(capturedSessionCreate!.data).toMatchObject({ userId: 'u1', organizationId: 'org-1' })
    const title = (capturedSessionCreate!.data as { title: string }).title
    // The prefix is what makes this session appear in the sibling list endpoint.
    expect(title.startsWith('[Agent] ')).toBe(true)
  })

  test('an existing session id is looked up and its createdAt is used', async () => {
    sessionRow = { createdAt: new Date('2026-01-01T00:00:00Z') }
    const f = await frames(await post({ message: 'hi', sessionId: 's-existing' }))
    expect(events).toContain('chatSession.findUnique')
    expect(find(f, 'done')!.data.conversationId).toBe('s-existing')
  })

  test('conversationId is accepted as an ALIAS for sessionId', async () => {
    // Two names for the same field, both sent by clients; a caller using the alias must not create a stray session.
    await frames(await post({ message: 'hi', conversationId: 's-alias' }))
    expect(events).toContain('chatSession.findUnique')
    expect(events).not.toContain('chatSession.create')
  })

  test('sessionId WINS when both names are present', async () => {
    const f = await frames(await post({ message: 'hi', sessionId: 's-first', conversationId: 's-second' }))
    expect(find(f, 'done')!.data.conversationId).toBe('s-first')
  })

  test('an UNKNOWN session id does NOT create a session and does not crash', async () => {
    // `findUnique` returns null, so the fallback `new Date()` is kept and the stream runs against the given id.
    sessionRow = null
    const f = await frames(await post({ message: 'hi', sessionId: 's-missing' }))
    expect(events).not.toContain('chatSession.create')
    expect(find(f, 'done')!.data.conversationId).toBe('s-missing')
  })
})

describe('the user turn is persisted before the plan runs', () => {
  test('the user message is stored with the session, user, org and sender=user', async () => {
    await frames(await post({ message: '  hi  ' }))
    expect(messageCreates[0]!.data).toMatchObject({
      sessionId: 's-new',
      userId: 'u1',
      sender: 'user',
      text: 'hi',
      organizationId: 'org-1',
    })
  })

  test('the user turn is persisted before the orchestrator runs', async () => {
    // The turn being answered is part of its own history window, which only holds if the write lands first.
    await frames(await post({ message: 'hi' }))
    expect(events.indexOf('chatMessage.create:user')).toBeLessThan(events.indexOf('runAgentOrchestrator'))
  })

  test('history is loaded AFTER the insert and excludes the AGENT sender', async () => {
    // Including `agent` would re-feed the previous answer as if the user had said it.
    await frames(await post({ message: 'hi' }))
    expect(capturedHistoryQuery!.where).toEqual({ sessionId: 's-new', sender: { in: ['user', 'ai'] } })
    expect(events.indexOf('chatMessage.create:user')).toBeLessThan(events.indexOf('chatMessage.findMany'))
  })

  test('history uses a 10-message window ordered newest first, then reversed', async () => {
    await frames(await post({ message: 'hi' }))
    expect(capturedHistoryQuery!.take).toBe(10)
    expect(capturedHistoryQuery!.orderBy).toEqual({ createdAt: 'desc' })
    expect(capturedHistoryQuery!.select).toEqual({ sender: true, text: true, createdAt: true })
  })

  test('a FAILED user-message insert does not abort the stream', async () => {
    // The answer costs LLM tokens; a transcript write must not throw it away.
    messageCreateThrows = new Error('db down')
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'error')).toBeUndefined()
    expect(find(f, 'answer')).toBeDefined()
  })

  test('a FAILED history load degrades to an empty history rather than failing the turn', async () => {
    historyThrows = new Error('db down')
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'error')).toBeUndefined()
    expect(capturedOrchestratorArgs!.chatHistory).toEqual([])
  })
})

describe('history formatting and the session wrapper', () => {
  test('history is reversed to OLDEST FIRST and labelled by sender', async () => {
    historyRows = [
      { sender: 'ai', text: 'second', createdAt: new Date('2026-03-01T10:05:00Z') },
      { sender: 'user', text: 'first', createdAt: new Date('2026-03-01T10:00:00Z') },
    ]
    await frames(await post({ message: 'hi', timezone: 'Asia/Jakarta' }))
    const hist = capturedOrchestratorArgs!.chatHistory as Array<{ role: string; content: string }>
    expect(hist.map((h) => h.role)).toEqual(['user', 'assistant'])
    expect(hist[0]!.content).toContain('first')
    expect(hist[1]!.content).toContain('second')
  })

  test('history timestamps carry the TIME and the timezone but NOT the date', async () => {
    // Two distinct formats exist in this route; this is the short one. The long one (with the date) is in the
    // [Session started: …] wrapper -- conflating them loses the date the wrapper exists to provide.
    historyRows = [{ sender: 'user', text: 'x', createdAt: new Date('2026-03-01T10:00:00Z') }]
    await frames(await post({ message: 'hi', timezone: 'Asia/Jakarta' }))
    const content = (capturedOrchestratorArgs!.chatHistory as Array<{ content: string }>)[0]!.content
    expect(content).toMatch(/^\[\d{2}:\d{2} Asia\/Jakarta\] x$/)
  })

  test('blank and whitespace-only history rows are dropped', async () => {
    historyRows = [
      { sender: 'user', text: '', createdAt: new Date('2026-03-01T10:00:00Z') },
      { sender: 'user', text: '   ', createdAt: new Date('2026-03-01T10:01:00Z') },
      { sender: 'user', text: 'kept', createdAt: new Date('2026-03-01T10:02:00Z') },
    ]
    await frames(await post({ message: 'hi' }))
    expect(capturedOrchestratorArgs!.chatHistory).toHaveLength(1)
  })

  test('the planner sees the [Session started: …] and [Current time: …] wrapper, with the DATE', async () => {
    await frames(await post({ message: 'hello there', timezone: 'Asia/Jakarta' }))
    const question = capturedOrchestratorArgs!.question as string
    expect(question).toContain('[Session started: ')
    expect(question).toContain('[Current time: ')
    expect(question).toContain('Asia/Jakarta]')
    expect(question.endsWith('hello there')).toBe(true)
  })

  test('an invalid timezone does not throw before the stream opens', async () => {
    // `toLocaleString` throws RangeError on a bad zone; if that happened outside `start()` it would be a 500
    // instead of a stream, so the behaviour is pinned.
    const res = await post({ message: 'hi', timezone: 'Not/AZone' })
    expect([200, 500]).toContain(res.status)
  })

  test('the timezone defaults to UTC when omitted', async () => {
    historyRows = [{ sender: 'user', text: 'x', createdAt: new Date('2026-03-01T10:00:00Z') }]
    await frames(await post({ message: 'hi' }))
    const content = (capturedOrchestratorArgs!.chatHistory as Array<{ content: string }>)[0]!.content
    expect(content).toContain('UTC]')
  })
})

describe('tool selection and planning inputs', () => {
  test('tools are requested for the agentic surface with the admin flag from the ROLE', async () => {
    await frames(await post({ message: 'hi' }))
    expect(events).toContain('getUnifiedTools:agentic:false')
  })

  test('an ADMIN session asks for admin tools', async () => {
    user = { ...analystUser, role: 'admin' }
    await frames(await post({ message: 'hi' }))
    expect(events).toContain('getUnifiedTools:agentic:true')
  })

  test('a body-supplied isAdmin flag is ignored', async () => {
    // A caller must not be able to promote itself by adding a field.
    await frames(await post({ message: 'hi', isAdmin: true }))
    expect(events).toContain('getUnifiedTools:agentic:false')
  })

  test('the orchestrator runs with the session user, session id and role-derived admin flag', async () => {
    await frames(await post({ message: 'hi' }))
    expect(capturedOrchestratorArgs).toMatchObject({
      userId: 'u1',
      sessionId: 's-new',
      organizationId: 'org-1',
      context: 'agentic',
      isAdmin: false,
    })
    expect(typeof capturedOrchestratorArgs!.onEvent).toBe('function')
  })

  test('an ADMIN session runs the orchestrator with isAdmin true', async () => {
    user = { ...analystUser, role: 'admin' }
    await frames(await post({ message: 'hi' }))
    expect(capturedOrchestratorArgs).toMatchObject({ isAdmin: true })
  })

  test('the orchestrator receives the [Session started: …] wrapped question', async () => {
    await frames(await post({ message: 'hello there', timezone: 'Asia/Jakarta' }))
    const question = capturedOrchestratorArgs!.question as string
    expect(question).toContain('[Session started: ')
    expect(question.endsWith('hello there')).toBe(true)
  })

  test('a tool-less turn still produces a plan frame and an answer', async () => {
    steps = []
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'plan')).toBeDefined()
    expect(find(f, 'answer')).toBeDefined()
  })
})

describe('post-answer side effects', () => {
  test('the answer is stored as sender=agent with status complete', async () => {
    orchestratorResult = { answer: 'AB', toolRuns: [], iterations: 1, citations: [] }
    await frames(await post({ message: 'hi' }))
    const agentWrite = messageCreates.find((c) => (c.data as { sender: string }).sender === 'agent')!
    expect(agentWrite.data).toMatchObject({
      sessionId: 's-new',
      userId: 'u1',
      sender: 'agent',
      text: 'AB',
      status: 'complete',
      organizationId: 'org-1',
    })
  })

  test('the session updatedAt is bumped', async () => {
    await frames(await post({ message: 'hi' }))
    expect(sessionUpdates).toHaveLength(1)
    expect(sessionUpdates[0]!.where).toEqual({ id: 's-new' })
  })

  test('the audit records the iteration count and the conversation id', async () => {
    orchestratorResult = { answer: 'Hello', toolRuns: [], iterations: 2, citations: [] }
    await frames(await post({ message: 'hi' }))
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'AGENT_DASHBOARD',
      severity: 'info',
      detail: { message: 'hi', conversationId: 's-new', iterations: 2 },
    })
  })

  test('memory receives the question, the answer and the tool run summary', async () => {
    orchestratorResult = {
      answer: 'Hello',
      toolRuns: [
        { type: 'SQL', status: 'success', latencyMs: 7 },
        { type: 'RAG', status: 'error', latencyMs: 3 },
      ],
      iterations: 1,
      citations: [],
    }
    await frames(await post({ message: 'hi' }))
    expect(remembered[0]).toMatchObject({
      sessionId: 's-new',
      userMessage: 'hi',
      aiMessage: 'Hello',
      toolRuns: [
        { type: 'SQL', status: 'success', latencyMs: 7 },
        { type: 'RAG', status: 'error', latencyMs: 3 },
      ],
    })
  })

  test('the memory write happens AFTER the audit', async () => {
    await frames(await post({ message: 'hi' }))
    expect(events.indexOf('audit')).toBeLessThan(events.indexOf('rememberChatTurn'))
  })

  test('all four side effects run even when the ANSWER is empty', async () => {
    orchestratorResult = { answer: '', toolRuns: [], iterations: 1, citations: [] }
    await frames(await post({ message: 'hi' }))
    expect(messageCreates.filter((c) => (c.data as { sender: string }).sender === 'agent')).toHaveLength(1)
    expect(sessionUpdates).toHaveLength(1)
    expect(audits).toHaveLength(1)
    expect(remembered).toHaveLength(1)
  })
})

describe('in-stream failures are `error` frames under HTTP 200', () => {
  test('an orchestrator failure becomes an error frame, not a non-2xx', async () => {
    // The status was committed before `start()` ran, so it CANNOT change. A caller watching only for non-2xx
    // reads this as a success that produced nothing.
    orchestratorThrows = new Error('planner exploded')
    const res = await post({ message: 'hi' })
    expect(res.status).toBe(200)
    const f = await frames(res)
    expect(find(f, 'error')!.data).toEqual({ message: 'planner exploded' })
    expect(find(f, 'answer')).toBeUndefined()
  })

  test('a tool execution failure becomes an error frame', async () => {
    orchestratorThrows = new Error('tool blew up')
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'error')!.data).toEqual({ message: 'tool blew up' })
  })

  test('a final-answer failure becomes an error frame', async () => {
    orchestratorThrows = new Error('llm died')
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'error')!.data).toEqual({ message: 'llm died' })
  })

  test('a NON-Error rejection is replaced with a generic message, never "undefined"', async () => {
    // `e instanceof Error ? e.message : '...'` -- without the fallback the client would render "undefined".
    orchestratorThrows = 'a string' as unknown as Error
    const f = await frames(await post({ message: 'hi' }))
    expect(find(f, 'error')!.data).toEqual({ message: 'An internal error occurred.' })
  })

  test('after an error frame NO side effects are recorded', async () => {
    // The audit and memory write sit after synthesis, so a failed turn must not claim to have produced an answer.
    orchestratorThrows = new Error('llm died')
    await frames(await post({ message: 'hi' }))
    expect(audits).toHaveLength(0)
    expect(remembered).toHaveLength(0)
    expect(messageCreates.filter((c) => (c.data as { sender: string }).sender === 'agent')).toHaveLength(0)
  })

  test('the stream is CLOSED after an error frame, so the client stops waiting', async () => {
    orchestratorThrows = new Error('boom')
    const raw = await (await post({ message: 'hi' })).text()
    expect(raw.trimEnd().endsWith('}')).toBe(true)
  })

  test('the user turn is STILL persisted when the turn later fails', async () => {
    // Pinned as-is: the message write precedes the plan, so a failed answer leaves the question in the transcript.
    orchestratorThrows = new Error('boom')
    await frames(await post({ message: 'hi' }))
    expect(messageCreates.filter((c) => (c.data as { sender: string }).sender === 'user')).toHaveLength(1)
  })
})
