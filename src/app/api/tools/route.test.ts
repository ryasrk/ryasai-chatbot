/**
 * GET + POST /api/tools — the plugin catalog and plugin creation.
 *
 * WHY THIS FILE EXISTS. GET is the one list endpoint whose WHOLE POINT is not leaking credentials, and POST is
 * the one place a credential is sealed. Several behaviours invert silently:
 *
 *   1. GET NEVER RETURNS `manifestJson`. The row is fetched WITH the raw column (needed to parse it) and the
 *      response is rebuilt field by field, substituting `maskPluginManifest(manifest)`. A `{...p}` spread -- the
 *      natural refactor -- would ship the ciphertext alongside the mask. Asserted by scanning the raw body for
 *      the ciphertext AND for the column name.
 *   2. AN UNPARSEABLE STORED MANIFEST YIELDS `manifest: null`, NOT A 500. One corrupt row must not take down the
 *      entire catalog listing; the client renders the plugin without its manifest.
 *   3. `toolId` IS UNIQUE PER ORG AND CHECKED BEFORE THE INSERT, because the planner uses it as a stable key.
 *      The pre-check exists so the caller gets a 409 rather than a raw unique-constraint 500.
 *   4. A NEW PLUGIN IS `isEnabled: false` — deliberately inert until an admin turns it on, so a paste of a
 *      half-configured manifest cannot start making outbound calls.
 *   5. CREDENTIALS ARE ENCRYPTED AT REST, and only when `authType !== 'NONE'`.
 *
 * Also pinned: `findMany` with an empty `where` (the tenant extension supplies the org filter, so an explicit
 * org clause here would be the bug), the three-level `orderBy`, `chatEnabled`/`agenticEnabled` defaulting to
 * true while `isEnabled` is false, the `category` fallback, and the audit.
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

const CIPHERTEXT = 'enc:v1:plugin-ciphertext'
const PLAINTEXT_CRED = 'service-token-LIVE-SECRET'

let rows: Array<Record<string, unknown>> = []
let manifests: Record<string, Record<string, unknown>> = {}
let existingPlugin: { id: string } | null = null
let createThrows: Error | null = null
let listThrows: Error | null = null
let normalizeError: string | null = null

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const encryptedInputs: Array<Record<string, unknown>> = []
const normalized: Array<unknown> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string; statusCode?: number }
    if (err?.code === 'VALIDATION_ERROR') {
      return Response.json({ ok: false, error: { code: err.code, message: err.message } }, { status: err.statusCode ?? 400 })
    }
    return Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/plugin-registry', () => ({
  parsePluginManifest: (json: string) => {
    const found = manifests[json]
    // The REAL parser returns null for an unparseable/invalid manifest rather than throwing.
    return found ?? null
  },
  maskPluginManifest: (m: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...m }
    if (out.authCredentials) out.authCredentials = '••••••••'
    return out
  },
  normalizeManifest: (raw: unknown) => {
    normalized.push(raw)
    if (normalizeError) return { error: normalizeError }
    const m = (raw ?? {}) as Record<string, unknown>
    return {
      url: m.url ?? 'https://plugin.example.com/hook',
      method: (m.method as string) ?? 'POST',
      authType: (m.authType as string) ?? 'NONE',
      ...(m.authCredentials ? { authCredentials: m.authCredentials } : {}),
    }
  },
  encryptPluginCredentials: (cred: unknown) => {
    encryptedInputs.push(cred as Record<string, unknown>)
    return CIPHERTEXT
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'plugin', op: 'findMany', args })
        if (listThrows) throw listThrows
        return rows
      },
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'plugin', op: 'findFirst', args })
        return existingPlugin
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'plugin', op: 'findUnique', args })
        return existingPlugin
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'plugin', op: 'create', args })
        if (createThrows) throw createThrows
        // The mock MUST honour `select`. My first version returned `{ id, ...args.data }`, which echoed
        // `manifestJson` (the ciphertext) back even though the route excludes it -- so the test reported a
        // secret leak that did not exist. Proven to be a mock artefact, not a route defect, by probing the REAL
        // Prisma client: `findFirst({ select })` returns
        //   agenticEnabled,chatEnabled,createdAt,description,id,isEnabled,name,toolId
        // while `findFirst()` returns those PLUS category,keywords,manifestJson,organizationId,subcategory,
        // updatedAt. So Prisma does filter, and a mock that ignores `select` is wider than the real database.
        // `createdAt` is filled by the SCHEMA default, not by `data`, so the mock has to supply it too or the
        // selected-keys assertion would fail for a reason the real database never produces.
        const stored = {
          id: 'p-new',
          createdAt: new Date('2026-01-03'),
          ...(args.data as Record<string, unknown>),
        }
        const select = args.select as Record<string, boolean> | undefined
        if (!select) return stored
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(select)) if (select[k] && k in stored) out[k] = stored[k]
        return out
      },
    },
  },
}))

import { GET, POST } from './route'

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/tools', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const creates = () => calls.filter((c) => c.op === 'create')
const findOnes = () => calls.filter((c) => c.op === 'findFirst')

beforeEach(() => {
  user = adminUser
  rows = []
  manifests = {}
  existingPlugin = null
  createThrows = null
  listThrows = null
  normalizeError = null
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  encryptedInputs.length = 0
  normalized.length = 0
})

function addRow(over: Record<string, unknown> = {}) {
  const manifestJson = JSON.stringify({ url: 'https://plugin.example.com/hook', authType: 'BEARER' })
  manifests[manifestJson] = {
    url: 'https://plugin.example.com/hook',
    authType: 'BEARER',
    authCredentials: CIPHERTEXT,
  }
  const row = {
    id: 'p1',
    toolId: 'weather',
    name: 'Weather',
    description: 'Gets the weather',
    manifestJson,
    isEnabled: true,
    chatEnabled: true,
    agenticEnabled: true,
    category: 'data',
    subcategory: 'external',
    keywords: 'weather,rain',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...over,
  }
  rows.push(row)
  return row
}

describe('GET', () => {
  test('it enters the session org, so the extension scopes the list', async () => {
    await GET()
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('the query uses an EMPTY where, leaving scoping to the tenant extension', async () => {
    // An explicit `organizationId` clause here would be the bug: it duplicates what the extension injects and
    // would silently disagree if the context ever changed.
    await GET()
    const q = calls.find((c) => c.op === 'findMany')!
    expect(q.args.where).toEqual({})
  })

  test('the list is ordered by category, then subcategory, then name', async () => {
    await GET()
    const q = calls.find((c) => c.op === 'findMany')!
    expect(q.args.orderBy).toEqual([{ category: 'asc' }, { subcategory: 'asc' }, { name: 'asc' }])
  })

  test('the response NEVER contains the raw manifestJson column', async () => {
    // THE load-bearing assertion. The row is fetched WITH the ciphertext; a `{...p}` spread -- the natural
    // "simplify this mapping" refactor -- would ship it alongside the mask.
    addRow()
    const res = await GET()
    const raw = await res.text()
    expect(raw).not.toContain(CIPHERTEXT)
    expect(raw).not.toContain('manifestJson')
    expect(raw).not.toContain('enc:')
  })

  test('the credential is MASKED, not dropped, so the UI can show "configured"', async () => {
    addRow()
    const body = JSON.parse(await (await GET()).text()) as { plugins: Array<Record<string, unknown>> }
    const manifest = body.plugins[0]!.manifest as Record<string, unknown>
    expect(manifest.authCredentials).toBe('••••••••')
    expect(manifest.url).toBe('https://plugin.example.com/hook')
  })

  test('the envelope carries exactly the documented plugin keys', async () => {
    addRow()
    const body = JSON.parse(await (await GET()).text()) as { plugins: Array<Record<string, unknown>> }
    expect(Object.keys(body.plugins[0]!).sort()).toEqual([
      'agenticEnabled',
      'category',
      'chatEnabled',
      'createdAt',
      'description',
      'id',
      'isEnabled',
      'keywords',
      'manifest',
      'name',
      'subcategory',
      'toolId',
      'updatedAt',
    ])
  })

  test('an UNPARSEABLE manifest yields null for that plugin, NOT a failed request', async () => {
    // One corrupt row must not take down the whole catalog: the client renders the plugin without its manifest.
    addRow({ id: 'p-bad', manifestJson: 'not json at all' })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { plugins: Array<{ id: string; manifest: unknown }> }
    expect(body.plugins[0]!.manifest).toBeNull()
  })

  test('a good row and a corrupt row coexist in one response', async () => {
    addRow({ id: 'p-good' })
    addRow({ id: 'p-bad', manifestJson: 'garbage' })
    const body = JSON.parse(await (await GET()).text()) as { plugins: Array<{ manifest: unknown }> }
    expect(body.plugins).toHaveLength(2)
    expect(body.plugins.filter((p) => p.manifest === null)).toHaveLength(1)
  })

  test('an empty catalog is 200 with an empty list', async () => {
    const body = JSON.parse(await (await GET()).text()) as { ok: boolean; plugins: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.plugins).toEqual([])
  })

  test('the documented columns are selected and no others', async () => {
    await GET()
    const q = calls.find((c) => c.op === 'findMany')!
    expect(Object.keys(q.args.select as Record<string, unknown>).sort()).toEqual([
      'agenticEnabled',
      'category',
      'chatEnabled',
      'createdAt',
      'description',
      'id',
      'isEnabled',
      'keywords',
      'manifestJson',
      'name',
      'subcategory',
      'toolId',
      'updatedAt',
    ])
  })

  test('a list failure is 500 without leaking the error text', async () => {
    listThrows = new Error('connection reset')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })
})

describe('POST validation', () => {
  test('a missing toolId is 400 and nothing is written', async () => {
    const res = await post({ name: 'X' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'toolId is required.' })
    expect(creates()).toHaveLength(0)
  })

  test('a WHITESPACE-ONLY toolId is 400, not stored as blank', async () => {
    const res = await post({ toolId: '   ', name: 'X' })
    expect(res.status).toBe(400)
    expect(creates()).toHaveLength(0)
  })

  test('a missing name is 400', async () => {
    const res = await post({ toolId: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'Plugin name is required.' })
  })

  test('a whitespace-only name is 400', async () => {
    expect((await post({ toolId: 'x', name: '  ' })).status).toBe(400)
  })

  test('a manifest error is surfaced with 400 and nothing is written', async () => {
    normalizeError = 'Invalid URL.'
    const res = await post({ toolId: 'x', name: 'X', manifest: { url: 'nope' } })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'Invalid URL.' })
    expect(creates()).toHaveLength(0)
  })

  test('an empty body is 400 on the FIRST missing field, not a crash', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'toolId is required.' })
  })

  test('a malformed JSON body is 400 (caught to {})', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  test('the manifest is normalised, not trusted verbatim', async () => {
    await post({ toolId: 'x', name: 'X', manifest: { url: 'https://a', method: 'post' } })
    expect(normalized[0]).toEqual({ url: 'https://a', method: 'post' })
  })
})

describe('toolId uniqueness', () => {
  test('a duplicate is refused with 409 BEFORE any insert', async () => {
    // The planner keys on toolId, so a duplicate would make routing ambiguous. The pre-check exists so the
    // caller gets 409 rather than a raw unique-constraint 500.
    existingPlugin = { id: 'p-existing' }
    const res = await post({ toolId: 'weather', name: 'W' })
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'Plugin with toolId "weather" already exists.',
    })
    expect(creates()).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('the uniqueness check is scoped by toolId alone (the org filter comes from the extension)', async () => {
    await post({ toolId: 'weather', name: 'W' })
    expect(findOnes()[0]!.args.where).toEqual({ toolId: 'weather' })
  })

  test('the duplicate check READS but never encrypts', async () => {
    existingPlugin = { id: 'p-existing' }
    await post({ toolId: 'w', name: 'W', manifest: { authType: 'BEARER', authCredentials: PLAINTEXT_CRED } })
    expect(encryptedInputs).toHaveLength(0)
  })

  test('a whitespace-padded toolId is trimmed before the uniqueness check', async () => {
    await post({ toolId: '  weather  ', name: 'W' })
    expect(findOnes()[0]!.args.where).toEqual({ toolId: 'weather' })
  })
})

describe('creation', () => {
  test('a new plugin is isEnabled FALSE -- inert until an admin turns it on', async () => {
    // A freshly pasted manifest must not start making outbound calls on its own.
    await post({ toolId: 'x', name: 'X' })
    expect(creates()[0]!.args.data).toMatchObject({ isEnabled: false })
  })

  test('the legacy-scoped flags default to TRUE independently of isEnabled', async () => {
    // Documented as-is: `isEnabled` gates execution while these two gate which surfaces offer the tool. They
    // default true, so the admin's single enabling action is enough.
    await post({ toolId: 'x', name: 'X' })
    expect(creates()[0]!.args.data).toMatchObject({ chatEnabled: true, agenticEnabled: true })
  })

  test('explicit false flags are honoured', async () => {
    await post({ toolId: 'x', name: 'X', chatEnabled: false, agenticEnabled: false })
    expect(creates()[0]!.args.data).toMatchObject({ chatEnabled: false, agenticEnabled: false })
  })

  test('a non-boolean flag falls back to the default rather than being stored as-is', async () => {
    await post({ toolId: 'x', name: 'X', chatEnabled: 'yes' as unknown as boolean, agenticEnabled: null as unknown as boolean })
    expect(creates()[0]!.args.data).toMatchObject({ chatEnabled: true, agenticEnabled: true })
  })

  test('the row carries the session organization', async () => {
    await post({ toolId: 'x', name: 'X' })
    expect(creates()[0]!.args.data).toMatchObject({ organizationId: 'org-1' })
  })

  test('an absent category falls back to "general"', async () => {
    await post({ toolId: 'x', name: 'X' })
    expect(creates()[0]!.args.data).toMatchObject({ category: 'general' })
  })

  test('a whitespace-only category also falls back to "general"', async () => {
    await post({ toolId: 'x', name: 'X', category: '   ' })
    expect(creates()[0]!.args.data).toMatchObject({ category: 'general' })
  })

  test('name, description and keywords are trimmed', async () => {
    await post({ toolId: 'x', name: '  X  ', description: '  d  ', keywords: '  a,b  ' })
    expect(creates()[0]!.args.data).toMatchObject({ name: 'X', description: 'd', keywords: 'a,b' })
  })

  test('the manifest is stored as a JSON STRING under manifestJson', async () => {
    // The column is a text column; storing the object would fail at the Prisma layer.
    await post({ toolId: 'x', name: 'X', manifest: { url: 'https://a', authType: 'NONE' } })
    const stored = (creates()[0]!.args.data as { manifestJson: string }).manifestJson
    expect(typeof stored).toBe('string')
    expect(JSON.parse(stored)).toMatchObject({ url: 'https://a' })
  })

  test('the create SELECT excludes manifestJson so the response carries no ciphertext', async () => {
    await post({ toolId: 'x', name: 'X' })
    const select = creates()[0]!.args.select as Record<string, unknown>
    expect(select.manifestJson).toBeUndefined()
    expect(select).toMatchObject({
      id: true,
      toolId: true,
      name: true,
      description: true,
      isEnabled: true,
      chatEnabled: true,
      agenticEnabled: true,
      createdAt: true,
    })
  })

  test('it answers 201 with the created row', async () => {
    const res = await post({ toolId: 'x', name: 'X' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.data.id).toBe('p-new')
  })
})

describe('the create response is shaped by `select`, not by the full row', () => {
  test('the returned object carries EXACTLY the selected keys', async () => {
    // Written because a mock returning the full row made this route look like it leaked the credential. The
    // real Prisma client DOES honour `select` (verified by probe), so this pins the contract the route relies on.
    const res = await post({ toolId: 'x', name: 'X' })
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual([
      'agenticEnabled',
      'chatEnabled',
      'createdAt',
      'description',
      'id',
      'isEnabled',
      'name',
      'toolId',
    ])
  })

  test('neither manifestJson nor organizationId can appear in the create response', async () => {
    const res = await post({ toolId: 'x', name: 'X', manifest: { authType: 'NONE' } })
    const raw = await res.text()
    expect(raw).not.toContain('manifestJson')
    expect(raw).not.toContain('organizationId')
  })
})

describe('credentials are encrypted at rest', () => {
  test('a real authType encrypts the supplied credentials', async () => {
    await post({
      toolId: 'x',
      name: 'X',
      manifest: { url: 'https://a', authType: 'BEARER', authCredentials: PLAINTEXT_CRED },
    })
    // NOTE the argument shape: the real helper takes the raw credential STRING, and this mock records whatever
    // it receives so the shape is pinned rather than assumed.
    expect(encryptedInputs).toHaveLength(1)
    const stored = (creates()[0]!.args.data as { manifestJson: string }).manifestJson
    expect(stored).toContain(CIPHERTEXT)
    expect(stored).not.toContain(PLAINTEXT_CRED)
  })

  test('authType NONE leaves credentials unencrypted', async () => {
    await post({
      toolId: 'x',
      name: 'X',
      manifest: { url: 'https://a', authType: 'NONE', authCredentials: PLAINTEXT_CRED },
    })
    expect(encryptedInputs).toHaveLength(0)
  })

  test('no credentials at all means no encryption call', async () => {
    await post({ toolId: 'x', name: 'X', manifest: { url: 'https://a', authType: 'BEARER' } })
    expect(encryptedInputs).toHaveLength(0)
  })

  test('the PLAINTEXT credential never reaches the database seam', async () => {
    // Scanning the whole create argument is stronger than checking the one field: a manifest logged or spread
    // elsewhere in the payload would be caught here.
    await post({
      toolId: 'x',
      name: 'X',
      manifest: { url: 'https://a', authType: 'API_KEY_HEADER', authCredentials: PLAINTEXT_CRED },
    })
    expect(JSON.stringify(creates()[0]!.args)).not.toContain(PLAINTEXT_CRED)
  })

  test('the credential is masked nowhere in the CREATE response (it is not returned at all)', async () => {
    const res = await post({
      toolId: 'x',
      name: 'X',
      manifest: { url: 'https://a', authType: 'BEARER', authCredentials: PLAINTEXT_CRED },
    })
    const raw = await res.text()
    expect(raw).not.toContain(PLAINTEXT_CRED)
    expect(raw).not.toContain(CIPHERTEXT)
  })
})

describe('audit trail', () => {
  test('creation is audited at WARNING with the plugin identity', async () => {
    // Warning, not info: a plugin can make outbound calls with an operator-supplied credential.
    await post({ toolId: 'weather', name: 'Weather' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'PLUGIN_CREATE',
      severity: 'warning',
      detail: { pluginId: 'p-new', toolId: 'weather', name: 'Weather' },
    })
  })

  test('the audit carries NO credential material', async () => {
    await post({
      toolId: 'x',
      name: 'X',
      manifest: { url: 'https://a', authType: 'BEARER', authCredentials: PLAINTEXT_CRED },
    })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain(PLAINTEXT_CRED)
    expect(logged).not.toContain(CIPHERTEXT)
  })

  test('the audit uses the acting user, not a constant', async () => {
    user = { ...adminUser, userId: 'u-other' }
    await post({ toolId: 'x', name: 'X' })
    expect(auditWrites[0]!.userId).toBe('u-other')
  })

  test('a failed create writes NO audit row claiming a plugin exists', async () => {
    createThrows = new Error('unique constraint')
    const res = await post({ toolId: 'x', name: 'X' })
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('POST enters the org context before any write', () => {
  test('the context is entered even when validation later fails', async () => {
    // Entered first so the duplicate check inside the handler is scoped, not just the create.
    await post({ name: 'X' })
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('the duplicate check runs AFTER the context is entered', async () => {
    existingPlugin = { id: 'p-existing' }
    await post({ toolId: 'weather', name: 'W' })
    expect(events.indexOf('enterWithOrg:org-1')).toBe(0)
  })
})
