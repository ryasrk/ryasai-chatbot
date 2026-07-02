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
  companyId: string
  label: string
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
  if (!token) throw new UnauthorizedError('API key wajib dikirim sebagai Bearer token.')

  const candidates = await db.apiKey.findMany({
    where: { isActive: true, revokedAt: null },
    select: { id: true, companyId: true, label: true, keyHash: true },
  })

  const matched = candidates.find((candidate) =>
    verifyApiKey(token, candidate.keyHash),
  )
  if (!matched) throw new UnauthorizedError('API key tidak valid atau sudah dicabut.')

  await db.apiKey.update({
    where: { id: matched.id },
    data: { lastUsedAt: new Date() },
  })

  return {
    apiKeyId: matched.id,
    companyId: matched.companyId,
    label: matched.label,
  }
}
