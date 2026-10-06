import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { UnauthorizedError } from '@/lib/session-errors'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'
import { readKeyScope, type KeyScope } from '@/lib/api-key-scope'

const KEY_PREFIX = 'ryas_'
const HASH_ALGO = 'sha256'

export function hashApiKey(plainText: string): string {
  return crypto.createHash(HASH_ALGO).update(plainText).digest('hex')
}

export function verifyApiKey(plainText: string, hash: string): boolean {
  const candidate = hashApiKey(plainText)
  if (candidate.length !== hash.length) return false
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash))
}

export function generateApiKey(): {
  plainText: string
  prefix: string
  hash: string
} {
  const secret = crypto.randomBytes(32).toString('base64url')
  const plainText = `${KEY_PREFIX}${secret}`
  return {
    plainText,
    prefix: plainText.slice(0, 13),
    hash: hashApiKey(plainText),
  }
}

export function maskApiKey(prefix: string): string {
  return `${prefix}...`
}

export interface ExternalApiIdentity {
  apiKeyId: string
  organizationId: string
  label: string
  requestLimitPerMinute: number | null
  /**
   * The key's stored source scope. Empty arrays mean unrestricted — see `api-key-scope.ts`.
   *
   * Returned here rather than re-read per call site: enforcement then cannot be skipped by
   * forgetting a query, and the columns are selected in exactly ONE place.
   */
  scope: KeyScope
}

export function getBearerToken(req: NextRequest): string | null {
  const raw = req.headers.get('authorization') ?? ''
  const match = raw.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export async function requireExternalApiKey(
  req: NextRequest,
): Promise<ExternalApiIdentity> {
  const token = getBearerToken(req)
  if (!token) throw new UnauthorizedError('API key must be sent as a Bearer token.')

  // Fast rejection: valid API keys must have KEY_PREFIX ('ryas_') and at least 13 characters.
  // This avoids scanning active API keys in the database for invalid or malformed tokens.
  if (token.length < 13 || !token.startsWith(KEY_PREFIX)) {
    throw new UnauthorizedError('API key is invalid or has been revoked.')
  }

  // ponytail: prefix-based narrowing — extract first 13 chars (KEY_PREFIX + 8) to filter
  // candidates before hashing.
  const prefix = token.slice(0, 13)
  // The key identifies the org, so its candidate lookup is explicitly pre-auth.
  const candidates = await bypassOrg(async () =>
    db.apiKey.findMany({
      where: { isActive: true, revokedAt: null, keyPrefix: prefix },
      select: {
        id: true,
        organizationId: true,
        label: true,
        keyHash: true,
        requestLimitPerMinute: true,
        dailyRequestLimit: true,
        // Scope columns are selected HERE and only here, so no call site can enforce a scope it
        // never loaded. A missing column would arrive as undefined and resolve to unrestricted,
        // which is why the select is explicit rather than a bare `findMany()`.
        allowedIntegrationIds: true,
        allowedDocumentIds: true,
        allowedTools: true,
      },
    }),
  )

  const matched = candidates.find((candidate) =>
    verifyApiKey(token, candidate.keyHash),
  )
  if (!matched) throw new UnauthorizedError('API key is invalid or has been revoked.')

  enterWithOrg(matched.organizationId)

  // Rate limit enforcement
  if (matched.requestLimitPerMinute || matched.dailyRequestLimit) {
    const now = new Date()
    const oneMinuteAgo = new Date(now.getTime() - 60_000)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    if (matched.requestLimitPerMinute) {
      const recentCount = await db.apiRequestLog.count({
        where: { apiKeyId: matched.id, createdAt: { gte: oneMinuteAgo } },
      })
      if (recentCount >= matched.requestLimitPerMinute) {
        throw new UnauthorizedError('Rate limit per minute reached. Try again later.')
      }
    }

    if (matched.dailyRequestLimit) {
      const dailyCount = await db.apiRequestLog.count({
        where: { apiKeyId: matched.id, createdAt: { gte: oneDayAgo } },
      })
      if (dailyCount >= matched.dailyRequestLimit) {
        throw new UnauthorizedError('Daily limit reached. Try again tomorrow.')
      }
    }
  }

  await db.apiKey.update({
    where: { id: matched.id },
    data: { lastUsedAt: new Date() },
  })

  return {
    apiKeyId: matched.id,
    organizationId: matched.organizationId,
    label: matched.label,
    requestLimitPerMinute: matched.requestLimitPerMinute,
    // Resolved here so every transport receives the same answer, from one place.
    scope: readKeyScope(matched),
  }
}
