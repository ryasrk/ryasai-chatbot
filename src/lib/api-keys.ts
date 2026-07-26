import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { UnauthorizedError } from '@/lib/session'

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
  label: string
  requestLimitPerMinute: number | null
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

  // ponytail: prefix-based narrowing — extract first 13 chars (KEY_PREFIX + 8) to filter
  // candidates before hashing. Falls back to all keys if prefix is too short.
  const prefix = token.slice(0, 13)
  const candidates = prefix.length >= 13
    ? await db.apiKey.findMany({
        where: { isActive: true, revokedAt: null, keyPrefix: prefix },
        select: { id: true, label: true, keyHash: true, requestLimitPerMinute: true, dailyRequestLimit: true },
      })
    : await db.apiKey.findMany({
        where: { isActive: true, revokedAt: null },
        select: { id: true, label: true, keyHash: true, requestLimitPerMinute: true, dailyRequestLimit: true },
      })

  const matched = candidates.find((candidate) =>
    verifyApiKey(token, candidate.keyHash),
  )
  if (!matched) throw new UnauthorizedError('API key is invalid or has been revoked.')

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
    label: matched.label,
    requestLimitPerMinute: matched.requestLimitPerMinute,
  }
}
