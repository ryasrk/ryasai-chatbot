/**
 * GET + PATCH + DELETE /api/tools/[id] — a plugin row, including its webhook credentials.
 *
 * WHY THIS FILE EXISTS. This is one of two routes the 2026-09 audit called out for CROSS-TENANT IDOR
 * (`api/mcp/servers/[id]` was the other): a plugin id is handed to the browser by the list route, so an
 * org-A user holds real ids that would resolve in org B's context. The fix is that every load uses
 * `findFirst` (org-scoped by the tenant extension) -- never `findUnique`, which the extension cannot scope.
 * The first test below asserts the WHERE SHAPE, because that is precisely what regressed before, and
 * `findFirst` vs `findUnique` is invisible in a happy-path test.
 *
 * Second property: THE CREDENTIAL ROUND-TRIP.
 *   - GET must return the MASKED manifest. A plugin's `authCredentials` hold a live secret.
 *   - PATCH must PRESERVE the stored ciphertext when the editor sends no new value, because the UI renders
 *     credentials as bullets and submits nothing back. Treating that as "clear the secret" would break every
 *     outbound plugin call on an unrelated rename.
 *   - A NEWLY supplied secret must be ENCRYPTED before storage, never written in the clear.
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

const PLAINTEXT_SECRET = 'whsec_LIVE_SUPERSECRET'

let pluginRow: Record<string, unknown> | null = null
let deleteCount = 1
let updateThrows: Error | null = null

const pluginCalls: Array<{ op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const encryptedInputs: string[] = []
let normalizeError: string | null = null
/** When set, the first plugin load throws -- to exercise each handler's catch block. */
let loadThrows: Error | null = null
let maskedOutput: Record<string, unknown> | null = null

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findFirst: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        return pluginRow
      },
      // Present so a regression to findUnique is an OBSERVABLE failure rather than a crash.
      findUnique: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'findUnique', args })
        return pluginRow
      },
      update: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'update', args })
        if (updateThrows) throw updateThrows
        return {
          id: 'p1',
          toolId: 'weather',
          name: 'Weather',
          description: '',
          isEnabled: true,
          chatEnabled: true,
          agenticEnabled: false,
          updatedAt: new Date(),
        }
      },
      deleteMany: async (args: Record<string, unknown>) => {
        pluginCalls.push({ op: 'deleteMany', args })
        return { count: deleteCount }
      },
    },
  },
  isPrismaNotFound: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2025',
}))

mock.module('@/lib/plugin-registry', () => ({
  parsePluginManifest: (raw: string | null) => {
    if (!raw) return null
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  },
  maskPluginManifest: (m: Record<string, unknown>) => {
    if (maskedOutput) return maskedOutput
    return { ...m, authCredentials: m.authCredentials ? '••••••••' : undefined }
  },
  normalizeManifest: (m: Record<string, unknown>) => {
    if (normalizeError) return { error: normalizeError }
    return { ...m }
  },
  encryptPluginCredentials: (c: string) => {
    encryptedInputs.push(c)
    return `enc:${Buffer.from(String(c)).toString('base64url')}`
  },
}))

import { GET, PATCH, DELETE } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/tools/p1', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    ctx('p1'),
  )
}

function storedManifest(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    toolId: 'weather',
    url: 'https://api.example.com/weather',
    method: 'GET',
    authType: 'HEADER',
    authCredentials: 'enc:STORED-CIPHERTEXT',
    ...over,
  })
}

beforeEach(() => {
  user = adminUser
  pluginRow = {
    id: 'p1',
    toolId: 'weather',
    name: 'Weather',
    description: '',
    isEnabled: true,
    chatEnabled: true,
    agenticEnabled: false,
    organizationId: 'org-1',
    manifestJson: storedManifest(),
  }
  deleteCount = 1
  updateThrows = null
  pluginCalls.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  encryptedInputs.length = 0
  normalizeError = null
  maskedOutput = null
  loadThrows = null
})

