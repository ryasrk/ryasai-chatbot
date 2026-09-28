import crypto from 'crypto'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

export interface WebhookPayload {
  query: string
  sessionId?: string
  integrationId?: string
}

/**
 * The organization an incoming webhook belongs to.
 *
 * `INCOMING_WEBHOOK_ORGANIZATION_ID` when set; otherwise the single-org case; THROWS when several organizations
 * exist. Mirrors `resolveSsoOrganizationId` on purpose — two entry points that both have "no org in the request"
 * must not answer the question differently, and an earlier hardcoded value in the SSO path was an FK violation on
 * a real multi-tenant database.
 */
export async function resolveWebhookOrganizationId(): Promise<string> {
  const explicit = process.env.INCOMING_WEBHOOK_ORGANIZATION_ID?.trim()
  if (explicit) {
    const found = await bypassOrg(() =>
      db.organization.findUnique({ where: { id: explicit }, select: { id: true } }),
    )
    if (!found) {
      throw new Error(
        `INCOMING_WEBHOOK_ORGANIZATION_ID is set to "${explicit}" but no such organization exists.`,
      )
    }
    return explicit
  }

  const orgs = await bypassOrg(() => db.organization.findMany({ select: { id: true }, take: 2 }))
  if (orgs.length === 0) {
    throw new Error('Incoming webhook called before any organization exists. Complete signup first.')
  }
  if (orgs.length > 1) {
    throw new Error(
      'Incoming webhook cannot determine which organization it belongs to: multiple organizations exist. ' +
        'Set INCOMING_WEBHOOK_ORGANIZATION_ID to choose one.',
    )
  }
  return orgs[0].id
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

  /*
   * THE ORG CONTEXT IS RESOLVED BEFORE ANY DB WORK, and this route had NONE.
   *
   * MEASURED CONSEQUENCE: without a context the tenant extension skips injection entirely
   * (`prisma-tenant.ts`: `if (!orgId) return query(args)`), so the `findFirst` below scanned the WHOLE user table
   * and could select ANOTHER ORG'S user as the actor for this request — the same cross-tenant read that
   * `/api/v1/agent/run` had. The webhook authenticates with an HMAC signature rather than a session or API key, so
   * there is no org to inherit: it has to be resolved, and the payload does not carry one.
   *
   * SAME POLICY AS SSO, deliberately: `INCOMING_WEBHOOK_ORGANIZATION_ID` when set, otherwise the single-org case,
   * and THROW when several orgs exist. Guessing would attribute a request to an arbitrary tenant, and a webhook
   * has no user watching to notice. Failing closed gives the operator a clear error instead.
   */
  const orgId = await resolveWebhookOrganizationId()
  enterWithOrg(orgId)

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
