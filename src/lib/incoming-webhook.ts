import crypto from 'crypto'
import { db } from '@/lib/db'

export interface WebhookPayload {
  query: string
  sessionId?: string
  integrationId?: string
}

export interface WebhookResult {
  answer: string
  citations: unknown[]
  toolRuns: unknown[]
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Raised when the webhook cannot be AUTHENTICATED (missing or mismatched signature/secret). Typed so the route
 * can answer 401 without sniffing message text: `/signature|secret/i.test(msg)` classified an unrelated upstream
 * error containing the word "secret" as a 401 (a proven false positive).
 */
export class WebhookAuthError extends Error {
  readonly code = 'WEBHOOK_UNAUTHORIZED'
}

export async function processIncomingWebhook(
  payload: WebhookPayload,
  signature: string,
  rawBody: string,
): Promise<WebhookResult> {
  const secret = process.env.INCOMING_WEBHOOK_SECRET
  if (!secret) throw new WebhookAuthError('INCOMING_WEBHOOK_SECRET not configured')
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    throw new WebhookAuthError('Invalid webhook signature')
  }

  const admin = await db.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!admin) throw new Error('No active user found')

  const { runNonStreamingChatCompletion } = await import('@/lib/tool-router')
  const result = await runNonStreamingChatCompletion({
    question: payload.query,
    userId: admin.id,
    sessionId: payload.sessionId,
    integrationId: payload.integrationId,
  })

  return {
    answer: result.answer,
    citations: result.citations,
    toolRuns: result.toolRuns,
  }
}
