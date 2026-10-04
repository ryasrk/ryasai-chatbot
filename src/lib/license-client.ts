/**
 * License client — validates license keys against the License-Validator service.
 * Ed25519 signed responses + nonce challenge + grace period + periodic revalidation.
 * ----------------------------------------------------------------------------
 * Env: LICENSE_VALIDATOR_URL (default: http://localhost:9000)
 *      LICENSE_PRODUCT (default: ryasai-chatbot)
 *      LICENSE_SIGNING_PUBLIC_KEY (Ed25519 public key, DER hex)
 *      LICENSE_GRACE_PERIOD_DAYS (default: 7)
 *      LICENSE_REVALIDATION_INTERVAL_HOURS (default: 24)
 */
import crypto from 'crypto'
import { scopedLogger } from '@/lib/logger'
import { normalizePlan, KNOWN_PLANS } from '@/lib/plan-gating'

const log = scopedLogger('license')

export const OFFICIAL_LICENSE_VALIDATOR_URL = 'https://license.ryasai.my.id'

export function validatorUrl(): string {
  // In production deployments, license validation is hardcoded to our official central authority
  // so client deployments cannot tamper with or redirect license verification.
  // E2E test mode and non-production environments allow local mock overrides.
  if (process.env.NODE_ENV === 'production' && process.env.E2E_TEST_MODE !== 'true') {
    return OFFICIAL_LICENSE_VALIDATOR_URL
  }
  return process.env.LICENSE_VALIDATOR_URL?.replace(/\/$/, '') || 'http://localhost:9000'
}

function product(): string {
  return process.env.LICENSE_PRODUCT || 'ryasai-chatbot'
}

const GRACE_PERIOD_MS = (Number(process.env.LICENSE_GRACE_PERIOD_DAYS) || 7) * 24 * 60 * 60 * 1000
const REVALIDATION_INTERVAL_MS = (Number(process.env.LICENSE_REVALIDATION_INTERVAL_HOURS) || 24) * 60 * 60 * 1000

