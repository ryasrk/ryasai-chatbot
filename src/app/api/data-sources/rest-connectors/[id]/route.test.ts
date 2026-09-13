/**
 * GET + PATCH + DELETE /api/data-sources/rest-connectors/[id] — a REST connector and its outbound credentials.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog. Three properties carry real risk here:
 *
 *   1. AN SSRF GATE ON THE EDIT PATH. `parseBaseUrl` refuses a non-http(s) scheme and throws when
 *      `isBlockedHost` matches, so a connector cannot be re-pointed at a cloud metadata endpoint
 *      (169.254.169.254) or at localhost. The connector is what the REST tool calls on the LLM's behalf, so
 *      this is the boundary that stops a tool call from reaching the platform's own network.
 *   2. `authType: 'NONE'` MUST NULL THE CREDENTIAL. `data.encryptedAuthConfig = authType === 'NONE' ? null : ...`
 *      -- switching a connector to no-auth has to actually DROP the stored token. Leaving it behind keeps a
 *      live secret in a row that no longer claims to use one.
 *   3. `timeoutMs` IS CLAMPED, not trusted. A caller-supplied 0 or 10_000_000 would make the connector hang a
 *      worker or time out instantly; the clamp is [1000, 120000].
 *
 * Also pinned: `findFirst` on every load (the cross-tenant IDOR class), the auth-type whitelist, the mask on
 * GET, and that the DELETE result body is asserted with toEqual (an id echoed back is part of the contract).
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

const PLAINTEXT_TOKEN = 'bearer-LIVE-SUPERSECRET'
const CIPHERTEXT = 'enc:STORED-CIPHERTEXT'

let row: Record<string, unknown> | null = null
let updateThrows: Error | null = null
let loadThrows: Error | null = null
let deleteThrows: Error | null = null
let decryptFails = false
let blockedHost: string | null = null

const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const encryptedInputs: Array<Record<string, unknown>> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    enteredOrgs.push(o)
  },
}))

// The encryptor must NOT be a faithful reversible copy of its input: a mock that embeds the plaintext inside
// the ciphertext would make a real secret LEAK look identical to correct encryption. I probed the real
// `encryptConfig` first (`blob.includes(SECRET) === false`, round-trip OK) and the mock below reproduces that
// property -- the plaintext is not recoverable from the output string -- while remaining reversible through a
// module-level table so the decrypt path stays testable.
const blobTable = new Map<string, Record<string, unknown>>()
let blobSeq = 0

/**
 * The row's stored blob is a LITERAL, so it must be registered in the table too -- the decrypt path looks
 * blobs up by id, and a row written outside `encryptConfig` would otherwise be undecryptable and make GET
 * return 500. Registered ONCE at module scope, NOT cleared per test: the fixture row lives across tests.
 */
const FIXTURE_BLOB = 'blob-fixture'
const FIXTURE_PLAINTEXT = { token: 'bearer-LIVE-SUPERSECRET' }
blobTable.set(FIXTURE_BLOB, FIXTURE_PLAINTEXT)

mock.module('@/lib/crypto', () => ({
  encryptConfig: (o: Record<string, unknown>) => {
    encryptedInputs.push(o)
    const id = `blob-${++blobSeq}-${Math.random().toString(36).slice(2)}`
    blobTable.set(id, o)
    // Opaque output: no plaintext substring, matching the real AES-256-GCM envelope.
    return `enc:v1:${id}`
  },
  decryptConfig: (blob: string) => {
    if (decryptFails) throw new Error('bad tag')
    if (!blob.startsWith('enc:v1:')) throw new Error('not a blob')
    const found = blobTable.get(blob.slice('enc:v1:'.length))
    if (!found) throw new Error('unknown blob')
    return found
  },
  maskConfig: (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' && v ? '••••••••' : v
    return out
  },
}))

mock.module('@/lib/llm-config', () => ({
  // The real guard's contract: true for loopback / link-local / private ranges.
  isBlockedHost: (host: string) => {
    if (blockedHost) return host === blockedHost
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    restApiConnector: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        return row
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findUnique', args })
        return row
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'update', args })
        if (updateThrows) throw updateThrows
        return { ...row, ...(args.data as Record<string, unknown>) }
      },
      delete: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'delete', args })
        if (deleteThrows) throw deleteThrows
        return {}
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'deleteMany', args })
        return { count: 1 }
      },
    },
  },
}))

