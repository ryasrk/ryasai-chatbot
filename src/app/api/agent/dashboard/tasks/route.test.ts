/**
 * GET/POST /api/agent/dashboard/tasks — the in-process async task queue's HTTP face.
 *
 * WHY THIS FILE EXISTS. The queue is an in-memory Map, so a task's identity is process-local and this route is
 * really a two-method protocol:
 *
 *   1. `?taskId=` SWITCHES THE RESPONSE SHAPE. With it the route returns `{task}` and answers 404 for an unknown
 *      id; without it, `{tasks}`. A caller reading `.tasks` from the id branch gets undefined, not an error.
 *   2. POST ONLY ACCEPTS `type === 'chat'` WITH A QUESTION. Anything else is 400 -- including `type: 'chat'`
 *      with no question, which is the tempting case to let through. Only 'chat' has a registered handler, so
 *      queueing any other type would create a task nothing ever runs.
 *   3. THE HANDLER IS REGISTERED AT MODULE SCOPE, so it runs on import and must run EXACTLY once.
 *
 * A REAL TOOLING FINDING, FOUND BY PROBING RATHER THAN GUESSING. `mock.module` DOES NOT APPLY TO A STATICALLY
 * IMPORTED MODULE. With `import { GET, POST } from './route'` the route is evaluated BEFORE `mock.module` runs,
 * so the route's module-scope `registerHandler('chat', ...)` reaches the REAL implementation and my mock's
 * recorder stays empty -- which reads exactly like "the route never registers a handler", a false finding about
 * the code. Two-way control, same file, only the import style changed:
 *
 *     import { GET } from './route'   ->  registerHandler mock called: NO  (recorder [])
 *     await import('./route')         ->  registerHandler mock called: YES (recorder ["chat"])
 *
 * The route therefore uses a DYNAMIC import, which is also why every mutable seam above must be declared at the
 * very top: hoisted imports still evaluate this file's body BEFORE any statement below them, so a seam declared
 * further down is still `undefined` when the route runs.
 *
 * ALSO PINNED: GET enters the org context; POST enters it BEFORE enqueueing; the `listTasks(20)` window; and the
 * queued payload carries the SESSION's userId rather than a body-supplied one.
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

// ---- mutable seams, declared before any mock.module so they exist when the route is evaluated ----
let user: typeof analystUser = analystUser
let task: Record<string, unknown> | null = null
let taskList: Array<Record<string, unknown>> = []
let enqueued: Array<{ type: string; input: Record<string, unknown> }> = []
let registeredHandlers: string[] = []
let chatAnswer = 'the answer'
let authThrows: Error | null = null
const handlers: Record<string, (t: { input: Record<string, unknown> }) => Promise<string>> = {}
const events: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: (_e: unknown, fallback: string, status = 500) =>
    Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/async-worker', () => ({
  enqueue: (type: string, input: Record<string, unknown>) => {
    enqueued.push({ type, input })
    events.push(`enqueue:${type}`)
    return 'task-1'
  },
  getTask: (id: string) => {
    events.push(`getTask:${id}`)
    return task
  },
  listTasks: (limit: number) => {
    events.push(`listTasks:${limit}`)
    return taskList
  },
  registerHandler: (name: string, fn: (t: { input: Record<string, unknown> }) => Promise<string>) => {
    registeredHandlers.push(name)
    handlers[name] = fn
  },
}))

mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: async (args: Record<string, unknown>) => {
    events.push(`chatCompletion:${String(args.userId)}`)
    return { answer: chatAnswer }
  },
}))

// DYNAMIC on purpose -- see the header. A static import would bypass every mock above.
const { GET, POST } = await import('./route')

function get(query = '') {
  const url = `http://localhost/api/agent/dashboard/tasks${query}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return GET(req as never)
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/agent/dashboard/tasks', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

beforeEach(() => {
  user = analystUser
  task = null
  taskList = []
  enqueued = []
  chatAnswer = 'the answer'
  authThrows = null
  events.length = 0
})

describe('module-scope handler registration', () => {
  test('the chat handler is registered exactly once, at import time', async () => {
    // Zero registrations would make every queued chat task hang with no error; two would replace the first.
    expect(registeredHandlers.filter((h) => h === 'chat')).toHaveLength(1)
  })

  test('the two imports placed at the END of the route file are still hoisted', async () => {
    // `registerHandler` and `enterWithOrg` are imported AFTER the handler registration, which reads like a bug.
    // ESM hoists imports, so the bindings exist first -- and the assertion below is what makes that fact
    // load-bearing: the registration succeeded, which it could not have if the import were a runtime step.
    expect(registeredHandlers).toContain('chat')
    expect(typeof handlers.chat).toBe('function')
  })

  test('no request registers another handler', async () => {
    const before = registeredHandlers.length
    await get()
    await post({ type: 'chat', question: 'hi' })
    expect(registeredHandlers).toHaveLength(before)
  })

  test('the registered handler returns the completion text', async () => {
    chatAnswer = 'forty-two'
    expect(await handlers.chat!({ input: { question: 'q', userId: 'u9' } })).toBe('forty-two')
  })

  test('the handler passes the task input userId through, not a constant', async () => {
    await handlers.chat!({ input: { question: 'q', userId: 'u-other' } })
    expect(events).toContain('chatCompletion:u-other')
  })
})

describe('GET', () => {
  test('an explicit taskId reads that ONE task', async () => {
    task = { id: 'task-1', status: 'done' }
    const body = (await (await get('?taskId=task-1')).json()) as { ok: boolean; task: unknown }
    expect(body).toEqual({ ok: true, task: { id: 'task-1', status: 'done' } })
    expect(events.some((e) => e.startsWith('listTasks'))).toBe(false)
  })

  test('an UNKNOWN taskId is 404 and does NOT fall back to the list', async () => {
    // Falling back would make a poller read a lost task as an empty queue.
    task = null
    const res = await get('?taskId=nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('Task not found.')
    expect(events.some((e) => e.startsWith('listTasks'))).toBe(false)
  })

  test('without a taskId it returns the 20-item list window', async () => {
    taskList = [{ id: 'a' }]
    const body = (await (await get()).json()) as { ok: boolean; tasks: unknown[] }
    expect(body).toEqual({ ok: true, tasks: [{ id: 'a' }] })
    expect(events).toContain('listTasks:20')
  })

  test('an EMPTY taskId falls through to the list', async () => {
    await get('?taskId=')
    expect(events.some((e) => e.startsWith('listTasks'))).toBe(true)
  })

  test('an empty queue is 200 with an empty array', async () => {
    expect(((await (await get()).json()) as { tasks: unknown[] }).tasks).toEqual([])
  })

  test('GET enters the org context', async () => {
    await get()
    expect(events).toContain('enterWithOrg:org-1')
  })
})

describe('POST', () => {
  test('a chat task with a question is queued with the SESSION userId', async () => {
    // A body-supplied userId would attribute work to another user; the route ignores it.
    const body = (await (await post({ type: 'chat', question: 'hi', userId: 'u-evil' })).json()) as {
      ok: boolean
      taskId: string
      message: string
    }
    expect(body.ok).toBe(true)
    expect(body.taskId).toBe('task-1')
    expect(body.message).toContain('Poll GET /api/agent/dashboard/tasks')
    expect(enqueued).toEqual([{ type: 'chat', input: { question: 'hi', userId: 'u1' } }])
  })

  test('an OMITTED type defaults to chat and STILL requires a question', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Type and question are required.')
    expect(enqueued).toHaveLength(0)
  })

  test('type chat with NO question is 400', async () => {
    expect((await post({ type: 'chat' })).status).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  test('an EMPTY-STRING question is 400, not queued blank', async () => {
    expect((await post({ type: 'chat', question: '' })).status).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  test('an unsupported type is 400 even WITH a question', async () => {
    // Control T5 (`body.type ?? 'other'`) does NOT bite and CANNOT. I tried to close it and could not: a
    // non-chat default is refused by this very guard, so the response is byte-identical either way, and the
    // OMITTED-type test above passes under both defaults too. DECLARED as a non-control rather than claimed as
    // covered -- the literal `'chat'` in the default documents intent, not observable behaviour.
    expect((await post({ type: 'embed', question: 'hi' })).status).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  test('the enqueue TYPE argument is the literal chat, not the request value', async () => {
    // Control T8 (`enqueue(type, ...)`) does NOT bite and CANNOT through HTTP: the only type that reaches this
    // line is 'chat', so `type` and `'chat'` are the same string. Pinned as a DECLARED non-control: the literal
    // is what keeps the handler lookup and the queue key in agreement if the guard above is ever widened.
    await post({ type: 'chat', question: 'hi' })
    expect(enqueued[0]!.type).toBe('chat')
  })

  test('nothing is enqueued before validation passes', async () => {
    await post({ type: 'chat' })
    expect(events.some((e) => e.startsWith('enqueue'))).toBe(false)
  })

  test('POST enters the org context BEFORE enqueueing', async () => {
    await post({ type: 'chat', question: 'hi' })
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('enqueue:chat'))
  })

  test('a malformed JSON body is 400 rather than a crash', async () => {
    expect((await post('not json')).status).toBe(400)
  })
})

describe('failure handling', () => {
  test('a session failure on GET is 500 through the typed handler, with no error text leaked', async () => {
    authThrows = new Error('session store down')
    const res = await get()
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('session store down')
    expect(raw).toContain('INTERNAL_ERROR')
  })

  test('a session failure on POST is 500 and enqueues nothing', async () => {
    authThrows = new Error('session store down')
    const res = await post({ type: 'chat', question: 'hi' })
    expect(res.status).toBe(500)
    expect(enqueued).toHaveLength(0)
  })
})
