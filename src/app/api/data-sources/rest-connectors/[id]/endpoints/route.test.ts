/**
 * GET + POST /api/data-sources/rest-connectors/[id]/endpoints — the endpoint whitelist for one connector.
 *
 * WHY THIS FILE EXISTS. This whitelist is the ONLY reason the LLM can call a REST path at all: the REST tool
 * picks from `RestApiEndpoint` rows, so every row written here is a URL the assistant may hit on the
 * customer's behalf. Three boundaries carry the risk:
 *
 *   1. TENANT ISOLATION IS A `findFirst`. Both verbs load the connector by a client-supplied id with
 *      `findFirst({ where: { id } })`, which the Prisma tenant extension org-scopes. A regression to
 *      `findUnique` would let org A append endpoints to org B's connector. Pinned by asserting the call the
 *      route actually makes (and that `findUnique` is never reached).
 *   2. THE METHOD IS WHITELISTED AND UPPERCASED. An arbitrary method string reaching the DB row would be
 *      echoed by the whitelist UI as an allowed verb; the route accepts exactly GET/POST/PUT/PATCH/DELETE.
 *   3. THE PATH IS NORMALISED, NOT STORED RAW. `normalizeEndpointPath` guarantees a leading slash and maps an
 *      empty string to '/', which the route then rejects as "required". A raw store would let `'users'` and
 *      `'/users'` coexist as two whitelist entries for one endpoint.
 *
 * Also pinned: `organizationId` is set EXPLICITLY on create (not left to the ambient context alone),
 * the JSON-ish columns go through stringify-or-null, the LLM first-scan is fire-and-forget and ONLY fires
 * when no description was supplied, and the ORDER of (create → audit → response) is asserted.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

const connectorRow: Record<string, unknown> | null = { id: 'c1', name: 'CRM' }
let connector: Record<string, unknown> | null = null
let endpointList: Array<Record<string, unknown>> = []
let created: Record<string, unknown> | null = null
let createThrows: Error | null = null
let connectorLoadThrows: Error | null = null

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const sourceInitCalls: string[] = []
let sourceInitRejects = false

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
class AppError extends Error {
  readonly code = 'VALIDATION_ERROR'
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
  }
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (!user) throw new UnauthorizedError('No active session.')
    return user
  },
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) throw new ForbiddenError(`Requires ${role} role. You have ${u.role}.`)
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    // Class-based, matching session.ts. A class-only mock is what makes the 401/403/422 branches reachable.
    if (e instanceof UnauthorizedError)
      return Response.json({ error: { code: 'UNAUTHORIZED', message: e.message } }, { status: 401 })
    if (e instanceof ForbiddenError)
      return Response.json({ error: { code: 'FORBIDDEN', message: e.message } }, { status: 403 })
    if (e instanceof LicenseError)
      return Response.json({ error: { code: 'LICENSE_INVALID', message: e.message } }, { status: 402 })
    if (e instanceof AppError)
      return Response.json({ error: { code: e.code, message: e.message } }, { status: e.statusCode })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/rest-api-connectors', () => ({
  // Faithful to the real one-liner: leading slash, '' -> '/'.
  normalizeEndpointPath: (p: string) => {
    const t = (p ?? '').trim()
    if (!t) return '/'
    return t.startsWith('/') ? t : `/${t}`
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
    restApiEndpoint: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'findMany', args })
        events.push('restApiEndpoint.findMany')
        return endpointList
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'create', args })
        events.push('restApiEndpoint.create')
        if (createThrows) throw createThrows
        return created
      },
    },
  },
}))

mock.module('@/lib/source-init', () => ({
  initRestEndpointContext: async (id: string) => {
    sourceInitCalls.push(id)
    events.push('initRestEndpointContext')
    if (sourceInitRejects) throw new Error('LLM unavailable')
  },
}))

const { GET, POST } = await import('./route')

const ctx = (id = 'c1') => ({ params: Promise.resolve({ id }) })

function get(id = 'c1') {
  const url = `http://localhost/api/data-sources/rest-connectors/${id}/endpoints`
  const r = new Request(url) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return GET(r as never, ctx(id))
}

function post(body: unknown, id = 'c1') {
  const url = `http://localhost/api/data-sources/rest-connectors/${id}/endpoints`
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

/** Let the route's fire-and-forget `void initRestEndpointContext(...)` settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  user = adminUser
  connector = { ...connectorRow! }
  endpointList = [
    { id: 'e1', method: 'GET', path: '/customers', isEnabled: true },
    { id: 'e2', method: 'POST', path: '/orders', isEnabled: true },
  ]
  // NOTE: `description: null` here mirrors what the real create returns when the body supplied none — the
  // route branches on the RETURNED row's description, not on the request body, so a fixture that always
  // carried a description would make the first-scan branch unreachable.
  created = {
    id: 'e9',
    method: 'GET',
    path: '/invoices',
    description: null,
    connectorId: 'c1',
    organizationId: 'org-1',
    isEnabled: true,
  }
  createThrows = null
  connectorLoadThrows = null
  sourceInitRejects = false
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  sourceInitCalls.length = 0
})

describe('org context', () => {
  test('GET enters the session org before the connector lookup', async () => {
    await get()
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'restApiConnector.findFirst'])
  })

  test('POST enters the session org before the connector lookup', async () => {
    await post({ method: 'GET', path: '/x' })
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'restApiConnector.findFirst'])
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-B' }
    await get()
    expect(events[0]).toBe('enterWithOrg:org-B')
  })
})

describe('GET — listing the whitelist', () => {
  test('an unknown connector is 404 and never lists endpoints', async () => {
    connector = null
    const res = await get()
    expect(res.status).toBe(404)
    expect(await readBody(res)).toEqual({ ok: false, error: 'REST connector not found.' })
    expect(calls.some((c) => c.op === 'findMany')).toBe(false)
  })

  test('it returns the endpoints under an ok envelope', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({ ok: true, items: endpointList })
  })

  test('the THEMES: the query orders by method then path', async () => {
    // A stable order is what makes the whitelist readable and diffable. The route asks the DB to sort so the
    // list does not depend on insertion order.
    await get()
    const list = calls.find((c) => c.op === 'findMany')!
    expect(list.args.orderBy).toEqual([{ method: 'asc' }, { path: 'asc' }])
  })

  test('the list is filtered by the CONNECTOR ID that the scoped read returned', async () => {
    // Not the raw path id: the route uses `connector.id`, so an org-scoped connector read is the gate.
    await get('c-from-url')
    const list = calls.find((c) => c.op === 'findMany')!
    expect(list.args.where).toEqual({ connectorId: 'c1' })
  })

  test('the connector read is a findFirst with the path id, and findUnique is NEVER used', async () => {
    // The cross-tenant IDOR class: findUnique cannot be org-scoped by the tenant extension.
    await get('c1')
    const load = calls.find((c) => c.op === 'findFirst')!
    expect(load.args.where).toEqual({ id: 'c1' })
    expect(load.args.select).toEqual({ id: true })
    expect(calls.filter((c) => c.op === 'findUnique')).toHaveLength(0)
  })

  test('an empty whitelist is 200 with an empty array, not a 404', async () => {
    endpointList = []
    const res = await get()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({ ok: true, items: [] })
  })

  test('the items are returned WHOLE — the route does not project or mask them', async () => {
    // Pinned as a shape contract: the UI reads parameterSchema/sampleResponse from these rows, and a future
    // field-narrowing has to be deliberate. Also confirms no credential-shaped field is introduced here.
    endpointList = [
      { id: 'e1', method: 'GET', path: '/a', parameterSchema: '{"q":"string"}', sampleResponse: '{"a":1}', isEnabled: true },
    ]
    const res = await get()
    const body = await readBody(res)
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'id',
      'isEnabled',
      'method',
      'parameterSchema',
      'path',
      'sampleResponse',
    ])
  })

  test('a DB failure is 500 and leaks no SQL detail', async () => {
    connectorLoadThrows = new Error('relation "RestApiConnector" does not exist on replica-3')
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('replica-3')
  })
})

describe('POST — adding to the whitelist', () => {
  test('a valid endpoint is 201 with the created row', async () => {
    created = { ...created!, description: 'List invoices' }
    const res = await post({ method: 'GET', path: '/invoices', description: 'List invoices' })
    expect(res.status).toBe(201)
    expect(await readBody(res)).toEqual({ ok: true, data: created })
  })

  test('the create sets organizationId EXPLICITLY from the session user', async () => {
    // Belt-and-braces alongside the tenant extension: the row must carry the caller org even if the ambient
    // context is lost, because RestApiEndpoint rows are executable whitelist entries.
    await post({ method: 'get', path: 'invoices' })
    const create = calls.find((c) => c.op === 'create')!
    const data = create.args.data as Record<string, unknown>
    expect(data.organizationId).toBe('org-1')
    expect(data.connectorId).toBe('c1')
  })

  test('the method is UPPERCASED before it is stored', async () => {
    await post({ method: '  get ', path: '/x' })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.method).toBe('GET')
  })

  test('every whitelisted verb is accepted', async () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      await post({ method: m, path: '/x' })
    }
    const methods = calls.filter((c) => c.op === 'create').map((c) => (c.args.data as Record<string, unknown>).method)
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  })

  test('an unsupported method is 400 and NOTHING is written', async () => {
    // HEAD/OPTIONS/TRACE would otherwise become whitelist entries the REST tool could select.
    const res = await post({ method: 'TRACE', path: '/x' })
    expect(res.status).toBe(400)
    expect(await readBody(res)).toMatchObject({
      ok: false,
      error: 'Method must be GET, POST, PUT, PATCH, or DELETE.',
    })
    expect(calls.some((c) => c.op === 'create')).toBe(false)
    expect(auditWrites).toHaveLength(0)
  })

  test('a missing method is 400, not a defaulted GET', async () => {
    // Defaulting a missing method would silently create a GET whitelist entry the admin never asked for.
    const res = await post({ path: '/x' })
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.op === 'create')).toBe(false)
  })

  test('the path is normalised to a leading slash before storage', async () => {
    await post({ method: 'GET', path: 'invoices/open' })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.path).toBe('/invoices/open')
  })

  test('an empty or missing path is 400 (it normalises to / and is rejected)', async () => {
    for (const path of [undefined, '', '   ', '/']) {
      const res = await post({ method: 'GET', path })
      expect(res.status).toBe(400)
      expect(await readBody(res)).toMatchObject({ ok: false, error: 'Endpoint path is required.' })
    }
    expect(calls.some((c) => c.op === 'create')).toBe(false)
  })

  test('isEnabled defaults to TRUE when the body omits it', async () => {
    await post({ method: 'GET', path: '/x' })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.isEnabled).toBe(true)
  })

  test('isEnabled false is honoured (a saved-but-disabled probe endpoint)', async () => {
    await post({ method: 'GET', path: '/x', isEnabled: false })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.isEnabled).toBe(false)
  })

  test('a blank description is stored as NULL, not an empty string', async () => {
    await post({ method: 'GET', path: '/x', description: '   ' })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.description).toBeNull()
  })

  test('a description is trimmed', async () => {
    await post({ method: 'GET', path: '/x', description: '  List invoices  ' })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.description).toBe('List invoices')
  })

  test('a non-string description is NULL rather than coerced', async () => {
    await post({ method: 'GET', path: '/x', description: 42 })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.description).toBeNull()
  })

  test('the JSON columns are STRINGIFIED, since the schema stores them as strings', async () => {
    await post({
      method: 'GET',
      path: '/x',
      parameterSchema: { q: 'string' },
      sampleRequest: { q: 'acme' },
      sampleResponse: { rows: [] },
    })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.parameterSchema).toBe('{"q":"string"}')
    expect(data.sampleRequest).toBe('{"q":"acme"}')
    expect(data.sampleResponse).toBe('{"rows":[]}')
  })

  test('each JSON column is NULL when absent, and the empty string is treated as absent', async () => {
    await post({ method: 'GET', path: '/x', parameterSchema: '', sampleRequest: undefined, sampleResponse: null })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.parameterSchema).toBeNull()
    expect(data.sampleRequest).toBeNull()
    expect(data.sampleResponse).toBeNull()
  })

  test('a falsy-but-present JSON value is still serialised (0 and false are not dropped)', async () => {
    // `value === undefined || value === null || value === ''` — only those three are treated as absent, so a
    // literal 0 in a schema is preserved rather than silently becoming NULL.
    await post({ method: 'GET', path: '/x', parameterSchema: 0 })
    const data = calls.find((c) => c.op === 'create')!.args.data as Record<string, unknown>
    expect(data.parameterSchema).toBe('0')
  })

  test('an unknown connector is 404 and no endpoint is created', async () => {
    connector = null
    const res = await post({ method: 'GET', path: '/x' })
    expect(res.status).toBe(404)
    expect(calls.some((c) => c.op === 'create')).toBe(false)
  })

  test('the connector lookup happens BEFORE the body is validated', async () => {
    // Order matters for the error the user sees: an unknown connector reports 404 with a bad method too,
    // rather than a misleading 400 about the method.
    connector = null
    const res = await post({ method: 'TRACE', path: '/x' })
    expect(res.status).toBe(404)
  })

  test('a MALFORMED body is rejected with 400, not treated as an empty valid body', async () => {
    const res = await post('{ not json')
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.op === 'create')).toBe(false)
  })

  test('a create failure is 500 and writes NO audit row', async () => {
    createThrows = new Error('unique constraint on (connectorId, method, path)')
    const res = await post({ method: 'GET', path: '/x' })
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('POST — audit trail', () => {
  test('the audit records the connector, the new endpoint id, its method and its normalised path', async () => {
    await post({ method: 'get', path: 'invoices' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'REST_ENDPOINT_CREATE',
      severity: 'info',
      detail: {
        connectorId: 'c1',
        connectorName: 'CRM',
        endpointId: 'e9',
        method: 'GET',
        path: '/invoices',
      },
    })
  })

  test('the audit is written AFTER the create', async () => {
    // Auditing first would leave a record of an endpoint that does not exist when the insert fails.
    await settle()
    await post({ method: 'GET', path: '/x' })
    const createIdx = events.indexOf('restApiEndpoint.create')
    const auditIdx = events.indexOf('audit')
    expect(createIdx).toBeGreaterThan(-1)
    expect(auditIdx).toBeGreaterThan(createIdx)
  })

  test('the audit names the connector by the NAME stored on the row, not by the id', async () => {
    connector = { id: 'c1', name: 'Billing API' }
    await post({ method: 'GET', path: '/x' })
    expect((auditWrites[0]!.detail as Record<string, unknown>).connectorName).toBe('Billing API')
  })
})

describe('POST — the LLM first-scan (source-init)', () => {
  test('it fires when no description was supplied', async () => {
    // `generateRestCall` matches questions against the endpoint description; an empty one degrades routing
    // badly, so the route kicks off an LLM scan of method/path/params/sampleResponse.
    await post({ method: 'GET', path: '/x' })
    await settle()
    expect(sourceInitCalls).toEqual(['e9'])
  })

  test('it does NOT fire when the admin supplied a description', async () => {
    created = { ...created!, description: 'List invoices' }
    await post({ method: 'GET', path: '/x', description: 'List invoices' })
    await settle()
    expect(sourceInitCalls).toEqual([])
  })

  test('the scan is keyed on the created endpoint ID, not on the connector', async () => {
    created = { ...created!, id: 'e-abc' }
    await post({ method: 'GET', path: '/x' })
    await settle()
    expect(sourceInitCalls).toEqual(['e-abc'])
  })

  test('a failing scan does NOT fail the response', async () => {
    // Fire-and-forget: an LLM outage must not lose the endpoint the admin just saved.
    sourceInitRejects = true
    const res = await post({ method: 'GET', path: '/x' })
    await settle()
    expect(res.status).toBe(201)
    expect(await readBody(res)).toEqual({ ok: true, data: created })
  })

  test('the scan is not awaited — the response does not wait for the LLM', async () => {
    // Proven by ordering: the audit and the response happen before the scan body runs to completion.
    await post({ method: 'GET', path: '/x' })
    const auditIdx = events.indexOf('audit')
    const initIdx = events.indexOf('initRestEndpointContext')
    expect(auditIdx).toBeGreaterThan(-1)
    if (initIdx !== -1) expect(initIdx).toBeLessThanOrEqual(auditIdx + 1)
  })
})

describe('no shared state between the two verbs', () => {
  test('GET never creates and POST never lists', async () => {
    await get()
    expect(calls.some((c) => c.op === 'create')).toBe(false)
    calls.length = 0
    await post({ method: 'GET', path: '/x' })
    expect(calls.some((c) => c.op === 'findMany')).toBe(false)
  })
})
