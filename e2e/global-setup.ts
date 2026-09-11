/**
 * Playwright global setup.
 *
 * 1. Seeds the e2e Postgres database (schema push, no rows).
 * 2. Starts the mock License-Validator (:4546) and exports its test public key
 *    into the web server env via LICENSE_SIGNING_PUBLIC_KEY.
 * 3. Starts the mock LLM (:4545) for the whole run.
 * 4. Starts the mock Midtrans Snap (:4547) and injects the matching billing
 *    env into the app under test: MIDTRANS_SERVER_KEY (same fixed value the
 *    mock signs webhook notifications with), MIDTRANS_IS_PRODUCTION=false,
 *    LICENSE_INTERNAL_SECRET (checked by the mock's /internal/licenses/generate).
 *
 * The webServer command in playwright.config.ts reads MOCK_LICENSE_PUBKEY from
 * this process's env — Playwright inherits global-setup env mutations, so we
 * set it via process.env before the web server spawns.
 */
import { execSync } from 'child_process'
import { startMockLlm } from './mock-llm'
import { startMockLicenseValidator } from './mock-license-validator'
// ponytail: the billing env values (MIDTRANS_SERVER_KEY, LICENSE_INTERNAL_SECRET)
// matching these mocks are baked into the webServer command in
// playwright.config.ts — globalSetup process.env mutations do NOT propagate.
import { startMockMidtrans } from './mock-midtrans'
import { E2E_LICENSE_PUBKEY_HEX } from '../e2e-keys'
import type { Server } from 'http'

export default async function globalSetup() {
  console.log('\n[global-setup] Seeding e2e database…')
  execSync('bun run scripts/e2e-seed.ts', {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  console.log('[global-setup] Starting mock License-Validator on :4546…')
  const { server: licenseServer } = startMockLicenseValidator(4546)
  // Fixed test keypair — the webServer command reads this constant directly
  // from mock-license-validator (config loads before globalSetup runs).
  process.env.LICENSE_SIGNING_PUBLIC_KEY = E2E_LICENSE_PUBKEY_HEX

  console.log('[global-setup] Starting mock LLM on :4545…')
  const server: Server = startMockLlm(4545)

  console.log('[global-setup] Starting mock Midtrans on :4547…')
  // Billing env for the app under test is NOT set here — globalSetup
  // process.env mutations don't reach the Playwright-spawned webServer.
  // playwright.config.ts bakes the matching values into the webServer command
  // line directly from these same constants.
  const midtransServer = startMockMidtrans(4547)

  return async () => {
    console.log('\n[global-setup] Stopping mocks…')
    return new Promise<void>((resolve) => {
      server.close(() =>
        midtransServer.close(() => licenseServer.close(() => resolve())),
      )
    })
  }
}
