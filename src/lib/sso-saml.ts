/**
 * SAML 2.0 SSO — SERVER-ONLY.
 * ----------------------------------------------------------------------------
 * Uses @node-saml/node-saml for XML canonicalization + signature verification.
 * Supports SP-initiated and IdP-initiated login. When SAML env vars are unset,
 * isSamlConfigured() returns false and the login button is hidden.
 *
 * Env: SAML_SP_ENTITY_ID, SAML_SP_CALLBACK_URL, SAML_IDP_ENTRY_POINT,
 *      SAML_IDP_CERT, SAML_IDP_METADATA_URL (optional),
 *      SAML_SP_CERT, SAML_SP_PRIVATE_KEY (optional, for signed AuthnRequests)
 */
import { SAML, ValidateInResponseTo, type Profile, type SamlOptions } from '@node-saml/node-saml'
import { db } from '@/lib/db'
import { signSession } from '@/lib/crypto'
import { redisCmd } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('sso-saml')

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

export function isSamlConfigured(): boolean {
  return !!(env('SAML_SP_ENTITY_ID') && env('SAML_SP_CALLBACK_URL') &&
    (env('SAML_IDP_ENTRY_POINT') || env('SAML_IDP_METADATA_URL')))
}

export interface SamlConfigResult {
  entryPoint: string
  cert?: string
  issuer: string
  callbackUrl: string
  decryptionPvk?: string
  privateKey?: string
  spCert?: string
}

export function buildSamlConfig(): SamlConfigResult {
  const issuer = env('SAML_SP_ENTITY_ID')!
  const callbackUrl = env('SAML_SP_CALLBACK_URL')!
  const entryPoint = env('SAML_IDP_ENTRY_POINT') ?? ''
  const cert = env('SAML_IDP_CERT')
  const spCert = env('SAML_SP_CERT')
  const spPrivateKey = env('SAML_SP_PRIVATE_KEY')

  if (!entryPoint && !env('SAML_IDP_METADATA_URL')) {
    throw new Error('SAML_IDP_ENTRY_POINT or SAML_IDP_METADATA_URL must be set')
  }

  return {
    entryPoint,
    cert,
    issuer,
    callbackUrl,
    privateKey: spPrivateKey,
    spCert,
  }
}

export async function createSamlInstance(): Promise<SAML> {
  const cfg = buildSamlConfig()
  const metadataUrl = env('SAML_IDP_METADATA_URL')

  let entryPoint = cfg.entryPoint
  let cert = cfg.cert

  if (metadataUrl && (!entryPoint || !cert)) {
    const discovered = await discoverFromMetadata(metadataUrl)
    if (!entryPoint) entryPoint = discovered.entryPoint
    if (!cert) cert = discovered.cert
  }

  if (!entryPoint) throw new Error('SAML entry point could not be resolved')

  const options: SamlOptions = {
    idpCert: cert || '',
    issuer: cfg.issuer,
    callbackUrl: cfg.callbackUrl,
    entryPoint,
    signatureAlgorithm: 'sha256',
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    acceptedClockSkewMs: 60_000,
    disableRequestedAuthnContext: true,
    forceAuthn: false,
    allowCreate: false,
    identifierFormat: null,
    additionalParams: {},
    additionalAuthorizeParams: {},
    authnContext: [],
    racComparison: 'exact',
    passive: false,
    skipRequestCompression: false,
    audience: cfg.issuer,
    maxAssertionAgeMs: 60_000,
    validateInResponseTo: ValidateInResponseTo.never,
    requestIdExpirationPeriodMs: 28_800_000,
    cacheProvider: { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null },
    signMetadata: false,
    generateUniqueId: () => Math.random().toString(36).substring(2, 18),
    logoutUrl: entryPoint,
    additionalLogoutParams: {},
    disableRequestAcsUrl: false,
  }

  if (cfg.privateKey && cfg.spCert) {
    options.privateKey = cfg.privateKey
    options.publicCert = cfg.spCert
  }

  return new SAML(options)
}

interface DiscoveredMetadata {
  entryPoint: string
  cert?: string
}

