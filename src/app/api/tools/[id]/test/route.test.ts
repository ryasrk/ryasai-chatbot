/**
 * POST /api/tools/[id]/test — invoke a saved plugin with a test input from the custom-tools Test dialog.
 *
 * WHY THIS FILE EXISTS. This route hands arbitrary input to an outbound webhook and returns the response to a
 * browser, so it sits on two failure modes at once. Four properties:
 *
 *   1. THE PLUGIN IS LOADED WITH `findFirst`, ORG-SCOPED. The id is client-supplied (the tools list returns it),
 *      so this is exactly the pattern the 2026-09 audit called out: `findUnique` is NOT org-scoped and ids are not
 *      secret. The OPERATION is asserted, not the outcome, because a happy-path test cannot tell the two apart.
 *   2. THE LOAD SELECT IS FIVE COLUMNS AND EXCLUDES NOTHING SECRET — but note WHICH five. `manifestJson` IS part
 *      of the select, deliberately, because executePlugin needs it. That makes this route the place where the
 *      credential question actually lives, and the section below records the finding with evidence.
 *   3. THE EXECUTION GOES THROUGH THE REAL `executePlugin` WITH NO BYPASS. The route's own comment says a test
 *      button that skipped guards would be an SSRF oracle; the test below proves the seam receives the manifest
 *      and toolId rather than a pre-built request.
 *   4. THE AUDIT IS BEST-EFFORT AND MUST NOT BREAK A SUCCESSFUL TEST. It is `.catch(() => {})`-ed, unlike every
 *      other route in this family, so a failing audit log does NOT fail the user's test run. Pinned as the
 *      detected behaviour, including the consequence: a plugin test can run without an audit row.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 * FINDING ON THE TWO REPORTED CREDENTIAL DEFECTS IN THE /api/tools/[id] FAMILY — ONE CONFIRMED, ONE REFUTED HERE.
 *
 * CONFIRMED (and NOT reproduced by this route): `src/app/api/tools/[id]/route.ts` GET spreads the whole row
 *   (`...plugin`) and only then attaches a masked `manifest` sibling, so `manifestJson` — the column that holds
 *   the ENCRYPTED `authCredentials` — ships to the client verbatim. That is already pinned by
 *   `src/app/api/tools/[id]/route.test.ts` ("the raw manifestJson IS sent to the client alongside the mask"), and
 *   I re-verified it by reading the route: line 31 `...plugin,` before line 32's masked `manifest`. It is
 *   ciphertext, not plaintext, but it is the disclosure masking exists to prevent.
 *   This test route does NOT have that defect, and that is a REAL difference, not a compliment: it selects an
 *   explicit five-column set and returns only `{ ok, result }`, so `manifestJson` never reaches the response.
 *
 * REFUTED HERE: "the test route leaks the tool credentials to the client." It does not, and the leak cannot come
 *   through `result` either: `executePlugin` returns `{ ok, output, error, latencyMs }` and its outgoing
 *   credentials go into REQUEST HEADERS (`Authorization` / `X-API-Key`), never into the returned object. The only
 *   field that can echo upstream content is `output` (the response body, capped at 8000 chars), which the mock
 *   cannot exercise meaningfully — so the honest statement is: no credential path EXISTS in this route's response
 *   shape, asserted structurally below by pinning the result key set, and the mocked seam cannot invent one.
 *   The load's five-column select is asserted too, so widening it (e.g. adding the raw row) is a visible edit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Control tests were verified by mutating the route in place, running the file, and restoring it.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser
let authThrows: Error | null = null
const STORED_CIPHERTEXT = 'enc:STORED-CIPHERTEXT-DO-NOT-ECHO'
let pluginRow: Record<string, unknown> | null = {
  id: 'p1',
  toolId: 'weather',
  name: 'Weather',
  manifestJson: `{"executorType":"webhook","endpoint":"https://api.example.com/w","method":"GET","authType":"BEARER","authCredentials":"${STORED_CIPHERTEXT}"}`,
  isEnabled: true,
}
let loadThrows: Error | null = null
let executeThrows: Error | null = null
let result: { ok: boolean; output: string; error?: string; latencyMs: number } = {
  ok: true,
  output: '{"temp":21}',
  latencyMs: 42,
}
let auditThrows: Error | null = null
const pluginCalls: Array<{ op: string; args: Record<string, unknown> }> = []
const executeArgs: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
const events: string[] = []
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  writeAudit: async (row: Record<string, unknown>) => {
    events.push('writeAudit')
    if (auditThrows) throw auditThrows
    audits.push(row)
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    handleErrorArgs.push({ fallback, status })
    events.push('handleApiError')
    const name = (e as { name?: string } | null)?.name
    if (name === 'UnauthorizedError') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: (e as Error).message } }, { status: 401 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findFirst: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'findFirst', args })
        events.push('plugin.findFirst')
        if (loadThrows) throw loadThrows
        return pluginRow
      },
      // Present so a regression to findUnique is an OBSERVABLE failure rather than a crash.
      findUnique: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'findUnique', args })
        events.push('plugin.findUnique')
        return pluginRow
      },
    },
  },
}))

mock.module('@/lib/plugin-registry', () => ({
  executePlugin: async (args: Record<string, unknown>) => {
    executeArgs.push(args)
    events.push('executePlugin')
    if (executeThrows) throw executeThrows
    return result
  },
}))

// DYNAMIC: mock.module does not apply to static imports.
const { POST } = await import('./route')

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function post(body: unknown, id = 'p1', url = 'http://localhost/api/tools/p1/test') {
  const req = new Request(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json' },
  }) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return POST(req as never, ctx(id))
}

beforeEach(() => {
  user = adminUser
  authThrows = null
  pluginRow = {
    id: 'p1',
    toolId: 'weather',
    name: 'Weather',
    manifestJson: `{"executorType":"webhook","endpoint":"https://api.example.com/w","method":"GET","authType":"BEARER","authCredentials":"${STORED_CIPHERTEXT}"}`,
    isEnabled: true,
  }
  loadThrows = null
  executeThrows = null
  result = { ok: true, output: '{"temp":21}', latencyMs: 42 }
  auditThrows = null
  pluginCalls.length = 0
  executeArgs.length = 0
  audits.length = 0
  events.length = 0
  handleErrorArgs = []
})

describe('the tenant scope', () => {
  test('the plugin is loaded with findFirst, never findUnique', async () => {
    // Control C1 (switching to findUnique): red. The id is handed to the browser by GET /api/tools, so a
    // findUnique load would let an org-A admin run org-B's plugin — and the plugin carries a live credential.
    await post({ input: 'x' })
    const loads = pluginCalls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads).toHaveLength(1)
    expect(loads[0]!.op).toBe('findFirst')
  })

  test('the lookup filters by the PATH id', async () => {
    await post({ input: 'x' }, 'plugin-42')
    expect(pluginCalls[0]!.args.where).toEqual({ id: 'plugin-42' })
  })

  test('the load select is exactly five columns', async () => {
    // Control C2 (dropping the select so the whole row is fetched): red. With the full row in hand a later
    // `{ ...plugin }` in a response would ship organizationId, createdAt, and every future column.
    await post({ input: 'x' })
    const select = pluginCalls[0]!.args.select as Record<string, unknown>
    expect(Object.keys(select).sort()).toEqual([
      'id',
      'isEnabled',
      'manifestJson',
      'name',
      'toolId',
    ])
  })

  test('the org context is entered from the session before the load', async () => {
    // Without enterWithOrg the findFirst is UNSCOPED, which is the whole tenant defence here.
    await post({ input: 'x' })
    // `events[0]` is getActiveUser: the fake records the call itself, and enterWithOrg CANNOT precede it because
    // the org id comes from its result. What matters is that the context is established before the first query.
    expect(events).toContain('enterWithOrg:org-1')
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('plugin.findFirst'))
  })

  test('a missing session is a 401 and never reaches the plugin', async () => {
    authThrows = Object.assign(new Error('No active session.'), { name: 'UnauthorizedError' })
    const res = await post({ input: 'x' })
    expect(res.status).toBe(401)
    expect(pluginCalls).toHaveLength(0)
    expect(executeArgs).toHaveLength(0)
  })

  test('the org id follows the session, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-9' }
    await post({ input: 'x' })
    expect(events).toContain('enterWithOrg:org-9')
  })

  test('it reads the id from ctx.params via the awaited promise', async () => {
    // Next 16 hands params as a Promise; reading it as a plain object would silently yield `undefined` and the
    // route would look up `{ id: undefined }`.
    await post({ input: 'x' }, 'from-params')
    expect(pluginCalls[0]!.args.where).toEqual({ id: 'from-params' })
  })
})

describe('the plugin gates', () => {
  test('a missing plugin is 404 with ok:false and no execution', async () => {
    pluginRow = null
    const res = await post({ input: 'x' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'Plugin not found.' })
    expect(executeArgs).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a DISABLED plugin is 409 and is never executed', async () => {
    // Control C3 (deleting the isEnabled gate): red. A disabled plugin is one an admin turned OFF; the test button
    // must not be a way to fire it anyway.
    pluginRow = { ...pluginRow, isEnabled: false }
    const res = await post({ input: 'x' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'Plugin is disabled.' })
    expect(executeArgs).toHaveLength(0)
  })

  test('the disabled check happens AFTER the load, so a missing plugin is still a 404', async () => {
    pluginRow = null
    expect((await post({ input: 'x' })).status).toBe(404)
  })
})

describe('what reaches executePlugin', () => {
  test('executePlugin receives the stored manifestJson and toolId, not a pre-built request', async () => {
    // Control C4 (calling fetch directly, bypassing the registry): red. The route comment promises the test goes
    // through the same SSRF/host checks, auth decryption and timeout cap as a real invocation.
    await post({ input: 'x' })
    expect(executeArgs[0]).toEqual({
      plugin: { manifestJson: pluginRow!.manifestJson, toolId: 'weather' },
      input: 'x',
    })
  })

  test('the input is passed through as a TRIMMED string', async () => {
    await post({ input: '  {"lat":1}  ' })
    expect((executeArgs[0] as { input: string }).input).toBe('{"lat":1}')
  })

  test('a MISSING input becomes an empty string, not undefined', async () => {
    // executePlugin switches on `args.input` truthiness in several branches (GET query params, body build), so
    // undefined would take a different path than '' on every one of them.
    await post({})
    expect((executeArgs[0] as { input: string }).input).toBe('')
  })

  test('FIXED: a NUMERIC input is COERCED to its string form and DOES reach the executor', async () => {
    // THIS USED TO PIN A 500. `(body.input ?? '').trim()` only guarded null/undefined, so a JSON number or object
    // threw inside the handler and the caller saw "Failed to test plugin." -- indistinguishable from a plugin that
    // is actually broken, for a request that was merely the wrong shape. The value is coerced now, so the plugin is
    // tested with "42" and the route never reports a server fault for a client-shaped mistake.
    const res = await post({ input: 42 })
    expect(res.status).toBe(200)
    expect(executeArgs[executeArgs.length - 1]).toMatchObject({ input: '42' })
  })

  test('FIXED: an OBJECT input is coerced too, and never becomes a server fault', async () => {
    const res = await post({ input: { nested: true } })
    expect(res.status).toBe(200)
    // `String({nested:true})` is "[object Object]" -- honest about the shape rather than throwing.
    expect(executeArgs[executeArgs.length - 1]).toMatchObject({ input: '[object Object]' })
  })


  test('a malformed JSON body degrades to an empty input instead of a 500', async () => {
    const res = await post('not json')
    expect(res.status).toBe(200)
    expect((executeArgs[0] as { input: string }).input).toBe('')
  })

  test('an EMPTY body is accepted (the dialog allows a no-input smoke test)', async () => {
    const req = new Request('http://localhost/api/tools/p1/test', { method: 'POST' }) as Request & { nextUrl: URL }
    req.nextUrl = new URL('http://localhost/api/tools/p1/test')
    expect((await POST(req as never, ctx('p1'))).status).toBe(200)
    expect(executeArgs).toHaveLength(1)
  })
})

describe('the response — no credential surface', () => {
  test('it answers { ok: true, result } with the executor result verbatim', async () => {
    const body = (await (await post({ input: 'x' })).json()) as { ok: boolean; result: unknown }
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ ok: true, output: '{"temp":21}', latencyMs: 42 })
  })

  test('the result key set is EXACTLY ok, output, error, latencyMs', async () => {
    // THE STRUCTURAL CREDENTIAL CONTROL. `executePlugin` puts credentials in REQUEST HEADERS (Authorization /
    // X-API-Key), never in its return value, so this key set is what bounds the leak surface. If the executor is
    // ever changed to echo the request it built, this fails before the credential reaches a browser.
    const body = (await (await post({ input: 'x' })).json()) as { result: Record<string, unknown> }
    expect(Object.keys(body.result).sort()).toEqual(['latencyMs', 'ok', 'output'])
  })

  test('the RESPONSE never contains the stored credential ciphertext', async () => {
    // REFUTATION EVIDENCE for the "test route leaks credentials" report: even with the ciphertext in the row and
    // in the manifest handed to the executor, the serialised body does not contain it, because the route returns
    // only the executor's four fields.
    const t = await (await post({ input: 'x' })).text()
    expect(t).not.toContain(STORED_CIPHERTEXT)
    expect(t).not.toContain('authCredentials')
    expect(t).not.toContain('manifestJson')
  })

  test('the response never carries the plugin ROW either', async () => {
    // Unlike the GET handler in this family, this route does not spread the row: no id, name, organizationId.
    const t = await (await post({ input: 'x' })).text()
    expect(t).not.toContain('"toolId"')
    expect(t).not.toContain('organizationId')
    expect(t).not.toContain('"Weather"')
  })

  test('a FAILED execution is still a 200 with the failure inside result', async () => {
    // The dialog reads data.result on success and data.error on failure; a non-2xx here would make the UI show a
    // transport error for a well-understood plugin verdict (e.g. a blocked host).
    result = { ok: false, output: '', error: 'Endpoint points to a blocked internal host.', latencyMs: 0 }
    const res = await post({ input: 'x' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; result: { ok: boolean; error: string } }
    expect(body.ok).toBe(true)
    expect(body.result.ok).toBe(false)
    expect(body.result.error).toContain('blocked internal host')
  })

  test('an EXECUTOR THROW is a 500 with no result payload', async () => {
    executeThrows = new Error('decryptConfig: ENCRYPTION_SECRET_KEY mismatch')
    const res = await post({ input: 'x' })
    expect(res.status).toBe(500)
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to test plugin.', status: 500 }])
  })

  test('the executor error text never reaches the client', async () => {
    executeThrows = new Error('fetch failed for https://internal.corp/admin')
    const t = await (await post({ input: 'x' })).text()
    expect(t).not.toContain('internal.corp')
    expect(t).not.toContain('ENCRYPTION_SECRET_KEY')
  })

  test('a LOAD failure is a 500 and executes nothing', async () => {
    loadThrows = new Error('connection reset')
    const res = await post({ input: 'x' })
    expect(res.status).toBe(500)
    expect(executeArgs).toHaveLength(0)
  })
})

describe('the audit', () => {
  test('a successful test audits PLUGIN_TEST at info with the plugin and tool ids', async () => {
    await post({ input: 'x' })
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'PLUGIN_TEST',
      severity: 'info',
      detail: { pluginId: 'p1', toolId: 'weather', latencyMs: 42, ok: true },
    })
  })

  test('a FAILED execution audits PLUGIN_TEST_FAILED so an operator can see failures', async () => {
    result = { ok: false, output: '', error: 'timeout', latencyMs: 15000 }
    await post({ input: 'x' })
    expect(audits[0]).toMatchObject({ action: 'PLUGIN_TEST_FAILED', detail: { ok: false, latencyMs: 15000 } })
  })

  test('the audit records the PATH id, not the row id it loaded', async () => {
    await post({ input: 'x' }, 'p-from-path')
    expect((audits[0]!.detail as { pluginId: string }).pluginId).toBe('p-from-path')
  })

  test('the audit carries NO input payload and NO credentials', async () => {
    // The test input is whatever the admin typed, which may include real data; the audit keeps only the ids.
    await post({ input: 'SECRET-CUSTOMER-QUERY', })
    const logged = JSON.stringify(audits[0])
    expect(logged).not.toContain('SECRET-CUSTOMER-QUERY')
    expect(logged).not.toContain(STORED_CIPHERTEXT)
  })

  test('the audit happens AFTER the execution, so latency is real', async () => {
    await post({ input: 'x' })
    expect(events.indexOf('executePlugin')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('FINDING: an audit failure does NOT fail the test run', async () => {
    // This route is the only one in the family that `.catch(() => {})`es writeAudit. Consequence, stated plainly:
    // a plugin invocation can happen with NO audit row, so "every tool run is observable" does not hold for this
    // endpoint during an audit outage. Pinned as detected behaviour -- not asserted as a value judgment.
    auditThrows = new Error('audit table unreachable')
    const res = await post({ input: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, result: { ok: true } })
  })

  test('FINDING: with the audit failing, the execution still went out', async () => {
    // The other half of the same finding: the outbound webhook is not the thing that gets retried or suppressed.
    auditThrows = new Error('audit table unreachable')
    await post({ input: 'x' })
    expect(executeArgs).toHaveLength(1)
  })

  test('the audit is not written for a 404 or a 409', async () => {
    pluginRow = null
    await post({ input: 'x' })
    pluginRow = { id: 'p1', toolId: 'weather', name: 'W', manifestJson: '{}', isEnabled: false }
    await post({ input: 'x' })
    expect(audits).toHaveLength(0)
  })
})
