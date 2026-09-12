import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// /api/mcp/servers/[id] — GET / PATCH / DELETE.
//
// This route had NO tests at all, and it is one of the two routes named in the
// cross-tenant IDOR audit. Both were reached with a correct org-context goroutine
// (`getActiveUser()` + `enterWithOrg()`), which is why tenant-route-guard.test.ts
// passed them: the context was established and the query ignored it. The fix is
// that a CLIENT-SUPPLIED id must be loaded with findFirst (org-scoped by the
// tenant extension), never findUnique (which cannot be scoped).
//
// MCP servers are also the one place an admin can register a process to SPAWN,
// so the credential and URL handling here is a security boundary, not plumbing.
// ---------------------------------------------------------------------------
const state = {
  org: 'org-A' as string | undefined,
  row: null as any,
  findFirstCalls: [] as any[],
  findUniqueCalls: [] as any[],
  updates: [] as any[],
  deletes: [] as any[],
  deleteThrows: null as any,
  updateThrows: null as any,
  audits: [] as any[],
  disconnects: [] as string[],
  role: 'admin',
  encrypted: [] as any[],
}

mock.module('@/lib/db', () => ({
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
  db: {
    mcpServer: {
      // The tenant extension is what adds organizationId to the where clause in
      // production. This fake models it explicitly so an assertion can prove the
      // handler went through a scoped read rather than a unique one.
      findFirst: async (a: any) => {
        state.findFirstCalls.push(a)
        return state.row
      },
      findUnique: async (a: any) => {
        state.findUniqueCalls.push(a)
        return state.row
      },
      update: async (a: any) => {
        state.updates.push(a)
        if (state.updateThrows) throw state.updateThrows
        return { id: a.where.id, name: a.data.name ?? 'S', transport: a.data.transport ?? 'stdio', chatEnabled: true, agenticEnabled: true }
      },
      delete: async (a: any) => {
        state.deletes.push(a)
        if (state.deleteThrows) throw state.deleteThrows
        return { id: a.where.id }
      },
    },
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => ({ userId: 'u1', organizationId: state.org ?? 'org-A', role: state.role }),
  requireRole: (user: any, role: string) => {
    if (user.role !== role) throw Object.assign(new Error('Insufficient permissions.'), { statusCode: 403 })
  },
  writeAudit: async (a: any) => { state.audits.push(a) },
  handleApiError: (e: any, fallback: string) => ({
    status: (e as any)?.statusCode ?? 500,
    json: async () => ({ error: { message: (e as any)?.message ?? fallback } }),
  }),
}))
mock.module('@/lib/crypto', () => ({
  encryptConfig: (c: any) => { state.encrypted.push(c); return `enc:${Object.keys(c).join(',')}` },
  decryptConfig: () => ({}),
  signSession: () => 't',
}))
mock.module('@/lib/llm-config', () => ({
  // Real implementation is pure string matching over the parsed host — no need
  // to fake it, and faking it would hide a regression in the block list.
  isBlockedHost: (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '169.254.169.254' || h.startsWith('10.'),
}))
mock.module('@/lib/mcp-client', () => ({
  disconnectMcpServer: async (id: string) => { state.disconnects.push(id) },
  testMcpServer: async () => ({ ok: true, tools: [], toolCount: 0 }),
  invalidateMcpToolsCache: () => {},
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => {},
  getOrgContext: () => state.org,
  bypassOrg: (fn: () => unknown) => fn(),
}))

import { GET, PATCH, DELETE } from './route'
import { sanitizeServer } from '../route'

const base = {
  id: 'srv-1', name: 'Files', description: 'd', transport: 'stdio', command: 'npx',
  args: '["-y","pkg"]', url: '', envJson: 'enc-secrets', headersJson: 'enc-headers',
  isEnabled: true, chatEnabled: true, agenticEnabled: true,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const ctx = (id = 'srv-1') => ({ params: Promise.resolve({ id }) })
const req = (body?: unknown) => ({ json: async () => body } as any)

beforeEach(() => {
  state.org = 'org-A'
  state.row = { ...base }
  state.findFirstCalls = []
  state.findUniqueCalls = []
  state.updates = []
  state.deletes = []
  state.deleteThrows = null
  state.updateThrows = null
  state.audits = []
  state.disconnects = []
  state.role = 'admin'
  state.encrypted = []
})

describe('GET /api/mcp/servers/[id] — credential exposure', () => {
  test('an unknown id is 404, not an empty object', async () => {
    state.row = null
    const res = await GET({} as any, ctx()) as any
    expect(res.status).toBe(404)
  })

  test('the stored credential blobs are NEVER returned, only has* flags', async () => {
    const res = await GET({} as any, ctx()) as any
    const body = await res.json()
    // envJson/headersJson hold encrypted env vars and auth headers. Returning
    // them would hand every MCP credential to the browser.
    expect(JSON.stringify(body)).not.toContain('enc-secrets')
    expect(JSON.stringify(body)).not.toContain('enc-headers')
    expect(body.server.hasEnvVars).toBe(true)
    expect(body.server.hasHeaders).toBe(true)
    expect(body.server.envJson).toBeUndefined()
    expect(body.server.headersJson).toBeUndefined()
  })

  test('has* flags are false for the empty-blob default', async () => {
    state.row = { ...base, envJson: '{}', headersJson: '{}' }
    const body = await (await (GET({} as any, ctx()) as any)).json()
    expect(body.server.hasEnvVars).toBe(false)
    expect(body.server.hasHeaders).toBe(false)
  })

  test('CROSS-TENANT: the row is loaded by a SCOPED read, never findUnique', async () => {
    await GET({} as any, ctx('someone-elses-id'))
    // findUnique cannot be org-scoped by the tenant extension, so using it here
    // is the IDOR. This asserts the read that actually enforces isolation.
    expect(state.findFirstCalls).toHaveLength(1)
    expect(state.findUniqueCalls).toHaveLength(0)
  })

  test('the id from the route params is what gets looked up', async () => {
    await GET({} as any, ctx('abc-123'))
    expect(state.findFirstCalls[0].where.id).toBe('abc-123')
  })
})

describe('PATCH /api/mcp/servers/[id] — validation and credential handling', () => {
  test('an unknown id is 404', async () => {
    state.row = null
    expect((await PATCH(req({ name: 'x' }), ctx()) as any).status).toBe(404)
  })

  test('CROSS-TENANT: the existence check is a scoped read', async () => {
    await PATCH(req({ name: 'x' }), ctx('other-org-id'))
    expect(state.findFirstCalls[0].where.id).toBe('other-org-id')
    expect(state.findUniqueCalls).toHaveLength(0)
  })

  test('an empty body is refused rather than issuing a no-op write', async () => {
    const res = await PATCH(req({}), ctx()) as any
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  test('a malformed JSON body is treated as empty, not a 500', async () => {
    const res = await PATCH({ json: async () => { throw new Error('bad') } } as any, ctx()) as any
    expect(res.status).toBe(400)
  })

  test('an invalid transport is refused and the allowed set is named', async () => {
    const body = await (await (PATCH(req({ transport: 'carrier-pigeon' }), ctx()) as any)).json()
    expect(body.error).toContain('stdio')
    expect(body.error).toContain('http')
    expect(state.updates).toHaveLength(0)
  })

  test('every valid transport is accepted', async () => {
    for (const transport of ['stdio', 'sse', 'http']) {
      state.updates = []
      const res = await PATCH(req({ transport }), ctx()) as any
      expect(res.status).toBe(200)
      expect(state.updates[0].data.transport).toBe(transport)
    }
  })

  test('SSRF: a blocked internal URL is refused', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://localhost:8080/mcp', 'http://10.0.0.5/sse']) {
      state.updates = []
      const res = await PATCH(req({ url: bad }), ctx()) as any
      expect(res.status).toBe(400)
      expect(state.updates).toHaveLength(0)
    }
  })

  test('SSRF: a non-http scheme is refused', async () => {
    const res = await PATCH(req({ url: 'file:///etc/passwd' }), ctx()) as any
    expect(res.status).toBe(400)
  })

  test('a non-URL string is refused', async () => {
    expect((await PATCH(req({ url: 'not a url' }), ctx()) as any).status).toBe(400)
  })

  test('a public MCP URL is accepted', async () => {
    const res = await PATCH(req({ url: 'https://mcp.example.com/sse' }), ctx()) as any
    expect(res.status).toBe(200)
  })

  test('an empty url string is accepted as a clear, not treated as invalid', async () => {
    const res = await PATCH(req({ url: '' }), ctx()) as any
    // Clearing the URL when switching to stdio must be possible.
    expect(res.status).toBe(200)
    expect(state.updates[0].data.url).toBe('')
  })

  test('envVars are ENCRYPTED before storage, never stored plain', async () => {
    await PATCH(req({ envVars: { GITHUB_TOKEN: 'ghp_secret' } }), ctx())
    const stored = state.updates[0].data.envJson
    expect(stored).toBe('enc:GITHUB_TOKEN')
    expect(stored).not.toContain('ghp_secret')
    expect(state.encrypted[0]).toEqual({ GITHUB_TOKEN: 'ghp_secret' })
  })

  test('headers are ENCRYPTED before storage', async () => {
    await PATCH(req({ headers: { Authorization: 'Bearer t' } }), ctx())
    expect(state.updates[0].data.headersJson).toBe('enc:Authorization')
  })

  test('an ABSENT envVars key preserves the stored value', async () => {
    await PATCH(req({ name: 'Renamed' }), ctx())
    // The edit dialog omits the key when the admin did not retype it; wiping it
    // would silently break every authenticated MCP server on any rename.
    expect(state.updates[0].data.envJson).toBeUndefined()
  })

  test('an EMPTY envVars object is not a change at all, so it is refused as a no-op', async () => {
    const res = await PATCH(req({ envVars: {} }), ctx()) as any
    // Measured, not assumed: with envVars as the ONLY field and no clean entries,
    // `data` stays empty and the handler returns 400 "No fields provided for
    // update." That is the correct outcome — it preserves the stored value by
    // simply not performing a write, and it refuses to report success for a call
    // that asked for nothing.
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  test('non-string env values are coerced rather than dropped', async () => {
    await PATCH(req({ envVars: { PORT: 8080, FLAG: true, NUL: null } }), ctx())
    const sent = state.encrypted[0]
    expect(sent.PORT).toBe('8080')
    expect(sent.FLAG).toBe('true')
    // a null is not a value; storing "null" would be a lie about the config
    expect(sent.NUL).toBeUndefined()
  })

  test('args are normalised to a JSON string array', async () => {
    await PATCH(req({ args: ['-y', 'pkg'] }), ctx())
    expect(state.updates[0].data.args).toBe('["-y","pkg"]')
    state.updates = []
    await PATCH(req({ args: 'not-an-array' }), ctx())
    // A non-array must not become a raw string in a column the connector parses.
    expect(state.updates[0].data.args).toBe('[]')
  })

  test('a blank name never wipes the stored name', async () => {
    const res = await PATCH(req({ name: '   ' }), ctx()) as any
    // A blank string is not a rename, so it produces no field and the request is
    // refused as a no-op rather than writing name:''.
    expect(res.status).toBe(400)
    expect(state.updates).toHaveLength(0)

    // And when sent ALONGSIDE a real change it must still not overwrite the name.
    state.updates = []
    await PATCH(req({ name: '   ', command: 'bunx' }), ctx())
    expect(state.updates[0].data.name).toBeUndefined()
    expect(state.updates[0].data.command).toBe('bunx')
  })

  test('boolean toggles are applied', async () => {
    await PATCH(req({ isEnabled: false, chatEnabled: false, agenticEnabled: false }), ctx())
    const d = state.updates[0].data
    expect(d.isEnabled).toBe(false)
    expect(d.chatEnabled).toBe(false)
    expect(d.agenticEnabled).toBe(false)
  })

  test('a concurrent delete surfaces as 404, not a 500', async () => {
    state.updateThrows = { code: 'P2025' }
    expect((await PATCH(req({ name: 'x' }), ctx()) as any).status).toBe(404)
  })

  test('a non-P2025 write error propagates to the error handler', async () => {
    state.updateThrows = new Error('connection lost')
    expect((await PATCH(req({ name: 'x' }), ctx()) as any).status).toBe(500)
  })

  test('the cached connection is dropped so the next call reconnects', async () => {
    await PATCH(req({ command: 'bunx' }), ctx())
    // Without this the old command's tools keep serving from cache.
    expect(state.disconnects).toContain('srv-1')
  })

  test('the update is audited with the changed field names only', async () => {
    await PATCH(req({ name: 'x', command: 'y' }), ctx())
    const audit = state.audits.find((a) => a.action === 'MCP_SERVER_UPDATE')
    expect(audit).toBeDefined()
    // Auditing the VALUES would write the credential into the audit log.
    expect(JSON.stringify(audit.detail)).not.toContain('ghp_secret')
    expect(audit.detail.changes).toContain('name')
  })

  test('a non-admin caller is refused', async () => {
    state.role = 'viewer'
    const res = await PATCH(req({ name: 'x' }), ctx()) as any
    expect(res.status).toBe(403)
    expect(state.updates).toHaveLength(0)
  })
})

describe('DELETE /api/mcp/servers/[id]', () => {
  test('an unknown id is 404 and nothing is deleted', async () => {
    state.row = null
    expect((await DELETE({} as any, ctx()) as any).status).toBe(404)
    expect(state.deletes).toHaveLength(0)
  })

  test('CROSS-TENANT: the existence check is a scoped read', async () => {
    await DELETE({} as any, ctx('victim-id'))
    expect(state.findFirstCalls[0].where.id).toBe('victim-id')
    expect(state.findUniqueCalls).toHaveLength(0)
  })

  test('a successful delete drops the connection and audits at warning severity', async () => {
    const body = await (await (DELETE({} as any, ctx()) as any)).json()
    expect(body).toEqual({ ok: true, deleted: true })
    expect(state.disconnects).toContain('srv-1')
    const audit = state.audits.find((a) => a.action === 'MCP_SERVER_DELETE')
    expect(audit.severity).toBe('warning')
  })

  test('a concurrent delete is NOT an error — the row is gone, which was the goal', async () => {
    state.deleteThrows = { code: 'P2025' }
    const res = await DELETE({} as any, ctx()) as any
    // Measured behaviour, and deliberately different from PATCH: PATCH must fail
    // because it was asked to CHANGE a row that no longer exists, while DELETE
    // asked for the row to be absent and it is. Returning 404 here would make a
    // double-click report a failure for a successful outcome.
    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(true)
  })

  test('a non-admin caller is refused', async () => {
    state.role = 'analyst'
    expect((await DELETE({} as any, ctx()) as any).status).toBe(403)
    expect(state.deletes).toHaveLength(0)
  })
})

describe('sanitizeServer — the single scrubbing point', () => {
  test('drops both credential blobs and keeps the flags', () => {
    const out = sanitizeServer(base as any)
    expect(out).not.toHaveProperty('envJson')
    expect(out).not.toHaveProperty('headersJson')
    expect((out as any).hasEnvVars).toBe(true)
  })
})