describe('the cross-tenant IDOR fix: findFirst, never findUnique', () => {
  test('GET loads the plugin with findFirst (a findUnique regression is INVISIBLE to a happy path)', async () => {
    // The 2026-09 audit: `api/mcp/servers/[id]` and this route were both exploitable by id. findUnique is NOT
    // org-scoped, and ids ARE returned to the browser by the list route, so the "cuid ids are unguessable"
    // rationale was false. Asserted on the OPERATION, not the result.
    await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    const loads = pluginCalls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads).toHaveLength(1)
    expect(loads[0]!.op).toBe('findFirst')
    expect(loads[0]!.args.where).toEqual({ id: 'p1' })
  })

  test('PATCH loads the plugin with findFirst', async () => {
    await patch({ name: 'New' })
    const loads = pluginCalls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads.length).toBeGreaterThanOrEqual(1)
    for (const l of loads) expect(l.op).toBe('findFirst')
  })

  test('DELETE loads with findFirst AND deletes with deleteMany (which the extension DOES scope)', async () => {
    // deleteMany is org-scoped by the extension; delete({where:{id}}) is not reached here on purpose.
    await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(pluginCalls.find((c) => c.op === 'findFirst')).toBeDefined()
    const del = pluginCalls.find((c) => c.op === 'deleteMany')
    expect(del).toBeDefined()
    expect(del!.args.where).toEqual({ id: 'p1' })
  })

  test('all three handlers enter the session org context', async () => {
    await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    await patch({ name: 'N' })
    await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(enteredOrgs).toEqual(['org-1', 'org-1', 'org-1'])
  })
})

describe('GET returns the MASKED manifest', () => {
  test('DEFECT (pinned): the raw manifestJson IS sent to the client alongside the mask', async () => {
    // FOUND WHILE WRITING THIS FILE, NOT FIXED -- pinned so the fix is deliberate.
    //
    // GET spreads the whole row (`...plugin`) and only then attaches a MASKED `manifest` sibling. The row's
    // `manifestJson` column therefore ships verbatim, so the response carries the manifest TWICE: once
    // masked, once raw. Live ciphertext confirmed in the body:
    //   {"ok":true,"plugin":{"id":"p1",...,"manifestJson":"{\"authCredentials\":\"enc:SECRET\"}",
    //    "manifest":{"authCredentials":"••••"}}}
    //
    // IMPACT, stated honestly: this exposes the AES-256-GCM CIPHERTEXT, not the plaintext, so it is NOT
    // equivalent to leaking the key. It is still a disclosure the masking exists to prevent -- ciphertext
    // plus a future key compromise retro-decrypts it, and the response has to be re-read to understand why
    // the secret it shows is not the secret it also ships. `manifest` (masked) is the intended surface.
    //
    // This test asserts the CURRENT behaviour, so when the leak is fixed IT TURNS RED and must be inverted.
    // The mask test below covers the intended behaviour and stays green either way.
    const res = await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    const raw = await res.text()
    expect(raw).toContain('manifestJson')
    expect(raw).toContain('STORED-CIPHERTEXT')
  })

  test('the MASKED manifest never contains the stored credential', async () => {
    // The property that must hold regardless of the defect above: whatever else the payload carries, the
    // `manifest` object itself is masked.
    const res = await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    const body = (await res.json()) as { plugin: { manifest: Record<string, unknown> } }
    expect(JSON.stringify(body.plugin.manifest)).not.toContain('STORED-CIPHERTEXT')
    expect(body.plugin.manifest.authCredentials).toBe('••••••••')
  })

  test('a mask is returned in its place', async () => {
    const res = await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    const body = (await res.json()) as { plugin: { manifest: Record<string, unknown> } }
    expect(body.plugin.manifest.authCredentials).toBe('••••••••')
  })

  test('an unparseable manifest yields manifest: null rather than a 500', async () => {
    // A row written by an older version, or hand-edited, must not take the plugin list down.
    pluginRow!.manifestJson = 'not json'
    const res = await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { plugin: { manifest: unknown } }).plugin.manifest).toBeNull()
  })

  test('a missing plugin is 404', async () => {
    pluginRow = null
    expect((await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))).status).toBe(404)
  })
})