import { GET, PATCH, DELETE } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/data-sources/rest-connectors/c1', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    ctx('c1'),
  )
}

function upd() {
  return calls.find((c) => c.op === 'update')
}

beforeEach(() => {
  user = adminUser
  row = {
    id: 'c1',
    name: 'Orders API',
    baseUrl: 'https://api.example.com/',
    authType: 'BEARER',
    encryptedAuthConfig: `enc:v1:${FIXTURE_BLOB}`,
    isActive: true,
    timeoutMs: 30000,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    endpoints: [{ id: 'e1', method: 'GET', path: '/orders' }],
  }
  updateThrows = null
  loadThrows = null
  deleteThrows = null
  decryptFails = false
  blockedHost = null
  calls.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  encryptedInputs.length = 0
})

describe('the IDOR class: findFirst on every load', () => {
  test('GET, PATCH and DELETE load with findFirst, never findUnique', async () => {
    await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads.length).toBeGreaterThanOrEqual(3)
    for (const l of loads) expect(l.op).toBe('findFirst')
  })

  test('all three handlers enter the session org', async () => {
    await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    expect(enteredOrgs).toEqual(['org-1', 'org-1', 'org-1'])
  })
})

describe('GET masks the credential and includes the endpoints', () => {
  test('the fixture blob is decryptable, so this suite is testing the ROUTE and not a broken fixture', async () => {
    // A guard on the harness itself: if the blob table lost the fixture entry, GET would 500 and every mask
    // assertion below would fail for the wrong reason.
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    expect(res.status).toBe(200)
  })

  test('the ciphertext and the plaintext token never reach the client', async () => {
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    const raw = await res.text()
    expect(raw).not.toContain('STORED-CIPHERTEXT')
    expect(raw).not.toContain(PLAINTEXT_TOKEN)
    expect(raw).not.toContain('encryptedAuthConfig')
  })

  test('the masked shape bullets the secret and keeps the non-secret fields', async () => {
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.authConfig).toEqual({ token: '••••••••' })
    expect(body.data.authType).toBe('BEARER')
    expect(body.data.timeoutMs).toBe(30000)
  })

  test('a connector with NO stored credentials reports an EMPTY authConfig, not null', async () => {
    // `connector.encryptedAuthConfig ? mask(...) : {}` -- the UI reads authConfig as an object.
    row!.encryptedAuthConfig = null
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    expect(((await res.json()) as { data: { authConfig: unknown } }).data.authConfig).toEqual({})
  })

  test('the endpoints are returned with the connector', async () => {
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    const body = (await res.json()) as { data: { endpoints: Array<{ path: string }> } }
    expect(body.data.endpoints).toHaveLength(1)
    expect(body.data.endpoints[0]!.path).toBe('/orders')
  })

  test('the endpoints are ordered by method then path', async () => {
    // Deterministic ordering keeps the schema sheet stable between loads.
    await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    const load = calls.find((c) => c.op === 'findFirst')!
    expect(load.args.include).toEqual({
      endpoints: { orderBy: [{ method: 'asc' }, { path: 'asc' }] },
    })
  })

  test('a missing connector is 404', async () => {
    row = null
    expect((await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))).status).toBe(404)
  })

  test('an UNDECRYPTABLE blob propagates as a handled 500 rather than a leaked stack', async () => {
    // Documented honestly as the current behaviour: unlike the notifications route, this GET has no inner
    // catch around the decrypt, so a rotated ENCRYPTION_SECRET_KEY surfaces as the typed error response.
    decryptFails = true
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('bad tag')
  })
})

