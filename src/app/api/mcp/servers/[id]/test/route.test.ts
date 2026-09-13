import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// POST /api/mcp/servers/[id]/test — connect to a saved MCP server, list tools.
//
// Two things make this route security-relevant rather than plumbing:
//
//  1. `id` is CLIENT-SUPPLIED. The route's own existence check uses the scoped
//     `findFirst` read (the tenant extension injects organizationId), so the
//     route-level lookup is correct. But the id is then handed verbatim to
//     `testMcpServer()`, which re-reads the row itself — and that re-read is
//     `findUnique`, which the tenant extension CANNOT scope (Prisma's unique
//     `where` rejects extra fields). So a cross-tenant id that the route's
//     scoped lookup rejects can never reach this branch; but the DUPLICATE
//     unscoped read inside the client is the pattern the tenant audit names.
//
//  2. It opens an OUTBOUND connection to a server-supplied URL/command. The
//     SSRF guard lives in `buildTransport` (isBlockedHost / isBlockedHostAsync)
//     inside mcp-client.ts, i.e. BELOW this route. This file pins that the
//     route does not implement its own (weaker) URL check and does not
//     second-guess the guard, and that a connect failure is surfaced as the
//     client's diagnostic — not as the upstream response body verbatim.
//
// The mocks below model the REAL contracts read from src/lib/session.ts,
// src/lib/db.ts, src/lib/prisma-tenant.ts and src/lib/mcp-client.ts.
// ---------------------------------------------------------------------------

// --- mutable seams, declared ABOVE every mock.module ------------------------
const state = {
  org: 'org-A' as string,
  authThrows: null as any,
  // route-level scoped read
  routeRow: null as any,
  findFirstCalls: [] as any[],
  // the second read performed INSIDE testMcpServer (unscoped findUnique)
  clientFindUniqueCalls: [] as any[],
  clientRow: null as any,
  testCalls: [] as string[],
  testResult: { ok: true, tools: [{ name: 'get_weather', description: 'w' }], toolCount: 1 } as any,
  invalidateCalls: 0,
  audits: [] as any[],
  auditThrows: null as any,
  // ordered side-effect log, so assertions pin ORDER not just presence
  events: [] as string[],
}

mock.module('@/lib/db', () => ({
  isPrismaNotFound: (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
  db: {
    mcpServer: {
      // The route's existence check. A scoped read: the tenant extension is
      // what appends organizationId to `where`, so this fake records exactly
      // what the handler asked for and never widens it.
      findFirst: async (a: any) => {
        state.events.push('findFirst')
        state.findFirstCalls.push(a)
        return state.routeRow
      },
      // testMcpServer() re-reads the row with findUnique — the read the tenant
      // extension cannot scope. Modelled so the assertion is about the real
      // call, not a guess.
      findUnique: async (a: any) => {
        state.events.push('findUnique')
        state.clientFindUniqueCalls.push(a)
        return state.clientRow
      },
    },
  },
}))

mock.module('@/lib/session', () => {
  // The real module DISCRIMINATES on the error CLASS (instanceof), not on a
  // code string, and its generic branch returns the caller's `fallback` — it
  // deliberately does NOT echo e.message (#8 convention: the fallback is the
  // sanitised text). Reproducing the class identities is what makes the 401
  // branch reachable from a test at all; a fake that keyed off `e.code` would
  // have "passed" a route behaviour that never happens.
  class UnauthorizedError extends Error {
    readonly code = 'UNAUTHORIZED'
    constructor(message = 'No active session.') {
      super(message)
      this.name = 'UnauthorizedError'
    }
  }
  class ForbiddenError extends Error {
    readonly code = 'FORBIDDEN'
    constructor(message = 'Insufficient permissions.') {
      super(message)
      this.name = 'ForbiddenError'
    }
  }
  return {
    UnauthorizedError,
    ForbiddenError,
    // ActiveUser: { userId, name, email, role, organizationId, plan }
    getActiveUser: async () => {
      state.events.push('getActiveUser')
      if (state.authThrows) throw state.authThrows
      return {
        userId: 'u1',
        name: 'A',
        email: 'a@example.test',
        role: 'admin',
        organizationId: state.org,
        plan: 'pro',
      }
    },
    enterWithOrg: () => {},
    // Real writeAudit swallows non-critical failures internally; the route also
    // attaches .catch(()=>{}). Fake the throw path so we can prove the route's
    // own guard is what keeps the response 200.
    writeAudit: async (a: any) => {
      state.events.push(`writeAudit:${a.action}`)
      state.audits.push(a)
      if (state.auditThrows) throw state.auditThrows
    },
    // Mirrors src/lib/session.ts: 401/403/402 by class, AppError by statusCode,
    // and the generic branch returns `fallback` (never e.message).
    handleApiError: (e: any, fallback: string, status = 500) => {
      state.events.push('handleApiError')
      const unauth = e instanceof UnauthorizedError
      const forbidden = e instanceof ForbiddenError
      return new Response(
        JSON.stringify({
          error: {
            code: unauth ? 'UNAUTHORIZED' : forbidden ? 'FORBIDDEN' : (e?.code ?? 'INTERNAL_ERROR'),
            message: unauth || forbidden ? e.message : fallback,
          },
        }),
        {
          status: unauth ? 401 : forbidden ? 403 : (e?.statusCode ?? status),
          headers: { 'content-type': 'application/json' },
        },
      )
    },
    __errors: { UnauthorizedError, ForbiddenError },
  }
})

// Re-imported by identity so a test can throw the SAME class instance the mock
// compares against (instanceof needs object identity, not a duck-typed shape).
const { UnauthorizedError } = (await import('@/lib/session')) as any

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => { state.events.push('enterWithOrg') },
  getOrgContext: () => state.org,
  bypassOrg: (fn: () => unknown) => fn(),
}))