describe('PATCH preserves the credential when the editor sends none', () => {
  test('a manifest with NO new credentials keeps the STORED ciphertext value', async () => {
    // The UI masks credentials as bullets and submits nothing back, so this is the normal edit path. Writing
    // an empty credential would silently break every outbound call for this plugin.
    await patch({ manifest: { toolId: 'weather', url: 'https://api.example.com/v2', authType: 'HEADER' } })
    const w = pluginCalls.find((c) => c.op === 'update')!
    const written = JSON.parse((w.args.data as { manifestJson: string }).manifestJson) as {
      authCredentials?: string
    }
    expect(written.authCredentials).toBe('enc:STORED-CIPHERTEXT')
    expect(encryptedInputs).toHaveLength(0)
  })

  test('a NEW credential is encrypted, and the plaintext never reaches the DB', async () => {
    await patch({
      manifest: {
        toolId: 'weather',
        url: 'https://api.example.com/v2',
        authType: 'HEADER',
        authCredentials: PLAINTEXT_SECRET,
      },
    })
    // The argument is the RAW credential STRING, not an object -- verified against the real call site, since
    // my first assertion assumed a shape the route never passes.
    expect(encryptedInputs).toEqual([PLAINTEXT_SECRET])
    const w = pluginCalls.find((c) => c.op === 'update')!
    const raw = JSON.stringify(w.args)
    expect(raw).not.toContain(PLAINTEXT_SECRET)
    const written = JSON.parse((w.args.data as { manifestJson: string }).manifestJson) as {
      authCredentials: string
    }
    expect(written.authCredentials).toMatch(/^enc:/)
  })

  test('a NONE authType does not carry credentials forward and does not encrypt', async () => {
    // The guard is `authType !== 'NONE'` on both branches. Carrying a secret onto an authType NONE manifest
    // would leave a live credential in a row that no longer uses it.
    await patch({ manifest: { toolId: 'weather', url: 'https://api.example.com/v2', authType: 'NONE' } })
    const w = pluginCalls.find((c) => c.op === 'update')!
    const written = JSON.parse((w.args.data as { manifestJson: string }).manifestJson) as {
      authCredentials?: string
    }
    expect(written.authCredentials).toBeUndefined()
    expect(encryptedInputs).toHaveLength(0)
  })

  test('DEFECT (pinned): a stray credential on authType NONE is stored in PLAINTEXT', async () => {
    // FOUND WHILE WRITING THIS FILE, NOT FIXED -- pinned so the fix is deliberate.
    //
    // The route's two guards are `authType !== 'NONE'`. That correctly stops it from CARRYING a secret
    // forward and from ENCRYPTING one -- but when authType IS 'NONE' and the editor nevertheless sent
    // `authCredentials`, the value is neither encrypted nor removed. It is written to `manifestJson`
    // verbatim, so a live webhook secret lands in the database in the clear.
    //
    // The failure mode is a stale UI or a hand-crafted body, so it is a low-frequency path rather than the
    // normal one. The fix is one `else` branch: when authType is 'NONE', delete `authCredentials`. As with
    // the GET leak, this test asserts the CURRENT behaviour and will turn red on the fix.
    await patch({
      manifest: {
        toolId: 'weather',
        url: 'https://api.example.com/v2',
        authType: 'NONE',
        authCredentials: PLAINTEXT_SECRET,
      },
    })
    expect(encryptedInputs).toHaveLength(0)
    const w = pluginCalls.find((c) => c.op === 'update')!
    const written = JSON.parse((w.args.data as { manifestJson: string }).manifestJson) as {
      authCredentials?: string
    }
    expect(written.authCredentials).toBe(PLAINTEXT_SECRET)
  })

  test('an INVALID manifest is 400 and nothing is written', async () => {
    normalizeError = 'Blocked host'
    const res = await patch({ manifest: { toolId: 'x', url: 'http://169.254.169.254/' } })
    expect(res.status).toBe(400)
    expect(pluginCalls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('a previous manifest with NO credentials leaves the new one without credentials', async () => {
    pluginRow!.manifestJson = storedManifest({ authCredentials: undefined })
    await patch({ manifest: { toolId: 'weather', url: 'https://api.example.com/v2', authType: 'HEADER' } })
    const w = pluginCalls.find((c) => c.op === 'update')!
    const written = JSON.parse((w.args.data as { manifestJson: string }).manifestJson) as {
      authCredentials?: string
    }
    expect(written.authCredentials).toBeUndefined()
  })
})

describe('PATCH field handling', () => {
  test('only supplied fields are written', async () => {
    // A partial update must not blank the columns it did not mention -- `undefined` in Prisma means "leave
    // alone", but an explicit '' would clear the column.
    await patch({ isEnabled: false })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.data).toEqual({ isEnabled: false })
  })

  test('all six boolean/string toggles can be set independently', async () => {
    await patch({
      name: 'Weather v2',
      description: 'desc',
      isEnabled: false,
      chatEnabled: false,
      agenticEnabled: true,
      category: 'data',
      keywords: 'weather,rain',
    })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.data).toEqual({
      name: 'Weather v2',
      description: 'desc',
      isEnabled: false,
      chatEnabled: false,
      agenticEnabled: true,
      category: 'data',
      keywords: 'weather,rain',
    })
  })

  test('a whitespace-only name is IGNORED rather than clearing the name', async () => {
    await patch({ name: '   ', isEnabled: true })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.data).not.toHaveProperty('name')
  })

  test('strings are trimmed', async () => {
    await patch({ name: '  Padded  ', category: '  cat  ', keywords: '  a,b  ' })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.data).toMatchObject({ name: 'Padded', category: 'cat', keywords: 'a,b' })
  })

  test('an EMPTY description IS applied (it is a legitimate way to clear it)', async () => {
    // Unlike name, an empty description is meaningful -- and the guard is `typeof === 'string'`, not truthiness.
    await patch({ description: '' })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.data).toEqual({ description: '' })
  })

  test('a WRONG-TYPED field is ignored rather than coerced', async () => {
    // `"false"` (string) must not be written as a boolean; Prisma would either reject it or store truthy.
    await patch({ isEnabled: 'false', chatEnabled: 1, name: 42, keywords: null })
    expect(pluginCalls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('an empty body is 400, not a silent no-op', async () => {
    const res = await patch({})
    expect(res.status).toBe(400)
    expect(pluginCalls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('a malformed JSON body is 400', async () => {
    expect((await patch('not json')).status).toBe(400)
  })

  test('a missing plugin is 404 before any write', async () => {
    pluginRow = null
    const res = await patch({ name: 'X' })
    expect(res.status).toBe(404)
    expect(pluginCalls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('a concurrent delete (P2025) is reported as 404, not a 500', async () => {
    // The row can vanish between the load and the update. `isPrismaNotFound` turns that race into a clean 404.
    const e = new Error('not found') as Error & { code?: string }
    e.code = 'P2025'
    updateThrows = e
    const res = await patch({ name: 'X' })
    expect(res.status).toBe(404)
  })

  test('a non-P2025 update error propagates', async () => {
    updateThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })

  test('the update selects an explicit field set (no credential columns back to the client)', async () => {
    await patch({ name: 'X' })
    const w = pluginCalls.find((c) => c.op === 'update')!
    expect(w.args.select).toMatchObject({
      id: true,
      toolId: true,
      name: true,
      description: true,
      isEnabled: true,
      chatEnabled: true,
      agenticEnabled: true,
      updatedAt: true,
    })
    expect((w.args.select as Record<string, unknown>).manifestJson).toBeUndefined()
  })

  test('the audit records the CHANGES, and no credential material', async () => {
    await patch({
      name: 'X',
      manifest: {
        toolId: 'weather',
        url: 'https://api.example.com/v2',
        authType: 'HEADER',
        authCredentials: PLAINTEXT_SECRET,
      },
    })
    expect(auditWrites[0]).toMatchObject({ userId: 'u1', action: 'PLUGIN_UPDATE', severity: 'info' })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain(PLAINTEXT_SECRET)
    // The change log DOES include the new manifest JSON, so the ciphertext form is what may appear -- never
    // the plaintext, which is what the assertion above pins.
    expect((auditWrites[0]!.detail as { toolId: string }).toolId).toBe('weather')
  })
})

describe('DELETE', () => {
  test('a successful delete is audited at WARNING with the identifying fields', async () => {
    // Severity warning, not info: removing a plugin removes a capability, and the audit must let an operator
    // see which one went and what it was called.
    await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'PLUGIN_DELETE',
      severity: 'warning',
      detail: { id: 'p1', toolId: 'weather', name: 'Weather' },
    })
  })

  test('it answers { ok: true, deleted: true }', async () => {
    const res = await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(await res.json()).toEqual({ ok: true, deleted: true })
  })

  test('a missing plugin is 404 with no audit', async () => {
    pluginRow = null
    const res = await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })

  test('a delete losing a race (count 0) is 404 AND not audited', async () => {
    // Auditing a delete that removed nothing would fabricate a security event.
    deleteCount = 0
    const res = await DELETE(new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never, ctx('p1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('each handler maps an internal failure to the typed error response', () => {
  // These three tests exist to reach the catch blocks, which the happy paths never touch. Each asserts the
  // status AND that the raw error text does not reach the client.
  test('GET reports a load failure as 500 without leaking the error text', async () => {
    loadThrows = new Error('connection reset')
    const res = await GET(new Request('http://localhost/api/tools/p1') as never, ctx('p1'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('PATCH reports a load failure as 500', async () => {
    loadThrows = new Error('connection reset')
    const res = await patch({ name: 'X' })
    expect(res.status).toBe(500)
  })

  test('DELETE reports a load failure as 500', async () => {
    loadThrows = new Error('connection reset')
    const res = await DELETE(
      new Request('http://localhost/api/tools/p1', { method: 'DELETE' }) as never,
      ctx('p1'),
    )
    expect(res.status).toBe(500)
  })
})