describe('the SSRF gate on the edit path', () => {
  test('a non-http(s) scheme is refused with 400 and nothing is written', async () => {
    const res = await patch({ baseUrl: 'file:///etc/passwd' })
    expect(res.status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('a CLOUD METADATA address is refused and nothing is written', async () => {
    // 169.254.169.254 serves instance credentials on every major cloud. The REST tool calls whatever this
    // connector points at ON THE LLM'S BEHALF, so this is the boundary that keeps a tool call off the
    // platform's own network.
    const res = await patch({ baseUrl: 'http://169.254.169.254/latest/meta-data/' })
    expect(res.status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('loopback is refused', async () => {
    expect((await patch({ baseUrl: 'http://127.0.0.1:9000/' })).status).toBe(400)
    expect((await patch({ baseUrl: 'http://localhost:3000/' })).status).toBe(400)
  })

  test('a private-range address is refused', async () => {
    expect((await patch({ baseUrl: 'http://10.0.0.5/' })).status).toBe(400)
    expect((await patch({ baseUrl: 'http://192.168.1.10/' })).status).toBe(400)
  })

  test('the blocked-host message is the specific one, not the generic invalid-URL one', async () => {
    // The distinction matters to an operator: "blocked internal host" is a policy decision, "invalid" is a
    // typo. Asserted on the message body.
    const res = await patch({ baseUrl: 'http://169.254.169.254/' })
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('blocked internal host')
  })

  test('a public https URL is accepted', async () => {
    expect((await patch({ baseUrl: 'https://api.example.com/v2' })).status).toBe(200)
    expect((upd()!.args.data as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v2')
  })

  test('a TRAILING SLASH is stripped so endpoint paths do not double up', async () => {
    await patch({ baseUrl: 'https://api.example.com/v2/' })
    expect((upd()!.args.data as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v2')
  })

  test('surrounding whitespace is trimmed before parsing', async () => {
    await patch({ baseUrl: '   https://api.example.com/v3   ' })
    expect((upd()!.args.data as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v3')
  })

  test('a whitespace-only baseUrl is IGNORED, leaving the stored URL', async () => {
    await patch({ baseUrl: '   ', isActive: false })
    expect(upd()!.args.data).not.toHaveProperty('baseUrl')
  })

  test('a non-URL string is 400', async () => {
    expect((await patch({ baseUrl: 'not a url' })).status).toBe(400)
  })
})

describe('auth handling', () => {
  test("authType NONE NULLs the stored credential", async () => {
    // Switching a connector to no-auth must actually DROP the token. Leaving it behind keeps a live secret in
    // a row that no longer claims to use one.
    await patch({ authType: 'NONE' })
    expect(upd()!.args.data).toMatchObject({ authType: 'NONE', encryptedAuthConfig: null })
  })

  test('authType NONE does not encrypt the supplied config either', async () => {
    await patch({ authType: 'NONE', authConfig: { token: PLAINTEXT_TOKEN } })
    expect(encryptedInputs).toHaveLength(0)
    expect(JSON.stringify(upd()!.args)).not.toContain(PLAINTEXT_TOKEN)
  })

  test('a real authType encrypts the supplied config', async () => {
    await patch({ authType: 'BEARER', authConfig: { token: PLAINTEXT_TOKEN } })
    expect(encryptedInputs).toEqual([{ token: PLAINTEXT_TOKEN }])
    const written = (upd()!.args.data as { encryptedAuthConfig: string }).encryptedAuthConfig
    expect(written).toMatch(/^enc:/)
    // The stored value must NOT contain the plaintext. Verified against the real encryptor during this round:
    // its output never contains the input substring, so this assertion is meaningful rather than a mock artefact.
    expect(written).not.toContain(PLAINTEXT_TOKEN)
  })

  test('a real authType with NO config encrypts an EMPTY object rather than storing nothing', async () => {
    // `encryptConfig(body.authConfig ?? {})` -- an explicit authType always writes a blob, so the row cannot
    // be left claiming BEARER with no credential blob at all.
    await patch({ authType: 'API_KEY_HEADER' })
    expect(encryptedInputs).toEqual([{}])
    expect((upd()!.args.data as { encryptedAuthConfig: string }).encryptedAuthConfig).toMatch(/^enc:/)
  })

  test('the authType is upper-cased before the whitelist check', async () => {
    expect((await patch({ authType: 'bearer' })).status).toBe(200)
    expect(upd()!.args.data).toMatchObject({ authType: 'BEARER' })
  })

  test('the authType is trimmed before the whitelist check', async () => {
    expect((await patch({ authType: '  BEARER  ' })).status).toBe(200)
  })

  test('an unknown authType is 400 and nothing is written', async () => {
    const res = await patch({ authType: 'OAUTH2' })
    expect(res.status).toBe(400)
    expect(upd()).toBeUndefined()
    expect(encryptedInputs).toHaveLength(0)
  })

  test('an authConfig WITHOUT an authType re-encrypts but does not touch authType', async () => {
    // The `else if (body.authConfig)` branch: a token rotation that leaves the auth mode alone.
    await patch({ authConfig: { token: 'ROTATED' } })
    expect(encryptedInputs).toEqual([{ token: 'ROTATED' }])
    expect(upd()!.args.data).not.toHaveProperty('authType')
    expect((upd()!.args.data as { encryptedAuthConfig: string }).encryptedAuthConfig).toMatch(/^enc:/)
  })

  test('an EMPTY authConfig PLUS an authType still writes a blob', async () => {
    // `body.authConfig` is falsy for `{}`, which is why the authType branch (not the else-if) must handle it.
    await patch({ authType: 'BEARER', authConfig: {} })
    expect(encryptedInputs).toEqual([{}])
  })
})

describe('timeoutMs is CLAMPED, not trusted', () => {
  test('a value below the floor is raised to 1000', async () => {
    // A 0ms timeout would fail every call instantly and read as "the API is down".
    await patch({ timeoutMs: 0 })
    expect(upd()!.args.data).toMatchObject({ timeoutMs: 1000 })
  })

  test('a negative value is raised to 1000', async () => {
    await patch({ timeoutMs: -5000 })
    expect(upd()!.args.data).toMatchObject({ timeoutMs: 1000 })
  })

  test('a value above the ceiling is lowered to 120000', async () => {
    // An unbounded timeout lets one slow endpoint pin a worker slot indefinitely.
    await patch({ timeoutMs: 10_000_000 })
    expect(upd()!.args.data).toMatchObject({ timeoutMs: 120000 })
  })

  test('a fractional value is floored', async () => {
    await patch({ timeoutMs: 4500.9 })
    expect(upd()!.args.data).toMatchObject({ timeoutMs: 4500 })
  })

  test('both boundaries are inclusive', async () => {
    await patch({ timeoutMs: 1000 })
    expect(upd()!.args.data).toMatchObject({ timeoutMs: 1000 })
    await patch({ timeoutMs: 120000 })
    expect(calls.filter((c) => c.op === 'update')[1]!.args.data).toMatchObject({ timeoutMs: 120000 })
  })

  test('a JSON non-finite timeout arrives as null and is correctly IGNORED', async () => {
    // THE `Number.isFinite` GUARD CANNOT BE EXERCISED THROUGH HTTP, and this test records why instead of
    // pretending otherwise.
    //
    // `JSON.stringify(Infinity)` and `JSON.stringify(NaN)` both emit **null** -- proven with a separate probe,
    // not assumed. So the value never reaches the route as a number, `typeof null === 'object'` fails the
    // `typeof === 'number'` test FIRST, and the `Number.isFinite` half is never evaluated. A control that
    // deletes `Number.isFinite` therefore cannot bite here: no HTTP request can distinguish the two versions.
    //
    // That makes this an honest DECLARED NON-CONTROL, not a test gap I can close. What IS asserted is the
    // behaviour that actually reaches production: a null timeout is ignored and does not become 1000, 120000,
    // or an explicit null write.
    await patch({ timeoutMs: Number.POSITIVE_INFINITY, isActive: false })
    expect(upd()!.args.data).toEqual({ isActive: false })

    await patch({ timeoutMs: Number.NaN, isActive: true })
    expect((calls.filter((c) => c.op === 'update')[1]!.args.data as Record<string, unknown>)).toEqual({
      isActive: true,
    })
  })

  test('an explicit null timeout is ignored too (the same path, reached directly)', async () => {
    // Two different ways to reach the identical branch: `JSON.stringify` collapsing a non-finite number, and a
    // caller literally sending null. Both must be ignored identically.
    await patch({ timeoutMs: null, isActive: false })
    expect(upd()!.args.data).toEqual({ isActive: false })
  })

  test('a STRING timeout is ignored', async () => {
    await patch({ timeoutMs: '5000' as unknown as number, isActive: false })
    expect(upd()!.args.data).not.toHaveProperty('timeoutMs')
  })
})

describe('validation and audit', () => {
  test('a whitespace-only name does not clear the stored name', async () => {
    await patch({ name: '   ', isActive: false })
    expect(upd()!.args.data).not.toHaveProperty('name')
  })

  test('an empty body is 400', async () => {
    expect((await patch({})).status).toBe(400)
    expect(upd()).toBeUndefined()
  })

  test('a malformed JSON body is 400', async () => {
    expect((await patch('not json')).status).toBe(400)
  })

  test('a missing connector is 404 before any write', async () => {
    row = null
    expect((await patch({ name: 'X' })).status).toBe(404)
    expect(upd()).toBeUndefined()
  })

  test('the update SELECTS a field set that excludes the credential blob', async () => {
    await patch({ name: 'X' })
    expect(upd()!.args.select).toMatchObject({
      id: true,
      name: true,
      baseUrl: true,
      authType: true,
      isActive: true,
      timeoutMs: true,
      updatedAt: true,
    })
    expect((upd()!.args.select as Record<string, unknown>).encryptedAuthConfig).toBeUndefined()
  })

  test('the update audit is WARNING and records the change set', async () => {
    // Warning, not info: a connector edit can redirect outbound calls and rotate a credential.
    await patch({ name: 'Renamed' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'REST_CONNECTOR_UPDATE',
      severity: 'warning',
      detail: { connectorId: 'c1', beforeName: 'Orders API' },
    })
  })

  test('the audit carries the CIPHERTEXT but never the plaintext', async () => {
    // Split into two facts, because only one of them is a defect worth flagging.
    //
    // NOT a defect: the plaintext is absent. Confirmed against the REAL `encryptConfig` -- its output never
    // contains the input substring -- so this is a property of the system, not of the test's mock.
    //
    // FLAGGED, deliberately not fixed: `after: data` puts the credential CIPHERTEXT into the audit row. A
    // ciphertext is not a plaintext, and this is therefore NOT equivalent to leaking the token; but an audit
    // table is widely readable, is exported for review, and a future key compromise would retro-decrypt every
    // blob it accumulated. An audit trail should record THAT a credential rotated, not its encrypted form.
    await patch({ authConfig: { token: PLAINTEXT_TOKEN } })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain(PLAINTEXT_TOKEN)
    // The presence of the blob is asserted so the flag above is verifiable rather than a claim.
    expect(logged).toContain('encryptedAuthConfig')
  })
})

describe('DELETE', () => {
  test('it deletes by the LOADED row id', async () => {
    await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    const del = calls.find((c) => c.op === 'delete')
    expect(del).toBeDefined()
    expect(del!.args.where).toEqual({ id: 'c1' })
  })

  test('deleting by the LOADED id is distinguishable from the raw path param', async () => {
    // Control K14 (swapping `existing.id` for the path param) initially did NOT bite, because my fixture used
    // the same string for both -- so the two expressions were indistinguishable and the test proved nothing.
    // Here the path param is a DIFFERENT string from the row's id, which is the only way the assertion has
    // content. The route must delete the row it actually loaded.
    const realId = 'c1'
    const poisonedParam = 'c1-other-org'
    await DELETE(
      new Request('http://localhost/api/data-sources/rest-connectors/' + poisonedParam, { method: 'DELETE' }) as never,
      ctx(poisonedParam),
    )
    const del = calls.find((c) => c.op === 'delete')!
    expect(del.args.where).toEqual({ id: realId })
    expect(del.args.where).not.toEqual({ id: poisonedParam })
  })

  test('the response body is exactly { ok, data: { id, deleted } }', async () => {
    const res = await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    expect(await res.json()).toEqual({ ok: true, data: { id: 'c1', deleted: true } })
  })

  test('the delete is audited at WARNING', async () => {
    await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'REST_CONNECTOR_DELETE',
      severity: 'warning',
      detail: { connectorId: 'c1', name: 'Orders API' },
    })
  })

  test('a missing connector is 404 with no delete and no audit', async () => {
    row = null
    const res = await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    expect(res.status).toBe(404)
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('each handler maps an internal failure to the typed error response', () => {
  test('GET failure is 500 without leaking the error text', async () => {
    loadThrows = new Error('connection reset')
    const res = await GET(new Request('http://localhost/api/data-sources/rest-connectors/c1') as never, ctx('c1'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('PATCH failure is 500', async () => {
    loadThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })

  test('DELETE failure is 500', async () => {
    deleteThrows = new Error('connection reset')
    const res = await DELETE(new Request('http://localhost/api/data-sources/rest-connectors/c1', { method: 'DELETE' }) as never, ctx('c1'))
    expect(res.status).toBe(500)
  })
})