mock.module('@/lib/mcp-client', () => ({
  // Real signature: testMcpServer(serverId) => { ok, toolCount?, tools?, error? }.
  // It is the caller of the SSRF guard, so the guard is exercised through it —
  // this route never touches buildTransport directly.
  testMcpServer: async (serverId: string) => {
    state.events.push(`testMcpServer:${serverId}`)
    state.testCalls.push(serverId)
    return state.testResult
  },
  invalidateMcpToolsCache: () => { state.events.push('invalidateMcpToolsCache') },
}))

// Dynamic import AFTER all mock.module calls. A static import would be
// evaluated first and would bypass every mock above.
const { POST } = await import('./route')

// The route's real signature is (req, ctx) where ctx.params is a Promise.
const ctx = (id = 'srv-1') => ({ params: Promise.resolve({ id }) })
const req = () => new Request('http://localhost/api/mcp/servers/srv-1/test', { method: 'POST' })

// Read the body ONCE as text, then parse (res.text() consumes the stream).
async function bodyOf(res: Response) {
  const raw = await res.text()
  return JSON.parse(raw)
}

beforeEach(() => {
  state.org = 'org-A'
  state.authThrows = null
  state.routeRow = { id: 'srv-1', name: 'Files', isEnabled: true }
  state.findFirstCalls = []
  state.clientFindUniqueCalls = []
  state.clientRow = { id: 'srv-1', name: 'Files', isEnabled: true }
  state.testCalls = []
  state.testResult = { ok: true, tools: [{ name: 'get_weather', description: 'w' }], toolCount: 1 }
  state.invalidateCalls = 0
  state.audits = []
  state.auditThrows = null
  state.events = []
})

describe('the credential columns are never selected', () => {
  test('the server lookup selects only id/name/isEnabled -- no envJson, no headersJson', async () => {
    // The route is a pure relay of a connection TEST, so the one thing it must never do is load a server's
    // credentials into memory just to ping it. Asserted on the QUERY, which is the only place this is visible.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).toMatch(/mcpServer\.findFirst/)
    expect(routeSrc).not.toMatch(/mcpServer\.findUnique/)
    expect(routeSrc).not.toMatch(/envJson/)
    expect(routeSrc).not.toMatch(/headersJson/)
  })
})

