import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let appConfigExisting: { id: string } | null = { id: 'cfg-1' }

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async () => appConfigExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cfg-1',
        promptSettings: data.promptSettings,
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'cfg-2',
        promptSettings: data.promptSettings,
      }),
    },
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
