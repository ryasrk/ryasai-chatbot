import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import crypto from 'crypto'
import {
  verifyWebhookSignature,
  processIncomingWebhook,
  resolveWebhookOrganizationId,
  type WebhookPayload,
} from './incoming-webhook'

const mockUserFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => {
    seq.push('user.findFirst')
    return { id: 'admin-1' }
  },
)
const mockRunNonStreaming = mock(async () => ({
  answer: '42 users',
  citations: [{ name: 'DB' }],
  toolRuns: [{ type: 'SQL', status: 'success' }],
}))

/**
 * `organization` is present because the webhook now RESOLVES its org before any other query.
 *
 * MEASURED GAP this closes: the route had NO org context, so the tenant extension skipped injection entirely
 * (`prisma-tenant.ts`: `if (!orgId) return query(args)`) and `user.findFirst` below scanned the whole user table,
 * able to select ANOTHER org's user as the actor — the same cross-tenant read `/api/v1/agent/run` had. The webhook
 * authenticates by HMAC signature, so there is no org to inherit and none in its payload: it must be resolved.
 */
const mockOrgFindMany = mock(async (): Promise<Array<{ id: string }>> => [{ id: 'org-solo' }])
const mockOrgFindUnique = mock(async (): Promise<{ id: string } | null> => ({ id: 'org-explicit' }))

/**
 * Records the org context AS IT IS SET, and stamps the sequence.
 *
 * A source-proximity assertion would not have caught this: a negative control that DELETED
 * `enterWithOrg(orgId)` from the module left my first version of these tests green, because
 * `tenant-route-guard.test.ts` guards `src/app/api/**` routes and this context is set inside
 * `src/lib/incoming-webhook.ts`. Recording the call and its ORDER against the user lookup is what makes a missing
 * context observable.
 */
const mockEnterWithOrg = mock((orgId: string) => {
  seq.push(`org:${orgId}`)
})
const seq: string[] = []

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: mockEnterWithOrg,
  bypassOrg: async (fn: () => Promise<unknown>) => fn(),
}))

mock.module('@/lib/db', () => ({
  db: {
    user: { findFirst: mockUserFindFirst },
    organization: { findMany: mockOrgFindMany, findUnique: mockOrgFindUnique },
  },
}))
mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: mockRunNonStreaming,
}))

const SECRET = 'test-secret-1234'

function sign(body: string, secret: string = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

const originalSecret = process.env.INCOMING_WEBHOOK_SECRET

beforeEach(() => {
  process.env.INCOMING_WEBHOOK_SECRET = SECRET
  mockUserFindFirst.mockClear()
  mockRunNonStreaming.mockClear()
  mockUserFindFirst.mockImplementation(async () => ({ id: 'admin-1' }))
  mockRunNonStreaming.mockImplementation(async () => ({
    answer: '42 users',
    citations: [{ name: 'DB' }],
    toolRuns: [{ type: 'SQL', status: 'success' }],
  }))
})

afterEach(() => {
  if (originalSecret === undefined) delete process.env.INCOMING_WEBHOOK_SECRET
  else process.env.INCOMING_WEBHOOK_SECRET = originalSecret
})

describe('verifyWebhookSignature', () => {
  test('valid signature returns true', () => {
    const body = '{"query":"hi"}'
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true)
  })

  test('tampered body returns false', () => {
    const body = '{"query":"hi"}'
    expect(verifyWebhookSignature('{"query":"evil"}', sign(body), SECRET)).toBe(false)
  })

  test('wrong secret returns false', () => {
    const body = '{"query":"hi"}'
    expect(verifyWebhookSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false)
  })

  test('different-length signature returns false (no crash)', () => {
    expect(verifyWebhookSignature('body', 'short', SECRET)).toBe(false)
  })
})

describe('processIncomingWebhook', () => {
  const payload: WebhookPayload = { query: 'How many users?' }
  const rawBody = JSON.stringify(payload)

  test('valid signature processes query and returns result', async () => {
    const result = await processIncomingWebhook(payload, sign(rawBody), rawBody)
    expect(result.answer).toBe('42 users')
    expect(result.citations).toEqual([{ name: 'DB' }])
    expect(result.toolRuns).toHaveLength(1)

    const callArg = (mockRunNonStreaming.mock.calls[0] as unknown as [{ question: string; userId: string; sessionId?: string; integrationId?: string }])[0]
    expect(callArg.question).toBe('How many users?')
    expect(callArg.userId).toBe('admin-1')
  })

  test('passes sessionId and integrationId through', async () => {
    const p: WebhookPayload = { query: 'q', sessionId: 's1', integrationId: 'i1' }
    const body = JSON.stringify(p)
    await processIncomingWebhook(p, sign(body), body)
    const callArg = (mockRunNonStreaming.mock.calls[0] as unknown as [{ sessionId?: string; integrationId?: string }])[0]
    expect(callArg.sessionId).toBe('s1')
    expect(callArg.integrationId).toBe('i1')
  })

  test('invalid signature throws', async () => {
    expect(processIncomingWebhook(payload, 'bad-signature', rawBody)).rejects.toThrow(
      /Invalid webhook signature/,
    )
    expect(mockRunNonStreaming.mock.calls.length).toBe(0)
  })

  test('missing secret throws', async () => {
    delete process.env.INCOMING_WEBHOOK_SECRET
    expect(processIncomingWebhook(payload, sign(rawBody), rawBody)).rejects.toThrow(
      /INCOMING_WEBHOOK_SECRET not configured/,
    )
  })

  test('no active user throws', async () => {
    mockUserFindFirst.mockImplementation(async () => null)
    expect(processIncomingWebhook(payload, sign(rawBody), rawBody)).rejects.toThrow(
      /No active user/,
    )
  })
})

