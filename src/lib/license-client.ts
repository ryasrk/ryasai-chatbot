/**
 * License client — validates license keys against the License-Validator service.
 * ----------------------------------------------------------------------------
 * Env: LICENSE_VALIDATOR_URL (default: http://localhost:9000)
 *      LICENSE_PRODUCT (default: ryasai-chatbot)
 */
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('license')

function validatorUrl(): string {
  return process.env.LICENSE_VALIDATOR_URL?.replace(/\/$/, '') || 'http://localhost:9000'
}

function product(): string {
  return process.env.LICENSE_PRODUCT || 'ryasai-chatbot'
}

export interface LicenseValidationResult {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  message: string
}

export async function validateLicense(
  licenseKey: string,
  machineId: string,
): Promise<LicenseValidationResult> {
  const url = `${validatorUrl()}/api/v1/license/validate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: licenseKey,
      machine_id: machineId,
      product: product(),
      hostname: process.env.HOSTNAME || 'ryasai-chatbot',
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    log.error('License validator HTTP error', { status: res.status })
    return { valid: false, plan: null, expiresAt: null, message: `Validator returned ${res.status}` }
  }

  const data = await res.json() as LicenseValidationResult
  return {
    valid: data.valid,
    plan: data.plan,
    expiresAt: data.expiresAt,
    message: data.message,
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
    const data = await res.json() as { success: boolean }
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
