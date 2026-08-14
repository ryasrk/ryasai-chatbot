/**
 * Playwright global setup.
 *
 * 1. Seeds the e2e Postgres database (schema push, no rows).
 * 2. Starts the mock License-Validator (:4546) and exports its test public key
 *    into the web server env via LICENSE_SIGNING_PUBLIC_KEY.
 * 3. Starts the mock LLM (:4545) for the whole run.
 *
 * The webServer command in playwright.config.ts reads MOCK_LICENSE_PUBKEY from
 * this process's env — Playwright inherits global-setup env mutations, so we
 * set it via process.env before the web server spawns.
 */
import { execSync } from 'child_process'
import { startMockLlm } from './mock-llm'
import { startMockLicenseValidator, E2E_LICENSE_PUBKEY_HEX } from './mock-license-validator'
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

  return async () => {
    console.log('\n[global-setup] Stopping mocks…')
    return new Promise<void>((resolve) => {
      server.close(() => licenseServer.close(() => resolve()))
    })
  }
}