// Ed25519 public key (DER hex) — not secret. Used to verify server signatures.
// ponytail: no hardcoded fallback — a missing LICENSE_SIGNING_PUBLIC_KEY must
// fail closed (all signatures fail → lockdown), never trust a shipped default
// key whose private half could exist somewhere.
// ponytail: read at CALL time, not at module load. A module-load constant makes the
// malformed-key branch unreachable without a query-string import (which creates a SECOND,
// uninstrumented module instance), and it also meant a key set after boot was ignored.
function getPublicKey(): crypto.KeyObject | null {
  const publicKeyHex = process.env.LICENSE_SIGNING_PUBLIC_KEY
  if (!publicKeyHex) {
    log.error('LICENSE_SIGNING_PUBLIC_KEY is not set — signature verification disabled (fail closed)')
    return null
  }
  try {
    return crypto.createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
  } catch {
    log.error('Failed to load LICENSE_SIGNING_PUBLIC_KEY — signature verification disabled')
    return null
  }
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Verify Ed25519 signature on a validation response.
 * Returns true if signature is valid and nonce matches.
 */
function verifySignature(response: Record<string, unknown>, sentNonce: string): boolean {
  const pubKey = getPublicKey()
  if (!pubKey) return false // no key = fail closed

  const signature = response.signature as string | undefined
  if (!signature) return false

  const receivedNonce = response.nonce as string | undefined
  if (receivedNonce !== sentNonce) return false

  // Build canonical JSON (sorted keys, exclude signature field)
  const { signature: _sig, ...payload } = response
  const canonical = JSON.stringify(payload, Object.keys(payload).sort())
  // ponytail: canonical JSON must match server's sort_keys + separators

  try {
    return crypto.verify(null, Buffer.from(canonical), pubKey, Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

export interface LicenseValidationResult {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  message: string
  signatureVerified: boolean
}

export async function validateLicense(
  licenseKey: string,
  machineId: string,
): Promise<LicenseValidationResult> {
  const nonce = generateNonce()
  const url = `${validatorUrl()}/api/v1/license/validate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: licenseKey,
      machine_id: machineId,
      product: product(),
      hostname: process.env.HOSTNAME || 'ryasai-chatbot',
      nonce,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    log.error('License validator HTTP error', { status: res.status })
    return { valid: false, plan: null, expiresAt: null, message: `Validator returned ${res.status}`, signatureVerified: false }
  }

  const data = (await res.json()) as Record<string, unknown>

  // Verify Ed25519 signature + nonce
  const sigOk = verifySignature(data, nonce)
  if (!sigOk) {
    log.error('License response signature verification failed')
    return { valid: false, plan: null, expiresAt: null, message: 'Signature verification failed.', signatureVerified: false }
  }

  /*
   * The plan is normalised at the BOUNDARY, not trusted downstream.
   *
   * This is the single point where an untrusted `data.plan` enters the app, so
   * it is the right place to reject a value we do not recognise — see the WHY
   * block on `KNOWN_PLANS` in plan-gating.ts. An unknown plan resolves to
   * `null`, which the callers treat as "no plan information" and therefore
   * leave the stored `licensePlan` alone (the conditional spread in
   * `licenseUpdateFromResult` drops `undefined`), instead of silently
   * downgrading a paying install to `starter`.
   *
   * A rejection is LOGGED, because an unrecognised plan means the validator and
   * this build disagree about the plan vocabulary — which an operator needs to
   * know about, and which would otherwise be invisible.
   */
  const plan = normalizePlan(data.plan)
  if (data.plan != null && plan === null) {
    log.warn('License validator returned an unrecognised plan — ignoring it and keeping the stored plan', {
      receivedPlan: String(data.plan),
      knownPlans: KNOWN_PLANS.join(', '),
    })
  }

  return {
    valid: data.valid as boolean,
    plan,
    expiresAt: (data.expires_at as string) ?? null,
    message: (data.message as string) ?? '',
    signatureVerified: true,
  }
}

export async function deactivateMachine(licenseKey: string, machineId: string): Promise<boolean> {
  const url = `${validatorUrl()}/api/v1/license/deactivate`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: licenseKey,
        machine_id: machineId,
        product: product(),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success: boolean }
    return data.success
  } catch (e) {
    log.error('License deactivation failed', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

export function generateMachineId(slug: string): string {
  // ponytail: machine ID = org slug + hostname hash — stable across restarts
  // so re-validation doesn't consume a new machine slot.
  const host = process.env.HOSTNAME || 'ryasai-instance'
  return `${slug}:${host}`
}

/**
 * Check if a license is within the grace period.
 * Returns true if the license can still be used despite being unreachable.
 */
export function isWithinGracePeriod(validatedAt: Date | null): boolean {
  if (!validatedAt) return false
  return Date.now() - validatedAt.getTime() < GRACE_PERIOD_MS
}

/**
 * Determine if the app should be locked down based on license status.
 * Returns the lockdown reason, or null if app should run normally.
 * 'unpaid' = licenseless signup, org hasn't purchased a subscription yet.
 */
export function getLockdownReason(
  status: string,
  validatedAt: Date | null,
): 'expired' | 'deactivated' | 'unreachable' | 'unpaid' | null {
  if (status === 'valid') return null
  if (status === 'unpaid' || status === 'none') return 'unpaid'
  if (status === 'expired' || status === 'invalid' || status === 'suspended') return status === 'suspended' ? 'deactivated' : 'expired'
  if (status === 'unreachable') {
    return isWithinGracePeriod(validatedAt) ? null : 'unreachable'
  }
  // Unknown persisted states cannot establish a signed entitlement.
  return 'expired'
}

export { REVALIDATION_INTERVAL_MS }

/**
 * Map a LicenseValidationResult to the org licenseStatus string persisted in DB.
 * Single source of truth for the status mapping — used by the retry route,
 * the periodic revalidation job, and the admin revalidate route so they can
 * never diverge on what "signatureVerified + message contains 'expired'" means.
 *
 *   valid             → 'valid'
 *   signed + invalid  → 'expired' | 'suspended' | 'invalid' (by message)
 *   unsigned / network → 'unreachable' (grace period applies)
 */
export function licenseStatusFromResult(result: LicenseValidationResult): string {
  if (result.signatureVerified && result.valid) return 'valid'
  if (result.signatureVerified && !result.valid) {
    return result.message.includes('expired') ? 'expired'
      : result.message.includes('deactivated') ? 'suspended'
      : 'invalid'
  }
  return 'unreachable'
}

/**
 * Build the `Organization` update payload from a validation result — the
 * write half of {@link licenseStatusFromResult}.
 *
 * INCIDENT (2026-09): this four-field payload was copy-pasted across FOUR call
 * sites (periodic revalidation, post-issue validation, admin revalidate route,
 * and the retry route). One of them even carried the comment "mirrors
 * runRevalidation() exactly; the two must never diverge" — a comment that only
 * exists because the author knew they could. They had already drifted:
 * `license-issue.ts` wrote `result.plan ?? 'flat'` while the other three wrote
 * `result.plan`, so a purchase that validated without a plan field kept the
 * flat plan while an admin revalidate would have cleared it.
 *
 * Two invariants this encodes, both previously re-derived per site:
 *
 *  1. `licenseValidatedAt` advances ONLY on a verified-and-valid answer.
 *     Writing it for an unsigned/unreachable response would silence the
 *     7-day grace window and lock out a paying customer during an outage.
 *  2. `licenseExpiresAt` is written ONLY when the signed response carried one.
 *     Writing `undefined`/null on a network blip would wipe known-good expiry
 *     metadata, so a later grace-period check would see no expiry at all.
 *
 * Prisma ignores `undefined` fields in `update`, which is what makes the
 * conditional spread below leave the previous value intact.
 */
export function licenseUpdateFromResult(
  result: LicenseValidationResult,
  options: { planFallback?: string } = {},
): {
  licenseStatus: string
  licensePlan?: string
  licenseValidatedAt?: Date
  licenseExpiresAt?: Date
} {
  const verified = result.signatureVerified
  /*
   * BOTH inputs are validated, because both reach the database.
   *
   * `result.plan` is already normalised at the parse boundary, but
   * `options.planFallback` is a caller-supplied LITERAL — `'flat'` today, in
   * `license-issue.ts`. A typed fallback that drifts (or that this build does
   * not recognise) would be stored verbatim and then silently resolve to
   * `starter` in every quota check, which is the same downgrade this
   * normalisation exists to prevent. Validating a value twice is cheaper than
   * trusting it once.
   *
   * `null` means "no plan information": the conditional spread below omits the
   * field entirely, and Prisma ignores `undefined` on `update`, so the stored
   * plan survives a validator that answered without one — the exact drift the
   * INCIDENT above records between the four call sites.
   */
  const plan = normalizePlan(verified ? (result.plan ?? options.planFallback) : undefined)
  if (verified && plan === null && options.planFallback) {
    log.warn('Ignoring an unrecognised plan fallback — keeping the stored plan', {
      receivedFallback: options.planFallback,
      knownPlans: KNOWN_PLANS.join(', '),
    })
  }
  return {
    licenseStatus: licenseStatusFromResult(result),
    ...(plan ? { licensePlan: plan } : {}),
    ...(verified && result.valid ? { licenseValidatedAt: new Date() } : {}),
    ...(verified && result.expiresAt ? { licenseExpiresAt: new Date(result.expiresAt) } : {}),
  }
}
