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
import { bypassOrg } from '@/lib/prisma-tenant'
import { redisCmd } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

/**
 * SAML metadata discovery and the IdP round trip are both on the login path; a hung IdP must
 * not hang sign-in. 10s matches the convention used by the other outbound calls here.
 */
function samlTimeoutMs(): number {
  const raw = Number(process.env.SAML_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
}
import { resolveSsoOrganizationId } from '@/lib/sso'
import { checkQuota, quotaExceededMessage } from '@/lib/plan-gating'

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
    // BIND THE RESPONSE TO THE REQUEST WE SENT. `never` accepted any well-signed assertion from the IdP, including
    // one this SP never asked for: a captured SAMLResponse (proxy log, browser history, shared terminal) was a
    // bearer credential replayable from anywhere until NotOnOrAfter. `ifPresent` enforces the binding whenever a
    // request id is cached, so a deployment whose cache is unreachable still fails safe instead of silently
    // accepting an unsolicited response.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: 28_800_000,
    // A REAL cache, backed by the same Redis the replay guard uses. It used to be a no-op (`saveAsync` returning
    // null), which made `validateInResponseTo` impossible to honour even when enabled: the id was never stored, so
    // nothing could ever match it, and the setting was decorative.
    cacheProvider: samlRequestIdCache(),
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

/** Test-only accessor; see the note on `oidcTimeoutMs` in sso.ts. */
export const __samlTimeoutMsForTest = samlTimeoutMs

export async function discoverFromMetadata(metadataUrl: string): Promise<DiscoveredMetadata> {
  // Metadata discovery is part of SAML login: a hung IdP metadata endpoint would hang
// sign-in. 10s, overridable for slow on-prem deployments.
const res = await fetch(metadataUrl, {
    headers: { Accept: 'application/xml' },
    signal: AbortSignal.timeout(samlTimeoutMs()),
  })
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

/**
 * Thrown when the replay guard cannot reach its store. Typed so a caller can tell "the store is down" from "this
 * assertion was replayed" without matching on prose.
 */
export class SamlReplayCheckUnavailableError extends Error {
  readonly code = 'SAML_REPLAY_CHECK_UNAVAILABLE'
  constructor() {
    super('SAML replay protection is unavailable (session store unreachable). Login refused.')
    this.name = 'SamlReplayCheckUnavailableError'
  }
}

/**
 * Has this assertion already been consumed?
 *
 * THIS USED TO FAIL OPEN. When Redis was unreachable the catch returned `false` ("not replayed") and the login
 * proceeded, justified by a comment that signature validation is the primary barrier. Signature validation proves
 * an assertion is AUTHENTIC; it does not stop the SAME authentic assertion being replayed, which is this check's
 * entire purpose. Worse, `false` is also the ordinary answer, so a store outage removed replay protection while
 * looking exactly like normal operation.
 *
 * It now fails CLOSED by throwing. The trade-off is deliberate: during a store outage logins are REFUSED rather
 * than accepted without replay protection. A refused login is recoverable; a replayed assertion is not.
 */
async function isAssertionReplayed(assertionId: string): Promise<boolean> {
  try {
    const key = `saml:assertion:${assertionId}`
    const set = await redisCmd.set(key, '1', 'PX', 300_000, 'NX')
    return !set
  } catch (e) {
    log.error('Replay protection UNAVAILABLE — refusing the assertion rather than accepting it unchecked', {
      error: e instanceof Error ? e.message : String(e),
    })
    throw new SamlReplayCheckUnavailableError()
  }
}

/**
 * Redis-backed store for outstanding AuthnRequest ids, so `validateInResponseTo` can reject a response that does
 * not answer a request this SP issued. An unresolvable id returns `null`, which makes validation FAIL CLOSED: a
 * response whose request id cannot be found is refused.
 */
function samlRequestIdCache() {
  const prefix = 'saml:reqid:'
  return {
    // `saveAsync` must resolve to a `CacheItem` (`{ value, createdAt }`), not the bare string -- returning the
    // string type-checks against nothing and the library would later fail to read what it stored.
    async saveAsync(key: string, value: string): Promise<{ value: string; createdAt: number } | null> {
      const createdAt = Date.now()
      await redisCmd.set(`${prefix}${key}`, value, 'PX', 28_800_000)
      return { value, createdAt }
    },
    async getAsync(key: string): Promise<string | null> {
      try {
        return (await redisCmd.get(`${prefix}${key}`)) ?? null
      } catch (e) {
        log.error('InResponseTo lookup failed — the response will be refused', {
          error: e instanceof Error ? e.message : String(e),
        })
        return null
      }
    },
    async removeAsync(key: string | null): Promise<string | null> {
      if (!key) return null
      const value = (await redisCmd.get(`${prefix}${key}`)) ?? null
      await redisCmd.del(`${prefix}${key}`)
      return value
    },
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
    // BIND THE RESPONSE TO THE REQUEST WE SENT. `never` accepted any well-signed assertion from the IdP, including
    // one this SP never asked for: a captured SAMLResponse (proxy log, browser history, shared terminal) was a
    // bearer credential replayable from anywhere until NotOnOrAfter. `ifPresent` enforces the binding whenever a
    // request id is cached, so a deployment whose cache is unreachable still fails safe instead of silently
    // accepting an unsolicited response.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: 28_800_000,
    // A REAL cache, backed by the same Redis the replay guard uses. It used to be a no-op (`saveAsync` returning
    // null), which made `validateInResponseTo` impossible to honour even when enabled: the id was never stored, so
    // nothing could ever match it, and the setting was decorative.
    cacheProvider: samlRequestIdCache(),
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

  // Same org-resolution + quota rules as the OIDC path — see
  // `resolveSsoOrganizationId` in sso.ts for why the old hardcoded
  // 'org-default' was a foreign-key violation, and why we fail closed rather
  // than guess a tenant.
  const orgId = await resolveSsoOrganizationId()
  const org = await bypassOrg(() =>
    db.organization.findUnique({ where: { id: orgId }, select: { licensePlan: true } }),
  )
  const memberCount = await bypassOrg(() => db.user.count({ where: { organizationId: orgId } }))
  const quota = checkQuota(org?.licensePlan, 'maxUsers', memberCount)
  if (!quota.allowed) {
    throw new Error(quotaExceededMessage('maxUsers', quota))
  }

  const created = await bypassOrg(() => db.user.create({
    data: {
      organizationId: orgId,
      email,
      name,
      ssoSubject: userInfo.sub,
      passwordHash: '!',
      sessionVersion: 1,
    },
    select: { id: true, name: true, email: true },
  }))
  return {
    userId: created.id,
    name: created.name,
    email: created.email,
    sessionToken: signSession(created.id, 1),
    created: true,
  }
}
