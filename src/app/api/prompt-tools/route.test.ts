import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let appConfigExisting: { id: string } | null = { id: 'cfg-1' }
let createCalls: Array<{ data: Record<string, unknown> }> = []
/** When set, getPromptSettings rejects -- to exercise the catch blocks. */
let promptSettingsError: Error | null = null

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async () => appConfigExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cfg-1',
        promptSettings: data.promptSettings,
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createCalls.push({ data })
        return { id: 'cfg-2', promptSettings: data.promptSettings }
      },
    },
  },
}))
mock.module('@/lib/prompt-settings', () => ({
  // Two jobs: let the route be told to FAIL, and otherwise return the SAME empty defaults the real
  // parsePromptSettings produces (an absent key resolves to '', never undefined). An earlier version
  // of this stub returned a non-empty ragContextPrompt, which contradicted the real module's
  // documented backward-compat behaviour and broke three pre-existing tests.
  getPromptSettings: async () => {
    if (promptSettingsError) throw promptSettingsError
    return { systemPrompt: '', ragContextPrompt: '', tools: { rag: true, sql: true, restApi: true } }
  },
  mergePromptSettings: (cur: Record<string, unknown>, upd: Record<string, unknown>) => {
    const merged = { ...cur, ...upd } as Record<string, unknown>
    // Mirror the real merge: only the fields the caller actually sent are replaced, and non-string
    // ragContextPrompt is ignored (the real module guards with `typeof ... === 'string'`).
    if (typeof upd.ragContextPrompt !== 'string') merged.ragContextPrompt = cur.ragContextPrompt
    return merged
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => getActiveUserImpl(),
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) throw new Error('Forbidden')
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditCalls.push(args)
  },
  handleApiError: (e: unknown, fallback: string) =>
    new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: e instanceof Error ? e.message : fallback } }),
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 },
    ),
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))

const { GET, PUT } = await import('./route')

function put(body: unknown): Promise<Response> {
  const req = new Request('http://localhost/api/prompt-tools', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  return PUT(req as never)
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  appConfigExisting = { id: 'cfg-1' }
  createCalls = []
  promptSettingsError = null
})

describe('PUT /api/prompt-tools ragContextPrompt', () => {
  test('ragContextPrompt persisted + returned', async () => {
    const res = await put({ ragContextPrompt: 'prefer SOP-7' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.settings.ragContextPrompt).toBe('prefer SOP-7')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('PROMPT_TOOLS_UPDATE')
    expect((auditCalls[0].detail as Record<string, unknown>).ragContextPromptLength).toBe(12)
  })

  test('empty string allowed (clears the prompt)', async () => {
    const res = await put({ ragContextPrompt: '' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings.ragContextPrompt).toBe('')
  })

  test('existing systemPrompt path still works', async () => {
    const res = await put({ systemPrompt: 'be concise' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings.systemPrompt).toBe('be concise')
    expect(json.settings.ragContextPrompt).toBe('')
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await put({ ragContextPrompt: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await put({ ragContextPrompt: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})

describe('GET /api/prompt-tools', () => {
  test('returns full settings including ragContextPrompt', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(typeof json.settings.ragContextPrompt).toBe('string')
  })

  test('enters org context (tenant guard)', async () => {
    await GET()
    expect(enterCalls).toEqual(['org-1'])
  })
})

// ---------------------------------------------------------------------------
// The branches the original file never reached: GET entirely, the FIRST-WRITE
// path (no AppConfig row yet), and both routes' catch blocks.
// ---------------------------------------------------------------------------

describe('GET /api/prompt-tools', () => {
  test('returns the full settings object', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; settings: Record<string, unknown> }
    expect(body.ok).toBe(true)
    // ragContextPrompt must be PRESENT (not undefined): the whole point of the GET is that the
    // editor can read back what PUT stored, and a dropped field makes the UI look like the save
    // failed. The stub returns the real module's empty default here.
    expect(body.settings.ragContextPrompt).toBe('')
    expect(body.settings).toHaveProperty('tools')
  })

  test('enters the org context BEFORE reading settings', async () => {
    await GET()
    expect(enterCalls).toContain('org-1')
  })

  test('a read failure is routed through handleApiError', async () => {
    // The catch had never executed. Without it a DB outage surfaces as an unhandled rejection
    // rather than a typed error the UI can render.
    promptSettingsError = new Error('db is down')
    const res = await GET()
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error).toBeDefined()
  })
})

describe('PUT /api/prompt-tools — the FIRST write (no AppConfig row yet)', () => {
  test('creates the row when none exists, scoped to the caller org', async () => {
    // The `else` branch: a fresh install has no AppConfig row, so a save must CREATE one. If this
    // path regressed, the very first prompt save on a new install would throw on update-by-id and
    // the admin would be unable to configure prompts at all.
    appConfigExisting = null
    const res = await put({ systemPrompt: 'first ever save' })
    expect(res.status).toBe(200)

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]!.data.organizationId).toBe('org-1')
    const stored = JSON.parse(createCalls[0]!.data.promptSettings as string) as Record<string, unknown>
    expect(stored.systemPrompt).toBe('first ever save')
  })

  test('a save failure is routed through handleApiError', async () => {
    promptSettingsError = new Error('write failed')
    const res = await put({ systemPrompt: 'x' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error).toBeDefined()
  })
})
