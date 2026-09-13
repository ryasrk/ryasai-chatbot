/**
 * GET + PATCH + DELETE /api/notifications/[id] — a notification channel and its credentials.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog, and this row holds a live credential (a Telegram bot token, a
 * webhook signing secret, or SMTP auth). Two things here are subtle enough to have been wrong without a test:
 *
 *   1. `type` IS PACKED INTO THE ENCRYPTED BLOB. So changing the type alone must RE-ENCRYPT the blob with the
 *      new type while keeping the existing credentials, and supplying a new config must encrypt
 *      `{ type, ...config }` -- if the type were kept outside the blob, `sendNotification` would dispatch on
 *      a type that disagrees with the stored credentials.
 *   2. A CORRUPT BLOB MUST NOT BRICK THE EDIT FORM. The re-pack path catches its own decrypt failure and
 *      leaves the blob alone so the operator can still PATCH a name or toggle `isActive`. The mask path has
 *      the same shape: an undecryptable row returns `configured: false` rather than a 500.
 *
 * Also pinned: every load uses `findFirst` (the cross-tenant IDOR class -- ids are handed to the browser by
 * the list route), the mask never leaks the ciphertext, the type whitelist, and the audit trail.
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

const PLAINTEXT_TOKEN = '123456:AAF-LIVE-BOT-TOKEN'
const CIPHERTEXT = 'enc:STORED-CIPHERTEXT'

let row: Record<string, unknown> | null = null
let deleteCount = 1
let updateThrows: Error | null = null
let loadThrows: Error | null = null
let decryptFails = false

const calls: Array<{ op: string; args: Record<string, unknown> }> = []
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

mock.module('@/lib/crypto', () => ({
  // The real blob is JSON with the type packed in; keeping that shape is what makes the re-pack testable.
  encryptConfig: (o: Record<string, unknown>) => {
    encryptedInputs.push(o)
    return `enc:${JSON.stringify(o)}`
  },
  decryptConfig: (blob: string) => {
    if (decryptFails) throw new Error('bad tag')
    if (!blob.startsWith('enc:')) throw new Error('not a blob')
    return JSON.parse(blob.slice(4)) as Record<string, unknown>
  },
  maskConfig: (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      out[k] = k === 'type' ? v : typeof v === 'string' && v ? '••••••••' : v
    }
    return out
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    notificationConfig: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        return row
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ op: 'findUnique', args })
        return row
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ op: 'update', args })
        if (updateThrows) throw updateThrows
        // The route masks the UPDATED row, so the mock must return a full row including the blob.
        return { ...row, ...(args.data as Record<string, unknown>) }
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ op: 'deleteMany', args })
        return { count: deleteCount }
      },
    },
  },
  isPrismaNotFound: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2025',
}))

import { GET, PATCH, DELETE } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/notifications/n1', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    ctx('n1'),
  )
}

beforeEach(() => {
  user = adminUser
  row = {
    id: 'n1',
    name: 'Ops webhook',
    type: 'webhook',
    encryptedConfig: `enc:${JSON.stringify({ type: 'webhook', url: 'https://hooks.example.com/x', secret: PLAINTEXT_TOKEN })}`,
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  }
  deleteCount = 1
  updateThrows = null
  loadThrows = null
  decryptFails = false
  calls.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  encryptedInputs.length = 0
})

describe('the IDOR class: findFirst, never findUnique', () => {
  test('GET, PATCH and DELETE all load with findFirst', async () => {
    // A notification id is returned to the browser by the list route, so findUnique (which the tenant
    // extension cannot scope) would be a cross-tenant read/modify/delete. Asserted on the OPERATION.
    await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads.length).toBeGreaterThanOrEqual(3)
    for (const l of loads) expect(l.op).toBe('findFirst')
  })

  test('the session org is entered on all three handlers', async () => {
    await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    await patch({ name: 'X' })
    await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(enteredOrgs).toEqual(['org-1', 'org-1', 'org-1'])
  })
})

describe('the mask never leaks the credential', () => {
  test('GET returns a masked config without the ciphertext or the plaintext', async () => {
    const res = await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    const raw = await res.text()
    expect(raw).not.toContain('STORED-CIPHERTEXT')
    expect(raw).not.toContain(PLAINTEXT_TOKEN)
    // The row spreads nothing -- maskRow builds the shape explicitly, so the blob column cannot ride along.
    expect(raw).not.toContain('encryptedConfig')
  })

  test('the masked shape keeps type readable and bullets the secrets', async () => {
    const res = await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    const body = (await res.json()) as { config: Record<string, unknown> }
    expect(body.config.configured).toBe(true)
    const masked = body.config.maskedConfig as Record<string, unknown>
    expect(masked.type).toBe('webhook')
    expect(masked.url).toBe('••••••••')
    expect(masked.secret).toBe('••••••••')
  })

  test('an UNDECRYPTABLE row reports configured:false instead of 500', async () => {
    // A row written with a rotated ENCRYPTION_SECRET_KEY must still be listed and deletable -- otherwise the
    // operator cannot clear it and the list page 500s forever.
    decryptFails = true
    const res = await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: Record<string, unknown> }
    expect(body.config.maskedConfig).toEqual({ configured: false })
    expect(body.config.configured).toBe(true)
  })

  test('a missing row is 404', async () => {
    row = null
    expect((await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))).status).toBe(404)
  })
})

describe('PATCH: the type lives INSIDE the encrypted blob', () => {
  test('a NEW config is encrypted together with the resulting type', async () => {
    // `encryptConfig({ type: newType, ...config })` -- the type is not a separate column of truth, so storing
    // it outside the blob would let a dispatch disagree with the credentials.
    await patch({ config: { url: 'https://new.example.com', secret: 'NEWSECRET' } })
    expect(encryptedInputs).toEqual([
      { type: 'webhook', url: 'https://new.example.com', secret: 'NEWSECRET' },
    ])
  })

  test('a supplied config does NOT leak the plaintext into the update payload', async () => {
    await patch({ config: { url: 'https://new.example.com', secret: PLAINTEXT_TOKEN } })
    const u = calls.find((c) => c.op === 'update')!
    const blob = (u.args.data as { encryptedConfig: string }).encryptedConfig
    expect(blob.startsWith('enc:')).toBe(true)
    // The ciphertext necessarily contains the plaintext in this mock (enc = JSON), so the meaningful
    // assertion is that the value went THROUGH the encryptor.
    expect(encryptedInputs).toHaveLength(1)
  })

  test('changing ONLY the type re-packs the blob, KEEPING the existing credentials', async () => {
    // The behaviour this file exists for: switching webhook -> telegram without re-entering the bot token
    // must not silently drop the token.
    await patch({ type: 'telegram' })
    expect(encryptedInputs).toHaveLength(1)
    const packed = encryptedInputs[0]!
    expect(packed.type).toBe('telegram')
    expect(packed.secret).toBe(PLAINTEXT_TOKEN)
    expect(packed.url).toBe('https://hooks.example.com/x')
  })

  test('the re-packed blob is what gets stored', async () => {
    await patch({ type: 'email' })
    const u = calls.find((c) => c.op === 'update')!
    const blob = (u.args.data as { encryptedConfig: string }).encryptedConfig
    expect(blob).toContain('"type":"email"')
    expect(blob).toContain(PLAINTEXT_TOKEN)
  })

  test('a type change COMBINED with a new config uses the NEW type and the NEW config', async () => {
    // Both branches could plausibly run; the config branch wins, and the type must be the incoming one.
    await patch({ type: 'telegram', config: { botToken: 'BOTNEW', chatId: '42' } })
    expect(encryptedInputs).toEqual([
      { type: 'telegram', botToken: 'BOTNEW', chatId: '42' },
    ])
  })

  test('an EMPTY config object is treated as "no config supplied"', async () => {
    // `Object.keys(body.config).length > 0` -- a UI that always posts `config: {}` must not wipe the stored
    // credentials on a name-only edit.
    await patch({ name: 'Renamed', config: {} })
    expect(encryptedInputs).toHaveLength(0)
    const u = calls.find((c) => c.op === 'update')!
    expect(u.args.data).toEqual({ name: 'Renamed' })
  })

  test('a CORRUPT blob does NOT block a type change (it leaves the blob alone)', async () => {
    // The catch is deliberate: an unreadable blob must not brick the form, and sendNotification surfaces the
    // decrypt error at send time. So a type-only PATCH on a corrupt row still succeeds and still writes type.
    decryptFails = true
    const res = await patch({ type: 'telegram' })
    expect(res.status).toBe(200)
    const u = calls.find((c) => c.op === 'update')!
    expect(u.args.data).toEqual({ type: 'telegram' })
    expect(encryptedInputs).toHaveLength(0)
  })

  test('a corrupt blob still allows a name-only edit', async () => {
    decryptFails = true
    expect((await patch({ name: 'X' })).status).toBe(200)
  })
})

describe('PATCH: validation', () => {
  test('an unknown type is 400 and nothing is written', async () => {
    // The type selects the transport; persisting 'slack' would produce a channel that reads as configured and
    // fails only when a scheduled run tries to notify.
    const res = await patch({ type: 'slack' })
    expect(res.status).toBe(400)
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('each of the three valid types is accepted', async () => {
    for (const t of ['webhook', 'email', 'telegram']) {
      calls.length = 0
      encryptedInputs.length = 0
      expect((await patch({ type: t })).status).toBe(200)
    }
  })

  test('a whitespace-only name is ignored rather than clearing it', async () => {
    await patch({ name: '   ', isActive: false })
    const u = calls.find((c) => c.op === 'update')!
    expect(u.args.data).not.toHaveProperty('name')
  })

  test('a whitespace-padded TYPE is trimmed before the whitelist check', async () => {
    // `body.type!.trim()` -- without the trim, ' telegram ' would be refused as invalid.
    expect((await patch({ type: '  telegram  ' })).status).toBe(200)
    expect(encryptedInputs[0]!.type).toBe('telegram')
  })

  test('an empty body is 400', async () => {
    expect((await patch({})).status).toBe(400)
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('a malformed JSON body is 400', async () => {
    expect((await patch('not json')).status).toBe(400)
  })

  test('isActive is only applied when it is a real boolean', async () => {
    await patch({ isActive: 'false' as unknown as boolean })
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
    await patch({ isActive: false })
    expect(calls.find((c) => c.op === 'update')!.args.data).toEqual({ isActive: false })
  })

  test('a missing row is 404 before any write', async () => {
    row = null
    expect((await patch({ name: 'X' })).status).toBe(404)
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('a P2025 race on update is 404, not 500', async () => {
    const e = new Error('gone') as Error & { code?: string }
    e.code = 'P2025'
    updateThrows = e
    expect((await patch({ name: 'X' })).status).toBe(404)
  })

  test('a non-P2025 error propagates', async () => {
    updateThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })
})

describe('the audit trail records WHICH fields changed, never their values', () => {
  test('the update audit lists the changed KEYS', async () => {
    // `changes: Object.keys(data)` -- deliberately not the values, because `data` can contain the credential
    // blob. This is the assertion that keeps a future "log the payload" refactor from leaking it.
    await patch({ name: 'X', isActive: false })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'NOTIFICATION_CONFIG_UPDATE',
      severity: 'info',
      detail: { name: 'X', changes: ['name', 'isActive'] },
    })
    expect(JSON.stringify(auditWrites[0])).not.toContain(PLAINTEXT_TOKEN)
  })

  test('an audit for a config change carries the KEY NAME but not the value', async () => {
    await patch({ config: { secret: PLAINTEXT_TOKEN } })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).toContain('encryptedConfig')
    expect(logged).not.toContain(PLAINTEXT_TOKEN)
  })

  test('DELETE is audited at WARNING with the identifying fields', async () => {
    await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'NOTIFICATION_CONFIG_DELETE',
      severity: 'warning',
      detail: { id: 'n1', name: 'Ops webhook' },
    })
  })
})

describe('DELETE', () => {
  test('it answers { ok: true, deleted: true } and uses deleteMany (which the extension scopes)', async () => {
    const res = await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(calls.find((c) => c.op === 'deleteMany')).toBeDefined()
  })

  test('a missing row is 404 with no audit', async () => {
    row = null
    const res = await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })

  test('a lost race (count 0) is 404 and NOT audited', async () => {
    deleteCount = 0
    const res = await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('each handler maps an internal failure to the typed error response', () => {
  test('GET failure is 500 without leaking the error text', async () => {
    loadThrows = new Error('connection reset')
    const res = await GET(new Request('http://localhost/api/notifications/n1') as never, ctx('n1'))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('PATCH failure is 500', async () => {
    loadThrows = new Error('connection reset')
    expect((await patch({ name: 'X' })).status).toBe(500)
  })

  test('DELETE failure is 500', async () => {
    loadThrows = new Error('connection reset')
    const res = await DELETE(new Request('http://localhost/api/notifications/n1', { method: 'DELETE' }) as never, ctx('n1'))
    expect(res.status).toBe(500)
  })
})