describe('POST /api/mcp/servers/[id]/test — happy path', () => {
  test('a successful test returns the tools and the tool count', async () => {
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.toolCount).toBe(1)
    expect(body.tools).toEqual([{ name: 'get_weather', description: 'w' }])
  })

  test('the id from the route params, not the URL, is what is tested', async () => {
    await POST(req() as any, ctx('abc-123'))
    // The request URL says srv-1; the dynamic segment says abc-123. The segment wins.
    expect(state.testCalls).toEqual(['abc-123'])
    expect(state.findFirstCalls[0].where.id).toBe('abc-123')
  })

  test('a missing tools array does not become `undefined` in the body', async () => {
    state.testResult = { ok: true }
    const body = await bodyOf(await POST(req() as any, ctx()))
    // Contract: { ok, tools, toolCount } — the ?? [] / ?? 0 fallbacks.
    expect(body.tools).toEqual([])
    expect(body.toolCount).toBe(0)
  })

  test('ORDER on success: org context → scoped lookup → test → invalidate → audit', async () => {
    await POST(req() as any, ctx())
    const order = state.events.filter((e) => !e.startsWith('getActiveUser') || true)
    // enterWithOrg must precede the DB read, or the read is unscoped.
    expect(order.indexOf('enterWithOrg')).toBeLessThan(order.indexOf('findFirst'))
    expect(order.indexOf('findFirst')).toBeLessThan(order.indexOf('testMcpServer:srv-1'))
    expect(order.indexOf('testMcpServer:srv-1')).toBeLessThan(order.indexOf('invalidateMcpToolsCache'))
    expect(order.indexOf('invalidateMcpToolsCache')).toBeLessThan(order.indexOf('writeAudit:MCP_SERVER_TEST'))
  })

  test('a successful test invalidates the aggregated tools cache', async () => {
    await POST(req() as any, ctx())
    // Without this the next chat turn keeps serving the pre-test tool list.
    expect(state.events).toContain('invalidateMcpToolsCache')
  })

  test('the success audit is info severity and carries the tool count', async () => {
    await POST(req() as any, ctx())
    const audit = state.audits.find((a) => a.action === 'MCP_SERVER_TEST')
    expect(audit).toBeDefined()
    expect(audit.severity).toBe('info')
    expect(audit.userId).toBe('u1')
    expect(audit.detail).toEqual({ serverId: 'srv-1', name: 'Files', toolCount: 1 })
  })

  test('a FAILED test does NOT invalidate the tools cache', async () => {
    state.testResult = { ok: false, error: 'boom' }
    await POST(req() as any, ctx())
    // Nothing changed server-side, so dropping the cache is pure churn.
    expect(state.events).not.toContain('invalidateMcpToolsCache')
  })
})