describe('resolveWebhookOrganizationId — never guesses which tenant a webhook belongs to', () => {
  /**
   * The webhook authenticates by HMAC signature: no session, no API key, and NO org in its payload. So the org has
   * to be resolved, and the failure mode of guessing is that a machine caller's query runs against an arbitrary
   * tenant. This mirrors `resolveSsoOrganizationId` deliberately — two entry points with the same question must
   * not answer it differently.
   */
  const originalId = process.env.INCOMING_WEBHOOK_ORGANIZATION_ID

  beforeEach(() => {
    delete process.env.INCOMING_WEBHOOK_ORGANIZATION_ID
    mockOrgFindMany.mockImplementation(async () => [{ id: 'org-solo' }])
    mockOrgFindUnique.mockImplementation(async () => ({ id: 'org-explicit' }))
  })

  afterEach(() => {
    if (originalId === undefined) delete process.env.INCOMING_WEBHOOK_ORGANIZATION_ID
    else process.env.INCOMING_WEBHOOK_ORGANIZATION_ID = originalId
  })

  test('an explicit id wins and is VERIFIED to exist', async () => {
    process.env.INCOMING_WEBHOOK_ORGANIZATION_ID = 'org-explicit'
    expect(await resolveWebhookOrganizationId()).toBe('org-explicit')
    // Verified, not trusted: a typo'd id must not silently scope every webhook to a nonexistent tenant.
    expect(mockOrgFindUnique).toHaveBeenCalled()
  })

  test('an explicit id that does NOT exist throws, naming the variable', async () => {
    process.env.INCOMING_WEBHOOK_ORGANIZATION_ID = 'org-typo'
    mockOrgFindUnique.mockImplementation(async () => null)
    await expect(resolveWebhookOrganizationId()).rejects.toThrow(/INCOMING_WEBHOOK_ORGANIZATION_ID/)
  })

  test('the single-org case resolves without configuration', async () => {
    // The common on-prem install: one customer, one org, nothing to configure.
    expect(await resolveWebhookOrganizationId()).toBe('org-solo')
  })

  test('MULTIPLE orgs throw instead of picking one', async () => {
    // The direction that matters. The query asked `take: 2` precisely so two rows are enough to know it is
    // ambiguous — and returning `orgs[0]` here would attach a machine caller to an arbitrary tenant.
    mockOrgFindMany.mockImplementation(async () => [{ id: 'org-a' }, { id: 'org-b' }])
    await expect(resolveWebhookOrganizationId()).rejects.toThrow(/multiple organizations/i)
  })

  test('NO org at all throws, rather than querying with an empty context', async () => {
    mockOrgFindMany.mockImplementation(async () => [])
    await expect(resolveWebhookOrganizationId()).rejects.toThrow(/before any organization exists/i)
  })
})

describe('the webhook ENTERS its org context before it queries', () => {
  /**
   * THE ORDER IS THE GUARANTEE. Without a context the tenant extension skips injection entirely
   * (`prisma-tenant.ts`: `if (!orgId) return query(args)`), so `user.findFirst` scans every tenant's users and can
   * return another org's user as the actor for this machine caller's request.
   *
   * Asserted through recorded CALL ORDER rather than by reading the source, because a negative control proved the
   * source-shaped guard vacuous: deleting the `enterWithOrg` call left the previous tests green.
   */
  test('the org is entered BEFORE any user query', async () => {
    seq.length = 0
    mockEnterWithOrg.mockClear()
    mockOrgFindMany.mockImplementation(async () => [{ id: 'org-solo' }])
    mockUserFindFirst.mockImplementation(async () => {
      seq.push('user.findFirst')
      return { id: 'admin-1' }
    })

    const body = JSON.stringify({ query: 'how many users?' })
    await processIncomingWebhook({ query: 'how many users?' } as WebhookPayload, sign(body), body)

    const orgAt = seq.indexOf('org:org-solo')
    const userAt = seq.indexOf('user.findFirst')
    expect(orgAt).toBeGreaterThan(-1) // the context was set at all
    expect(userAt).toBeGreaterThan(-1) // and the query really ran
    expect(orgAt).toBeLessThan(userAt) // BEFORE it — the whole point
  })
})