async function discoverFromMetadata(metadataUrl: string): Promise<DiscoveredMetadata> {
  const res = await fetch(metadataUrl, { headers: { Accept: 'application/xml' } })
  if (!res.ok) throw new Error(`SAML metadata fetch failed: ${res.status} for ${metadataUrl}`)
  const xml = await res.text()
  // ponytail: simple regex extraction — the IdP metadata XML has predictable structure:
  //   <SingleSignOnService Location="https://..." Binding="...:POST"/>
  //   <X509Certificate>...</X509Certificate>
  const entryMatch = xml.match(/<SingleSignOnService[^>]+Location="([^"]+)"/i)
  const certMatch = xml.match(/<X509Certificate[^>]*>([^<]+)<\/X509Certificate>/i)

  if (!entryMatch) throw new Error('SAML metadata missing SingleSignOnService Location')

  const entryPoint = entryMatch[1]
  let cert: string | undefined
  if (certMatch) {
    const certBody = certMatch[1].replace(/\s/g, '')
    cert = `-----BEGIN CERTIFICATE-----\n${certBody.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----`
  }

  return { entryPoint, cert }
}

export async function generateAuthnRequestRedirectUrl(): Promise<string> {
  const saml = await createSamlInstance()
  const url = await saml.getAuthorizeUrlAsync('', undefined, {})
  return url
}

export interface SamlUserInfo {
  sub: string
  email?: string
  name?: string
}

export async function validateSamlResponse(samlBody: string): Promise<SamlUserInfo> {
  const saml = await createSamlInstance()
  const result = await saml.validatePostResponseAsync({ SAMLResponse: samlBody })

  if (!result.profile) throw new Error('SAML response validation failed: no profile')

  const profile = result.profile as Profile

  // Extract NameID as ssoSubject
  if (!profile.nameID) throw new Error('SAML response missing NameID')
  const sub = profile.nameID

  // Replay protection
  const assertionId = profile.ID ?? profile.sessionIndex ?? sub
  if (await isAssertionReplayed(assertionId)) {
    throw new Error('SAML assertion replay detected')
  }

  // Extract email — check OID format, URI format, mail, email fields
  const email =
    (profile['urn:oid:0.9.2342.19200300.100.1.3'] as string) ??
    (profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] as string) ??
    profile.mail ??
    profile.email

  // Extract name — check common attribute formats
  const name =
    (profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] as string) ??
    (profile['urn:oid:2.5.4.3'] as string) ??
    (profile['urn:oid:2.5.4.42'] as string) ??
    (profile.displayName as string) ??
    (profile.cn as string)

  return {
    sub,
    email: email?.toLowerCase(),
    name,
  }
}

async function isAssertionReplayed(assertionId: string): Promise<boolean> {
  try {
    const key = `saml:assertion:${assertionId}`
    const set = await redisCmd.set(key, '1', 'PX', 300_000, 'NX')
    return !set
  } catch (e) {
    // ponytail: Redis down — skip replay check, log warning.
    // Signature validation is the primary security barrier.
    log.warn('Replay protection skipped — Redis unavailable', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

export function generateSpMetadata(): string {
  const cfg = buildSamlConfig()
  const spCert = cfg.spCert ?? null
  const saml = new SAML({
    idpCert: cfg.cert || '',
    issuer: cfg.issuer,
    callbackUrl: cfg.callbackUrl,
    entryPoint: cfg.entryPoint || 'https://placeholder',
    signatureAlgorithm: 'sha256',
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    acceptedClockSkewMs: 60_000,
    disableRequestedAuthnContext: true,
    forceAuthn: false,
    allowCreate: false,
    identifierFormat: null,
    additionalParams: {},
    additionalAuthorizeParams: {},
    authnContext: [],
    racComparison: 'exact',
    passive: false,
    skipRequestCompression: false,
    audience: cfg.issuer,
    maxAssertionAgeMs: 60_000,
    validateInResponseTo: ValidateInResponseTo.never,
    requestIdExpirationPeriodMs: 28_800_000,
    cacheProvider: { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null },
    signMetadata: false,
    generateUniqueId: () => Math.random().toString(36).substring(2, 18),
    logoutUrl: cfg.entryPoint || 'https://placeholder',
    additionalLogoutParams: {},
    disableRequestAcsUrl: false,
    ...(cfg.privateKey && spCert ? { privateKey: cfg.privateKey, cert: spCert } : {}),
  })
  return saml.generateServiceProviderMetadata(spCert, spCert ? [spCert] : null)
}

export interface SamlUserResult {
  userId: string
  name: string
  email: string
  sessionToken: string
  created: boolean
}

export async function getOrCreateSsoUser(userInfo: SamlUserInfo): Promise<SamlUserResult> {
  if (!userInfo.sub) throw new Error('SAML userinfo missing NameID')
  const email = (userInfo.email ?? `sso_${userInfo.sub}@sso.local`).toLowerCase()
  const name = userInfo.name ?? email.split('@')[0]

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
      passwordHash: '!',
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