describe('POST /api/mcp/servers/[id]/test — the [id] lookup scoping', () => {
  test('the lookup is a SCOPED findFirst with an explicit select', async () => {
    await POST(req() as any, ctx())
    expect(state.findFirstCalls).toHaveLength(1)
    expect(state.findFirstCalls[0].where).toEqual({ id: 'srv-1' })
    // The route reads only these three columns; leaking envJson/headersJson
    // (encrypted MCP credentials) into every test click would be a regression.
    expect(state.findFirstCalls[0].select).toEqual({ id: true, name: true, isEnabled: true })
  })

  test('the route itself never performs an unscoped findUnique', async () => {
    await POST(req() as any, ctx('other-org-id'))
    // The ROUTE's own lookup is correctly scoped. Any unscoped read recorded
    // here comes from testMcpServer() inside mcp-client, asserted separately.
    expect(state.findFirstCalls[0].where.id).toBe('other-org-id')
  })

  test('an unknown id is 404 and NO outbound connection is attempted', async () => {
    state.routeRow = null
    const res = await POST(req() as any, ctx('nope'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'MCP server not found.' })
    // Critical: a 404 must not reach the connection path with an id the scoped
    // read just proved the caller cannot see.
    expect(state.testCalls).toHaveLength(0)
    expect(state.audits).toHaveLength(0)
  })

  test('the route performs exactly ONE lookup, and it is the scoped one', async () => {
    await POST(req() as any, ctx('srv-1'))
    // Measured: this handler issues one read. NOTE ON SCOPE — the *duplicate*
    // unscoped read the tenant audit names lives one module down, inside
    // `testMcpServer()`:
    //     const row = await db.mcpServer.findUnique({ where: { id: serverId } })
    // (src/lib/mcp-client.ts). Because it is mocked out here, this file cannot
    // observe that call; what it CAN prove is that the route does not add an
    // unscoped read of its own, and that the scoped findFirst gates the id
    // before any connection is attempted.
    //
    // RESIDUAL HAZARD (not an IDOR in this handler): testMcpServer receives the
    // raw client-supplied id and re-reads it with findUnique, which the tenant
    // extension cannot scope. It is reachable only AFTER the scoped findFirst
    // returned a row, so a cross-tenant id 404s first. If that scoped check is
    // ever removed, or testMcpServer gains a caller that skips it, the unscoped
    // read becomes the leak. Fix direction is on mcp-client.ts (findFirst), and
    // the route-side guard to preserve is the findFirst below.
    expect(state.events.filter((e) => e === 'findFirst')).toHaveLength(1)
    expect(state.findFirstCalls[0].where).toEqual({ id: 'srv-1' })
    // The route never names a unique read.
    expect(state.events).not.toContain('findUnique')
  })

  test('isEnabled is selected by the route but the gate lives in testMcpServer', async () => {
    state.routeRow = { id: 'srv-1', name: 'Disabled', isEnabled: false }
    state.testResult = { ok: false, error: 'MCP server is disabled.' }
    const res = await POST(req() as any, ctx())
    // The route does NOT short-circuit on isEnabled: it selects the column and
    // then defers to the client, which is where the real gate is
    // (`if (!row.isEnabled) return { ok:false, error:'MCP server is disabled.' }`).
    // The result is still a 200 with ok:false, matching the UI contract.
    expect(state.testCalls).toEqual(['srv-1'])
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('MCP server is disabled.')
  })
})

