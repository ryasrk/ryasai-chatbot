import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import crypto from 'crypto'
import {
  verifyWebhookSignature,
  processIncomingWebhook,
  type WebhookPayload,
} from './incoming-webhook'

const mockUserFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => ({ id: 'admin-1' }),
)
const mockRunNonStreaming = mock(async () => ({
  answer: '42 users',
  citations: [{ name: 'DB' }],
  toolRuns: [{ type: 'SQL', status: 'success' }],
}))

mock.module('@/lib/db', () => ({
  db: { user: { findFirst: mockUserFindFirst } },
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
