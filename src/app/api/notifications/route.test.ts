import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockUser = { userId: 'u1', name: 'Test', email: 't@t.com', role: 'admin', organizationId: 'org-default' }

let findManyResult: any[] = []
let createData: any = null
let createResult: any = {}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) => Response.json({ error: msg }, { status }),
  writeAudit: async () => {},
}))

mock.module('@/lib/crypto', () => ({
  encryptConfig: (config: Record<string, unknown>) => 'enc_' + JSON.stringify(config),
  decryptConfig: (hex: string) => (typeof hex === 'string' && hex.startsWith('enc_') ? JSON.parse(hex.slice(4)) : {}),
  maskConfig: (config: Record<string, unknown>) => config,
}))

mock.module('@/lib/db', () => ({
  db: {
    notificationConfig: {
      findMany: async () => findManyResult,
      create: async (args: any) => {
        createData = args.data
        return createResult
      },
    },
  },
}))

import { GET, POST } from './route'

beforeEach(() => {
  findManyResult = []
  createData = null
  createResult = {
    id: 'n1',
    name: 'My Webhook',
    type: 'webhook',
    encryptedConfig: 'enc_{"type":"webhook","url":"https://example.com/hook"}',
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
})

describe('GET /api/notifications', () => {
  test('returns list without encryptedConfig', async () => {
    findManyResult = [
      {
        id: 'n1',
        name: 'My Webhook',
        type: 'webhook',
        encryptedConfig: 'enc_{"type":"webhook","url":"https://x.com/h"}',
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.configs).toHaveLength(1)
    expect(body.configs[0].encryptedConfig).toBeUndefined()
    expect(body.configs[0].configured).toBe(true)
    expect(body.configs[0].maskedConfig).toBeDefined()
  })
})

describe('POST /api/notifications', () => {
  test('creates config with valid data', async () => {
    const req = new Request('http://localhost/api/notifications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'My Webhook',
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
      }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(createData.name).toBe('My Webhook')
    expect(createData.type).toBe('webhook')
    expect(createData.isActive).toBe(true)
  })

  test('returns 400 for invalid type', async () => {
    const req = new Request('http://localhost/api/notifications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad',
        type: 'carrier-pigeon',
        config: { x: 1 },
      }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  test('returns 400 when required fields are missing', async () => {
    const req = new Request('http://localhost/api/notifications', {
      method: 'POST',
      body: JSON.stringify({ type: 'webhook' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })
})