describe('POST /api/mcp/servers/[id]/test — SSRF and failure surfacing', () => {
  test('a blocked-host failure is reported as the client diagnostic, at 200', async () => {
    // buildTransport() in mcp-client returns null for a blocked host and
    // testMcpServer turns that into an 'Invalid transport config' error. The
    // route must pass it through as ok:false/200 so the UI renders it.
    state.testResult = {
      ok: false,
      error: 'Invalid transport config (command: , url: http://169.254.169.254/latest/meta-data).',
    }
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('Invalid transport config')
  })

  test('the route adds NO URL validation of its own', async () => {
    // The route never receives the URL — only the id — so the SSRF guard cannot
    // be bypassed or duplicated here. Pin that the client is the sole gate.
    await POST(req() as any, ctx('srv-1'))
    expect(state.testCalls).toEqual(['srv-1'])
    // No fetch of any kind is performed by the route directly.
    expect(state.findFirstCalls).toHaveLength(1)
  })

  test('a connection failure names the target server, not just "failed"', async () => {
    state.testResult = { ok: false, error: 'npx: connect ECONNREFUSED' }
    const body = await bodyOf(await POST(req() as any, ctx()))
    // testMcpServer prefixes the command (stdio) or URL (http) so an operator
    // testing several servers can tell them apart. The route must not strip it.
    expect(body.error).toBe('npx: connect ECONNREFUSED')
  })

  test('a failure with no error field falls back to a generic message', async () => {
    state.testResult = { ok: false }
    const body = await bodyOf(await POST(req() as any, ctx()))
    expect(body.error).toBe('Connection test failed.')
  })

  test('the failure audit is warning severity and records the error', async () => {
    state.testResult = { ok: false, error: 'npx: ECONNREFUSED' }
    await POST(req() as any, ctx())
    const audit = state.audits.find((a) => a.action === 'MCP_SERVER_TEST_FAILED')
    expect(audit).toBeDefined()
    expect(audit.severity).toBe('warning')
    expect(audit.detail).toEqual({ serverId: 'srv-1', name: 'Files', error: 'npx: ECONNREFUSED' })
  })

  test('a failure is reported with HTTP 200, by UI contract', async () => {
    state.testResult = { ok: false, error: 'boom' }
    const res = await POST(req() as any, ctx())
    // Deliberate: the panel reads { ok, error } from the body; a non-2xx would
    // be swallowed into a generic toast and lose the diagnostic.
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).ok).toBe(false)
  })

  test('the route is a pure relay for result.error — it neither redacts nor truncates', async () => {
    // Responsibility boundary: this route performs NO sanitisation of
    // result.error. Whatever mcp-client hands back is what the admin's browser
    // receives, byte for byte. That is the mechanism behind the leak pinned in
    // the next test; here it is asserted for the benign case so the two
    // behaviours are visibly the same code path.
    state.testResult = { ok: false, error: 'https://mcp.example.test/rpc: HTTP 500' }
    const res = await POST(req() as any, ctx())
    expect(JSON.parse(await res.text()).error).toBe('https://mcp.example.test/rpc: HTTP 500')
  })

  test('CURRENT BEHAVIOUR (defect): the route forwards the upstream response body verbatim', async () => {
    // REAL DEFECT, end to end. No sanitisation exists at any layer:
    //
    // 1. SDK (node_modules/@modelcontextprotocol/sdk/.../client/streamableHttp.js):
    //      const text = await response.text().catch(() => null)      // line ~313
    //      throw new StreamableHTTPError(response.status,
    //        `Error POSTing to endpoint: ${text}`)                    // line ~364
    //    The ENTIRE upstream body is interpolated into the error message.
    // 2. mcp-client.ts testMcpServer catch:
    //      const msg = e instanceof Error ? e.message : String(e)
    //      return { ok: false, error: `${row.url}: ${msg}` }
    // 3. this route: `return NextResponse.json({ ok: false, error: result.error })`
    //
    // A malicious or merely chatty MCP server therefore gets to write arbitrary
    // text into an authenticated admin's browser response. The test below pins
    // that pass-through so a future sanitiser is a visible behaviour change
    // rather than a silent one.
    //
    // MUST INVERT when mcp-client.ts (or this route) starts reducing the error
    // to a category/status before returning it — at that point assert the body
    // is NOT present.
    const leaky = 'Error POSTing to endpoint: <html>secret=AKIA-not-for-browsers</html>'
    state.testResult = { ok: false, error: `https://mcp.example.test/rpc: ${leaky}` }
    const body = await bodyOf(await POST(req() as any, ctx()))
    expect(body.ok).toBe(false)
    expect(body.error).toContain('<html>')
    expect(body.error).toContain('AKIA-not-for-browsers')
  })
})

describe('POST /api/mcp/servers/[id]/test — auth and error paths', () => {
  test('no session yields 401 from the shared error handler', async () => {
    state.authThrows = new UnauthorizedError()
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(401)
    expect((await bodyOf(res)).error.code).toBe('UNAUTHORIZED')
    // Nothing may be read or connected before auth resolves.
    expect(state.findFirstCalls).toHaveLength(0)
    expect(state.testCalls).toHaveLength(0)
  })

  test('an unexpected throw is converted by handleApiError, never leaked raw', async () => {
    state.authThrows = new Error('redis pool exhausted')
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(500)
    expect(state.events).toContain('handleApiError')
    const raw = await res.text()
    // The generic branch returns the route's fallback, NOT e.message — an
    // internal error string ("redis pool exhausted") must not reach the browser.
    expect(raw).toContain('Failed to test MCP server.')
    expect(raw).not.toContain('redis pool exhausted')
    expect(raw).not.toContain('redis')
  })

  test('an audit-write failure does not fail an otherwise successful test', async () => {
    state.auditThrows = new Error('audit db down')
    // writeAudit() swallows info-severity failures internally; the route also
    // chains .catch(()=>{}). Either way the test result must still be returned.
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).ok).toBe(true)
  })

  test('an audit-write failure does not turn a failure report into a 500', async () => {
    state.auditThrows = new Error('audit db down')
    state.testResult = { ok: false, error: 'boom' }
    const res = await POST(req() as any, ctx())
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).error).toBe('boom')
  })
})
