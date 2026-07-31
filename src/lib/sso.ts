/**
 * OIDC (OpenID Connect) SSO — SERVER-ONLY.
 * ----------------------------------------------------------------------------
 * Uses fetch + node:crypto only (no dep). Supports HS256 (symmetric, client
 * secret) and RS256 (asymmetric, JWKS fetch). When OIDC env vars are unset,
 * all functions no-op / return null so the app runs without SSO configured.
 *
 * Env: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { signSession } from '@/lib/crypto'

export interface OidcConfig {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
}

export interface OidcTokens {
  access_token: string
  id_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
}

export interface OidcUserInfo {
  sub: string
  email?: string
  name?: string
  preferred_username?: string
}

export interface SsoUserResult {
  userId: string
  name: string
  email: string
  sessionToken: string
  created: boolean
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

export function isOidcConfigured(): boolean {
  return !!(env('OIDC_ISSUER') && env('OIDC_CLIENT_ID') && env('OIDC_REDIRECT_URI'))
}

export async function getOidcConfig(issuerUrl: string): Promise<OidcConfig> {
  const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} for ${url}`)
  const cfg = (await res.json()) as OidcConfig
  if (!cfg.authorization_endpoint || !cfg.token_endpoint) {
    throw new Error('OIDC discovery response missing required endpoints')
  }
  return cfg
}

export function buildAuthUrl(
  config: OidcConfig,
  state: string,
  nonce: string,
  codeChallenge?: string,
): string {
  const clientId = env('OIDC_CLIENT_ID')
  const redirectUri = env('OIDC_REDIRECT_URI')
  if (!clientId || !redirectUri) throw new Error('OIDC_CLIENT_ID or OIDC_REDIRECT_URI not set')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
  })
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return `${config.authorization_endpoint}?${params.toString()}`
}

export async function exchangeCode(
  code: string,
  config: OidcConfig,
  codeVerifier?: string,
): Promise<OidcTokens> {
  const clientId = env('OIDC_CLIENT_ID')
  const clientSecret = env('OIDC_CLIENT_SECRET')
  const redirectUri = env('OIDC_REDIRECT_URI')
  if (!clientId || !redirectUri) throw new Error('OIDC_CLIENT_ID or OIDC_REDIRECT_URI not set')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  const res = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`OIDC token exchange failed: ${res.status} ${text}`)
  }
  const tokens = (await res.json()) as OidcTokens
  if (!tokens.id_token) throw new Error('OIDC token response missing id_token')
  return tokens
}

interface JwtHeader { alg: string; kid?: string; typ?: string }
interface JwtPayload {
  iss?: string
  sub?: string
  aud?: string
  exp?: number
  iat?: number
  nonce?: string
  email?: string
  name?: string
  preferred_username?: string
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const json = Buffer.from(part, 'base64url').toString('utf-8')
  return JSON.parse(json)
}

export function decodeIdToken(token: string): { header: JwtHeader; payload: JwtPayload } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT: expected 3 parts')
  return {
    header: decodeJwtPart(parts[0]) as unknown as JwtHeader,
    payload: decodeJwtPart(parts[1]) as unknown as JwtPayload,
  }
}

export function verifyIdToken(
  token: string,
  config: OidcConfig,
  expectedNonce?: string,
): JwtPayload {
  const { header, payload } = decodeIdToken(token)
  const issuer = config.issuer
  const clientId = env('OIDC_CLIENT_ID')

  if (payload.iss && payload.iss !== issuer) throw new Error(`JWT iss mismatch: ${payload.iss}`)
  if (payload.aud && clientId && payload.aud !== clientId) throw new Error('JWT aud mismatch')
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('JWT expired')
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('JWT nonce mismatch')

  const parts = token.split('.')
  const signedData = `${parts[0]}.${parts[1]}`
  const signature = Buffer.from(parts[2], 'base64url')

  if (header.alg === 'HS256') {
    const clientSecret = env('OIDC_CLIENT_SECRET')
    if (!clientSecret) throw new Error('HS256 requires OIDC_CLIENT_SECRET')
    const expected = crypto.createHmac('sha256', clientSecret).update(signedData).digest()
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
      throw new Error('JWT HS256 signature verification failed')
    }
  } else if (header.alg === 'RS256') {
    // ponytail: RS256 needs JWKS — synchronous verify not possible without fetching keys.
    // Caller should use verifyIdTokenRs256 (async) for RS256. This throws to fail-closed.
    throw new Error('RS256 tokens require verifyIdTokenRs256 (async JWKS fetch)')
  } else {
    throw new Error(`Unsupported JWT alg: ${header.alg}`)
  }
  return payload
}

interface Jwk { kty: string; kid?: string; use?: string; alg?: string; n?: string; e?: string; x5c?: string[] }

let _jwksCache: { uri: string; keys: Jwk[]; fetchedAt: number } | null = null
const JWKS_TTL_MS = 10 * 60 * 1000

export async function verifyIdTokenRs256(
  token: string,
  config: OidcConfig,
  expectedNonce?: string,
): Promise<JwtPayload> {
  const { header, payload } = decodeIdToken(token)
  if (header.alg !== 'RS256') throw new Error(`Expected RS256, got ${header.alg}`)
  const issuer = config.issuer
  const clientId = env('OIDC_CLIENT_ID')
  if (payload.iss && payload.iss !== issuer) throw new Error(`JWT iss mismatch: ${payload.iss}`)
  if (payload.aud && clientId && payload.aud !== clientId) throw new Error('JWT aud mismatch')
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('JWT expired')
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('JWT nonce mismatch')

  if (!config.jwks_uri) throw new Error('OIDC config missing jwks_uri for RS256 verification')
  const jwk = await fetchJwk(config.jwks_uri, header.kid)
  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const parts = token.split('.')
  const signedData = `${parts[0]}.${parts[1]}`
  const signature = Buffer.from(parts[2], 'base64url')
  const ok = crypto.verify('sha256', Buffer.from(signedData), keyObj, signature)
  if (!ok) throw new Error('JWT RS256 signature verification failed')
  return payload
}

async function fetchJwk(jwksUri: string, kid?: string): Promise<Jwk> {
  if (_jwksCache && _jwksCache.uri === jwksUri && Date.now() - _jwksCache.fetchedAt < JWKS_TTL_MS) {
    const key = kid ? _jwksCache.keys.find((k) => k.kid === kid) : _jwksCache.keys[0]
    if (key) return key
  }
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const body = (await res.json()) as { keys: Jwk[] }
  if (!body.keys?.length) throw new Error('JWKS response has no keys')
  _jwksCache = { uri: jwksUri, keys: body.keys, fetchedAt: Date.now() }
  const key = kid ? body.keys.find((k) => k.kid === kid) : body.keys[0]
  if (!key) throw new Error(`JWKS has no key for kid=${kid}`)
  return key
}

export function resetJwksCache(): void { _jwksCache = null }

export async function fetchUserInfo(accessToken: string, config: OidcConfig): Promise<OidcUserInfo> {
  if (!config.userinfo_endpoint) {
    const { payload } = decodeIdToken(accessToken)
    return {
      sub: payload.sub ?? '',
      email: payload.email,
      name: payload.name,
      preferred_username: payload.preferred_username,
    }
  }
  const res = await fetch(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`UserInfo fetch failed: ${res.status}`)
  return (await res.json()) as OidcUserInfo
}

export async function getOrCreateSsoUser(userInfo: OidcUserInfo): Promise<SsoUserResult> {
  if (!userInfo.sub) throw new Error('SSO userinfo missing sub claim')
  const email = (userInfo.email ?? `sso_${userInfo.sub}@sso.local`).toLowerCase()
  const name = userInfo.name ?? userInfo.preferred_username ?? email.split('@')[0]

  const existing = await db.user.findFirst({ where: { ssoSubject: userInfo.sub } })
  if (existing) {
    const updated = await db.user.update({
      where: { id: existing.id },
      data: { sessionVersion: { increment: 1 } },
      select: { id: true, sessionVersion: true },
    })
    return {
      userId: existing.id,
      name: existing.name,
      email: existing.email,
      sessionToken: signSession(existing.id, updated.sessionVersion),
      created: false,
    }
  }

  const byEmail = await db.user.findUnique({ where: { email } })
  if (byEmail) {
    const updated = await db.user.update({
      where: { id: byEmail.id },
      data: { ssoSubject: userInfo.sub, sessionVersion: { increment: 1 } },
      select: { id: true, name: true, email: true, sessionVersion: true },
    })
    return {
      userId: updated.id,
      name: updated.name,
      email: updated.email,
      sessionToken: signSession(updated.id, updated.sessionVersion),
      created: false,
    }
  }

  const created = await db.user.create({
    data: {
      email,
      name,
      ssoSubject: userInfo.sub,
      passwordHash: '!', // ponytail: SSO users have no password — '!' blocks password login
      sessionVersion: 1,
    },
    select: { id: true, name: true, email: true },
  })
  return {
    userId: created.id,
    name: created.name,
    email: created.email,
    sessionToken: signSession(created.id, 1),
    created: true,
  }
}

export function generateStateNonce(): { state: string; nonce: string } {
  return {
    state: crypto.randomBytes(16).toString('hex'),
    nonce: crypto.randomBytes(16).toString('hex'),
  }
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function computeCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}
