import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// /api/mcp/servers — GET (list) and POST (create).
//
// A separate file from servers/[id]/route.test.ts because the two routes have
// independent module graphs and the [id] file's mocks are shaped for a single-row
// lookup. This one covers the collection route plus the pure helpers it uses.
//
// POST is the door the AGENTIC installer also goes through, and it is where an
// admin registers a process to spawn (stdio) or a host to connect to (sse/http).
// The plan gate, the transport/URL validation and the credential encryption are
// the three boundaries, and all three are asserted here.
// ---------------------------------------------------------------------------
const state = {
  rows: [] as any[],
  created: [] as any[],
  audits: [] as any[],
  invalidations: 0,
  role: 'admin',
  plan: 'pro',
  encryptCalls: [] as any[],
}

mock.module('@/lib/db', () => ({
  isPrismaNotFound: () => false,
  db: {
    mcpServer: {
      findMany: async (a: any) => { void a; return state.rows },
      create: async (a: any) => {
        state.created.push(a)
        return { id: 'srv-new', createdAt: new Date(), updatedAt: new Date(), ...a.data }
      },
    },
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => ({ userId: 'u1', organizationId: 'org-A', role: state.role, plan: state.plan }),
  requireRole: (user: any, role: string) => {
    if (user.role !== role) throw Object.assign(new Error('Insufficient permissions.'), { statusCode: 403 })
  },
  writeAudit: async (a: any) => { state.audits.push(a) },
  handleApiError: (e: any, fallback: string) => ({
    status: (e as any)?.statusCode ?? 500,
    json: async () => ({ error: { message: (e as any)?.message ?? fallback } }),
  }),
}))
mock.module('@/lib/plan-gating', () => ({
  hasPlan: (plan: string | null | undefined, required: string) => plan === required || plan === 'enterprise',
}))
mock.module('@/lib/crypto', () => ({
  encryptConfig: (c: any) => { state.encryptCalls.push(c); return `enc:${Object.keys(c).join(',')}` },
  decryptConfig: () => ({}),
}))
mock.module('@/lib/llm-config', () => ({
  isBlockedHost: (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '169.254.169.254' || h.startsWith('10.') || h.startsWith('192.168.'),
}))
mock.module('@/lib/mcp-client', () => ({
  invalidateMcpToolsCache: () => { state.invalidations++ },
  disconnectMcpServer: async () => {},
  testMcpServer: async () => ({ ok: true, tools: [], toolCount: 0 }),
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => {},
  getOrgContext: () => 'org-A',
  bypassOrg: (fn: () => unknown) => fn(),
}))

import { GET, POST, sanitizeServer } from './route'

const req = (body: unknown) => ({ json: async () => body } as any)
const stdio = (over: Record<string, unknown> = {}) => ({
  name: 'Files', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], ...over,
})

beforeEach(() => {
  state.rows = []
  state.created = []
  state.audits = []
  state.invalidations = 0
  state.role = 'admin'
  state.plan = 'pro'
  state.encryptCalls = []
})

describe('POST /api/mcp/servers — the plan gate', () => {
  test('a plan below Pro is refused with 403 and creates nothing', async () => {
    state.plan = 'starter'
    const res = await POST(req(stdio())) as any
    // MCP servers are a Pro feature; the row must not exist either.
    expect(res.status).toBe(403)
    expect(state.created).toHaveLength(0)
  })

  test('a Pro plan is accepted', async () => {
    state.plan = 'pro'
    expect((await POST(req(stdio())) as any).status).toBe(201)
  })

  test('an Enterprise plan is accepted', async () => {
    state.plan = 'enterprise'
    expect((await POST(req(stdio())) as any).status).toBe(201)
  })

  test('a non-admin caller is refused', async () => {
    state.role = 'analyst'
    expect((await POST(req(stdio())) as any).status).toBe(403)
    expect(state.created).toHaveLength(0)
  })
})

describe('POST /api/mcp/servers — transport validation', () => {
  test('a missing name is refused', async () => {
    expect((await POST(req(stdio({ name: '  ' }))) as any).status).toBe(400)
  })

  test('an invalid transport is refused and the allowed set is named', async () => {
    const body = await (await (POST(req(stdio({ transport: 'udp' }))) as any)).json()
    expect(body.error).toContain('stdio')
    expect(body.error).toContain('sse')
    expect(body.error).toContain('http')
  })

  test('a missing transport is refused rather than defaulting silently', async () => {
    expect((await POST(req({ name: 'x' })) as any).status).toBe(400)
  })

  test('stdio without a command is refused', async () => {
    const body = await (await (POST(req(stdio({ command: '   ' }))) as any)).json()
    expect(body.error).toContain('command is required')
  })

  test('sse without a url is refused', async () => {
    const body = await (await (POST(req({ name: 'x', transport: 'sse' })) as any)).json()
    expect(body.error).toContain('url is required')
  })

  test('SSRF: a blocked internal host is refused for sse and http', async () => {
    for (const url of ['http://169.254.169.254/x', 'http://localhost:9000/sse', 'http://10.1.2.3/mcp', 'http://192.168.1.9/sse']) {
      state.created = []
      const res = await POST(req({ name: 'x', transport: 'sse', url })) as any
      expect(res.status).toBe(400)
      expect(state.created).toHaveLength(0)
    }
  })

  test('a non-http scheme is refused', async () => {
    expect((await POST(req({ name: 'x', transport: 'http', url: 'gopher://h/x' })) as any).status).toBe(400)
  })

  test('a malformed url string is refused', async () => {
    expect((await POST(req({ name: 'x', transport: 'http', url: 'nope' })) as any).status).toBe(400)
  })

  test('a public sse url is accepted', async () => {
    expect((await POST(req({ name: 'x', transport: 'sse', url: 'https://mcp.example.com/sse' })) as any).status).toBe(201)
  })

  test('a stdio server stores an EMPTY url, never a leftover one', async () => {
    await POST(req(stdio({ url: 'https://ignored.example.com' })))
    // Otherwise a later transport switch would silently reuse a stale endpoint.
    expect(state.created[0].data.url).toBe('')
  })
})

describe('POST /api/mcp/servers — credentials and defaults', () => {
  test('envVars are ENCRYPTED, and the plaintext never reaches the column', async () => {
    await POST(req(stdio({ envVars: { GITHUB_TOKEN: 'ghp_secret' } })))
    const stored = state.created[0].data.envJson
    expect(stored).toBe('enc:GITHUB_TOKEN')
    expect(stored).not.toContain('ghp_secret')
  })

  test('headers are ENCRYPTED too', async () => {
    await POST(req({ name: 'x', transport: 'sse', url: 'https://a.example.com/sse', headers: { Authorization: 'Bearer t' } }))
    expect(state.created[0].data.headersJson).toBe('enc:Authorization')
  })

  test('no credentials store an empty object, not an encrypted empty blob', async () => {
    await POST(req(stdio()))
    // A non-'{}' value would make hasEnvVars report a credential that is not there.
    expect(state.created[0].data.envJson).toBe('{}')
    expect(state.created[0].data.headersJson).toBe('{}')
  })

  test('an empty credentials object is also stored as {}', async () => {
    await POST(req(stdio({ envVars: {}, headers: {} })))
    expect(state.created[0].data.envJson).toBe('{}')
  })

  test('non-string credential values are coerced and nulls dropped', async () => {
    await POST(req(stdio({ envVars: { PORT: 8080, OK: true, NUL: null } })))
    const sent = state.encryptCalls[0]
    expect(sent.PORT).toBe('8080')
    expect(sent.OK).toBe('true')
    expect(sent.NUL).toBeUndefined()
  })

  test('a non-object credentials value does not throw', async () => {
    await POST(req(stdio({ envVars: 'oops' as any })))
    expect(state.created[0].data.envJson).toBe('{}')
  })

  test('args are normalised to a JSON string array', async () => {
    await POST(req(stdio({ args: ['-y', 'pkg', 'dir'] })))
    expect(state.created[0].data.args).toBe('["-y","pkg","dir"]')
    state.created = []
    await POST(req(stdio({ args: 'raw string' })))
    expect(state.created[0].data.args).toBe('[]')
  })

  test('the row is scoped to the calling org', async () => {
    await POST(req(stdio()))
    expect(state.created[0].data.organizationId).toBe('org-A')
  })

  test('the three enable flags default to true', async () => {
    await POST(req(stdio()))
    const d = state.created[0].data
    expect(d.isEnabled).toBe(true)
    expect(d.chatEnabled).toBe(true)
    expect(d.agenticEnabled).toBe(true)
  })

  test('explicit false flags are honoured rather than overwritten by the default', async () => {
    await POST(req(stdio({ isEnabled: false, chatEnabled: false, agenticEnabled: false })))
    const d = state.created[0].data
    // `body.isEnabled ?? true` and `typeof === 'boolean'` differ here on purpose;
    // both must respect an explicit false.
    expect(d.isEnabled).toBe(false)
    expect(d.chatEnabled).toBe(false)
    expect(d.agenticEnabled).toBe(false)
  })

  test('the tool cache is invalidated so the new server is visible immediately', async () => {
    await POST(req(stdio()))
    expect(state.invalidations).toBeGreaterThan(0)
  })

  test('the create is audited at warning severity', async () => {
    await POST(req(stdio()))
    const audit = state.audits.find((a) => a.action === 'MCP_SERVER_CREATE')
    expect(audit.severity).toBe('warning')
  })

  test('a malformed JSON body is a 400, not a 500', async () => {
    const res = await POST({ json: async () => { throw new Error('bad') } } as any) as any
    expect(res.status).toBe(400)
  })
})

describe('GET /api/mcp/servers — list', () => {
  test('returns an empty list without inventing entries', async () => {
    const body = await (await (GET() as any)).json()
    expect(body.ok).toBe(true)
    expect(body.servers).toEqual([])
  })

  test('credential blobs are scrubbed from every row in the list', async () => {
    state.rows = [
      { id: 'a', name: 'A', description: '', transport: 'stdio', command: 'npx', args: '[]', url: '', envJson: 'enc-secret-a', headersJson: 'enc-hdr-a', isEnabled: true, chatEnabled: true, agenticEnabled: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'b', name: 'B', description: '', transport: 'sse', command: '', args: '[]', url: 'https://x/sse', envJson: '{}', headersJson: '{}', isEnabled: true, chatEnabled: true, agenticEnabled: true, createdAt: new Date(), updatedAt: new Date() },
    ]
    const body = await (await (GET() as any)).json()
    // A leak here exposes every credential in the org at once.
    expect(JSON.stringify(body)).not.toContain('enc-secret-a')
    expect(JSON.stringify(body)).not.toContain('enc-hdr-a')
    expect(body.servers).toHaveLength(2)
    expect(body.servers[0].hasEnvVars).toBe(true)
    expect(body.servers[1].hasEnvVars).toBe(false)
  })
})

describe('sanitizeServer', () => {
  test('replaces envJson/headersJson with boolean flags', () => {
    const out = sanitizeServer({
      id: 'i', name: 'n', description: 'd', transport: 'stdio', command: 'c', args: '[]', url: '',
      envJson: 'enc', headersJson: '{}', isEnabled: true, chatEnabled: false, agenticEnabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    } as any)
    expect(out).not.toHaveProperty('envJson')
    expect((out as any).hasEnvVars).toBe(true)
    expect((out as any).hasHeaders).toBe(false)
    expect((out as any).chatEnabled).toBe(false)
  })
})
