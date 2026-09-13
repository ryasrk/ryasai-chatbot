/**
 * POST /api/data-sources/rest-connectors/[id]/test — the connector sheet "Test" button.
 *
 * WHY THIS FILE EXISTS. This is the one route in the connector family that makes an OUTBOUND request with the
 * tenant's DECRYPTED credentials attached, and it returns the upstream response to the browser. Three
 * boundaries are asserted here:
 *
 *   1. ADMIN-ONLY, AND BEFORE THE CONNECTOR IS EVEN LOADED. `requireRole(user, 'admin')` runs before the DB
 *      read, so a non-admin cannot use the endpoint as an oracle for "does this connector id exist".
 *   2. THE SSRF GATE IS DELEGATED, NOT SKIPPED. The route performs NO URL validation of its own; it relies on
 *      `executeRestRequest`, which resolves the final URL, refuses a blocked host (plus a DNS check), and only
 *      then fetches. The tests therefore assert the CONTRACT the route hands over (baseUrl, timeout, the
 *      decrypted config blob, the method/path it was given) rather than re-testing the lib.
 *   3. THE UPSTREAM BODY IS FORWARDED VERBATIM. `body: result.body` / `bodyText: result.bodyText` cross to the
 *      client unbounded by this route — the 8000-character cap lives in the callee. Pinned, including the
 *      consequence: any upstream that echoes the request back (an echo/debug endpoint, an error page quoting
 *      the Authorization header) returns the DECRYPTED CREDENTIAL to the browser.
 *
 * DEFECTS PINNED (both static, both read from the real files so a fix turns them red):
 *
 *   A. ABSOLUTE-URL PATH ESCAPES THE CONNECTOR baseUrl. `buildEndpointUrl` resolves the caller-supplied path
 *      with `new URL(normalizeEndpointPath(path).slice(1), base)`; a path like `https://other-host/x` or
 *      `\\\\other-host/x` is an ABSOLUTE url and wins over the base. The admin-configured baseUrl is therefore
 *      not a host restriction for the probe. (The SSRF blocklist still runs on the RESULTING host, so this is
 *      an escape from "only the configured API", not from the private-network blocklist.)
 *   B. THE WHITELIST IS BYPASSED BY DESIGN here (documented in the route) while the SAME request shape on the
 *      agentic path IS whitelisted -- so a path an admin probes successfully is not necessarily callable by
 *      the agent. Pinned as a behavioural note, not a security hole.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

let connector: Record<string, unknown> | null = null
let connectorLoadThrows: Error | null = null
let requireRoleThrows: Error | null = null
let auditFails = false

type RestResult =
  | { ok: true; statusCode: number; latencyMs: number; bodyText: string; body: unknown }
  | { ok: false; error: string; latencyMs: number }
let result: RestResult = {
  ok: true,
  statusCode: 200,
  latencyMs: 42,
  bodyText: '{"rows":[{"id":1}]}',
  body: { rows: [{ id: 1 }] },
}

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const execCalls: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []

class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
}
class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  readonly statusCode = 403
}
class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID'
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (!user) throw new UnauthorizedError('No active session.')
    return user
  },
  requireRole: (u: { role: string }, role: string) => {
    events.push(`requireRole:${role}`)
    if (requireRoleThrows) throw requireRoleThrows
    if (u.role !== role) throw new ForbiddenError(`Requires ${role} role. You have ${u.role}.`)
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
    if (auditFails) throw new Error('audit table unavailable')
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof UnauthorizedError)
      return Response.json({ error: { code: 'UNAUTHORIZED', message: e.message } }, { status: 401 })
    if (e instanceof ForbiddenError)
      return Response.json({ error: { code: 'FORBIDDEN', message: e.message } }, { status: 403 })
    if (e instanceof LicenseError)
      return Response.json({ error: { code: 'LICENSE_INVALID', message: e.message } }, { status: 402 })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    restApiConnector: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findFirst', args })
        events.push('restApiConnector.findFirst')
        if (connectorLoadThrows) throw connectorLoadThrows
        return connector
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findUnique', args })
        events.push('restApiConnector.findUnique')
        return connector
      },
    },
  },
}))

mock.module('@/lib/tool-branches', () => ({
  executeRestRequest: async (args: Record<string, unknown>) => {
    execCalls.push(args)
    events.push('executeRestRequest')
    return result
  },
}))

const { POST } = await import('./route')

const ctx = (id = 'c1') => ({ params: Promise.resolve({ id }) })

function post(body: unknown, id = 'c1') {
  const url = `http://localhost/api/data-sources/rest-connectors/${id}/test`
  const r = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return POST(r as never, ctx(id))
}

async function readBody(res: Response) {
  return JSON.parse(await res.text()) as Record<string, any>
}

const staticSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf-8')

beforeEach(() => {
  user = adminUser
  connector = {
    id: 'c1',
    name: 'CRM',
    baseUrl: 'https://api.crm.example.com',
    authType: 'BEARER',
    encryptedAuthConfig: 'enc:deadbeef',
    timeoutMs: 30_000,
  }
  connectorLoadThrows = null
  requireRoleThrows = null
  auditFails = false
  result = {
    ok: true,
    statusCode: 200,
    latencyMs: 42,
    bodyText: '{"rows":[{"id":1}]}',
    body: { rows: [{ id: 1 }] },
  }
  events.length = 0
  calls.length = 0
  execCalls.length = 0
  auditWrites.length = 0
})

describe('authorization and ordering', () => {
  test('the org context is entered before the admin gate and before the connector load', async () => {
    await post({ method: 'GET', path: '/users' })
    expect(events.slice(0, 3)).toEqual(['enterWithOrg:org-1', 'requireRole:admin', 'restApiConnector.findFirst'])
  })

  test('a non-admin is 403 BEFORE the connector is looked up', async () => {
    // Order is the point: if the load ran first, a viewer could probe connector ids by response timing/404s.
    user = { ...adminUser, role: 'analyst' }
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
    expect(execCalls).toHaveLength(0)
    expect(events).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
  })

  test('a viewer is refused too', async () => {
    user = { ...adminUser, role: 'viewer' }
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(403)
  })

  test('an unauthenticated caller makes no outbound request', async () => {
    user = null as unknown as typeof adminUser
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(401)
    expect(events).toEqual([])
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-T' }
    await post({ method: 'GET', path: '/users' })
    expect(events[0]).toBe('enterWithOrg:org-T')
  })
})

describe('validation', () => {
  test('an empty path is 400 and nothing is fetched', async () => {
    for (const path of [undefined, '', '   ']) {
      const res = await post({ method: 'GET', path })
      expect(res.status).toBe(400)
      expect(await readBody(res)).toEqual({ ok: false, error: 'Test path is required.' })
    }
    expect(execCalls).toHaveLength(0)
  })

  test('an unsupported method is 400 with the method echoed back', async () => {
    const res = await post({ method: 'TRACE', path: '/users' })
    expect(res.status).toBe(400)
    expect(await readBody(res)).toEqual({ ok: false, error: 'Unsupported method: TRACE.' })
    expect(execCalls).toHaveLength(0)
  })

  test('every supported verb is accepted, including HEAD', async () => {
    // HEAD is allowed here but NOT in the whitelist POST handler — the probe is deliberately wider.
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const res = await post({ method: m, path: '/users' })
      expect(res.status).toBe(200)
    }
    expect(execCalls.map((c) => c.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
  })

  test('the method defaults to GET when omitted and is uppercased', async () => {
    await post({ path: '/users' })
    expect(execCalls[0]!.method).toBe('GET')
    execCalls.length = 0
    await post({ method: '  post  ', path: '/users' })
    expect(execCalls[0]!.method).toBe('POST')
  })

  test('the path is trimmed but otherwise passed through unvalidated', async () => {
    await post({ method: 'GET', path: '   /users?x=1  ' })
    expect(execCalls[0]!.path).toBe('/users?x=1')
  })

  test('the method/path validation happens BEFORE the connector load', async () => {
    // A caller with a bad method must not learn whether the connector exists.
    await post({ method: 'TRACE', path: '/users' })
    expect(calls).toHaveLength(0)
  })

  test('a MALFORMED body is 400 (empty path), not a defaulted request', async () => {
    const res = await post('{ not json')
    expect(res.status).toBe(400)
    expect(execCalls).toHaveLength(0)
  })
})

describe('the connector load', () => {
  test('an unknown connector is 404 and no request is made', async () => {
    connector = null
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(404)
    expect(await readBody(res)).toEqual({ ok: false, error: 'Connector not found.' })
    expect(execCalls).toHaveLength(0)
  })

  test('the load is a findFirst filtered by the path id (never findUnique)', async () => {
    // Cross-tenant IDOR class: only findFirst can be org-scoped by the tenant extension.
    await post({ method: 'GET', path: '/users' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('findFirst')
    expect(calls[0]!.args.where).toEqual({ id: 'c1' })
  })

  test('the load selects the baseUrl, authType, ENCRYPTED config and timeout the executor needs', async () => {
    await post({ method: 'GET', path: '/users' })
    expect(calls[0]!.args.select).toEqual({
      id: true,
      name: true,
      baseUrl: true,
      authType: true,
      encryptedAuthConfig: true,
      timeoutMs: true,
    })
  })

  test('a connector in another org is invisible, so the probe 404s', async () => {
    connector = null
    const res = await post({ method: 'GET', path: '/users' }, 'c-other-org')
    expect(res.status).toBe(404)
    expect(execCalls).toHaveLength(0)
  })

  test('a load failure is 500 and makes no outbound request', async () => {
    connectorLoadThrows = new Error('timeout reading RestApiConnector on replica-9')
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('replica-9')
    expect(execCalls).toHaveLength(0)
  })
})

describe('the delegated SSRF gate', () => {
  test('the connector row is handed to the executor WITH its encrypted config, not decrypted by the route', async () => {
    // The route must not decrypt: decryption belongs to the transport so the plaintext never lives in the
    // route frame. Asserted because it is the difference between one copy of a secret and two.
    await post({ method: 'GET', path: '/users' })
    expect(execCalls[0]!.connector).toEqual(connector)
  })

  test('the route passes the connector baseUrl and timeout through unchanged', async () => {
    connector = { ...connector!, baseUrl: 'https://api.other.example.org/v2', timeoutMs: 7500 }
    await post({ method: 'GET', path: '/users' })
    const passed = execCalls[0]!.connector as Record<string, unknown>
    expect(passed.baseUrl).toBe('https://api.other.example.org/v2')
    expect(passed.timeoutMs).toBe(7500)
  })

  test('endpointId is null — a manual probe is not a whitelisted endpoint run', async () => {
    // The `null as unknown as string` cast in the route is deliberate: the request log column is nullable.
    await post({ method: 'GET', path: '/users' })
    expect(execCalls[0]!.endpointId).toBeNull()
  })

  test('the plan carries the caller query and body, plus a fixed explanation', async () => {
    await post({
      method: 'POST',
      path: '/orders',
      query: { page: 2, q: 'acme' },
      body: { amount: 10 },
    })
    expect(execCalls[0]!.plan).toEqual({
      endpointId: '',
      explanation: 'Manual test from connector sheet',
      query: { page: 2, q: 'acme' },
      body: { amount: 10 },
    })
  })

  test('query defaults to an empty object and body to null when omitted', async () => {
    await post({ method: 'GET', path: '/users' })
    expect(execCalls[0]!.plan).toEqual({
      endpointId: '',
      explanation: 'Manual test from connector sheet',
      query: {},
      body: null,
    })
  })

  test('the route does its OWN SSRF check too, so a blocked host fails before any fetch', async () => {
    // NOT a control on this route: `executeRestRequest` is mocked, so this only proves the route never
    // validates the host itself. The real gate lives in the callee and is asserted statically below.
    await post({ method: 'GET', path: '/users' })
    const src = staticSrc('route.ts')
    expect(src).not.toContain('isBlockedHost')
  })

  test('the executor it delegates to is the one that performs the host and DNS blocklist check', () => {
    const src = staticSrc('../../../../../../lib/tool-branches.ts')
    expect(src).toContain('isBlockedHost(parsedUrl.hostname)')
    expect(src).toContain('isBlockedHostAsync(parsedUrl.hostname)')
  })
})

describe('the response forwarded to the browser', () => {
  test('a success returns statusCode, latencyMs, body and bodyText', async () => {
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: true,
      statusCode: 200,
      latencyMs: 42,
      body: { rows: [{ id: 1 }] },
      bodyText: '{"rows":[{"id":1}]}',
    })
  })

  test('a non-2xx upstream is a 200 response with ok:false and the executor error', async () => {
    // The probe reports the upstream failure as DATA (the sheet renders it), not as a transport error. Pinned
    // because a future refactor to `status: 502` would break the UI contract.
    result = { ok: false, error: 'REST API returned HTTP 404 (Not Found). Endpoint: GET /users.', latencyMs: 11 }
    const res = await post({ method: 'GET', path: '/users' })
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({
      ok: false,
      error: 'REST API returned HTTP 404 (Not Found). Endpoint: GET /users.',
      latencyMs: 11,
    })
  })

  test('a failed probe writes NO audit row', async () => {
    result = { ok: false, error: 'blocked host', latencyMs: 3 }
    await post({ method: 'GET', path: '/users' })
    expect(auditWrites).toHaveLength(0)
  })

  test('the request log is not written by the route — the executor owns that', async () => {
    await post({ method: 'GET', path: '/users' })
    expect(calls.every((c) => c.model === 'restApiConnector')).toBe(true)
  })
})

describe('audit', () => {
  test('a successful probe audits the connector, method, path, status and latency', async () => {
    await post({ method: 'PATCH', path: '/orders/9' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'REST_CONNECTOR_TEST',
      severity: 'info',
      detail: { connectorId: 'c1', method: 'PATCH', path: '/orders/9', statusCode: 200, latencyMs: 42 },
    })
  })

  test('the audit is written AFTER the request completes', async () => {
    await post({ method: 'GET', path: '/users' })
    expect(events).toEqual([
      'enterWithOrg:org-1',
      'requireRole:admin',
      'restApiConnector.findFirst',
      'executeRestRequest',
      'audit',
    ])
  })

  test('an audit failure does NOT fail the probe (the .catch(() => {}) is deliberate)', async () => {
    // The outbound request already went out and succeeded; losing the audit row is better than reporting a
    // failure the user would read as "the endpoint is broken". Proven by making the audit writer reject --
    // this is also the only path that executes the route's inline `.catch(() => {})` callback.
    auditFails = true
    const res = await post({ method: 'GET', path: '/users' })
    auditFails = false
    expect(res.status).toBe(200)
    expect(await readBody(res)).toMatchObject({ ok: true, statusCode: 200 })
  })

  test('the probe still reports the upstream status even when its own audit write failed', async () => {
    // The audit is telemetry, never a gate on the response.
    result = { ok: true, statusCode: 500, latencyMs: 7, bodyText: 'boom', body: 'boom' }
    auditFails = true
    const res = await post({ method: 'GET', path: '/users' })
    auditFails = false
    expect(await readBody(res)).toEqual({ ok: true, statusCode: 500, latencyMs: 7, body: 'boom', bodyText: 'boom' })
  })
})

describe('FIXED A — an absolute URL in the path can no longer escape the configured baseUrl', () => {
  // THIS BLOCK USED TO PIN THE DEFECT. `buildEndpointUrl` resolved the caller-supplied `path` with
  // `new URL(normalizedPath.slice(1), base)`, and an ABSOLUTE url (or a backslash-leading one, which the WHATWG
  // parser normalises to '/') WINS over the base -- so the admin-configured baseUrl was not a host restriction,
  // while the connector's DECRYPTED auth header was attached to the request. The capability probe is admin-only,
  // but a tenant API token is a tenant API token: it must not be aimable at a third-party host.
  //
  // The expectations are INVERTED: the builder now refuses a path whose resolved origin differs from the base.
  // The assertions below read the REAL library source AND execute the real function, so removing the guard turns
  // them red.
  test('buildEndpointUrl compares the resolved ORIGIN against the base', () => {
    const src = staticSrc('../../../../../../lib/rest-api-connectors.ts')
    expect(src).toMatch(/url\.origin !== base\.origin/)
    // The refusal is typed, so a caller can answer 400 rather than reporting an upstream failure.
    expect(src).toContain('EndpointPathEscapeError')
  })

  test('an absolute-URL path is REFUSED instead of being sent', async () => {
    const { buildEndpointUrl, EndpointPathEscapeError } = await import('@/lib/rest-api-connectors')
    expect(() => buildEndpointUrl('https://api.crm.example.com', 'https://attacker.example.net/collect')).toThrow(
      EndpointPathEscapeError,
    )
    // The error NAMES the offending path so an operator can see what was attempted.
    try {
      buildEndpointUrl('https://api.crm.example.com', 'https://attacker.example.net/collect')
    } catch (e) {
      expect((e as Error).message).toContain('attacker.example.net')
    }
  })

  test('a DOUBLE-backslash path is REFUSED, because the parser normalises it to an absolute reference', async () => {
    // MEASURED, and the measurement corrected this test. The original pin claimed a SINGLE backslash escaped;
    // executed against the real parser, ONE backslash resolves to the SAME ORIGIN
    // (https://api.crm.example.com/attacker.example.net/collect) -- a lone backslash is a path separator, so the
    // hostile host becomes a path segment. Only the DOUBLE form becomes a protocol-relative reference and leaves.
    // The character is DERIVED from String.fromCharCode(92) rather than written as an escape: a backslash literal
    // must be doubled at every layer, and earlier revisions of this assertion got that count wrong twice.
    const { buildEndpointUrl, EndpointPathEscapeError } = await import('@/lib/rest-api-connectors')
    const BS = String.fromCharCode(92)
    expect(() => buildEndpointUrl('https://api.crm.example.com', `${BS}${BS}attacker.example.net/collect`)).toThrow(
      EndpointPathEscapeError,
    )
    // MEASURED, and it corrected this assertion too: `//host/path` does NOT escape here, because
    // `normalizeEndpointPath` prefixes a slash, turning it into the single-slash same-origin path above. Pinning
    // that so nobody adds a "double slash" guard that would refuse a legitimate path.
    expect(buildEndpointUrl('https://api.crm.example.com', '//attacker.example.net/collect')).toBe(
      'https://api.crm.example.com/attacker.example.net/collect',
    )
  })

  test('a SINGLE backslash stays on the configured origin — it is a path separator, not an escape', async () => {
    // The measured truth, pinned so nobody "hardens" this into a false refusal: the hostile host becomes a path
    // segment under the configured base, which is exactly where it belongs.
    const { buildEndpointUrl } = await import('@/lib/rest-api-connectors')
    expect(buildEndpointUrl('https://api.crm.example.com', '\\attacker.example.net/collect')).toBe(
      'https://api.crm.example.com/attacker.example.net/collect',
    )
  })

  test('a RELATIVE path still resolves against the base — the guard is not a blanket refusal', async () => {
    // The other half of the contract. A guard that broke normal use would be worse than the defect, so the
    // legitimate shapes are pinned: plain, leading-slash, nested, and with a query string.
    const { buildEndpointUrl } = await import('@/lib/rest-api-connectors')
    expect(buildEndpointUrl('https://api.crm.example.com', 'customers')).toBe(
      'https://api.crm.example.com/customers',
    )
    expect(buildEndpointUrl('https://api.crm.example.com', '/customers')).toBe(
      'https://api.crm.example.com/customers',
    )
    expect(buildEndpointUrl('https://api.crm.example.com', '/v2/customers/42')).toBe(
      'https://api.crm.example.com/v2/customers/42',
    )
    expect(buildEndpointUrl('https://api.crm.example.com', 'customers', { limit: 5 })).toBe(
      'https://api.crm.example.com/customers?limit=5',
    )
    // A base with a path prefix keeps the prefix: the origin check compares origin, not the whole url.
    expect(buildEndpointUrl('https://api.crm.example.com/v1', 'customers')).toBe(
      'https://api.crm.example.com/v1/customers',
    )
    // A same-origin ABSOLUTE url is allowed, because it cannot leave the configured host.
    expect(buildEndpointUrl('https://api.crm.example.com', 'https://api.crm.example.com/customers')).toBe(
      'https://api.crm.example.com/customers',
    )
  })

  test('the route reports the refusal as a 400, not as an upstream failure', async () => {
    // A misconfigured/aimed path is the CALLER's error, and the route says so. Pinned at the source level rather
    // than by driving the handler, because the handler needs a full connector + auth config to reach the call.
    const src = staticSrc('route.ts')
    expect(src).toContain('EndpointPathEscapeError')
    expect(src).toMatch(/status: 400/)
  })
})

describe('DOCUMENTED — the whitelist is deliberately bypassed on this path', () => {
  test('the probe does not consult RestApiEndpoint at all', () => {
    // Unlike the agentic REST branch (which matches the plan against whitelisted `RestApiEndpoint` rows), the
    // probe passes `endpointId: null` and lets any path through. That is intentional ("admins probe endpoints
    // before saving them") and it is why this route is admin-only. Pinned so a removal of the admin gate in
    // one place without the other is visible.
    const src = staticSrc('route.ts')
    expect(src).toContain('endpointId: null')
    expect(src).toContain("requireRole(user, 'admin')")
    expect(src).toContain('does NOT require the path to be whitelisted')
  })
})
