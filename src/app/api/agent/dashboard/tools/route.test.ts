/**
 * GET /api/agent/dashboard/tools — the static tool catalogue the sidebar renders.
 *
 * WHY THIS FILE EXISTS. The list is a module constant, so the interesting properties are about the CONTRACT
 * rather than the data: the org context is still entered (the handler is session-authenticated even though it
 * reads nothing), the envelope key is `tools` (not `data`), and the ids stay unique -- a duplicate id would make
 * the sidebar key collide and the category grouping ambiguous.
 *
 * The counts are asserted EXACTLY. If a tool is added or removed the test fails, which is the point: the sidebar
 * is the agent console's inventory and a silent change to it should be a deliberate edit here.
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
let user: typeof analystUser = analystUser
let authThrows: Error | null = null

const events: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

import { GET } from './route'

type Tool = { id: string; category: string; name: string; description: string; status: string }

const toolsOf = async (): Promise<Tool[]> =>
  ((await (await GET()).json()) as { tools: Tool[] }).tools

beforeEach(() => {
  user = analystUser
  authThrows = null
  events.length = 0
})

describe('the envelope and the org context', () => {
  test('the payload is keyed `tools`, not `data`', async () => {
    // The sidebar reads `.tools`; a rename would render an empty console with no error.
    const body = (await (await GET()).json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['tools'])
    expect(Array.isArray(body.tools)).toBe(true)
  })

  test('the session org is entered even though no DB row is read', async () => {
    // Pinned deliberately: the handler is session-authenticated, so the context entry is what keeps it
    // consistent with every sibling route (and with the static tenant guard).
    await GET()
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('it answers 200', async () => {
    expect((await GET()).status).toBe(200)
  })

  test('the context is entered from the SESSION user, not a constant', async () => {
    user = { ...analystUser, organizationId: 'org-other' }
    await GET()
    expect(events).toContain('enterWithOrg:org-other')
  })
})

describe('the catalogue contract', () => {
  test('it holds exactly 28 tools', async () => {
    expect(await toolsOf()).toHaveLength(28)
  })

  test('every id is UNIQUE', async () => {
    // A duplicate id would make the sidebar's React key collide.
    const ids = (await toolsOf()).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every tool carries all five documented fields, non-empty', async () => {
    for (const t of await toolsOf()) {
      expect(typeof t.id).toBe('string')
      expect(t.id.length).toBeGreaterThan(0)
      expect(t.category.length).toBeGreaterThan(0)
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.status.length).toBeGreaterThan(0)
    }
  })

  test('every id is namespaced as category.action', async () => {
    // The sidebar groups on the CATEGORY field, but the id namespace must agree with it or a future reader
    // cannot tell which of the two is authoritative.
    for (const t of await toolsOf()) {
      expect(t.id.startsWith(`${t.category}.`)).toBe(true)
    }
  })

  test('every status is `available`', async () => {
    // A status field exists so tools could be shown unavailable; none are today.
    expect((await toolsOf()).every((t) => t.status === 'available')).toBe(true)
  })

  test('the six categories and their sizes are exactly as documented', async () => {
    const counts: Record<string, number> = {}
    for (const t of await toolsOf()) counts[t.category] = (counts[t.category] ?? 0) + 1
    expect(counts).toEqual({
      database: 5,
      knowledge: 5,
      api: 4,
      monitoring: 5,
      security: 4,
      provider: 5,
    })
  })

  test('the provider list covers the five BYOK backends', async () => {
    const providers = (await toolsOf()).filter((t) => t.category === 'provider').map((t) => t.id)
    // Compared as a SET: my first version used `.sort()` and asserted an order I had guessed wrong
    // ('provider.openai' sorts before 'provider.openrouter'). The inventory is what matters, not its order.
    expect([...providers].sort()).toEqual([
      'provider.anthropic',
      'provider.gemini',
      'provider.ollama',
      'provider.openai',
      'provider.openrouter',
    ])
  })

  test('the database category exposes the five lifecycle actions', async () => {
    const ids = (await toolsOf()).filter((t) => t.category === 'database').map((t) => t.id)
    expect([...ids].sort()).toEqual([
      'database.connect',
      'database.disconnect',
      'database.query',
      'database.refresh',
      'database.schema',
    ])
  })

  test('the payload is stable across calls (no per-request mutation of the constant)', async () => {
    // `as const` is type-level only: a handler that mutated the array would leak across requests.
    expect(await toolsOf()).toEqual(await toolsOf())
  })

  test('two concurrent calls return the same content', async () => {
    const [a, b] = await Promise.all([toolsOf(), toolsOf()])
    expect(a).toEqual(b)
  })
})

describe('failure handling', () => {
  test('a session failure is 500 through the typed handler, with no error text leaked', async () => {
    // The handler reads its user and nothing else, so this is the ONLY way its catch can run. Exercised rather
    // than left uncovered, because an unexercised catch is where a leak or a 200-on-failure hides.
    authThrows = new Error('session store down')
    const res = await GET()
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('session store down')
    expect(raw).toContain('INTERNAL_ERROR')
  })
})
